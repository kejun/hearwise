// Fixed successful ITF traces, all using the checked production-shaped transitions.
module relation_single_witnesses {
  import relation_protocol(ACTORS = Set(0), CAP = 1, SCRIPTED = false, MAX_CRASHES = 1, MUTATION = "none").* from "./relation-protocol"

  run relationNoCrashSuccessTest = initMode("valid")
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(notify(0, false))
    .expect(safety and outcome.get(0) == "ok" and calls.get(0) == 1)
  run normalSuccessTest = initMode("valid")
    .then(admit(0)).then(crash).then(recover).then(admit(0))
    .then(send(0)).then(respond(0, "ok")).then(commit(0)).then(notify(0, false))
    .expect(safety and generation == 1 and outcome.get(0) == "ok" and counts.get(0) == 2)
  run relationSentUnknownCrashTest = initMode("valid")
    .then(admit(0)).then(send(0)).then(crash).then(recover)
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(notify(0, false))
    .expect(safety and generation == 1 and outcome.get(0) == "ok" and counts.get(0) == 2)
  run relationReceivedUncommittedCrashTest = initMode("valid")
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(crash)
    .then(recover).then(admit(0)).then(send(0)).then(respond(0, "ok"))
    .then(commit(0)).then(notify(0, false))
    .expect(safety and generation == 1 and outcome.get(0) == "ok" and counts.get(0) == 2)
  run relationCommittedBeforeNotifyCrashTest = initMode("valid")
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(crash).then(recover).then(stutter)
    .expect(safety and generation == 1 and phase.get(0) == "done" and relations.get(0) == 1 and calls.get(0) == 1)
  run relationExhaustedReservationCrashTest = initMode("valid")
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(crash).then(recover).then(stutter)
    .expect(safety and generation == 1 and counts.get(0) == 3 and calls.get(0) == 2 and outcome.get(0) == "failed")
  run relationExhaustedSentCrashTest = initMode("valid")
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(crash).then(recover)
    .then(stutter)
    .expect(safety and generation == 1 and counts.get(0) == 3 and calls.get(0) == 3 and outcome.get(0) == "failed")
  run relationPostRecoveryCommitFailureTest = initMode("valid")
    .then(admit(0)).then(send(0)).then(crash).then(recover)
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(commitFail(0))
    .expect(safety and generation == 1 and calls.get(0) == 2 and outcome.get(0) == "failed")
}
module relation_multi_cap1_witnesses {
  import relation_protocol(ACTORS = Set(0, 1, 2), CAP = 1, SCRIPTED = true, MAX_CRASHES = 1, MUTATION = "none").* from "./relation-protocol"

  run relationCap1RetainedCommittedTest = initMode("valid")
    .then(admit(0)).then(send(0)).then(respond(0, "protocol")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(notify(0, false)).then(admit(2)).then(send(2)).then(respond(2, "filtered"))
    .then(crash).then(recover).then(admit(2)).then(send(2))
    .then(respond(2, "filtered")).then(commit(2)).then(notify(2, false)).then(admit(1))
    .then(send(1)).then(respond(1, "transient")).then(advanceTime).then(admit(1))
    .then(send(1)).then(respond(1, "empty")).then(commit(1)).then(notify(1, false))
    .expect(safety and generation == 1 and allTerminal and relations.get(0) == 1 and calls.get(0) == 2 and calls.get(2) == 2)
}
module relation_multi_cap2_witnesses {
  import relation_protocol(ACTORS = Set(0, 1, 2), CAP = 2, SCRIPTED = true, MAX_CRASHES = 1, MUTATION = "none").* from "./relation-protocol"

