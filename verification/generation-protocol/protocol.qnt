// KEJ-66: request/owner envelope. A request is one workflow dispatch, not a
// reduced product retry budget. Full retry/repair budgets are separate domains.
module generation_protocol {
  const ACTORS: Set[int]
  const CAP: int
  const PROTOCOL: str
  const MUTATION: str
  const TRACE: bool
  var lastAction: str
  var actor: int
  var response: str
  var generation: int -> int
  var present: int -> bool
  var cancelled: int -> bool
  var activeOwner: int -> int
  var requestGeneration: int -> int
  var aborted: int -> bool
  var physical: int -> str
  var reserved: int -> int
  var usage: int -> str
  var business: int -> Set[int]
  var outcome: int -> str
  var calls: int -> int
  var callbackCount: int -> int
  var authorizedBusiness: int -> Set[int]
  var authorizedOutcome: int -> str
  var restartCount: int

  pure val SESSIONS = ACTORS.map(a => if (a == 1) 1 else 0)
  pure val REQUESTS = ACTORS.fold(Set(), (s, a) => s.union(Set(a * 2, a * 2 + 1)))
  pure def session(a) = if (a == 1) 1 else 0
  pure def requestActor(r) = r / 2
  pure def requestId(a, g) = a * 2 + g
  val activeCount = ACTORS.filter(a => activeOwner.get(a) != -1).size()
  def current(r) = present.get(session(requestActor(r))) and
    not(cancelled.get(session(requestActor(r)))) and
    not(aborted.get(r)) and requestGeneration.get(r) == generation.get(requestActor(r)) and
    activeOwner.get(requestActor(r)) == r
  def admissible(a) = present.get(session(a)) and not(cancelled.get(session(a))) and
    activeOwner.get(a) == -1 and activeCount < CAP and
    physical.get(requestId(a, generation.get(a))) == "none" and
    (PROTOCOL != "relation" or business.get(a).size() == 0) and
    (PROTOCOL != "knowledge" or ACTORS.forall(b => session(a) != session(b) or activeOwner.get(b) == -1))

  action init = all {
    lastAction' = if (TRACE) "init" else "",
    actor' = if (TRACE) -1 else -1,
    response' = if (TRACE) "" else "",
    generation' = ACTORS.mapBy(_ => 0),
    present' = SESSIONS.mapBy(_ => true),
    cancelled' = SESSIONS.mapBy(_ => false),
    activeOwner' = ACTORS.mapBy(_ => -1),
    requestGeneration' = REQUESTS.mapBy(r => r % 2),
    aborted' = REQUESTS.mapBy(_ => false),
    physical' = REQUESTS.mapBy(_ => "none"),
    reserved' = REQUESTS.mapBy(_ => 0),
    usage' = REQUESTS.mapBy(_ => "none"),
    business' = ACTORS.mapBy(_ => Set()),
    outcome' = ACTORS.mapBy(_ => "none"),
    calls' = REQUESTS.mapBy(_ => 0),
    callbackCount' = REQUESTS.mapBy(_ => 0),
    authorizedBusiness' = ACTORS.mapBy(_ => Set()),
    authorizedOutcome' = ACTORS.mapBy(_ => "none"),
    restartCount' = 0
  }

  // Reservation and provider invocation are separate boundaries. Cancel is
  // may occur before send; an aborted reservation cannot start a physical call.
  action reserve(a) = {
    val r = requestId(a, generation.get(a))

    all {
    ACTORS.contains(a),
    admissible(a),
    lastAction' = if (TRACE) "reserve" else "",
    actor' = if (TRACE) a else -1,
    response' = if (TRACE) "" else "",
    generation' = generation,
    present' = present,
    cancelled' = cancelled,
    activeOwner' = activeOwner.set(a, r),
    requestGeneration' = requestGeneration,
    aborted' = aborted,
    physical' = physical.set(r, "reserved"),
    reserved' = reserved.set(r, if (MUTATION == "skip_reservation") 0 else 1),
    usage' = usage,
    business' = business,
    outcome' = outcome.set(a, "none"),
    calls' = calls,
    callbackCount' = callbackCount,
    authorizedBusiness' = authorizedBusiness,
    authorizedOutcome' = authorizedOutcome.set(a, "none"),
    restartCount' = restartCount
  }
  }

