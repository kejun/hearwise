// KEJ-71. Request slots are bounded explicit attempts, not asynchronous SQLite
// steps. Receipt lookup precedes current-revision and source-anchor validation.
// Raw input names remain distinct even when trimming yields the same target.
module name_protocol {
  const MODE: str
  const MUTATION: str
  pure val ATTEMPTS = Set(0, 1)
  pure val OPS = Set(0, 1)
  pure val names = Map(0 -> "Deebo", 1 -> "Tibo", 2 -> "Mira")
  pure val paddedNames = Map(0 -> " Deebo ", 1 -> " Tibo ", 2 -> " Mira ")
  type State = {
    revision: int, name: int, sourceName: int, associatedName: int, evidenceName: int,
    changes: int, sourceVersion: int, associatedVersion: int, evidenceVersion: int,
    anchorValid: bool, background: str, stalePreserved: bool, scopePreserved: bool, identitiesPreserved: bool,
    phase: int -> str, rawName: int -> str, submittedRevision: int -> int, submittedName: int -> int,
    operationId: int -> int, requests: int -> int, txResult: int -> str, reply: int -> str,
    commitBaseRevision: int -> int, commitBaseAnchorValid: int -> bool,
    loadedRevision: int -> int, loadedName: int -> int,
    receipt: int -> str, receiptRawName: int -> str, receiptInputRevision: int -> int,
    receiptCommitRevision: int -> int, receiptOwner: int -> int, commits: int -> int
  }
  var state: State
  var lastAction: str
  var actor: int
  var argument: str
  action mark(label, a, value) = all { lastAction' = label, actor' = a, argument' = value }
  def validActor(a) = ATTEMPTS.contains(a)
  def hasReceipt(a) = state.receipt.get(state.operationId.get(a)) == "succeeded"
  def exact(a) = state.receiptRawName.get(state.operationId.get(a)) == state.rawName.get(a) and
    state.receiptInputRevision.get(state.operationId.get(a)) == state.submittedRevision.get(a)

  action init = all {
    lastAction' = "init", actor' = -1, argument' = "",
    state' = { revision: 0, name: 0, sourceName: 0, associatedName: 0, evidenceName: 0,
      changes: 0, sourceVersion: 0, associatedVersion: 0, evidenceVersion: 0,
      anchorValid: true, background: "none", stalePreserved: true, scopePreserved: true, identitiesPreserved: true,
      phase: ATTEMPTS.mapBy(_ => "unused"), rawName: ATTEMPTS.mapBy(_ => ""),
      submittedRevision: ATTEMPTS.mapBy(_ => -1), submittedName: ATTEMPTS.mapBy(_ => -1),
      operationId: ATTEMPTS.mapBy(a => a), requests: ATTEMPTS.mapBy(_ => 0),
      txResult: ATTEMPTS.mapBy(_ => "none"), reply: ATTEMPTS.mapBy(_ => "none"),
      commitBaseRevision: ATTEMPTS.mapBy(_ => -1), commitBaseAnchorValid: ATTEMPTS.mapBy(_ => true),
      loadedRevision: ATTEMPTS.mapBy(_ => -1), loadedName: ATTEMPTS.mapBy(_ => -1),
      receipt: OPS.mapBy(_ => "none"), receiptRawName: OPS.mapBy(_ => ""),
      receiptInputRevision: OPS.mapBy(_ => -1), receiptCommitRevision: OPS.mapBy(_ => -1),
      receiptOwner: OPS.mapBy(_ => -1), commits: OPS.mapBy(_ => 0) }
  }
  // An explicit caller freezes a body before network dispatch. A retry copies the
  // exact original body/ID; it does not silently adopt a fresher revision.
  action prepare(a, choice) = {
    val reuse = Set("exact", "raw_mismatch", "revision_mismatch").contains(choice)
    val target = if (reuse) state.submittedName.get(0) else if (choice == "same") state.name else a + 1
    val bodyName = if (reuse) (if (choice == "raw_mismatch") paddedNames.get(target) else state.rawName.get(0)) else names.get(target)
    all {
      validActor(a), state.phase.get(a) == "unused",
      if (a == 0 or MODE == "independent") Set("new", "same").contains(choice)
      else reuse and state.requests.get(0) == 1,
      choice != "revision_mismatch" or state.revision != state.submittedRevision.get(0),
      mark("prepare", a, choice),
      state' = { ...state, phase: state.phase.set(a, "prepared"),
        rawName: state.rawName.set(a, bodyName), submittedName: state.submittedName.set(a, target),
        submittedRevision: state.submittedRevision.set(a, if (reuse and choice != "revision_mismatch") state.submittedRevision.get(0) else state.revision),
        operationId: state.operationId.set(a, if (reuse) 0 else a),
        loadedRevision: state.loadedRevision.set(a, state.revision), loadedName: state.loadedName.set(a, state.name) }
    }
  }
  action cancel(a) = all {
    validActor(a), state.phase.get(a) == "prepared", mark("cancel", a, ""),
    state' = { ...state, phase: state.phase.set(a, "cancelled") }
  }
  action send(a) = all {
    validActor(a), state.phase.get(a) == "prepared", mark("send", a, ""),
    state' = { ...state, phase: state.phase.set(a, "pending"), requests: state.requests.set(a, 1) }
  }
  // No action is allowed between the receipt check, revision/anchor rechecks,
  // associated writes and successful receipt COMMIT. Fault labels identify
  // real synchronous write boundaries, not invented await/interleaving points.
  action transaction(a, fault) = {
    val op = state.operationId.get(a)
    val duplicate = hasReceipt(a)
    val fingerprintOk = exact(a) or MUTATION == "ignore_fingerprint"
    val revisionOk = state.submittedRevision.get(a) == state.revision or MUTATION == "bypass_revision"
    val modified = state.submittedName.get(a) != state.name
    val anchorOk = not(modified) or state.anchorValid or MUTATION == "bypass_anchor"
    val eligible = not(duplicate) and revisionOk and anchorOk
    val writeFault = fault == "receipt_fail" or (fault == "associated_fail" and modified)
    val commit = eligible and not(writeFault)
    val changed = commit and modified
    val result = if (duplicate) (if (fingerprintOk) "duplicate" else "fingerprint_conflict")
      else if (not(revisionOk)) "revision_conflict" else if (not(anchorOk)) "anchor_conflict"
      else if (commit) "committed" else "rolled_back"
    val badPartial = eligible and writeFault and MUTATION == "partial_rollback"
    val badReceipt = eligible and writeFault and MUTATION == "receipt_without_commit"
    all {
      validActor(a), state.phase.get(a) == "pending", state.txResult.get(a) == "none",
      Set("ok", "associated_fail", "receipt_fail").contains(fault), mark("transaction", a, fault),
      state' = { ...state,
        revision: state.revision + (if (changed) 1 else 0), name: if (changed) state.submittedName.get(a) else state.name,
        sourceName: if (changed) state.submittedName.get(a) else state.sourceName,
        associatedName: if (changed) state.submittedName.get(a) else state.associatedName,
        evidenceName: if (changed) state.submittedName.get(a) else state.evidenceName,
        changes: state.changes + (if (changed) 1 else 0),
        sourceVersion: state.sourceVersion + (if (changed or badPartial) 1 else 0),
        associatedVersion: state.associatedVersion + (if (changed) 1 else 0),
        evidenceVersion: state.evidenceVersion + (if (changed) 1 else 0),
        anchorValid: if (changed) true else state.anchorValid,
        commitBaseRevision: state.commitBaseRevision.set(a, state.revision),
        commitBaseAnchorValid: state.commitBaseAnchorValid.set(a, state.anchorValid or not(modified)),
        txResult: state.txResult.set(a, result),
        receipt: if (commit or badReceipt) state.receipt.set(op, "succeeded") else state.receipt,
        receiptRawName: if (commit or badReceipt) state.receiptRawName.set(op, state.rawName.get(a)) else state.receiptRawName,
        receiptInputRevision: if (commit or badReceipt) state.receiptInputRevision.set(op, state.submittedRevision.get(a)) else state.receiptInputRevision,
        receiptCommitRevision: if (commit or badReceipt) state.receiptCommitRevision.set(op, state.revision + (if (changed) 1 else 0)) else state.receiptCommitRevision,
        receiptOwner: if (commit or badReceipt) state.receiptOwner.set(op, a) else state.receiptOwner,
        commits: if (commit) state.commits.set(op, state.commits.get(op) + 1) else state.commits }
    }
  }
  action deliver(a) = all {
    validActor(a), state.phase.get(a) == "pending", state.txResult.get(a) != "none", mark("deliver", a, ""),
    state' = { ...state,
      phase: state.phase.set(a, if (Set("committed", "duplicate").contains(state.txResult.get(a))) "saved"
        else if (state.txResult.get(a) == "rolled_back") "failed" else "conflict"),
      reply: state.reply.set(a, if (Set("committed", "duplicate").contains(state.txResult.get(a))) "ok"
        else if (state.txResult.get(a) == "rolled_back") "failed" else "conflict") }
  }
  action loseResponse(a, reason) = all {
    validActor(a), state.phase.get(a) == "pending", state.txResult.get(a) != "none",
    Set("lost", "proxy502").contains(reason), mark("lose_response", a, reason),
    state' = { ...state, phase: state.phase.set(a, "recovering"), reply: state.reply.set(a, "unknown") }
  }
  action lookup(a, result) = all {
    validActor(a), state.phase.get(a) == "recovering", Set("ok", "unavailable").contains(result), mark("lookup", a, result),
    // GET is scoped by ID/item. It establishes the stored operation outcome,
    // not success of a deliberately mismatched retry body. The browser uses a
    // fresh UUID for each explicit save. "receipt" keeps this distinction.
    state' = { ...state, phase: state.phase.set(a, if (result == "ok" and hasReceipt(a)) "saved" else "unknown"),
      reply: state.reply.set(a, if (result == "ok" and hasReceipt(a)) "receipt" else "unknown") }
  }
  action refresh(a) = all {
    validActor(a), Set("saved", "unknown", "conflict", "failed", "cancelled").contains(state.phase.get(a)), mark("refresh", a, ""),
    state' = { ...state, phase: state.phase.set(a, "done"), loadedRevision: state.loadedRevision.set(a, state.revision), loadedName: state.loadedName.set(a, state.name) }
  }
  action backgroundChange(kind) = all {
    state.background == "none", Set("revision", "anchor").contains(kind), mark("background_change", -1, kind),
    state' = { ...state, background: kind,
      revision: state.revision + (if (kind == "revision") 1 else 0), anchorValid: kind != "anchor" }
  }
  action stutter = all { mark("stutter", -1, ""), state' = state }
  action step = any {
    { nondet a = ATTEMPTS.oneOf(); nondet choice = Set("new", "same", "exact", "raw_mismatch", "revision_mismatch").oneOf(); prepare(a, choice) },
    { nondet a = ATTEMPTS.oneOf(); send(a) },
    { nondet a = ATTEMPTS.oneOf(); cancel(a) },
    { nondet a = ATTEMPTS.oneOf(); nondet fault = Set("ok", "associated_fail", "receipt_fail").oneOf(); transaction(a, fault) },
    { nondet a = ATTEMPTS.oneOf(); deliver(a) },
    { nondet a = ATTEMPTS.oneOf(); nondet reason = Set("lost", "proxy502").oneOf(); loseResponse(a, reason) },
    { nondet a = ATTEMPTS.oneOf(); nondet result = Set("ok", "unavailable").oneOf(); lookup(a, result) },
    { nondet a = ATTEMPTS.oneOf(); refresh(a) },
    { nondet kind = Set("revision", "anchor").oneOf(); backgroundChange(kind) }, stutter
  }

  val finiteDomain = state.revision >= 0 and state.revision <= 3 and state.changes >= 0 and state.changes <= 2 and
    Set(0, 1, 2).contains(state.name) and ATTEMPTS.forall(a => state.requests.get(a) >= 0 and state.requests.get(a) <= 1 and
      state.submittedRevision.get(a) >= -1 and state.submittedRevision.get(a) <= state.revision and OPS.contains(state.operationId.get(a)))
  val exactReplay = ATTEMPTS.forall(a => state.txResult.get(a) != "duplicate" or exact(a))
  val revisionRechecked = ATTEMPTS.forall(a => state.txResult.get(a) != "committed" or state.submittedRevision.get(a) == state.commitBaseRevision.get(a))
  val anchorsRechecked = ATTEMPTS.forall(a => state.txResult.get(a) != "committed" or state.commitBaseAnchorValid.get(a))
  val associatedAtomic = state.sourceName == state.name and state.associatedName == state.name and state.evidenceName == state.name and
    state.sourceVersion == state.changes and state.associatedVersion == state.changes and state.evidenceVersion == state.changes and
    state.revision == state.changes + (if (state.background == "revision") 1 else 0)
  val receiptAtomic = OPS.forall(op => (state.receipt.get(op) == "succeeded") == (state.commits.get(op) == 1))
  val atMostOnce = OPS.forall(op => state.commits.get(op) >= 0 and state.commits.get(op) <= 1)
  val receiptImmutable = OPS.forall(op => state.receipt.get(op) == "none" or {
    val owner = state.receiptOwner.get(op)
    state.receiptRawName.get(op) == state.rawName.get(owner) and
    state.receiptInputRevision.get(op) == state.submittedRevision.get(owner)
  })
  val protectedRecords = state.stalePreserved and state.scopePreserved and state.identitiesPreserved
  val honestResponse = ATTEMPTS.forall(a => state.reply.get(a) != "ok" or (hasReceipt(a) and exact(a)))
  val readCurrent = lastAction != "refresh" or (state.loadedRevision.get(actor) == state.revision and state.loadedName.get(actor) == state.name)
  val cancelledUnsent = ATTEMPTS.forall(a => state.phase.get(a) != "cancelled" or state.requests.get(a) == 0)
  val safety = finiteDomain and exactReplay and revisionRechecked and anchorsRechecked and associatedAtomic and receiptAtomic and
    atMostOnce and receiptImmutable and protectedRecords and honestResponse and readCurrent and cancelledUnsent
}