  run relationGlobalTwoInflightCrashTest = initMode("valid")
    .then(admit(0)).then(admit(1)).then(send(0)).then(send(1))
    .then(crash).then(recover).then(admit(0)).then(admit(1))
    .then(send(0)).then(send(1)).then(respond(0, "ok")).then(respond(1, "empty"))
    .then(commit(0)).then(notify(0, false)).then(commit(1)).then(notify(1, false))
    .then(admit(2)).then(send(2)).then(respond(2, "filtered")).then(commit(2))
    .then(notify(2, false))
    .expect(safety and generation == 1 and allTerminal and calls == Map(0 -> 2, 1 -> 2, 2 -> 1))
  run relationGlobalReservedAndCommittedCrashTest = initMode("valid")
    .then(admit(0)).then(send(0)).then(respond(0, "protocol")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(admit(1))
    .then(commit(0)).then(crash).then(recover).then(admit(1))
    .then(send(1)).then(respond(1, "empty")).then(commit(1)).then(notify(1, false))
    .then(admit(2)).then(send(2)).then(respond(2, "filtered")).then(commit(2))
    .then(notify(2, false))
    .expect(safety and generation == 1 and allTerminal and relations.get(0) == 1 and calls.get(0) == 2 and counts.get(1) == 2 and calls.get(1) == 1)
}
module knowledge_single_witnesses {
  import knowledge_protocol(PARTS = Set(0), MAX_CRASHES = 1, MUTATION = "none").* from "./knowledge-protocol"

  run knowledgeReservedCrashTest = init
    .then(admit(0)).then(crash).then(recover).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(notify(0, false))
    .expect(safety and generation == 1 and outcome == "ok" and initial_requests.get(0) == 2 and extra_requests == 1)
  run knowledgeSentUnknownCrashTest = init
    .then(admit(0)).then(send(0)).then(crash).then(recover)
    .then(advanceTime).then(admit(0)).then(send(0)).then(respond(0, "ok"))
    .then(commit(0)).then(notify(0, false))
    .expect(safety and generation == 1 and outcome == "ok" and initial_requests.get(0) == 2 and extra_requests == 1)
  run knowledgeReceivedUncommittedCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(crash)
    .then(recover).then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "ok")).then(commit(0)).then(notify(0, false))
    .expect(safety and generation == 1 and outcome == "ok" and initial_requests.get(0) == 2 and extra_requests == 1)
  run knowledgeCommittedBeforeNotifyCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(crash).then(recover).then(advanceTime).then(settle)
    .expect(safety and generation == 1 and outcome == "ok" and accepted.get(0) == Set(0) and extract_calls.get(0) == 1)
  run knowledgeRepairReservedCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial")).then(commit(0))
    .then(notify(0, false)).then(advanceTime).then(admit(0)).then(crash)
    .then(recover).then(advanceTime).then(settle)
    .expect(safety and generation == 1 and outcome == "partial" and repair_reserved.get(0) == 1 and accepted.get(0) == Set(0) and unresolved.get(0) == Set(1))
  run knowledgeRepairSentUnknownCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial")).then(commit(0))
    .then(notify(0, false)).then(advanceTime).then(admit(0)).then(send(0))
    .then(crash).then(recover).then(advanceTime).then(settle)
    .expect(safety and generation == 1 and outcome == "partial" and repair_reserved.get(0) == 1 and accepted.get(0) == Set(0) and unresolved.get(0) == Set(1))
  run knowledgeRepairReceivedUncommittedCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial")).then(commit(0))
    .then(notify(0, false)).then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "ok")).then(crash).then(recover).then(advanceTime)
    .then(settle)
    .expect(safety and generation == 1 and outcome == "partial" and repair_reserved.get(0) == 1 and accepted.get(0) == Set(0) and unresolved.get(0) == Set(1))
  run knowledgeRepairCommittedCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial")).then(commit(0))
    .then(notify(0, false)).then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "ok")).then(commit(0)).then(crash).then(recover)
    .then(advanceTime).then(settle)
    .expect(safety and generation == 1 and outcome == "ok" and repair_calls.get(0) == 1 and accepted.get(0) == Set(0, 1))
  run knowledgeExhaustedReservedCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(crash).then(recover).then(advanceTime)
    .then(settleExhausted(0))
    .expect(safety and generation == 1 and outcome == "invalid" and initial_requests.get(0) == 3 and extra_requests == 2)
  run knowledgeExhaustedSentCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(crash).then(recover)
    .then(advanceTime).then(settleExhausted(0))
    .expect(safety and generation == 1 and outcome == "invalid" and initial_requests.get(0) == 3 and extra_requests == 2)
  run knowledgeExhaustedReceivedCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(crash)
    .then(recover).then(advanceTime).then(settleExhausted(0))
    .expect(safety and generation == 1 and outcome == "invalid" and initial_requests.get(0) == 3 and extra_requests == 2)
  run knowledgeProtocolBudgetCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "protocol")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(crash).then(recover)
    .then(advanceTime).then(settleExhausted(0))
    .expect(safety and generation == 1 and outcome == "invalid" and protocol_retries == 1 and extra_requests == 1)
  run knowledgePostRecoveryCommitFailureTest = init
    .then(admit(0)).then(send(0)).then(crash).then(recover)
    .then(advanceTime).then(admit(0)).then(send(0)).then(respond(0, "ok"))
    .then(commitFail(0))
    .expect(safety and generation == 1 and outcome == "invalid" and extract_calls.get(0) == 2)
  run knowledgePostRecoveryNotifyFailureTest = init
    .then(admit(0)).then(crash).then(recover).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(notify(0, true))
    .expect(safety and generation == 1 and outcome == "ok" and accepted.get(0) == Set(0))
}
module knowledge_two_parts_witnesses {
  import knowledge_protocol(PARTS = Set(0, 1), MAX_CRASHES = 1, MUTATION = "none").* from "./knowledge-protocol"

  run knowledgeRetainedFirstPartCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(notify(0, false)).then(advanceTime).then(admit(1)).then(send(1))
    .then(respond(1, "partial")).then(crash).then(recover).then(advanceTime)
    .then(admit(1)).then(send(1)).then(respond(1, "partial")).then(commit(1))
    .then(notify(1, false)).then(advanceTime).then(admit(1)).then(send(1))
    .then(respond(1, "ok")).then(commit(1)).then(notify(1, false))
    .expect(safety and generation == 1 and outcome == "ok" and accepted.get(0) == Set(0) and accepted.get(1) == Set(0, 1) and extract_calls == Map(0 -> 1, 1 -> 2))
  run knowledgeRepairInterruptedNextPartTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial")).then(commit(0))
    .then(notify(0, false)).then(advanceTime).then(admit(0)).then(send(0))
    .then(crash).then(recover).then(advanceTime).then(admit(1))
    .then(send(1)).then(respond(1, "ok")).then(commit(1)).then(notify(1, false))
    .expect(safety and generation == 1 and outcome == "partial" and accepted.get(0) == Set(0) and accepted.get(1) == Set(0) and repair_calls.get(0) == 1)
  run knowledgeExhaustedNextPartTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(respond(0, "transient")).then(advanceTime)
    .then(admit(0)).then(send(0)).then(crash).then(recover)
    .then(advanceTime).then(settleExhausted(0)).then(advanceTime).then(admit(1))
    .then(send(1)).then(respond(1, "ok")).then(commit(1)).then(notify(1, false))
    .expect(safety and generation == 1 and outcome == "partial" and extra_requests == 2 and extract_calls == Map(0 -> 3, 1 -> 1))
  run knowledgeCommittedFirstPartCrashTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(crash).then(recover).then(advanceTime).then(admit(1))
    .then(send(1)).then(respond(1, "ok")).then(commit(1)).then(notify(1, false))
    .expect(safety and generation == 1 and outcome == "ok" and extract_calls == Map(0 -> 1, 1 -> 1) and accepted.get(0) == Set(0))
}
