// Controlled-provider replay domain. The complete lifecycle Safety model stays
// unchanged; each action below projects to one of its actions (permit -> stutter).
module replay_generation {
  const REPLAY_ACTORS: Set[int]
  const REPLAY_CAP: int
  const REPLAY_PROTOCOL: str
  import generation_protocol(ACTORS = REPLAY_ACTORS, CAP = REPLAY_CAP, PROTOCOL = REPLAY_PROTOCOL, MUTATION = "none", TRACE = true).* from "./protocol"

  var admissionPermit: bool
  var lastServedSession: int
  var creationRank: int -> int
  var nextCreationRank: int
  var permitsIssued: int
  var admissionsObserved: int
  var environmentAction: str

  // All initial fixture tasks exist and are ready. New knowledge jobs append to
  // their listening's source order. Relation windows retain their source order.
  def rank(a) = if (PROTOCOL == "relation") a else creationRank.get(requestId(a, generation.get(a)))
  def firstFor(s) = ACTORS.filter(a => session(a) == s and admissible(a) and
    ACTORS.forall(b => session(b) != s or not(admissible(b)) or rank(a) <= rank(b)))
  val eligibleSessions = SESSIONS.filter(s => firstFor(s).size() > 0)
  val selectedSession = if (lastServedSession == 0 and eligibleSessions.contains(1)) 1
    else if (eligibleSessions.contains(0)) 0 else 1
  val selectedActors = firstFor(selectedSession)

  action environment(tag, permit, served, ranks, nextRank, issued, observed) = all {
    environmentAction' = tag, admissionPermit' = permit, lastServedSession' = served,
    creationRank' = ranks, nextCreationRank' = nextRank, permitsIssued' = issued, admissionsObserved' = observed
  }
  action retainEnvironment = environment("core", admissionPermit, lastServedSession,
    creationRank, nextCreationRank, permitsIssued, admissionsObserved)
  action ReplayInit = all {
    init,
    environment("init", false, -1, REQUESTS.mapBy(r => if (r % 2 == 0) r / 2 else -1), ACTORS.size(), 0, 0)
  }
  // Opening the test provider permit advances the virtual clock by 6000ms, so
  // all declared quiet/admission intervals have elapsed. No real pump occurs
  // until the following reserve action; no other action is enabled in between.
  action permitReplay = all {
    not(admissionPermit), selectedActors.size() > 0, stutter,
    environment("permit", true, lastServedSession, creationRank, nextCreationRank, permitsIssued + 1, admissionsObserved)
  }
  action reserveReplay(a) = all {
    admissionPermit, selectedActors.contains(a), reserve(a),
    environment("core", false, session(a), creationRank, nextCreationRank, permitsIssued, admissionsObserved + 1)
  }
  action sendReplay(r) = all { not(admissionPermit), send(r), retainEnvironment }
  action responseReplay(r, result) = all { not(admissionPermit), respond(r, result), retainEnvironment }
  action duplicateReplay(r) = all { not(admissionPermit), duplicate(r), retainEnvironment }
  action usageReplay(r) = all { not(admissionPermit), reportUsage(r), retainEnvironment }
  action cancelReplay(s) = all { not(admissionPermit), cancel(s), retainEnvironment }
  action deleteReplay(s) = all { not(admissionPermit), deleteListening(s), retainEnvironment }
  action newGenerationReplay(target) = all {
    not(admissionPermit), newGeneration(target),
    environment("core", false, lastServedSession,
      if (PROTOCOL == "knowledge") creationRank.set(requestId(target, 1), nextCreationRank) else creationRank,
      if (PROTOCOL == "knowledge") nextCreationRank + 1 else nextCreationRank, permitsIssued, admissionsObserved)
  }
  action restartReplay = all {
    not(admissionPermit), restart,
    environment("core", false, -1, creationRank, nextCreationRank, permitsIssued, admissionsObserved)
  }
  action stutterReplay = all { not(admissionPermit), stutter, retainEnvironment }
  action ReplayStep = if (admissionPermit) { nondet a = ACTORS.oneOf(); reserveReplay(a) } else any {
    permitReplay,
    { nondet r = REQUESTS.oneOf(); sendReplay(r) },
    { nondet r = REQUESTS.oneOf(); nondet result = Set("ok", "failed").oneOf(); responseReplay(r, result) },
    { nondet r = REQUESTS.oneOf(); duplicateReplay(r) },
    { nondet r = REQUESTS.oneOf(); usageReplay(r) },
    { nondet s = SESSIONS.oneOf(); cancelReplay(s) },
    { nondet s = SESSIONS.oneOf(); deleteReplay(s) },
    { nondet target = (if (PROTOCOL == "relation") SESSIONS else ACTORS).oneOf(); newGenerationReplay(target) },
    restartReplay, stutterReplay
  }
  val ReplaySafety = safety and permitsIssued - admissionsObserved == (if (admissionPermit) 1 else 0)
  val observedRestartCount = restartCount
  val observedBusiness = business
  val observedCallbackCount = callbackCount
  val observedOutcome = outcome
  val observedActiveCount = activeCount
  val observedReserved = reserved
  val observedActiveOwner = activeOwner
  val observedPhysical = physical
  val observedPresent = present
  val observedGeneration = generation
  val observedUsage = usage
  val observedCalls = calls
  val observedREQUESTS = REQUESTS

}
module replay_relation_single {
  import replay_generation(REPLAY_ACTORS = Set(0), REPLAY_CAP = 1, REPLAY_PROTOCOL = "relation").* from "./replay-refinement"
  action Init = ReplayInit
  action Step = ReplayStep
  val Safety = ReplaySafety
}
module replay_relation_cap1 {
  import replay_generation(REPLAY_ACTORS = Set(0, 1, 2), REPLAY_CAP = 1, REPLAY_PROTOCOL = "relation").* from "./replay-refinement"
  action Init = ReplayInit
  action Step = ReplayStep
  val Safety = ReplaySafety
}
module replay_relation_cap2 {
  import replay_generation(REPLAY_ACTORS = Set(0, 1, 2), REPLAY_CAP = 2, REPLAY_PROTOCOL = "relation").* from "./replay-refinement"
  action Init = ReplayInit
  action Step = ReplayStep
  val Safety = ReplaySafety
}
module replay_knowledge_single {
  import replay_generation(REPLAY_ACTORS = Set(0), REPLAY_CAP = 1, REPLAY_PROTOCOL = "knowledge").* from "./replay-refinement"
  action Init = ReplayInit
  action Step = ReplayStep
  val Safety = ReplaySafety
}
module replay_knowledge_cap1 {
  import replay_generation(REPLAY_ACTORS = Set(0, 1, 2), REPLAY_CAP = 1, REPLAY_PROTOCOL = "knowledge").* from "./replay-refinement"
  action Init = ReplayInit
  action Step = ReplayStep
  val Safety = ReplaySafety
}
module replay_knowledge_cap2 {
  import replay_generation(REPLAY_ACTORS = Set(0, 1, 2), REPLAY_CAP = 2, REPLAY_PROTOCOL = "knowledge").* from "./replay-refinement"
  action Init = ReplayInit
  action Step = ReplayStep
  val Safety = ReplaySafety
}
