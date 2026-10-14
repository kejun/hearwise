// KEJ-65: bounded whole-process crash extension. Independent of KEJ-64.
// One automatic cycle, MAX_CRASHES=1, fixed virtual clock during requests.
module knowledge_protocol {
  const PARTS: Set[int]
  const MUTATION: str
  const MAX_CRASHES: int
  var processState: str
  var generation: int
  var initial_ever: int -> int
  var repair_ever: int -> int
  var protocol_ever: int
  var lastAction: str
  var actor: int
  var response: str
  var stage: str
  var outcome: str
  var ready: bool
  var extra_requests: int
  var protocol_retries: int
  var cycle: int
  var phase: int -> str
  var initial_requests: int -> int
  var repair_reserved: int -> int
  var extract_calls: int -> int
  var repair_calls: int -> int
  var initial_complete: int -> bool
  var retry_kind: int -> str
  var accepted: int -> Set[int]
  var unresolved: int -> Set[int]
  var anchored: int -> Set[int]
  var replies: int -> str
  var accepted_ever: int -> Set[int]
  var apply_counts: int -> int

  pure val emptySlots: Set[int] = Set()
  pure val phases = Set("extract_pending", "extract_inflight", "repair_pending", "repair_inflight", "done")
  pure val successes = Set("ok", "empty", "partial", "rejected", "unrepairable")
  pure val errors = Set("protocol", "transient", "auth", "rate_limit", "rate_limit_long", "unexpected")
  pure val responses = successes.union(errors)
  pure def hasAccepted(a) = PARTS.exists(p => a.get(p).size() > 0)
  pure def finished(ph) = PARTS.forall(p => ph.get(p) == "done")
  pure def result(ph, complete, a, u) =
    if (not(finished(ph))) "none"
    else if (PARTS.exists(p => u.get(p).size() > 0 or not(complete.get(p)))) {
      if (hasAccepted(a)) "partial" else "invalid"
    } else if (hasAccepted(a)) "ok" else "empty"
  def current(p) = PARTS.contains(p) and PARTS.forall(q => q >= p or phase.get(q) == "done")
  def extracting(p) = Set("extract_pending", "extract_inflight").contains(phase.get(p))
  def retryAllowed(r) = extra_requests < (if (MUTATION == "third_extra") 3 else 2) and
    ((r == "protocol" and protocol_retries < 1) or r == "transient" or r == "rate_limit")
  def admissible(p) = processState == "up" and current(p) and stage == "idle" and ready and
    ((phase.get(p) == "extract_pending" and (initial_requests.get(p) == 0 or
      (extra_requests < (if (MUTATION == "third_extra") 3 else 2) and
        (retry_kind.get(p) != "protocol" or protocol_retries < 1)))) or
    (phase.get(p) == "repair_pending" and repair_reserved.get(p) == 0 and anchored.get(p).size() > 0))
  action init = all {
    lastAction' = "init",
    processState' = "up", generation' = 0,
    initial_ever' = PARTS.mapBy(_ => 0), repair_ever' = PARTS.mapBy(_ => 0), protocol_ever' = 0,
    actor' = -1,
    response' = "",
    stage' = "idle",
    outcome' = "none",
    ready' = true,
    extra_requests' = 0,
    protocol_retries' = 0,
    cycle' = 1,
    phase' = PARTS.mapBy(_ => "extract_pending"),
    initial_requests' = PARTS.mapBy(_ => 0),
    repair_reserved' = PARTS.mapBy(_ => 0),
    extract_calls' = PARTS.mapBy(_ => 0),
    repair_calls' = PARTS.mapBy(_ => 0),
    initial_complete' = PARTS.mapBy(_ => false),
    retry_kind' = PARTS.mapBy(_ => "none"),
    accepted' = PARTS.mapBy(_ => emptySlots),
    unresolved' = PARTS.mapBy(_ => emptySlots),
    anchored' = PARTS.mapBy(_ => emptySlots),
    replies' = PARTS.mapBy(_ => "none"),
    accepted_ever' = PARTS.mapBy(_ => emptySlots),
    apply_counts' = PARTS.mapBy(_ => 0)
  }

