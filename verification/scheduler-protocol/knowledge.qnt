// Knowledge scheduler admission, with persistent jobs abstracted from SQLite.
// The v2 workflow's paid-call budgets are verified separately by KEJ-64.
module knowledge {
  const KEY_FOR_SESSION: int -> int
  const FAIR_CYCLE: bool
  const INITIAL_BUSY: bool
  const MUTATION: str
  const JOBS: Set[int]
  pure val SESSIONS = Set(0, 1)
  pure val KEYS = Set(0, 1)
  pure val emptyInts: Set[int] = Set()
  pure val emptyList: List[int] = List()
  pure def session(j) = if (j == 2) 1 else 0
  pure def key(j) = KEY_FOR_SESSION.get(session(j))
  type State = { phase: int -> str, durable: int -> str, running: Set[int], intervalReady: int -> bool, graceReady: int -> bool, retryReady: int -> bool, cooldownReady: int -> bool, providerReady: int -> bool, keyAvailable: int -> bool, retried: Set[int], continued: Set[int], aborted: Set[int], listenings: Set[int], closed: bool, lastServed: int, translationWaiting: int, translationRunning: int, interim: int, recentStarts: List[int], started: Set[int], legalAdmission: bool }
  var phase: int -> str
  var durable: int -> str
  var running: Set[int]
  var intervalReady: int -> bool
  var graceReady: int -> bool
  var retryReady: int -> bool
  var cooldownReady: int -> bool
  var providerReady: int -> bool
  var keyAvailable: int -> bool
  var retried: Set[int]
  var continued: Set[int]
  var aborted: Set[int]
  var listenings: Set[int]
  var closed: bool
  var lastServed: int
  var translationWaiting: int
  var translationRunning: int
  var interim: int
  var recentStarts: List[int]
  var started: Set[int]
  var legalAdmission: bool
  var lastAction: str
  var actor: int
  var argument: str
  val s: State = { phase: phase, durable: durable, running: running, intervalReady: intervalReady, graceReady: graceReady, retryReady: retryReady, cooldownReady: cooldownReady, providerReady: providerReady, keyAvailable: keyAvailable, retried: retried, continued: continued, aborted: aborted, listenings: listenings, closed: closed, lastServed: lastServed, translationWaiting: translationWaiting, translationRunning: translationRunning, interim: interim, recentStarts: recentStarts, started: started, legalAdmission: legalAdmission }
  pure def busy(st) = st.translationWaiting > 0 or st.translationRunning > 0 or st.interim > 0
  pure def limit(st) = if (busy(st)) 1 else 2
  pure def sessionRunning(st, id) = st.running.exists(j => session(j) == id)
  pure def pending(st, id) = List(0, 1, 2).select(j => JOBS.contains(j) and session(j) == id and st.phase.get(j) == "pending")
  pure def ready(st, j) = st.retryReady.get(j) and st.intervalReady.get(session(j)) and
    st.cooldownReady.get(key(j)) and st.providerReady.get(key(j)) and
    (not(busy(st)) or st.graceReady.get(j))
  pure def canStartSession(st, id) = not(st.closed) and st.listenings.contains(id) and
    st.keyAvailable.get(id) and not(sessionRunning(st, id)) and
    pending(st, id).length() > 0 and st.running.size() < limit(st) and (MUTATION == "ignore_ready" or ready(st, pending(st, id).nth(0)))
  pure def startSession(st, id) = {
    val j = pending(st, id).nth(0)
    st.with("phase", st.phase.set(j, "running")).with("durable", st.durable.set(j, "running")).with("running", st.running.union(Set(j)))
      .with("intervalReady", st.intervalReady.set(id, false)).with("lastServed", id)
      .with("recentStarts", st.recentStarts.append(j)).with("started", st.started.union(Set(j)))
      .with("legalAdmission", st.legalAdmission and ready(st, j) and st.running.size() < limit(st) and not(sessionRunning(st, id)))
  }
  pure def pumped(st) = {
    val order = if (MUTATION != "starve_session" and st.lastServed == 0) List(1, 0) else List(0, 1)
    order.foldl(st.with("recentStarts", emptyList), (state, id) =>
      if (canStartSession(state, id)) startSession(state, id) else state)
  }
  action initialize(nextState, label, who, detail) = all {
    phase' = nextState.phase,
    durable' = nextState.durable,
    running' = nextState.running,
    intervalReady' = nextState.intervalReady,
    graceReady' = nextState.graceReady,
    retryReady' = nextState.retryReady,
    cooldownReady' = nextState.cooldownReady,
    providerReady' = nextState.providerReady,
    keyAvailable' = nextState.keyAvailable,
    retried' = nextState.retried,
    continued' = nextState.continued,
    aborted' = nextState.aborted,
    listenings' = nextState.listenings,
    closed' = nextState.closed,
    lastServed' = nextState.lastServed,
    translationWaiting' = nextState.translationWaiting,
    translationRunning' = nextState.translationRunning,
    interim' = nextState.interim,
    recentStarts' = nextState.recentStarts,
    started' = nextState.started,
    legalAdmission' = nextState.legalAdmission,
    lastAction' = label, actor' = who, argument' = detail
  }
  action update(nextState, label, who, detail) = all {
    phase' = nextState.phase,
    durable' = nextState.durable,
    running' = nextState.running,
    intervalReady' = nextState.intervalReady,
    graceReady' = nextState.graceReady,
    retryReady' = nextState.retryReady,
    cooldownReady' = nextState.cooldownReady,
    providerReady' = nextState.providerReady,
    keyAvailable' = nextState.keyAvailable,
    retried' = nextState.retried,
    continued' = nextState.continued,
    aborted' = nextState.aborted,
    listenings' = nextState.listenings,
    closed' = nextState.closed,
    lastServed' = nextState.lastServed,
    translationWaiting' = nextState.translationWaiting,
    translationRunning' = nextState.translationRunning,
    interim' = nextState.interim,
    recentStarts' = if (Set("pump", "settle", "remove").contains(label)) nextState.recentStarts else emptyList,
    started' = nextState.started,
    legalAdmission' = nextState.legalAdmission,
    lastAction' = label, actor' = who, argument' = detail
  }
  action init = initialize({
    phase: JOBS.mapBy(_ => "pending"), durable: JOBS.mapBy(_ => "pending"), running: emptyInts,
    intervalReady: SESSIONS.mapBy(_ => true), graceReady: JOBS.mapBy(_ => false),
    retryReady: JOBS.mapBy(_ => true), cooldownReady: KEYS.mapBy(_ => true),
    providerReady: KEYS.mapBy(_ => true), keyAvailable: SESSIONS.mapBy(_ => true),
    retried: emptyInts, continued: emptyInts, aborted: emptyInts,
    listenings: SESSIONS, closed: false, lastServed: -1,
    translationWaiting: if (INITIAL_BUSY) 1 else 0, translationRunning: 0, interim: 0,
    recentStarts: emptyList, started: emptyInts, legalAdmission: true
  }, "init", -1, "")
  action pump = all {
    SESSIONS.exists(id => canStartSession(s, id)),
    update(pumped(s), "pump", -1, "")
  }
  // This snapshot is composed from the translation bridge's public queue and service counters.
  // A 2->1 limit change preserves every already-running knowledge task.
  action setTranslation(waiting, finals, optional) = all {
    Set(0, 1).contains(waiting), Set(0, 1, 2).contains(finals), Set(0, 1).contains(optional), finals + optional <= 2,
    update(s.with("translationWaiting", waiting).with("translationRunning", finals).with("interim", optional)
      .with("running", if (MUTATION == "revoke_on_busy" and (waiting + finals + optional > 0)) emptyInts else s.running),
      "set_translation", waiting, if (finals == 2) "2,0" else if (finals == 1) { if (optional == 1) "1,1" else "1,0" } else if (optional == 1) "0,1" else "0,0")
  }
  action blockProvider(k) = all {
    JOBS.exists(j => key(j) == k), not(s.closed), s.providerReady.get(k),
    update(s.with("providerReady", s.providerReady.set(k, false)), "block_provider", k, "")
  }
  action setKey(id, available) = all {
    JOBS.exists(j => session(j) == id), not(s.closed),
    update(s.with("keyAvailable", s.keyAvailable.set(id, available)), "set_key", id, if (available) "present" else "absent")
  }
  // A delayed event-loop turn crosses every currently outstanding finite deadline.
  // Pump is a separate timer callback action; no claim of exact wall-clock latency.
  action advanceTime = all {
    not(s.closed),
    JOBS.exists(j => not(s.graceReady.get(j)) or not(s.retryReady.get(j))) or
      SESSIONS.exists(id => not(s.intervalReady.get(id))) or KEYS.exists(k => not(s.cooldownReady.get(k)) or not(s.providerReady.get(k))),
    update(s.with("intervalReady", SESSIONS.mapBy(_ => true)).with("graceReady", JOBS.mapBy(_ => true))
      .with("retryReady", JOBS.mapBy(_ => true)).with("cooldownReady", KEYS.mapBy(_ => true))
      .with("providerReady", KEYS.mapBy(_ => true)), "advance_time", -1, "all_outstanding_deadlines")
  }
  action settle(j, outcome) = {
    val retry = outcome == "retry" and not(s.retried.contains(j))
    val continuation = outcome == "continue" and not(s.continued.contains(j))
    val cancelled = s.closed or s.aborted.contains(j) or not(s.listenings.contains(session(j)))
    val nextPhase = if (cancelled) "cancelled" else if (retry or continuation) "pending"
      else if (Set("error", "timeout", "retry", "rate_limit").contains(outcome)) "failed" else "complete"
    val released = s.with("running", if (MUTATION == "leak_cleanup") s.running else s.running.exclude(Set(j)))
      .with("phase", s.phase.set(j, nextPhase)).with("durable", s.durable.set(j, nextPhase)).with("aborted", s.aborted.exclude(Set(j)))
      .with("retried", if (retry) s.retried.union(Set(j)) else s.retried)
      .with("continued", if (continuation) s.continued.union(Set(j)) else s.continued)
      .with("retryReady", s.retryReady.set(j, not(retry or continuation)))
      .with("cooldownReady", if (outcome == "rate_limit") s.cooldownReady.set(key(j), false) else s.cooldownReady)
    all {
      s.running.contains(j), Set("success", "error", "timeout", "retry", "continue", "rate_limit", "cancelled").contains(outcome),
      outcome != "cancelled" or cancelled,
      outcome != "retry" or not(s.retried.contains(j)),
      outcome != "continue" or not(s.continued.contains(j)),
      update(if (s.closed) released.with("recentStarts", emptyList) else pumped(released), "settle", j, outcome)
    }
  }
  // Await actual runtime cancellation and finally cleanup; deletion removes durable rows.
  action remove(id) = all {
    s.listenings.contains(id),
    update(pumped(s.with("listenings", s.listenings.exclude(Set(id))).with("keyAvailable", s.keyAvailable.set(id, false))
      .with("running", if (MUTATION == "leak_cleanup") s.running else s.running.filter(j => session(j) != id))
      .with("phase", JOBS.mapBy(j => if (session(j) == id) "cancelled" else s.phase.get(j)))
      .with("durable", JOBS.mapBy(j => if (session(j) == id) "deleted" else s.durable.get(j)))
      .with("intervalReady", s.intervalReady.set(id, true))), "remove", id, "")
  }
  // close awaits cancellation. Durable running rows remain running until restart recovery.
  action close = all {
    not(s.closed),
    update(s.with("closed", true).with("running", if (MUTATION == "leak_cleanup") s.running else emptyInts)
      .with("phase", JOBS.mapBy(j => if (s.running.contains(j)) "cancelled" else s.phase.get(j)))
      .with("recentStarts", emptyList), "close", -1, "")
  }
  action finish = { nondet j = JOBS.oneOf(); nondet o = Set("success", "error", "timeout", "retry", "continue", "rate_limit", "cancelled").oneOf(); settle(j, o) }
  action recycle(j) = all {
    FAIR_CYCLE, JOBS.contains(j), session(j) == 0, s.phase.get(j) == "complete", not(s.closed), s.listenings.contains(0),
    update(s.with("phase", s.phase.set(j, "pending")).with("durable", s.durable.set(j, "pending")).with("retryReady", s.retryReady.set(j, true))
      .with("retried", s.retried.exclude(Set(j))).with("continued", s.continued.exclude(Set(j))), "recycle", j, "")
  }
  action stutter = update(s, "stutter", -1, "")
  action activeStep = any {
    pump, finish, advanceTime, close, { nondet j = JOBS.oneOf(); recycle(j) },
    { nondet id = SESSIONS.oneOf(); remove(id) },
    { nondet k = KEYS.oneOf(); blockProvider(k) },
    { nondet id = SESSIONS.oneOf(); nondet available = Set(true, false).oneOf(); setKey(id, available) },
    { nondet q = Set(0, 1).oneOf(); nondet f = Set(0, 1, 2).oneOf(); nondet i = Set(0, 1).oneOf(); setTranslation(q, f, i) },
    stutter
  }
  action coreFinish = { nondet j = JOBS.oneOf(); nondet o = Set("success", "error", "timeout").oneOf(); settle(j, o) }
  action coreActiveStep = any {
    pump, coreFinish, advanceTime, close,
    { nondet id = SESSIONS.oneOf(); remove(id) },
    { nondet q = Set(0, 1).oneOf(); nondet f = Set(0, 1, 2).oneOf(); nondet i = Set(0, 1).oneOf(); setTranslation(q, f, i) },
    stutter
  }
  action coreStep = if (s.closed or s.listenings.size() == 0 or JOBS.forall(j => Set("complete", "failed", "cancelled").contains(s.phase.get(j)))) stutter else coreActiveStep
  action step = if (s.closed or s.listenings.size() == 0 or JOBS.forall(j => Set("complete", "failed", "cancelled").contains(s.phase.get(j)))) stutter else activeStep
  action cooldownFinish = { nondet j = JOBS.oneOf(); nondet o = Set("success", "error", "rate_limit").oneOf(); settle(j, o) }
  action cooldownStep = if (s.closed or s.listenings.size() == 0 or JOBS.forall(j => Set("complete", "failed", "cancelled").contains(s.phase.get(j)))) stutter else any {
    pump, cooldownFinish, advanceTime, close,
    { nondet id = SESSIONS.oneOf(); remove(id) },
    { nondet k = KEYS.oneOf(); blockProvider(k) }, stutter
  }
  val observationFinished = s.started.contains(2) or s.closed or not(s.listenings.contains(1))
  action fairPump = all { not(observationFinished), pump }
  action fairFinish = all { not(observationFinished), finish }
  action fairClock = all { not(observationFinished), advanceTime }
  action fairEnvironment = all { not(observationFinished), any {
    close, { nondet id = SESSIONS.oneOf(); remove(id) },
    { nondet j = JOBS.oneOf(); recycle(j) },
    { nondet q = Set(0, 1).oneOf(); nondet f = Set(0, 1, 2).oneOf(); nondet i = Set(0, 1).oneOf(); setTranslation(q, f, i) }
  } }
  action fairStep = any { fairPump, fairFinish, fairClock, fairEnvironment, stutter }
  val finiteDomain = s.running.subseteq(JOBS) and s.aborted.subseteq(s.running) and
    Set(0, 1).contains(s.translationWaiting) and Set(0, 1, 2).contains(s.translationRunning) and
    Set(0, 1).contains(s.interim) and s.translationRunning + s.interim <= 2 and
    JOBS.forall(j => Set("pending", "running", "complete", "failed", "cancelled").contains(s.phase.get(j)))
  val lifecycle = JOBS.forall(j => (s.phase.get(j) == "running") == s.running.contains(j)) and
    JOBS.forall(j => if (s.phase.get(j) == "cancelled") Set("running", "deleted").contains(s.durable.get(j)) else s.durable.get(j) == s.phase.get(j))
  val sessionSerial = SESSIONS.forall(id => s.running.filter(j => session(j) == id).size() <= 1)
  val budget = s.running.size() <= 2
  val closeStopsAdmission = not(s.closed) or s.recentStarts.length() == 0
  val safety = finiteDomain and lifecycle and sessionSerial and budget and s.legalAdmission and closeStopsAdmission
  // Cooldowns may recur. Readiness must eventually persist; otherwise a provider can deny service forever.
  temporal availability = eventually(always(s.keyAvailable.get(1) and s.providerReady.get(KEY_FOR_SESSION.get(1))))
  temporal eligibleTarget = always(not(s.closed) and s.listenings.contains(1))
  temporal fairness = fairClock.weakFair(Set(s)) and fairPump.weakFair(Set(s)) and fairFinish.weakFair(Set(s))
  temporal Progress = (availability and eligibleTarget and fairness).implies(eventually(s.started.contains(2)))
  temporal NoClockProgress = (availability and eligibleTarget and fairPump.weakFair(Set(s)) and fairFinish.weakFair(Set(s))).implies(eventually(s.started.contains(2)))
  temporal NoSchedulerProgress = (availability and eligibleTarget and fairClock.weakFair(Set(s)) and fairFinish.weakFair(Set(s))).implies(eventually(s.started.contains(2)))
  temporal NoTerminationProgress = (availability and eligibleTarget and fairClock.weakFair(Set(s)) and fairPump.weakFair(Set(s))).implies(eventually(s.started.contains(2)))
  temporal Cleanup = always(s.closed.implies(s.running.size() == 0))
}
