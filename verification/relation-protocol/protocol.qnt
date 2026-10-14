// KEJ-63: finite, process-alive relation workflow protocol.
// Admission policy and response delivery are environment choices. No crash,
// cancellation, deletion, epoch changes, fairness or semantic-quality claim.
module protocol {
  const ACTORS: Set[int]
  const CAP: int
  const SCRIPTED: bool
  const MUTATION: str

  var lastAction: str
  var actor: int
  var response: str
  var mode: str
  var phase: int -> str
  var counts: int -> int
  var calls: int -> int
  var relations: int -> int
  var outcome: int -> str
  var replies: int -> str
  var ready: int -> bool

  pure val phases = Set("idle", "reserved", "inflight", "received", "committed",
    "retry_wait", "done", "waiting_nodes", "reserve_failed")
  pure val successResponses = Set("ok", "empty", "filtered")
  pure val responses = Set("ok", "empty", "filtered", "protocol", "transient",
    "auth", "rate_limit", "rate_limit_long", "unexpected")
  pure def active(p) = Set("reserved", "inflight", "received", "committed").contains(p)
  pure def terminal(p) = Set("done", "waiting_nodes", "reserve_failed").contains(p)
  val activeCount = ACTORS.filter(a => active(phase.get(a))).size()
  val allTerminal = ACTORS.forall(a => terminal(phase.get(a)))
  // Identities are actor 0=(session 0,window 0), 1=(session 1,window 0),
  // 2=(session 0,window 1). An older ready/initial job comes first; a retry
  // whose deadline has not elapsed does not block a later dirty window.
  def ordered(a) = a != 2 or phase.get(0) != "idle"
  pure def scriptedResponse(a, attempt) =
    if (a == 0) { if (attempt == 1) "protocol" else "ok" }
    else if (a == 1) { if (attempt == 1) "transient" else "empty" }
    else "filtered"
  pure def shouldRetry(r, count) = count < 3 and
    ((r == "protocol" and count < 2) or r == "transient" or r == "rate_limit")