  action admit(p) = all {
    admissible(p),
    lastAction' = "admit",
    processState' = processState, generation' = generation,
    initial_ever' = initial_ever.set(p, initial_ever.get(p) + (if (extracting(p)) 1 else 0)),
    repair_ever' = repair_ever.set(p, if (extracting(p)) repair_ever.get(p) else 1),
    protocol_ever' = protocol_ever + (if (extracting(p) and initial_requests.get(p) > 0 and retry_kind.get(p) == "protocol") 1 else 0),
    actor' = p,
    response' = "",
    stage' = "reserved",
    outcome' = outcome,
    ready' = ready,
    extra_requests' = extra_requests + (if (extracting(p) and initial_requests.get(p) > 0) 1 else 0),
    protocol_retries' = protocol_retries + (if (extracting(p) and initial_requests.get(p) > 0 and retry_kind.get(p) == "protocol") 1 else 0),
    cycle' = cycle,
    phase' = phase.set(p, if (extracting(p)) "extract_inflight" else "repair_inflight"),
    initial_requests' = initial_requests.set(p, initial_requests.get(p) + (if (extracting(p) and MUTATION != "send_without_reserve") 1 else 0)),
    repair_reserved' = repair_reserved.set(p, if (not(extracting(p)) and MUTATION != "send_without_reserve") 1 else repair_reserved.get(p)),
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies.set(p, "none"),
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts
  }

  action reserveFail(p) = all {
    admissible(p),
    lastAction' = "reserve_fail",
    processState' = processState, generation' = generation,
    initial_ever' = initial_ever, repair_ever' = repair_ever, protocol_ever' = protocol_ever,
    actor' = p,
    response' = "",
    stage' = "done",
    outcome' = if (hasAccepted(accepted)) "partial" else "invalid",
    ready' = true,
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = phase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies,
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts
  }

  action send(p) = all {
    processState == "up",
    current(p),
    stage == "reserved",
    Set("extract_inflight", "repair_inflight").contains(phase.get(p)),
    lastAction' = "send",
    processState' = processState, generation' = generation,
    initial_ever' = initial_ever, repair_ever' = repair_ever, protocol_ever' = protocol_ever,
    actor' = p,
    response' = "",
    stage' = "inflight",
    outcome' = outcome,
    ready' = ready,
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = phase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls.set(p, extract_calls.get(p) + (if (extracting(p)) 1 else 0)),
    repair_calls' = repair_calls.set(p, repair_calls.get(p) + (if (extracting(p)) 0 else 1)),
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies,
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts
  }

  action respond(p, r) = {
    val success = successes.contains(r)
    val retry = extracting(p) and retryAllowed(r)
    val nextPhase = if (success) phase
      else if (r == "auth") PARTS.mapBy(q => "done")
      else phase.set(p, if (retry) "extract_pending" else "done")
    val nextOutcome = if (success) "none" else result(nextPhase, initial_complete, accepted, unresolved)
    all {
    processState == "up",
    current(p),
    Set("extract_inflight", "repair_inflight").contains(phase.get(p)),
    stage == "inflight",
    responses.contains(r),
    extracting(p) or errors.contains(r) or Set("ok", "empty").contains(r),
    lastAction' = "response",
    processState' = processState, generation' = generation,
    initial_ever' = initial_ever, repair_ever' = repair_ever, protocol_ever' = protocol_ever,
    actor' = p,
    response' = r,
    stage' = if (success) "received" else if (finished(nextPhase)) "done" else "idle",
    outcome' = nextOutcome,
    ready' = (success or finished(nextPhase)),
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = nextPhase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind.set(p, if (not(success) and extracting(p)) { if (r == "protocol") "protocol" else "transient" } else retry_kind.get(p)),
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies.set(p, r),
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts
    }
  }

