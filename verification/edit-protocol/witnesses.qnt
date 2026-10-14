module current_witnesses {
  import edit_protocol(CLIENTS = Set(0, 1), CODECS = Map(0 -> "v1", 1 -> "v1"),
    INITIAL_OVERRIDE = false, BACKGROUND = true, MUTATION = "none").* from "./protocol"
  run successTest = init.then(read(0)).then(edit(0, "new")).then(send(0))
    .then(transaction(0, "ok")).then(notify(0, "ok")).then(deliver(0)).then(refreshSaved(0))
    .expect(safety and state.name == 1 and state.receipt.get(0) == "succeeded")
  run noOpTest = init.then(read(0)).then(edit(0, "same")).then(send(0))
    .then(transaction(0, "ok")).then(deliver(0)).then(refreshSaved(0))
    .expect(safety and state.revision == 0 and state.notification.get(0) == "skipped" and state.receipt.get(0) == "succeeded")
  run sameRevisionConflictTest = init.then(read(0)).then(read(1)).then(edit(0, "new")).then(edit(1, "new"))
    .then(send(0)).then(send(1)).then(transaction(0, "ok")).then(notify(0, "ok"))
    .then(transaction(1, "ok")).then(deliver(1)).then(refreshStale(1)).then(deliver(0)).then(refreshSaved(0))
    .expect(safety and state.name == 1 and state.phase.get(1) == "conflict" and state.draft.get(1) == 2 and state.requests.get(1) == 1)
  run backgroundConflictTest = init.then(read(0)).then(edit(0, "new")).then(send(0)).then(backgroundChange)
    .then(transaction(0, "ok")).then(deliver(0)).then(refreshStale(0))
    .expect(safety and state.name == 0 and state.phase.get(0) == "conflict" and state.requests.get(0) == 1)
  run rollbackTest = init.then(read(0)).then(edit(0, "new")).then(send(0)).then(transaction(0, "rollback"))
    .then(deliver(0)).then(close(0)).then(reopen(0))
    .expect(safety and state.revision == 0 and state.receipt.get(0) == "none" and state.draft.get(0) == 0)
  run cancelledDraftTest = init.then(read(0)).then(edit(0, "new")).then(close(0)).then(reopen(0))
    .expect(safety and state.revision == 0 and state.requests.get(0) == 0 and state.draft.get(0) == 0 and state.name == 0 and state.receipt.get(0) == "none")
  run notificationFailureTest = init.then(read(0)).then(edit(0, "new")).then(send(0)).then(transaction(0, "ok"))
    .then(notify(0, "fail")).then(deliver(0)).then(refreshSaved(0))
    .expect(safety and state.notification.get(0) == "fail" and state.reply.get(0) == "ok" and state.receipt.get(0) == "succeeded")
  run lostResponseReceiptRecoveryTest = init.then(read(0)).then(edit(0, "new")).then(send(0)).then(transaction(0, "ok"))
    .then(notify(0, "ok")).then(loseResponse(0, "lost")).then(lookup(0, "ok")).then(refreshSaved(0))
    .expect(safety and state.reply.get(0) == "ok" and state.requests.get(0) == 1 and state.name == 1)
  run proxy502UnknownReopenTest = init.then(read(0)).then(edit(0, "new")).then(send(0)).then(transaction(0, "ok"))
    .then(notify(0, "ok")).then(loseResponse(0, "proxy502")).then(lookup(0, "unavailable"))
    .expect(safety and state.phase.get(0) == "unknown" and state.draft.get(0) == 1)
    .then(close(0)).then(reopen(0)).expect(safety and state.loadedName.get(0) == 1 and state.requests.get(0) == 1)
  run failedUnknownReopenTest = init.then(read(0)).then(edit(0, "new")).then(send(0)).then(transaction(0, "rollback"))
    .then(loseResponse(0, "proxy502")).then(lookup(0, "ok")).then(close(0)).then(reopen(0))
    .expect(safety and state.name == 0 and state.receipt.get(0) == "none" and state.draft.get(0) == 0)
  run lateSuccessReadsLatestTest = init.then(read(0)).then(edit(0, "new")).then(send(0)).then(transaction(0, "ok")).then(notify(0, "ok"))
    .then(read(1)).then(edit(1, "new")).then(send(1)).then(transaction(1, "ok")).then(notify(1, "ok"))
    .then(deliver(1)).then(refreshSaved(1)).then(deliver(0)).then(refreshSaved(0))
    .expect(safety and state.name == 2 and state.loadedName.get(0) == 2 and state.loadedRevision.get(0) == 2)
}
module legacy_witnesses {
  import edit_protocol(CLIENTS = Set(0, 1), CODECS = Map(0 -> "v11", 1 -> "v12"),
    INITIAL_OVERRIDE = false, BACKGROUND = true, MUTATION = "none").* from "./protocol"
  run legacyConcurrentConflictTest = init.then(read(0)).then(read(1)).then(edit(0, "new")).then(edit(1, "new"))
    .then(send(0)).then(send(1)).then(transaction(0, "ok")).then(notify(0, "ok"))
    .then(transaction(1, "ok")).then(deliver(1)).then(refreshStale(1))
    .expect(safety and state.txResult.get(0) == "committed" and state.txResult.get(1) == "conflict")
  run legacyV12SuccessTest = init.then(read(1)).then(edit(1, "new")).then(send(1)).then(transaction(1, "ok"))
    .then(notify(1, "ok")).then(deliver(1)).then(refreshSaved(1))
    .expect(safety and state.name == 2 and state.receipt.get(1) == "succeeded")
}
module override_witnesses {
  import edit_protocol(CLIENTS = Set(0), CODECS = Map(0 -> "v11"),
    INITIAL_OVERRIDE = true, BACKGROUND = true, MUTATION = "none").* from "./protocol"
  run legacyV11OverrideRejectedTest = init.then(read(0)).then(edit(0, "new")).then(send(0)).then(transaction(0, "ok"))
    .then(deliver(0)).then(refreshStale(0))
    .expect(safety and state.phase.get(0) == "conflict" and state.revision == 0 and state.override)
}