  action initMode(m) = all {
    lastAction' = "init", actor' = -1, response' = "", mode' = m,
    phase' = ACTORS.mapBy(_ => "idle"), counts' = ACTORS.mapBy(_ => 0),
    calls' = ACTORS.mapBy(_ => 0), relations' = ACTORS.mapBy(_ => 0),
    outcome' = ACTORS.mapBy(_ => "none"), replies' = ACTORS.mapBy(_ => "none"),
    ready' = ACTORS.mapBy(_ => true)
  }
  action init = {
    nondet m = (if (SCRIPTED) Set("valid") else Set("valid", "no_candidates", "reserve_fail")).oneOf()
    initMode(m)
  }
  action admit(a) = all {
    ACTORS.contains(a), phase.get(a) == "idle", ordered(a), activeCount < CAP,
    counts.get(a) < (if (MUTATION == "fourth_request") 4 else 3),
    lastAction' = "admit", actor' = a, response' = "", mode' = mode,
    phase' = phase.set(a, if (mode == "no_candidates") "waiting_nodes"
      else if (mode == "reserve_fail") "reserve_failed" else "reserved"),
    counts' = counts.set(a, counts.get(a) + (if (mode == "valid" and MUTATION != "send_without_reserve") 1 else 0)),
    calls' = calls, relations' = relations,
    outcome' = outcome.set(a, if (mode == "no_candidates") "no_candidates"
      else if (mode == "reserve_fail") "reserve_failed" else "none"),
    replies' = replies.set(a, "none"), ready' = ready.set(a, true)
  }
  action send(a) = all {
    ACTORS.contains(a), phase.get(a) == "reserved",
    lastAction' = "send", actor' = a, response' = "", mode' = mode,
    phase' = phase.set(a, "inflight"), calls' = calls.set(a, calls.get(a) + 1),
    counts' = counts, relations' = relations, outcome' = outcome, replies' = replies, ready' = ready
  }
  action respond(a, r) = all {
    ACTORS.contains(a), phase.get(a) == "inflight", responses.contains(r),
    (not(SCRIPTED) or r == scriptedResponse(a, counts.get(a))),
    lastAction' = "response", actor' = a, response' = r, mode' = mode,
    phase' = phase.set(a, if (successResponses.contains(r)) "received"
      else if (shouldRetry(r, counts.get(a)) or (MUTATION == "fourth_request" and r == "transient" and counts.get(a) < 4)) "retry_wait" else "done"),
    outcome' = outcome.set(a, if (successResponses.contains(r) or shouldRetry(r, counts.get(a))
      or (MUTATION == "fourth_request" and r == "transient" and counts.get(a) < 4)) "none" else "failed"),
    replies' = replies.set(a, r),
    ready' = ready.set(a, not(shouldRetry(r, counts.get(a))
      or (MUTATION == "fourth_request" and r == "transient" and counts.get(a) < 4))),
    counts' = counts, calls' = calls, relations' = relations
  }
  action commit(a) = all {
    ACTORS.contains(a), phase.get(a) == "received",
    lastAction' = "commit", actor' = a, response' = "", mode' = mode,
    phase' = phase.set(a, "committed"),
    relations' = relations.set(a, if (replies.get(a) == "ok") 1 else 0),
    outcome' = outcome.set(a, if (replies.get(a) == "ok") "ok" else "empty"),
    counts' = counts, calls' = calls, replies' = replies, ready' = ready
  }
  action commitFail(a) = all {
    ACTORS.contains(a), phase.get(a) == "received", not(SCRIPTED),
    lastAction' = "commit_fail", actor' = a, response' = "", mode' = mode,
    phase' = phase.set(a, if (MUTATION == "retry_commit_failure") "retry_wait" else "done"),
    outcome' = outcome.set(a, "failed"), ready' = ready.set(a, MUTATION != "retry_commit_failure"),
    counts' = counts, calls' = calls, relations' = relations, replies' = replies
  }
  action notify(a, fails) = all {
    ACTORS.contains(a), phase.get(a) == "committed",
    lastAction' = if (fails) "notify_fail" else "notify", actor' = a, response' = "", mode' = mode,
    phase' = phase.set(a, "done"), counts' = counts, calls' = calls,
    relations' = relations, outcome' = outcome, replies' = replies, ready' = ready
  }
  // The injected logical clock jumps to the largest pending retry/cooldown.
  // Finite abstraction of elapsed waiting; no wall-clock/fairness claim.
  action advanceTime = all {
    ACTORS.exists(a => phase.get(a) == "retry_wait"),
    lastAction' = "advance_time", actor' = -1, response' = "", mode' = mode,
    phase' = ACTORS.mapBy(a => if (phase.get(a) == "retry_wait") "idle" else phase.get(a)),
    ready' = ACTORS.mapBy(_ => true), counts' = counts, calls' = calls,
    relations' = relations, outcome' = outcome, replies' = replies
  }
  action stutter = all {
    allTerminal, lastAction' = "stutter", actor' = -1, response' = "", mode' = mode,
    phase' = phase, counts' = counts, calls' = calls, relations' = relations,
    outcome' = outcome, replies' = replies, ready' = ready
  }
  action step = any {
    { nondet a = ACTORS.oneOf(); admit(a) },
    { nondet a = ACTORS.oneOf(); send(a) },
    { nondet a = ACTORS.oneOf(); nondet r = responses.oneOf(); respond(a, r) },
    { nondet a = ACTORS.oneOf(); commit(a) },
    { nondet a = ACTORS.oneOf(); commitFail(a) },
    { nondet a = ACTORS.oneOf(); nondet fails = Set(false, true).oneOf(); notify(a, fails) },
    advanceTime, stutter
  }

  val finiteDomain = ACTORS.forall(a => phases.contains(phase.get(a)) and
    counts.get(a) >= 0 and counts.get(a) <= 3 and calls.get(a) >= 0 and calls.get(a) <= 3 and
    Set(0, 1).contains(relations.get(a)))
  val budgetBeforeSend = ACTORS.forall(a => calls.get(a) <= counts.get(a))
  val requestLimit = ACTORS.forall(a => counts.get(a) <= 3)
  val concurrencyLimit = activeCount <= CAP
  val noCandidateNoCharge = mode != "no_candidates" or ACTORS.forall(a => counts.get(a) == 0 and calls.get(a) == 0 and relations.get(a) == 0)
  val reserveFailureNoCharge = mode != "reserve_fail" or ACTORS.forall(a => counts.get(a) == 0 and calls.get(a) == 0 and relations.get(a) == 0)
  val paidResponseNoRetry = ACTORS.forall(a => not(successResponses.contains(replies.get(a))) or
    Set("received", "committed", "done").contains(phase.get(a)))
  val protocolLimit = ACTORS.forall(a => replies.get(a) != "protocol" or counts.get(a) < 2 or phase.get(a) == "done")
  val terminalBudget = ACTORS.forall(a => counts.get(a) < 3 or phase.get(a) != "retry_wait")
  val resultConsistency = ACTORS.forall(a =>
    (outcome.get(a) != "ok" or (relations.get(a) == 1 and Set("committed", "done").contains(phase.get(a)))) and
    (outcome.get(a) != "empty" or (relations.get(a) == 0 and Set("committed", "done").contains(phase.get(a)))) and
    (outcome.get(a) != "failed" or (relations.get(a) == 0 and phase.get(a) == "done")))
  val retryReadiness = ACTORS.forall(a => ready.get(a) == (phase.get(a) != "retry_wait"))
  val safety = finiteDomain and budgetBeforeSend and requestLimit and concurrencyLimit and
    noCandidateNoCharge and reserveFailureNoCharge and paidResponseNoRetry and protocolLimit and
    terminalBudget and resultConsistency and retryReadiness
}