  action commit(p) = {
    val r = replies.get(p)
    val isExtract = extracting(p)
    val newSlots = if (isExtract) { if (Set("ok", "partial").contains(r)) Set(0) else emptySlots }
      else if (r == "ok") anchored.get(p) else emptySlots
    val nextAccepted = accepted.set(p, if (MUTATION == "accepted_loss" and not(isExtract)) newSlots
      else accepted.get(p).union(newSlots))
    val nextUnresolved = unresolved.set(p, if (isExtract) {
      if (r == "partial") Set(1) else if (Set("rejected", "unrepairable").contains(r)) Set(0) else emptySlots
    } else unresolved.get(p).exclude(newSlots))
    val nextAnchored = anchored.set(p, if (isExtract) {
      if (r == "partial") Set(1) else if (r == "rejected") Set(0) else emptySlots
    } else anchored.get(p).exclude(newSlots))
    val nextPhase = phase.set(p, if (isExtract and nextAnchored.get(p).size() > 0) "repair_pending" else "done")
    val nextComplete = initial_complete.set(p, true)
    val settledOutcome = result(nextPhase, nextComplete, nextAccepted, nextUnresolved)
    val reportedOutcome = if (MUTATION == "wrong_terminal_outcome" and finished(nextPhase)) {
      // Both mislabels satisfied the former one-way outcome constraints.
      if (settledOutcome == "ok") "partial" else if (settledOutcome == "empty") "invalid"
      else settledOutcome
    } else settledOutcome
    all {
    processState == "up",
    current(p),
    Set("extract_inflight", "repair_inflight").contains(phase.get(p)),
    stage == "received",
    lastAction' = "commit",
    processState' = processState, generation' = generation,
    initial_ever' = initial_ever, repair_ever' = repair_ever, protocol_ever' = protocol_ever,
    actor' = p,
    response' = "",
    stage' = "committed",
    outcome' = "none",
    ready' = true,
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = nextPhase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = nextComplete,
    retry_kind' = retry_kind.set(p, "none"),
    accepted' = nextAccepted,
    unresolved' = nextUnresolved,
    anchored' = nextAnchored,
    replies' = replies,
    accepted_ever' = accepted_ever.set(p, accepted_ever.get(p).union(newSlots)),
    apply_counts' = apply_counts.set(p, apply_counts.get(p) + newSlots.exclude(accepted.get(p)).size())
    }
  }

  action commitFail(p) = all {
    processState == "up",
    current(p),
    Set("extract_inflight", "repair_inflight").contains(phase.get(p)),
    stage == "received",
    lastAction' = "commit_fail",
    processState' = processState, generation' = generation,
    initial_ever' = initial_ever, repair_ever' = repair_ever, protocol_ever' = protocol_ever,
    actor' = p,
    response' = "",
    stage' = "done",
    outcome' = if (hasAccepted(accepted)) "partial" else "invalid",
    ready' = true,
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = phase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies,
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts
  }

  action advanceTime = all {
    processState == "up",
    stage == "idle",
    not(ready),
    lastAction' = "advance_time",
    processState' = processState, generation' = generation,
    initial_ever' = initial_ever, repair_ever' = repair_ever, protocol_ever' = protocol_ever,
    actor' = -1,
    response' = "",
    stage' = stage,
    outcome' = outcome,
    ready' = true,
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = phase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies,
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts
  }

  action stutter = all {
    processState == "up",
    stage == "done",
    lastAction' = "stutter",
    processState' = processState, generation' = generation,
    initial_ever' = initial_ever, repair_ever' = repair_ever, protocol_ever' = protocol_ever,
    actor' = -1,
    response' = "",
    stage' = stage,
    outcome' = outcome,
    ready' = ready,
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = phase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies,
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts
  }

  action notify(p, fails) = all {
    processState == "up",
    stage == "committed",
    actor == p,
    lastAction' = if (fails) "notify_fail" else "notify",
    actor' = p,
    response' = "",
    stage' = if (finished(phase)) "done" else "idle",
    outcome' = result(phase, initial_complete, accepted, unresolved),
    ready' = finished(phase),
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = phase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies,
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts,
    initial_ever' = initial_ever,
    repair_ever' = repair_ever,
    protocol_ever' = protocol_ever,
    processState' = processState,
    generation' = generation
  }