  action send(r) = {
    val a = requestActor(r)

    all {
    REQUESTS.contains(r),
    physical.get(r) == "reserved",
    current(r),
    lastAction' = if (TRACE) "send" else "",
    actor' = if (TRACE) r else -1,
    response' = if (TRACE) "" else "",
    generation' = generation,
    present' = present,
    cancelled' = cancelled,
    activeOwner' = activeOwner,
    requestGeneration' = requestGeneration,
    aborted' = aborted,
    physical' = physical.set(r, "inflight"),
    reserved' = reserved,
    usage' = usage,
    business' = business,
    outcome' = outcome,
    calls' = calls.set(r, 1),
    callbackCount' = callbackCount,
    authorizedBusiness' = authorizedBusiness,
    authorizedOutcome' = authorizedOutcome,
    restartCount' = restartCount
  }
  }

  // A provider can ignore abort. This observation follows the local abort race
  // and scheduler finally; it does not wait for the physical request to settle.

  action cancel(s) = all {
    SESSIONS.contains(s),
    present.get(s),
    not(cancelled.get(s)),
    ACTORS.exists(a => session(a) == s and activeOwner.get(a) != -1),
    lastAction' = if (TRACE) "cancel" else "",
    actor' = if (TRACE) s else -1,
    response' = if (TRACE) "" else "",
    generation' = generation,
    present' = present,
    cancelled' = cancelled.set(s, if (PROTOCOL == "relation") true else cancelled.get(s)),
    activeOwner' = ACTORS.mapBy(a => if (session(a) == s) -1 else activeOwner.get(a)),
    requestGeneration' = requestGeneration,
    aborted' = REQUESTS.mapBy(r => if (session(requestActor(r)) == s and activeOwner.get(requestActor(r)) == r) true else aborted.get(r)),
    physical' = physical,
    reserved' = reserved,
    usage' = usage,
    business' = business,
    outcome' = outcome,
    calls' = calls,
    callbackCount' = callbackCount,
    authorizedBusiness' = authorizedBusiness,
    authorizedOutcome' = authorizedOutcome,
    restartCount' = restartCount
  }

  // Relation: explicit enableRelations after cancellation, epoch advances.
  // Knowledge: a new pending job under the same listening after task cancellation;
  // generation is per actor and observational, NOT progress_json.cycle or a new
  // storage field. Unrelated pending knowledge actors are never cancelled.

  action newGeneration(target) = all {
    if (PROTOCOL == "relation") SESSIONS.contains(target) else ACTORS.contains(target),
    present.get(if (PROTOCOL == "relation") target else session(target)),
    if (PROTOCOL == "relation") cancelled.get(target) else aborted.get(requestId(target, 0)),
    if (PROTOCOL == "relation") ACTORS.forall(a => session(a) != target or generation.get(a) == 0)
      else generation.get(target) == 0,
    if (PROTOCOL == "knowledge") activeOwner.get(target) == -1 else true,
    lastAction' = if (TRACE) "new_generation" else "",
    actor' = if (TRACE) target else -1,
    response' = if (TRACE) "" else "",
    generation' = ACTORS.mapBy(a => if ((PROTOCOL == "relation" and session(a) == target) or (PROTOCOL == "knowledge" and a == target)) 1 else generation.get(a)),
    present' = present,
    cancelled' = if (PROTOCOL == "relation") cancelled.set(target, false) else cancelled,
    activeOwner' = activeOwner,
    requestGeneration' = requestGeneration,
    aborted' = aborted,
    physical' = physical,
    reserved' = reserved,
    usage' = usage,
    business' = business,
    outcome' = outcome,
    calls' = calls,
    callbackCount' = callbackCount,
    authorizedBusiness' = authorizedBusiness,
    authorizedOutcome' = authorizedOutcome,
    restartCount' = restartCount
  }

  // Failure is a nonretryable provider outcome in this envelope. Product network
  // and protocol retry choices are checked in the independent full-budget domains.
  action respond(r, result) = {
    val a = requestActor(r)
    val s = session(a)
    val allowed = if (MUTATION == "skip_generation_guard") present.get(s) else current(r)
    val accepted = result == "ok" and allowed
    val honestAccepted = result == "ok" and current(r)

    all {
    REQUESTS.contains(r),
    physical.get(r) == "inflight",
    Set("ok", "failed").contains(result),
    lastAction' = if (TRACE) "response" else "",
    actor' = if (TRACE) r else -1,
    response' = if (TRACE) result else "",
    generation' = generation,
    present' = present,
    cancelled' = cancelled,
    activeOwner' = activeOwner.set(a, if (activeOwner.get(a) == r) -1 else activeOwner.get(a)),
    requestGeneration' = requestGeneration,
    aborted' = aborted,
    physical' = physical.set(r, "settled"),
    reserved' = reserved,
    usage' = usage.set(r, if (PROTOCOL == "relation" and present.get(s)) { if (aborted.get(r)) "late_response" else "response_received" } else "none"),
    business' = business.set(a, if (accepted) business.get(a).union(Set(r)) else business.get(a)),
    outcome' = outcome.set(a, if (allowed) result else outcome.get(a)),
    calls' = calls,
    callbackCount' = callbackCount.set(r, if (allowed) 1 else 0),
    authorizedBusiness' = authorizedBusiness.set(a, if (honestAccepted) authorizedBusiness.get(a).union(Set(r)) else authorizedBusiness.get(a)),
    authorizedOutcome' = authorizedOutcome.set(a, if (current(r)) result else authorizedOutcome.get(a)),
    restartCount' = restartCount
  }
  }

