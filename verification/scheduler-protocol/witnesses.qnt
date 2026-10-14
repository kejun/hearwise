// Exported ITF witnesses use the production capacity. The cap=2 safety domain is separate.
module translation_witnesses {
  import translation(TOKENS = Set(0, 1, 2, 3), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2, 3 -> 3), CAP = 500, FAIR_CYCLE = false, MUTATION = "none").* from "./translation"
  run sharedAdmissionTest = init.then(admitInterim).then(enqueue(1)).then(enqueue(2)).then(pump)
    .expect(safety and interim == 1 and running == Set(1) and queue == List(2))
    .then(rejectInterim).then(settleInterim("success"))
    .expect(safety and interim == 0 and running == Set(1, 2) and recentStarts == List(2))
  run activeFinalsRejectInterimTest = init.then(enqueue(1)).then(enqueue(2)).then(pump).then(rejectInterim)
    .expect(safety and queue.length() == 0 and running.size() == 2 and interim == 0)
  run waitingFinalRejectsInterimTest = init.then(enqueue(0)).then(rejectInterim)
    .expect(safety and queue == List(0) and running.size() == 0 and interim == 0)
  run finalErrorCleanupTest = init.then(enqueue(1)).then(enqueue(2)).then(enqueue(3)).then(pump)
    .then(settleFinal(2, "error")).expect(safety and running == Set(1, 3) and recentStarts == List(1))
  run finalTimeoutCleanupTest = init.then(enqueue(1)).then(pump).then(settleFinal(1, "timeout"))
    .expect(safety and running.size() == 0)
  run finalCancellationCleanupTest = init.then(enqueue(1)).then(enqueue(2)).then(enqueue(3)).then(pump)
    .then(settleFinal(2, "cancelled")).expect(safety and running == Set(1, 3) and recentStarts == List(1))
  run interimErrorCleanupTest = init.then(admitInterim).then(settleInterim("error"))
    .expect(safety and interim == 0)
  run interimTimeoutCleanupTest = init.then(admitInterim).then(settleInterim("timeout"))
    .expect(safety and interim == 0)
  run interimCancellationCleanupTest = init.then(admitInterim).then(enqueue(1)).then(enqueue(2)).then(pump)
    .then(settleInterim("cancelled")).expect(safety and running == Set(1, 2) and interim == 0)
  run speechHeadAlternatesTest = init.then(enqueue(0)).then(enqueue(1)).then(enqueue(2)).then(enqueue(3))
    .then(setHead(0)).then(pump).expect(safety and recentStarts == List(0, 2))
  run cancelWaitingTest = init.then(enqueue(0)).then(enqueue(1)).then(cancelQueued(0)).then(pump)
    .expect(safety and running == Set(1) and phase.get(0) == "cancelled")
  run queueDedupTest = init.then(enqueue(1)).then(duplicate(1)).expect(safety and queue == List(1))
}
module alias_witnesses {
  import translation(TOKENS = Set(0, 1, 2), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 1), CAP = 500, FAIR_CYCLE = false, MUTATION = "none").* from "./translation"
  run waitingAliasRejectedTest = init.then(enqueue(1)).then(duplicate(2)).expect(safety and queue == List(1))
  run inflightIdentityMayRequeueTest = init.then(enqueue(1)).then(pump).then(enqueue(2)).then(pump)
    .expect(safety and running == Set(1, 2) and queue.length() == 0)
}
module window_witnesses {
  import translation(TOKENS = Set(0, 1, 2, 3), BACKGROUND = Set(), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2, 3 -> 3), CAP = 500, FAIR_CYCLE = false, MUTATION = "none").* from "./translation"
  run latestWindowTest = init.then(enqueue(0)).then(enqueue(1)).then(enqueue(2)).then(enqueue(3)).then(pump)
    .expect(safety and recentStarts == List(2, 3) and queue == List(0, 1))
  run lockedWindowTest = init.then(admitInterim).then(enqueue(0)).then(enqueue(1)).then(enqueue(2)).then(pump)
    .expect(safety and recentStarts == List(1)).then(enqueue(3)).then(settleFinal(1, "success"))
    .expect(safety and recentStarts == List(2) and running == Set(2) and queue == List(0, 3))
  run realtimeIsNotHardCappedTest = init.then(enqueue(0)).then(enqueue(1)).then(enqueue(2)).then(enqueue(3))
    .expect(safety and queue.length() == 4)
}
module fifo_witnesses {
  import translation(TOKENS = Set(0, 1, 2), BACKGROUND = Set(0, 1, 2), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2), CAP = 500, FAIR_CYCLE = false, MUTATION = "none").* from "./translation"
  run backgroundFifoTest = init.then(enqueue(0)).then(enqueue(1)).then(enqueue(2)).then(pump)
    .expect(safety and recentStarts == List(0, 1)).then(settleFinal(0, "success"))
    .expect(safety and recentStarts == List(2))
}
module fairness_witnesses {
  import translation(TOKENS = Set(0, 1, 2, 3), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2, 3 -> 3), CAP = 500, FAIR_CYCLE = true, MUTATION = "none").* from "./translation"
  run backgroundFairSuccessTest = init.then(pump).then(settleFinal(2, "success"))
    .expect(safety and streak == 3 and not(started.contains(0)))
    .then(recycle(2)).then(enqueue(2)).then(advanceTime).then(settleFinal(3, "success"))
    .expect(safety and started.contains(0) and recentStarts == List(0) and queue == List(2))
    .then(stutter).then(stutter).expect(safety and observationFinished and not(excluded.contains(0)))
}
module knowledge_witnesses {
  import knowledge(JOBS = Set(0, 1, 2), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 0), FAIR_CYCLE = false, INITIAL_BUSY = false, MUTATION = "none").* from "./knowledge"
  run twoSessionsSerialTest = init.then(pump).expect(safety and running == Set(0, 2) and phase.get(1) == "pending")
  run busyDoesNotRevokeTest = init.then(pump).then(setTranslation(0, 1, 0))
    .expect(safety and running == Set(0, 2)).then(settle(0, "success"))
    .expect(safety and running == Set(2) and phase.get(1) == "pending")
  run busyGraceAndLimitTest = init.then(setTranslation(0, 0, 1)).expect(safety and running.size() == 0)
    .then(advanceTime).then(pump).expect(safety and running == Set(0))
    .then(settle(0, "success")).expect(safety and running == Set(2))
  run intervalWaitTest = init.then(pump).then(settle(0, "success"))
    .expect(safety and phase.get(1) == "pending" and running == Set(2))
    .then(advanceTime).then(pump).expect(safety and running == Set(1, 2))
  run retryBlocksSessionTest = init.then(pump).then(settle(0, "retry"))
    .expect(safety and phase.get(0) == "pending" and phase.get(1) == "pending" and running == Set(2))
    .then(advanceTime).then(pump).expect(safety and running == Set(0, 2))
  run continuationReleasesTest = init.then(pump).then(settle(0, "continue"))
    .expect(safety and running == Set(2) and phase.get(0) == "pending")
  run knowledgeExceptionCleanupTest = init.then(pump).then(settle(0, "error"))
    .expect(safety and running == Set(2) and phase.get(0) == "failed")
  run providerCooldownWaitTest = init.then(blockProvider(0)).expect(safety and running.size() == 0)
    .then(advanceTime).then(pump).expect(safety and running == Set(0, 2))
  run sharedKeyCooldownTest = init.then(setTranslation(1, 0, 0)).then(advanceTime).then(pump)
    .then(settle(0, "rate_limit")).expect(safety and running.size() == 0 and phase.get(0) == "failed" and durable.get(0) == "failed" and phase.get(2) == "pending")
    .then(advanceTime).then(pump).expect(safety and running == Set(2))
  run removeCleanupTest = init.then(pump).then(remove(0))
    .expect(safety and running == Set(2) and phase.get(0) == "cancelled" and phase.get(1) == "cancelled")
  run closeCleanupTest = init.then(pump).then(close)
    .expect(safety and closed and running.size() == 0 and durable.get(0) == "running" and durable.get(2) == "running")
}
module knowledge_fairness_witnesses {
  import knowledge(JOBS = Set(0, 1, 2), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 0), FAIR_CYCLE = true, INITIAL_BUSY = true, MUTATION = "none").* from "./knowledge"
  run knowledgeFairSuccessTest = init.then(fairClock).then(fairPump).expect(safety and running == Set(0))
    .then(settle(0, "success")).expect(safety and started.contains(2))
    .then(stutter).then(stutter).expect(safety and observationFinished and not(closed) and listenings.contains(1))
}