  action crash = all {
    processState == "up",
    generation < MAX_CRASHES,
    Set("reserved", "inflight", "received", "committed").contains(stage),
    lastAction' = "crash",
    actor' = -1,
    response' = "",
    stage' = "down",
    outcome' = outcome,
    ready' = ready,
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = phase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies,
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts,
    initial_ever' = initial_ever,
    repair_ever' = repair_ever,
    protocol_ever' = protocol_ever,
    processState' = "down",
    generation' = generation
  }

  action recover = all {
    processState == "down",
    lastAction' = "recover",
    actor' = -1,
    response' = "",
    stage' = "idle",
    outcome' = outcome,
    ready' = false,
    extra_requests' = if (MUTATION == "reset_on_recovery") 0 else extra_requests,
    protocol_retries' = if (MUTATION == "reset_on_recovery") 0 else protocol_retries,
    cycle' = cycle,
    phase' = PARTS.mapBy(p => if (phase.get(p) == "extract_inflight") "extract_pending" else if (phase.get(p) == "repair_inflight") "done" else phase.get(p)),
    initial_requests' = if (MUTATION == "reset_on_recovery") PARTS.mapBy(_ => 0) else initial_requests,
    repair_reserved' = if (MUTATION == "reset_on_recovery") PARTS.mapBy(_ => 0) else repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = PARTS.mapBy(_ => "none"),
    accepted_ever' = accepted_ever,
    apply_counts' = if (MUTATION == "reapply_committed") PARTS.mapBy(p => apply_counts.get(p) + accepted.get(p).size()) else apply_counts,
    initial_ever' = initial_ever,
    repair_ever' = repair_ever,
    protocol_ever' = protocol_ever,
    processState' = "up",
    generation' = generation + 1
  }

  action settle = all {
    processState == "up",
    stage == "idle",
    ready,
    finished(phase),
    lastAction' = "settle",
    actor' = -1,
    response' = "",
    stage' = "done",
    outcome' = result(phase, initial_complete, accepted, unresolved),
    ready' = ready,
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = phase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies,
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts,
    initial_ever' = initial_ever,
    repair_ever' = repair_ever,
    protocol_ever' = protocol_ever,
    processState' = processState,
    generation' = generation
  }

  action settleExhausted(p) = {
    val nextPhase = phase.set(p, "done")
    all {
    processState == "up",
    stage == "idle",
    ready,
    current(p),
    phase.get(p) == "extract_pending",
    initial_requests.get(p) > 0,
    extra_requests >= 2 or (retry_kind.get(p) == "protocol" and protocol_retries >= 1),
    lastAction' = "settle_exhausted",
    actor' = p,
    response' = "",
    stage' = if (finished(nextPhase)) "done" else "idle",
    outcome' = result(nextPhase, initial_complete, accepted, unresolved),
    ready' = finished(nextPhase),
    extra_requests' = extra_requests,
    protocol_retries' = protocol_retries,
    cycle' = cycle,
    phase' = nextPhase,
    initial_requests' = initial_requests,
    repair_reserved' = repair_reserved,
    extract_calls' = extract_calls,
    repair_calls' = repair_calls,
    initial_complete' = initial_complete,
    retry_kind' = retry_kind,
    accepted' = accepted,
    unresolved' = unresolved,
    anchored' = anchored,
    replies' = replies,
    accepted_ever' = accepted_ever,
    apply_counts' = apply_counts,
    initial_ever' = initial_ever,
    repair_ever' = repair_ever,
    protocol_ever' = protocol_ever,
    processState' = processState,
    generation' = generation
  }
  }

  action step = any {
    { nondet p = PARTS.oneOf(); admit(p) },
    { nondet p = PARTS.oneOf(); reserveFail(p) },
    { nondet p = PARTS.oneOf(); send(p) },
    { nondet p = PARTS.oneOf(); nondet r = responses.oneOf(); respond(p, r) },
    { nondet p = PARTS.oneOf(); commit(p) },
    { nondet p = PARTS.oneOf(); nondet fails = Set(false, true).oneOf(); notify(p, fails) },
    { nondet p = PARTS.oneOf(); settleExhausted(p) },
    crash, recover, settle,
    { nondet p = PARTS.oneOf(); commitFail(p) },
    advanceTime, stutter
  }