  // Calling resolve/reject on the same JS promise again cannot execute a second
  // business continuation. This is an environment duplicate, a semantic stutter.

  action duplicate(r) = all {
    REQUESTS.contains(r),
    physical.get(r) == "settled",
    lastAction' = if (TRACE) "duplicate" else "",
    actor' = if (TRACE) r else -1,
    response' = if (TRACE) "" else "",
    generation' = generation,
    present' = present,
    cancelled' = cancelled,
    activeOwner' = activeOwner,
    requestGeneration' = requestGeneration,
    aborted' = aborted,
    physical' = physical,
    reserved' = reserved,
    usage' = usage,
    business' = business,
    outcome' = outcome,
    calls' = calls,
    callbackCount' = callbackCount,
    authorizedBusiness' = authorizedBusiness,
    authorizedOutcome' = authorizedOutcome,
    restartCount' = restartCount
  }


  // Real onUsage callbacks and the workflow's settlement callback may both
  // upsert this attempt. They are separate from duplicate Promise settlement.
  action reportUsage(r) = all {
    REQUESTS.contains(r),
    PROTOCOL == "relation",
    Set("inflight", "settled").contains(physical.get(r)),
    lastAction' = if (TRACE) "usage" else "",
    actor' = if (TRACE) r else -1,
    response' = if (TRACE) "" else "",
    generation' = generation,
    present' = present,
    cancelled' = cancelled,
    activeOwner' = activeOwner,
    requestGeneration' = requestGeneration,
    aborted' = aborted,
    physical' = physical,
    reserved' = reserved,
    usage' = usage.set(r, if (present.get(session(requestActor(r)))) {
      if (aborted.get(r)) "late_response" else "response_received"
    } else "none"),
    business' = business,
    outcome' = outcome,
    calls' = calls,
    callbackCount' = callbackCount,
    authorizedBusiness' = authorizedBusiness,
    authorizedOutcome' = authorizedOutcome,
    restartCount' = restartCount
  }

  // Foreign-key cascade removes durable business, reservations and usage for
  // this listening. External physical calls remain, independently observable.

  action deleteListening(s) = all {
    SESSIONS.contains(s),
    present.get(s),
    lastAction' = if (TRACE) "delete" else "",
    actor' = if (TRACE) s else -1,
    response' = if (TRACE) "" else "",
    generation' = generation,
    present' = present.set(s, false),
    cancelled' = cancelled.set(s, if (PROTOCOL == "relation") true else cancelled.get(s)),
    activeOwner' = ACTORS.mapBy(a => if (session(a) == s) -1 else activeOwner.get(a)),
    requestGeneration' = requestGeneration,
    aborted' = REQUESTS.mapBy(r => if (session(requestActor(r)) == s and activeOwner.get(requestActor(r)) == r) true else aborted.get(r)),
    physical' = physical,
    reserved' = REQUESTS.mapBy(r => if (session(requestActor(r)) == s) 0 else reserved.get(r)),
    usage' = REQUESTS.mapBy(r => if (session(requestActor(r)) == s) "none" else usage.get(r)),
    business' = ACTORS.mapBy(a => if (session(a) == s) Set() else business.get(a)),
    outcome' = ACTORS.mapBy(a => if (session(a) == s) "none" else outcome.get(a)),
    calls' = calls,
    callbackCount' = callbackCount,
    authorizedBusiness' = ACTORS.mapBy(a => if (session(a) == s) Set() else authorizedBusiness.get(a)),
    authorizedOutcome' = ACTORS.mapBy(a => if (session(a) == s) "none" else authorizedOutcome.get(a)),
    restartCount' = restartCount
  }

  // Clean scheduler/store restart after all local tasks settle/cancel. External
  // fixtures may still finish deleted-listening requests. No deleted listening
  // is recreated; surviving aborted work requires the independent recovery model.

  action restart = all {
    restartCount == 0,
    activeCount == 0,
    // A still-present cancelled knowledge job would recover as pending. That
    // distinct retry path belongs to the full budget/recovery protocols.
    REQUESTS.forall(r => not(present.get(session(requestActor(r)))) or
      (not(aborted.get(r)) and not(Set("reserved", "inflight").contains(physical.get(r))))),
    lastAction' = if (TRACE) "restart" else "",
    actor' = if (TRACE) -1 else -1,
    response' = if (TRACE) "" else "",
    generation' = generation,
    present' = present,
    cancelled' = cancelled,
    activeOwner' = activeOwner,
    requestGeneration' = requestGeneration,
    aborted' = aborted,
    physical' = physical,
    reserved' = reserved,
    usage' = usage,
    business' = business,
    outcome' = outcome,
    calls' = calls,
    callbackCount' = callbackCount,
    authorizedBusiness' = authorizedBusiness,
    authorizedOutcome' = authorizedOutcome,
    restartCount' = 1
  }

  action stutter = all {
    lastAction' = if (TRACE) "stutter" else "",
    actor' = if (TRACE) -1 else -1,
    response' = if (TRACE) "" else "",
    generation' = generation,
    present' = present,
    cancelled' = cancelled,
    activeOwner' = activeOwner,
    requestGeneration' = requestGeneration,
    aborted' = aborted,
    physical' = physical,
    reserved' = reserved,
    usage' = usage,
    business' = business,
    outcome' = outcome,
    calls' = calls,
    callbackCount' = callbackCount,
    authorizedBusiness' = authorizedBusiness,
    authorizedOutcome' = authorizedOutcome,
    restartCount' = restartCount
  }

  action step = any {
    { nondet a = ACTORS.oneOf(); reserve(a) },
    { nondet r = REQUESTS.oneOf(); send(r) },
    { nondet r = REQUESTS.oneOf(); nondet result = Set("ok", "failed").oneOf(); respond(r, result) },
    { nondet r = REQUESTS.oneOf(); duplicate(r) },
    { nondet r = REQUESTS.oneOf(); reportUsage(r) },
    { nondet s = SESSIONS.oneOf(); cancel(s) },
    { nondet target = (if (PROTOCOL == "relation") SESSIONS else ACTORS).oneOf(); newGeneration(target) },
    { nondet s = SESSIONS.oneOf(); deleteListening(s) },
    restart, stutter
  }

  val finiteDomain = ACTORS.forall(a => Set(0, 1).contains(generation.get(a))) and
    REQUESTS.forall(r => Set("none", "reserved", "inflight", "settled").contains(physical.get(r)) and
      Set(0, 1).contains(reserved.get(r)) and Set(0, 1).contains(calls.get(r)) and
      Set(0, 1).contains(callbackCount.get(r)) and requestGeneration.get(r) == r % 2) and
    Set(0, 1).contains(restartCount)
  val budgetBeforeSend = REQUESTS.forall(r => not(present.get(session(requestActor(r)))) or calls.get(r) <= reserved.get(r))
  val localCapacity = activeCount <= CAP
  val ownerGeneration = ACTORS.forall(a => activeOwner.get(a) == -1 or
    (present.get(session(a)) and not(cancelled.get(session(a))) and
      activeOwner.get(a) == requestId(a, generation.get(a)) and
      Set("reserved", "inflight").contains(physical.get(activeOwner.get(a)))))
  val ownerComplete = REQUESTS.forall(r =>
    not(present.get(session(requestActor(r))) and not(aborted.get(r)) and
      requestGeneration.get(r) == generation.get(requestActor(r)) and
      Set("reserved", "inflight").contains(physical.get(r))) or activeOwner.get(requestActor(r)) == r)
  val listeningSerial = PROTOCOL != "knowledge" or SESSIONS.forall(s =>
    ACTORS.filter(a => session(a) == s and activeOwner.get(a) != -1).size() <= 1)
  val listeningIsolation = ACTORS.forall(a => business.get(a).forall(r => requestActor(r) == a))
  val generationIsolation = business == authorizedBusiness and outcome == authorizedOutcome
  val deletedNeverResurrects = ACTORS.forall(a => present.get(session(a)) or
    (activeOwner.get(a) == -1 and business.get(a).size() == 0 and outcome.get(a) == "none")) and
    REQUESTS.forall(r => present.get(session(requestActor(r))) or (reserved.get(r) == 0 and usage.get(r) == "none"))
  val usageAttribution = REQUESTS.forall(r => usage.get(r) == "none" or
    (PROTOCOL == "relation" and calls.get(r) == 1 and reserved.get(r) == 1 and Set("inflight", "settled").contains(physical.get(r))))
  val safety = finiteDomain and budgetBeforeSend and localCapacity and ownerGeneration and ownerComplete and listeningSerial and
    generationIsolation and listeningIsolation and deletedNeverResurrects and usageAttribution
}
