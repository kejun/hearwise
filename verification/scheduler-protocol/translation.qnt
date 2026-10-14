// Queue selection AND synchronous server admission, not the queue alone.
module translation {
  const TOKENS: Set[int]
  const BACKGROUND: Set[int]
  const IDENTITIES: int -> int
  const CAP: int
  const FAIR_CYCLE: bool
  const MUTATION: str
  type State = {
    queue: List[int], window: List[int], running: Set[int],
    phase: int -> str, aged: Set[int], started: Set[int],
    excluded: Set[int], interim: int,
    streak: int, speechTurn: bool, headIdentity: int, legalStart: bool, legalDrop: bool, recentStarts: List[int]
  }
  var queue: List[int]
  var window: List[int]
  var running: Set[int]
  var phase: int -> str
  var aged: Set[int]
  var started: Set[int]
  var excluded: Set[int]
  var interim: int
  var streak: int
  var speechTurn: bool
  var headIdentity: int
  var legalStart: bool
  var legalDrop: bool
  var recentStarts: List[int]
  val s: State = { queue: queue, window: window, running: running, phase: phase, aged: aged, started: started, excluded: excluded, interim: interim, streak: streak, speechTurn: speechTurn, headIdentity: headIdentity, legalStart: legalStart, legalDrop: legalDrop, recentStarts: recentStarts }
  var lastAction: str
  var actor: int
  var argument: str
  pure val emptyInts: Set[int] = Set()
  pure def listSet(l) = l.foldl(Set(), (a, t) => a.union(Set(t)))
  pure val emptyList: List[int] = List()
  pure def identity(t) = IDENTITIES.get(t)
  pure def bg(t) = BACKGROUND.contains(t)
  pure def cappedStreak(n) = if (n >= 3) 3 else n
  def used = s.running.size() + s.interim
  def busy = s.queue.length() > 0 or used > 0
  def waitingIdentity(t) = listSet(s.queue).exists(q => identity(q) == identity(t))
  def canEnqueue(t) = TOKENS.contains(t) and s.phase.get(t) == "fresh" and not(waitingIdentity(t))
  def canInterim = s.queue.length() == 0 and s.interim < 1 and used < 2
  pure def backgrounds(q) = q.select(t => bg(t))
  pure def speechHeads(q, h) = q.select(t => identity(t) == h)
  pure def nextWindow(q, w) = {
    val live = w.select(t => listSet(q).contains(t))
    val reals = q.select(t => not(bg(t)))
    if (live.length() > 0) live else reals.slice(if (reals.length() > 2) reals.length() - 2 else 0, reals.length())
  }
  pure def mustServeBackground(q, streakValue, ages) = streakValue >= 3 and backgrounds(q).length() > 0 and ages.contains(backgrounds(q).nth(0))
  pure def takesBackground(q, streakValue, ages) = MUTATION != "starve_background" and mustServeBackground(q, streakValue, ages)
  pure def takesHead(q, streakValue, ages, turn, h) = not(takesBackground(q, streakValue, ages)) and speechHeads(q, h).length() > 0 and turn
  pure def selected(q, w, streakValue, ages, turn, h) = if (takesBackground(q, streakValue, ages)) backgrounds(q).nth(0)
    else if (takesHead(q, streakValue, ages, turn, h)) speechHeads(q, h).nth(0)
    else if (nextWindow(q, w).length() > 0) nextWindow(q, w).nth(0) else q.nth(0)
  pure def windowAfter(q, w, streakValue, ages, turn, h, t) = {
    val retained = if (takesBackground(q, streakValue, ages) or takesHead(q, streakValue, ages, turn, h)) w else nextWindow(q, w)
    if (retained.length() > 0 and retained.nth(0) == t) retained.tail() else retained
  }
  pure def streakAfter(q, w, streakValue, ages, turn, h) =
    if (takesBackground(q, streakValue, ages) or (not(takesHead(q, streakValue, ages, turn, h)) and nextWindow(q, w).length() == 0)) 0 else cappedStreak(streakValue + 1)
  pure def turnAfter(q, streakValue, ages, turn, h) = if (takesBackground(q, streakValue, ages)) turn else not(takesHead(q, streakValue, ages, turn, h))
  pure def canPump(st) = st.queue.length() > 0 and st.running.size() + st.interim < 2
  // At most two dispatches, calculated without nesting whole-state record transforms.
  pure def pumped(st) = {
    val hasFirst = canPump(st)
    val first = if (hasFirst) selected(st.queue, st.window, st.streak, st.aged, st.speechTurn, st.headIdentity) else -1
    val q1 = st.queue.select(t => t != first)
    val w1 = if (hasFirst) windowAfter(st.queue, st.window, st.streak, st.aged, st.speechTurn, st.headIdentity, first) else st.window
    val k1 = if (hasFirst) streakAfter(st.queue, st.window, st.streak, st.aged, st.speechTurn, st.headIdentity) else st.streak
    val turn1 = if (hasFirst) turnAfter(st.queue, st.streak, st.aged, st.speechTurn, st.headIdentity) else st.speechTurn
    val hasSecond = hasFirst and q1.length() > 0 and st.running.size() + st.interim + 1 < 2
    val second = if (hasSecond) selected(q1, w1, k1, st.aged, turn1, st.headIdentity) else -1
    val dispatch = (if (hasFirst) List(first) else emptyList).concat(if (hasSecond) List(second) else emptyList)
    val chosen = listSet(dispatch)
    st.with("queue", q1.select(t => t != second))
      .with("window", if (hasSecond) windowAfter(q1, w1, k1, st.aged, turn1, st.headIdentity, second) else w1)
      .with("streak", if (hasSecond) streakAfter(q1, w1, k1, st.aged, turn1, st.headIdentity) else k1)
      .with("speechTurn", if (hasSecond) turnAfter(q1, k1, st.aged, turn1, st.headIdentity) else turn1)
      .with("running", st.running.union(chosen)).with("phase", TOKENS.mapBy(t => if (chosen.contains(t)) "running" else st.phase.get(t)))
      .with("started", st.started.union(chosen)).with("aged", st.aged.exclude(chosen)).with("recentStarts", dispatch)
      .with("legalStart", st.legalStart and st.running.size() + st.interim + dispatch.length() <= 2 and
        (not(hasFirst) or not(mustServeBackground(st.queue, st.streak, st.aged)) or first == backgrounds(st.queue).nth(0)) and
        (not(hasSecond) or not(mustServeBackground(q1, k1, st.aged)) or second == backgrounds(q1).nth(0)))
  }
  action update(nextState, label, who, detail) = all {
    queue' = nextState.queue,
    window' = nextState.window,
    running' = nextState.running,
    phase' = nextState.phase,
    aged' = nextState.aged,
    started' = nextState.started,
    excluded' = nextState.excluded,
    interim' = nextState.interim,
    streak' = nextState.streak,
    speechTurn' = nextState.speechTurn,
    headIdentity' = nextState.headIdentity,
    legalStart' = nextState.legalStart,
    legalDrop' = nextState.legalDrop,
    recentStarts' = if (Set("pump", "settle_final", "settle_interim").contains(label)) nextState.recentStarts else emptyList,
    lastAction' = label, actor' = who, argument' = detail
  }
  action initialize(nextState, label, who, detail) = all {
    queue' = nextState.queue,
    window' = nextState.window,
    running' = nextState.running,
    phase' = nextState.phase,
    aged' = nextState.aged,
    started' = nextState.started,
    excluded' = nextState.excluded,
    interim' = nextState.interim,
    streak' = nextState.streak,
    speechTurn' = nextState.speechTurn,
    headIdentity' = nextState.headIdentity,
    legalStart' = nextState.legalStart,
    legalDrop' = nextState.legalDrop,
    recentStarts' = nextState.recentStarts,
    lastAction' = label, actor' = who, argument' = detail
  }
  action init = initialize({
      queue: if (FAIR_CYCLE) List(0, 1, 2, 3) else emptyList,
      window: emptyList, running: emptyInts,
      phase: TOKENS.mapBy(t => if (FAIR_CYCLE and Set(0, 1, 2, 3).contains(t)) "queued" else "fresh"),
      aged: emptyInts, started: emptyInts, excluded: emptyInts,
      interim: 0, streak: 0, speechTurn: true, headIdentity: -1,
      legalStart: true, legalDrop: true, recentStarts: emptyList
    }, "init", -1, "")
  action enqueue(t) = {
    val appended = s.queue.append(t)
    val background = appended.select(q => bg(q))
    val evicts = appended.length() > CAP and background.length() > 0
    val dropped = if (evicts) background.nth(0) else -1
    val phases = s.phase.set(t, "queued")
    all {
      canEnqueue(t),
      update(s.with("queue", appended.select(q => q != dropped))
        .with("phase", if (evicts) phases.set(dropped, "dropped") else phases)
        .with("aged", s.aged.exclude(Set(t, dropped)))
        .with("excluded", if (evicts) s.excluded.union(Set(dropped)) else s.excluded)
        .with("legalDrop", not(evicts) or bg(dropped)), "enqueue", t, "")
    }
  }
  action duplicate(t) = all {
    TOKENS.contains(t), waitingIdentity(t), update(s, "duplicate", t, "")
  }
  action pump = all {
    canPump(s), update(pumped(s), "pump", -1, "")
  }
  action admitInterim = all {
    if (MUTATION == "interim_queue_only") s.queue.length() == 0 else if (MUTATION == "interim_ignore_total") s.queue.length() == 0 and s.interim < 1 else canInterim,
    update(s.with("interim", s.interim + 1).with("legalStart", s.legalStart and canInterim), "admit_interim", -1, "")
  }
  action rejectInterim = all { not(canInterim), update(s, "reject_interim", -1, "busy") }
  action settleFinal(t, outcome) = all {
    s.running.contains(t), Set("success", "error", "timeout", "cancelled").contains(outcome),
    update(pumped(s.with("running", if (MUTATION == "leak_final") s.running else s.running.exclude(Set(t)))
      .with("phase", s.phase.set(t, "settled")).with("aged", if (outcome == "timeout") listSet(s.queue) else s.aged)),
      "settle_final", t, outcome)
  }
  action settleInterim(outcome) = all {
    s.interim == 1, Set("success", "error", "timeout", "cancelled").contains(outcome),
    update(pumped(s.with("interim", if (MUTATION == "leak_interim") 1 else 0).with("aged", if (outcome == "timeout") listSet(s.queue) else s.aged)),
      "settle_interim", -1, outcome)
  }
  action cancelQueued(t) = all {
    listSet(s.queue).exists(q => q == t),
    update(s.with("queue", s.queue.select(q => q != t)).with("window", s.window.select(q => q != t))
      .with("phase", s.phase.set(t, "cancelled")).with("aged", s.aged.exclude(Set(t)))
      .with("excluded", s.excluded.union(Set(t))), "cancel_queued", t, "")
  }
  action setHead(id) = all {
    Set(-1).union(TOKENS.map(t => identity(t))).contains(id),
    update(s.with("headIdentity", id), "set_head", id, "")
  }
  // The clock crosses the starvation boundary. No clock movement is implicit in scheduling.
  action advanceTime = all {
    listSet(s.queue).exists(t => not(s.aged.contains(t))),
    update(s.with("aged", s.queue.foldl(emptyInts, (a, t) => a.union(Set(t)))), "advance_time", -1, "starvation_threshold")
  }
  // Fairness-only producer: bounded identities, arbitrarily many realtime arrivals.
  action recycle(t) = all {
    FAIR_CYCLE, not(bg(t)), s.phase.get(t) == "settled",
    update(s.with("phase", s.phase.set(t, "fresh")), "recycle", t, "")
  }
  action finish = any {
    { nondet t = TOKENS.oneOf(); nondet o = Set("success", "error", "timeout", "cancelled").oneOf(); settleFinal(t, o) },
    { nondet o = Set("success", "error", "timeout", "cancelled").oneOf(); settleInterim(o) }
  }
  action stutter = update(s, "stutter", -1, "")
  action step = any {
    { nondet t = TOKENS.oneOf(); enqueue(t) }, { nondet t = TOKENS.oneOf(); duplicate(t) },
    pump, admitInterim, rejectInterim, finish,
    { nondet t = TOKENS.oneOf(); cancelQueued(t) },
    { nondet id = Set(-1).union(TOKENS.map(t => identity(t))).oneOf(); setHead(id) },
    advanceTime, { nondet t = TOKENS.oneOf(); recycle(t) }, stutter
  }
  val observationFinished = s.started.contains(0) or s.excluded.contains(0)
  action fairPump = all { not(observationFinished), pump }
  action fairFinish = all { not(observationFinished), finish }
  action fairClock = all { not(observationFinished), advanceTime }
  action fairEnvironment = all { not(observationFinished), any {
    { nondet t = TOKENS.oneOf(); enqueue(t) }, { nondet t = TOKENS.oneOf(); duplicate(t) },
    admitInterim, rejectInterim, { nondet t = TOKENS.oneOf(); cancelQueued(t) },
    { nondet id = Set(-1).union(TOKENS.map(t => identity(t))).oneOf(); setHead(id) },
    { nondet t = TOKENS.oneOf(); recycle(t) }
  } }
  action fairStep = any { fairPump, fairFinish, fairClock, fairEnvironment, stutter }
  val finiteDomain = s.queue.foldl(emptyInts, (a, t) => a.union(Set(t))).subseteq(TOKENS) and s.running.subseteq(TOKENS) and
    s.queue.length() == s.queue.foldl(emptyInts, (a, t) => a.union(Set(t))).size() and Set(0, 1).contains(s.interim) and
    Set(0, 1, 2, 3).contains(s.streak) and TOKENS.forall(t =>
      Set("fresh", "queued", "running", "settled", "cancelled", "dropped").contains(s.phase.get(t)))
  val queuedIdentityUnique = s.queue.length() == s.queue.foldl(emptyInts, (a, t) => a.union(Set(identity(t)))).size()
  val lifecycle = TOKENS.forall(t =>
    (s.phase.get(t) == "queued") == listSet(s.queue).exists(q => q == t) and
    (s.phase.get(t) == "running") == s.running.contains(t))
  val sharedBudget = used <= 2
  val interimReleased = lastAction != "settle_interim" or s.interim == 0
  val safety = finiteDomain and queuedIdentityUnique and lifecycle and sharedBudget and s.legalStart and s.legalDrop and interimReleased
  // No invariant incorrectly constrains queue.length <= CAP or forbids an active identity from being requeued.
  temporal fairness = fairClock.weakFair(Set(s)) and fairPump.weakFair(Set(s)) and fairFinish.weakFair(Set(s))
  temporal eligibleTarget = always(not(s.excluded.contains(0)))
  temporal Progress = (fairness and eligibleTarget).implies(eventually(s.started.contains(0)))
  temporal NoClockProgress = (fairPump.weakFair(Set(s)) and fairFinish.weakFair(Set(s)) and eligibleTarget).implies(eventually(s.started.contains(0)))
  temporal NoSchedulerProgress = (fairClock.weakFair(Set(s)) and fairFinish.weakFair(Set(s)) and eligibleTarget).implies(eventually(s.started.contains(0)))
  temporal NoTerminationProgress = (fairClock.weakFair(Set(s)) and fairPump.weakFair(Set(s)) and eligibleTarget).implies(eventually(s.started.contains(0)))
}