  val finiteDomain = Set("idle", "reserved", "inflight", "received", "committed", "down", "done").contains(stage) and
    Set("none", "ok", "empty", "partial", "invalid").contains(outcome) and
    PARTS.forall(p => phases.contains(phase.get(p)) and
      initial_requests.get(p) >= 0 and initial_requests.get(p) <= 4 and
      extract_calls.get(p) >= 0 and extract_calls.get(p) <= 4 and
      Set(0, 1).contains(repair_reserved.get(p)) and Set(0, 1).contains(repair_calls.get(p)) and
      accepted.get(p).subseteq(Set(0, 1)) and unresolved.get(p).subseteq(Set(0, 1)))
  val budgetBeforeSend = PARTS.forall(p => extract_calls.get(p) <= initial_requests.get(p) and repair_calls.get(p) <= repair_reserved.get(p))
  val sharedBudget = extra_requests >= 0 and extra_requests <= 2 and
    PARTS.fold(0, (n, p) => n + (if (initial_requests.get(p) > 0) initial_requests.get(p) - 1 else 0)) == extra_requests
  val protocolBudget = protocol_retries >= 0 and protocol_retries <= 1 and protocol_retries <= extra_requests
  val repairBudget = PARTS.forall(p => repair_reserved.get(p) <= 1 and repair_calls.get(p) <= 1 and
    (repair_reserved.get(p) == 0 or initial_complete.get(p)))
  val repairTargets = PARTS.forall(p => anchored.get(p).subseteq(unresolved.get(p)) and
    accepted.get(p).intersect(unresolved.get(p)) == emptySlots and
    (not(Set("repair_pending", "repair_inflight").contains(phase.get(p))) or anchored.get(p).size() > 0))
  val acceptedPreserved = PARTS.forall(p => accepted.get(p) == accepted_ever.get(p))
  val sourceIndexExactlyOnce = PARTS.forall(p => apply_counts.get(p) == accepted.get(p).size())
  val completedInitialNotRepeated = PARTS.forall(p => not(initial_complete.get(p)) or
    not(Set("extract_pending", "extract_inflight").contains(phase.get(p))))
  val continuationWaits = ready or Set("idle", "down").contains(stage)
  // Independent specification of terminal classification: do not call the
  // transition's result helper here, so a shared helper bug cannot self-verify.
  // Pending/inflight phases retained by storage faults are not all resolved.
  val allResolved = PARTS.forall(p => phase.get(p) == "done" and
    initial_complete.get(p) and unresolved.get(p).size() == 0)
  val expectedOutcome = if (stage != "done") "none"
    else if (allResolved) { if (PARTS.exists(p => accepted.get(p).size() > 0)) "ok" else "empty" }
    else if (PARTS.exists(p => accepted.get(p).size() > 0)) "partial" else "invalid"
  val terminalOutcome = outcome == expectedOutcome
  val oneAutomaticCycle = cycle == 1
  val processDomain = Set("up", "down").contains(processState) and generation >= 0 and generation <= MAX_CRASHES and
    ((processState == "down") == (stage == "down"))
  val durableReservationHistory = initial_requests == initial_ever and repair_reserved == repair_ever and protocol_retries == protocol_ever
  val recoveredVolatileCleared = lastAction != "recover" or PARTS.forall(p => replies.get(p) == "none")
  val recoverableProgress = processState != "up" or stage != "idle" or not(ready) or finished(phase) or
    PARTS.exists(p => admissible(p) or (current(p) and phase.get(p) == "extract_pending" and initial_requests.get(p) > 0 and
      (extra_requests >= 2 or (retry_kind.get(p) == "protocol" and protocol_retries >= 1))))
  val safety = processDomain and durableReservationHistory and recoveredVolatileCleared and recoverableProgress and finiteDomain and budgetBeforeSend and sharedBudget and protocolBudget and repairBudget and
    repairTargets and acceptedPreserved and sourceIndexExactlyOnce and completedInitialNotRepeated and
    continuationWaits and terminalOutcome and oneAutomaticCycle
}
