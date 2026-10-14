// KEJ-69: finite manual-name-edit protocol. No provider call is modeled.
// A synchronous SQLite transaction and its following synchronous notification
// are separate observations, but serverOwner forbids fictitious HTTP-handler
// interleavings between them. Network delivery remains independent.
module edit_protocol {
  const CLIENTS: Set[int]
  const CODECS: int -> str
  const INITIAL_OVERRIDE: bool
  const BACKGROUND: bool
  const MUTATION: str

  type State = {
    revision: int, name: int, override: bool, serverOwner: int, backgroundDone: bool,
    phase: int -> str, loadedRevision: int -> int, loadedName: int -> int,
    draft: int -> int, submittedRevision: int -> int, submittedName: int -> int,
    userSaves: int -> int, requests: int -> int, txResult: int -> str,
    receipt: int -> str, reply: int -> str, commitBaseRevision: int -> int,
    commitBaseOverride: int -> bool, notification: int -> str
  }
  var state: State
  var lastAction: str
  var actor: int
  var argument: str

  pure val phases = Set("closed", "loaded", "draft", "pending", "conflict", "failed", "recovering", "unknown", "saved", "done")
  pure val closable = Set("loaded", "draft", "conflict", "failed", "unknown", "done")
  pure val names = Set(0, 1, 2)
  pure val codecs = Set("v1", "v11", "v12")
  def available(a) = CLIENTS.contains(a)
  def compatible(a) = state.submittedRevision.get(a) == state.revision and
    (CODECS.get(a) != "v11" or not(state.override))
  def changed(a) = state.submittedName.get(a) != state.name or state.override
  action mark(label, a, value) = all { lastAction' = label, actor' = a, argument' = value }

  action init = all {
    lastAction' = "init", actor' = -1, argument' = "",
    state' = { revision: 0, name: 0, override: INITIAL_OVERRIDE, serverOwner: -1, backgroundDone: false,
      phase: CLIENTS.mapBy(_ => "closed"), loadedRevision: CLIENTS.mapBy(_ => -1),
      loadedName: CLIENTS.mapBy(_ => -1), draft: CLIENTS.mapBy(_ => -1),
      submittedRevision: CLIENTS.mapBy(_ => -1), submittedName: CLIENTS.mapBy(_ => -1),
      userSaves: CLIENTS.mapBy(_ => 0), requests: CLIENTS.mapBy(_ => 0),
      txResult: CLIENTS.mapBy(_ => "none"), receipt: CLIENTS.mapBy(_ => "none"),
      reply: CLIENTS.mapBy(_ => "none"), commitBaseRevision: CLIENTS.mapBy(_ => -1),
      commitBaseOverride: CLIENTS.mapBy(_ => false), notification: CLIENTS.mapBy(_ => "none") }
  }
  action read(a) = all {
    available(a), state.phase.get(a) == "closed", state.serverOwner == -1,
    mark("read", a, ""),
    state' = { ...state, phase: state.phase.set(a, "loaded"),
      loadedRevision: state.loadedRevision.set(a, state.revision),
      loadedName: state.loadedName.set(a, state.name), draft: state.draft.set(a, state.name) }
  }
  action edit(a, choice) = all {
    available(a), state.phase.get(a) == "loaded", Set("new", "same").contains(choice),
    mark("edit", a, choice),
    state' = { ...state, phase: state.phase.set(a, "draft"),
      draft: state.draft.set(a, if (choice == "same") state.loadedName.get(a) else a + 1) }
  }
  action send(a) = all {
    available(a), state.phase.get(a) == "draft", state.userSaves.get(a) == 0,
    mark("send", a, ""),
    state' = { ...state, phase: state.phase.set(a, "pending"),
      submittedRevision: state.submittedRevision.set(a, state.loadedRevision.get(a)),
      submittedName: state.submittedName.set(a, state.draft.get(a)),
      userSaves: state.userSaves.set(a, 1), requests: state.requests.set(a, state.requests.get(a) + 1) }
  }
  action transaction(a, fault) = {
    val allowed = compatible(a) or MUTATION == "bypass_revision"
    val commit = allowed and fault == "ok"
    val modified = commit and changed(a)
    all {
      available(a), state.phase.get(a) == "pending", state.txResult.get(a) == "none",
      state.serverOwner == -1, Set("ok", "rollback").contains(fault),
      mark("transaction", a, fault),
      state' = { ...state,
        revision: state.revision + (if (modified) 1 else 0),
        name: if (commit) state.submittedName.get(a) else state.name,
        override: if (commit) false else state.override,
        serverOwner: if (modified) a else -1,
        commitBaseRevision: state.commitBaseRevision.set(a, state.revision),
        commitBaseOverride: state.commitBaseOverride.set(a, state.override),
        txResult: state.txResult.set(a, if (commit) "committed" else if (allowed) "rolled_back" else "conflict"),
        receipt: state.receipt.set(a, if (commit) "succeeded" else "none"),
        notification: state.notification.set(a, if (modified) "none" else "skipped") }
    }
  }
  action notify(a, result) = all {
    available(a), state.serverOwner == a, state.txResult.get(a) == "committed",
    Set("ok", "fail").contains(result), mark("notify", a, result),
    state' = { ...state, serverOwner: -1, notification: state.notification.set(a, result) }
  }
  action deliver(a) = all {
    available(a), state.phase.get(a) == "pending", state.txResult.get(a) != "none",
    state.serverOwner != a, mark("deliver", a, ""),
    state' = { ...state,
      phase: state.phase.set(a, if (state.txResult.get(a) == "committed") "saved"
        else if (state.txResult.get(a) == "conflict") "conflict" else "failed"),
      reply: state.reply.set(a, if (state.txResult.get(a) == "committed") "ok"
        else if (state.txResult.get(a) == "conflict") "conflict" else "failed") }
  }
  action loseResponse(a, transport) = all {
    available(a), state.phase.get(a) == "pending", state.txResult.get(a) != "none",
    state.serverOwner != a, Set("lost", "proxy502").contains(transport), mark("lose_response", a, transport),
    state' = { ...state, phase: state.phase.set(a, "recovering"), reply: state.reply.set(a, "unknown") }
  }
  action lookup(a, result) = all {
    available(a), state.phase.get(a) == "recovering", state.serverOwner == -1,
    Set("ok", "unavailable").contains(result), mark("lookup", a, result),
    state' = { ...state,
      phase: state.phase.set(a, if (result == "ok" and state.receipt.get(a) == "succeeded") "saved" else "unknown"),
      reply: state.reply.set(a, if (result == "ok" and state.receipt.get(a) == "succeeded") "ok" else "unknown") }
  }
  action refreshStale(a) = all {
    available(a), state.phase.get(a) == "conflict", state.serverOwner == -1,
    mark("refresh_stale", a, ""),
    state' = { ...state, loadedRevision: state.loadedRevision.set(a, state.revision),
      loadedName: state.loadedName.set(a, state.name) }
  }
  action refreshSaved(a) = all {
    available(a), state.phase.get(a) == "saved", state.serverOwner == -1,
    mark("refresh_saved", a, ""),
    state' = { ...state, phase: state.phase.set(a, "done"),
      loadedRevision: state.loadedRevision.set(a, state.revision), loadedName: state.loadedName.set(a, state.name) }
  }
  action close(a) = all {
    available(a), closable.contains(state.phase.get(a)), mark("close", a, ""),
    state' = { ...state, phase: state.phase.set(a, "closed") }
  }
  action reopen(a) = all {
    available(a), state.phase.get(a) == "closed", state.serverOwner == -1,
    mark("reopen", a, ""),
    state' = { ...state, phase: state.phase.set(a, "loaded"),
      loadedRevision: state.loadedRevision.set(a, state.revision), loadedName: state.loadedName.set(a, state.name),
      draft: state.draft.set(a, state.name) }
  }
  action backgroundChange = all {
    BACKGROUND, not(state.backgroundDone), state.serverOwner == -1, mark("background_change", -1, ""),
    state' = { ...state, backgroundDone: true, revision: state.revision + 1 }
  }
  // Deliberately broken client: refresh adopted a new revision, then a response
  // handler emits another POST without another explicit user save.
  action automaticResend(a) = all {
    MUTATION == "auto_revision_resend", available(a), state.phase.get(a) == "conflict",
    state.loadedRevision.get(a) != state.submittedRevision.get(a), state.requests.get(a) == 1,
    mark("automatic_resend", a, ""),
    state' = { ...state, phase: state.phase.set(a, "pending"),
      submittedRevision: state.submittedRevision.set(a, state.loadedRevision.get(a)),
      requests: state.requests.set(a, state.requests.get(a) + 1), txResult: state.txResult.set(a, "none"),
      reply: state.reply.set(a, "none"), notification: state.notification.set(a, "none") }
  }
  // No liveness claim: the environment may keep a response unavailable forever.
  action stutter = all { mark("stutter", -1, ""), state' = state }
  action step = any {
    { nondet a = CLIENTS.oneOf(); read(a) },
    { nondet a = CLIENTS.oneOf(); nondet c = Set("new", "same").oneOf(); edit(a, c) },
    { nondet a = CLIENTS.oneOf(); send(a) },
    { nondet a = CLIENTS.oneOf(); nondet f = Set("ok", "rollback").oneOf(); transaction(a, f) },
    { nondet a = CLIENTS.oneOf(); nondet r = Set("ok", "fail").oneOf(); notify(a, r) },
    { nondet a = CLIENTS.oneOf(); deliver(a) },
    { nondet a = CLIENTS.oneOf(); nondet r = Set("lost", "proxy502").oneOf(); loseResponse(a, r) },
    { nondet a = CLIENTS.oneOf(); nondet r = Set("ok", "unavailable").oneOf(); lookup(a, r) },
    { nondet a = CLIENTS.oneOf(); refreshStale(a) },
    { nondet a = CLIENTS.oneOf(); refreshSaved(a) },
    { nondet a = CLIENTS.oneOf(); close(a) },
    { nondet a = CLIENTS.oneOf(); reopen(a) },
    { nondet a = CLIENTS.oneOf(); automaticResend(a) },
    backgroundChange, stutter
  }

  val finiteDomain = state.revision >= 0 and state.revision <= CLIENTS.size() + 1 and
    names.contains(state.name) and (state.serverOwner == -1 or CLIENTS.contains(state.serverOwner)) and
    CLIENTS.forall(a => phases.contains(state.phase.get(a)) and codecs.contains(CODECS.get(a)) and
      state.userSaves.get(a) >= 0 and state.userSaves.get(a) <= 1 and
      state.requests.get(a) >= 0 and state.requests.get(a) <= 2 and
      state.loadedRevision.get(a) >= -1 and state.loadedRevision.get(a) <= state.revision and
      state.submittedRevision.get(a) >= -1 and state.submittedRevision.get(a) <= state.revision)
  val revisionCheckedInTransaction = CLIENTS.forall(a => state.txResult.get(a) != "committed" or
    (state.submittedRevision.get(a) == state.commitBaseRevision.get(a) and
      (CODECS.get(a) != "v11" or not(state.commitBaseOverride.get(a)))))
  val noAutomaticOverwrite = CLIENTS.forall(a => state.requests.get(a) <= state.userSaves.get(a))
  val receiptAtomic = CLIENTS.forall(a => (state.receipt.get(a) == "succeeded") == (state.txResult.get(a) == "committed"))
  val honestSaveResult = CLIENTS.forall(a =>
    (state.reply.get(a) != "ok" or state.receipt.get(a) == "succeeded") and
    (state.reply.get(a) != "failed" or state.txResult.get(a) == "rolled_back"))
  val draftRetained = CLIENTS.forall(a => not(Set("pending", "conflict", "failed", "recovering", "unknown").contains(state.phase.get(a))) or
    state.draft.get(a) == state.submittedName.get(a))
  val currentRead = not(Set("read", "reopen", "refresh_stale", "refresh_saved").contains(lastAction)) or
    (state.loadedRevision.get(actor) == state.revision and state.loadedName.get(actor) == state.name)
  val closedPhase = lastAction != "close" or state.phase.get(actor) == "closed"
  val transactionOwner = state.serverOwner == -1 or
    (state.txResult.get(state.serverOwner) == "committed" and state.notification.get(state.serverOwner) == "none")
  val safety = finiteDomain and revisionCheckedInTransaction and noAutomaticOverwrite and receiptAtomic and
    honestSaveResult and draftRetained and currentRead and closedPhase and transactionOwner
}
