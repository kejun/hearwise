// Successful Quint tests export real ITF traces from the checked transition actions.
module single_witnesses {
  import protocol(PARTS = Set(0), MUTATION = "none").* from "./protocol"

  run normalSuccessTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok"))
    .then(commit(0))
    .expect(safety and outcome == "ok" and accepted.get(0) == Set(0))
  run emptyResultTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "empty"))
    .then(commit(0))
    .expect(safety and outcome == "empty" and repair_calls.get(0) == 0)
  run partialRepairSuccessTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "ok")).then(commit(0))
    .expect(safety and outcome == "ok" and accepted.get(0) == Set(0, 1) and extra_requests == 0)
  run allRejectedRepairSuccessTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "rejected"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "ok")).then(commit(0))
    .expect(safety and outcome == "ok" and accepted.get(0) == Set(0))
  run partialRepairEmptyTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "empty")).then(commit(0))
    .expect(safety and outcome == "partial" and accepted.get(0) == Set(0) and unresolved.get(0) == Set(1))
  run allRejectedRepairEmptyTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "rejected"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "empty")).then(commit(0))
    .expect(safety and outcome == "invalid" and accepted.get(0) == emptySlots)
  run partialRepairErrorTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "transient"))
    .expect(safety and outcome == "partial" and repair_calls.get(0) == 1 and extract_calls.get(0) == 1)
  run unrepairableTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "unrepairable"))
    .then(commit(0))
    .expect(safety and outcome == "invalid" and repair_calls.get(0) == 0 and unresolved.get(0) == Set(0))
  run initialReserveFailureTest = init
    .then(reserveFail(0))
    .expect(safety and outcome == "invalid" and initial_requests.get(0) == 0 and extract_calls.get(0) == 0)
  run repairReserveFailureTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(reserveFail(0))
    .expect(safety and outcome == "partial" and repair_reserved.get(0) == 0 and repair_calls.get(0) == 0)
  run initialCommitFailureTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok"))
    .then(commitFail(0))
    .expect(safety and outcome == "invalid" and phase.get(0) == "extract_inflight" and extract_calls.get(0) == 1)
  run repairCommitFailureTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "ok")).then(commitFail(0))
    .expect(safety and outcome == "partial" and phase.get(0) == "repair_inflight" and accepted.get(0) == Set(0))
  run initialNotifyFailureTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok"))
    .then(commitNotifyFailure(0))
    .expect(safety and outcome == "ok" and accepted.get(0) == Set(0))
  run repairNotifyFailureTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "ok")).then(commitNotifyFailure(0))
    .expect(safety and outcome == "ok" and accepted.get(0) == Set(0, 1))
  run rejectedNotifyFailureTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commitNotifyFailure(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "empty")).then(commitNotifyFailure(0))
    .expect(safety and outcome == "partial" and accepted.get(0) == Set(0))
  run protocolLimitTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "protocol"))
    .then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "protocol"))
    .expect(safety and outcome == "invalid" and extra_requests == 1 and protocol_retries == 1 and extract_calls.get(0) == 2)
  run transientLimitTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "transient"))
    .then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "transient")).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "transient"))
    .expect(safety and outcome == "invalid" and extra_requests == 2 and protocol_retries == 0 and extract_calls.get(0) == 3)
  run mixedProtocolThenTransientTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "protocol"))
    .then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "transient")).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "ok")).then(commit(0))
    .expect(safety and outcome == "ok" and extra_requests == 2 and protocol_retries == 1)
  run mixedTransientThenProtocolTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "transient"))
    .then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "protocol")).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "ok")).then(commit(0))
    .expect(safety and outcome == "ok" and extra_requests == 2 and protocol_retries == 1)
  run protocolThenSuccessTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "protocol"))
    .then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "ok")).then(commit(0))
    .expect(safety and outcome == "ok" and extra_requests == 1 and protocol_retries == 1)
  run transientThenSuccessTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "transient"))
    .then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "ok")).then(commit(0))
    .expect(safety and outcome == "ok" and extra_requests == 1 and protocol_retries == 0)
  run authTerminalTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "auth"))
    .expect(safety and outcome == "invalid" and extract_calls.get(0) == 1)
  run rateLimitThenSuccessTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "rate_limit"))
    .then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "ok")).then(commit(0))
    .expect(safety and outcome == "ok" and extra_requests == 1)
  run retryAfterOverLimitTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "rate_limit_long"))
    .expect(safety and outcome == "invalid" and extra_requests == 0 and extract_calls.get(0) == 1)
  run unexpectedTerminalTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "unexpected"))
    .expect(safety and outcome == "invalid" and extract_calls.get(0) == 1)
  run repairRateLimitTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "rate_limit"))
    .expect(safety and outcome == "partial" and repair_calls.get(0) == 1 and extra_requests == 0)
  run repairProtocolErrorTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "rejected"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "protocol"))
    .expect(safety and outcome == "invalid" and repair_calls.get(0) == 1 and protocol_retries == 0)
  run repairLongRetryAfterTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "rate_limit_long"))
    .expect(safety and outcome == "partial" and repair_calls.get(0) == 1 and extra_requests == 0)
}
module two_parts_witnesses {
  import protocol(PARTS = Set(0, 1), MUTATION = "none").* from "./protocol"

  run sequentialPartsIntervalTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok"))
    .then(commit(0)).then(advanceTime).then(admit(1))
    .then(send(1)).then(respond(1, "ok")).then(commit(1))
    .expect(safety and outcome == "ok" and extract_calls == Map(0 -> 1, 1 -> 1))
  run sharedExtraBudgetTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "transient"))
    .then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "transient")).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(advanceTime).then(admit(1)).then(send(1))
    .then(respond(1, "transient"))
    .expect(safety and outcome == "partial" and extra_requests == 2 and extract_calls == Map(0 -> 3, 1 -> 1))
  run sharedProtocolBudgetTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "protocol"))
    .then(advanceTime).then(admit(0)).then(send(0))
    .then(respond(0, "ok")).then(commit(0)).then(advanceTime)
    .then(admit(1)).then(send(1)).then(respond(1, "protocol"))
    .expect(safety and outcome == "partial" and extra_requests == 1 and protocol_retries == 1 and extract_calls == Map(0 -> 2, 1 -> 1))
  run independentRepairBudgetTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "ok")).then(commit(0))
    .then(advanceTime).then(admit(1)).then(send(1))
    .then(respond(1, "partial")).then(commit(1)).then(advanceTime)
    .then(admit(1)).then(send(1)).then(respond(1, "ok"))
    .then(commit(1))
    .expect(safety and outcome == "ok" and repair_reserved == Map(0 -> 1, 1 -> 1) and repair_calls == Map(0 -> 1, 1 -> 1) and extra_requests == 0)
  run retainedFirstPartTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok"))
    .then(commit(0)).then(advanceTime).then(admit(1))
    .then(send(1)).then(respond(1, "partial")).then(commit(1))
    .then(advanceTime).then(admit(1)).then(send(1))
    .then(respond(1, "empty")).then(commit(1))
    .expect(safety and outcome == "partial" and accepted.get(0) == Set(0) and apply_counts.get(0) == 1 and accepted.get(1) == Set(0))
  run authAfterAcceptedTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok"))
    .then(commit(0)).then(advanceTime).then(admit(1))
    .then(send(1)).then(respond(1, "auth"))
    .expect(safety and outcome == "partial" and accepted.get(0) == Set(0))
  run authStopsRemainingTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "auth"))
    .expect(safety and outcome == "invalid" and phase.get(1) == "done" and extract_calls.get(1) == 0)
  run repairRateLimitNextPartTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "rate_limit")).then(advanceTime)
    .then(admit(1)).then(send(1)).then(respond(1, "ok"))
    .then(commit(1))
    .expect(safety and outcome == "partial" and extract_calls.get(1) == 1 and extra_requests == 0)
  run repairLongCooldownNextPartTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "partial"))
    .then(commit(0)).then(advanceTime).then(admit(0))
    .then(send(0)).then(respond(0, "rate_limit_long")).then(advanceTime)
    .then(admit(1)).then(send(1)).then(respond(1, "ok"))
    .then(commit(1))
    .expect(safety and outcome == "partial" and extract_calls.get(1) == 1 and extra_requests == 0)
  run initialFailureThenNextTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "unexpected"))
    .then(advanceTime).then(admit(1)).then(send(1))
    .then(respond(1, "ok")).then(commit(1))
    .expect(safety and outcome == "partial" and accepted.get(1) == Set(0))
  run secondPartCommitFailureTest = init
    .then(admit(0)).then(send(0)).then(respond(0, "ok"))
    .then(commit(0)).then(advanceTime).then(admit(1))
    .then(send(1)).then(respond(1, "ok")).then(commitFail(1))
    .expect(safety and outcome == "partial" and accepted.get(0) == Set(0) and accepted.get(1) == emptySlots)
}
