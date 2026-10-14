// KEJ-72: a finite import preview/commit protocol, not the row-copy algorithm.
// Upload/readJson awaits finish before each modeled HTTP linearization point.
// Validation, SQLite transaction, consumed assignment and Map deletion are one
// synchronous critical section. discardImport deletes BEFORE its first await;
// filesystem cleanup cannot qualify a token or change the business projection.
module protocol {
  const TOKENS: Set[int]
  const MAX_GENERATIONS: int
  const MAX_WRITES: int
  const MAX_RESTARTS: int
  const MAX_FAILURES: int
  const MUTATION: str

  // Replay commands and public observations. Generation numbers normalize the
  // opaque random previewToken values actually returned by validate/preview.
  var lastAction: str
  var actor: int
  var requestedMode: str
  var requestedGeneration: int
  var fault: bool
  var lastHTTPStatus: int
  var lastHTTPCode: str
  var businessIds: Set[int]
  var clientGeneration: int -> int
  var clientMode: int -> str
  var clientCurrentCount: int -> int
  var clientAddedCount: int -> int
  var clientSkippedCount: int -> int

  // Internal finite specification state; never claimed observable via HTTP.
  var uploaded: Set[int]
  var present: Set[int]
  var expired: Set[int]
  var uploadEpoch: int -> int
  // Quotient obsolete hashes to -1: only equality with the current revision
  // can influence any future action. Client-returned metadata is preserved.
  var previewRevision: int -> int
  var consumptionCount: int -> int
  var dbRevision: int
  var writes: int
  var restarts: int
  var failures: int

  // Transition evidence, checked independently of the response branches.
  var versionAccepted: bool
  var expiryAccepted: bool
  var modeAccepted: bool
  var generationAccepted: bool
  var epochAccepted: bool
  var beforeBusinessIds: Set[int]

  pure val modes = Set("append", "replace")
  pure val requestModes = Set("append", "replace", "invalid")
  pure def importedIds(t) = Set(t + 1)
  pure def resultingIds(ids, t, m) = if (m == "replace") importedIds(t) else ids.union(importedIds(t))
  def live(t) = present.contains(t)
  def requestMatches(t, m, g) = m == clientMode.get(t) and g == clientGeneration.get(t)
  def revisionMatches(t) = previewRevision.get(t) == dbRevision
  def qualified(t, m, g) = live(t) and modes.contains(m) and requestMatches(t, m, g) and revisionMatches(t)

  action command(a, t, m, g, f) = all {
    lastAction' = a, actor' = t, requestedMode' = m,
    requestedGeneration' = g, fault' = f
  }
  action keepClientMetadata = all {
    clientGeneration' = clientGeneration, clientMode' = clientMode,
    clientCurrentCount' = clientCurrentCount, clientAddedCount' = clientAddedCount,
    clientSkippedCount' = clientSkippedCount
  }
  action keepClients = all { keepClientMetadata, previewRevision' = previewRevision }
  action keepChecks = all {
    versionAccepted' = versionAccepted, expiryAccepted' = expiryAccepted,
    modeAccepted' = modeAccepted, generationAccepted' = generationAccepted,
    epochAccepted' = epochAccepted, beforeBusinessIds' = businessIds
  }
  action keepHTTP = all { lastHTTPStatus' = lastHTTPStatus, lastHTTPCode' = lastHTTPCode }
  action keepBudgets = all { writes' = writes, restarts' = restarts, failures' = failures }
  action keepTokenState = all {
    uploaded' = uploaded, present' = present, expired' = expired,
    uploadEpoch' = uploadEpoch, consumptionCount' = consumptionCount
  }
  action keepBusiness = all { businessIds' = businessIds, dbRevision' = dbRevision }

  action init = all {
    lastAction' = "init", actor' = -1, requestedMode' = "", requestedGeneration' = 0, fault' = false,
    lastHTTPStatus' = 0, lastHTTPCode' = "", businessIds' = Set(0),
    clientGeneration' = TOKENS.mapBy(_ => 0), clientMode' = TOKENS.mapBy(_ => ""),
    clientCurrentCount' = TOKENS.mapBy(_ => 0), clientAddedCount' = TOKENS.mapBy(_ => 0),
    clientSkippedCount' = TOKENS.mapBy(_ => 0),
    uploaded' = Set(), present' = Set(), expired' = Set(),
    uploadEpoch' = TOKENS.mapBy(_ => -1), previewRevision' = TOKENS.mapBy(_ => -1),
    consumptionCount' = TOKENS.mapBy(_ => 0),
    dbRevision' = 0, writes' = 0, restarts' = 0, failures' = 0,
    versionAccepted' = true, expiryAccepted' = true, modeAccepted' = true,
    generationAccepted' = true, epochAccepted' = true, beforeBusinessIds' = Set(0)
  }

  action upload(t, m) = all {
    TOKENS.contains(t), not(uploaded.contains(t)), modes.contains(m),
    command("upload", t, m, 1, false), lastHTTPStatus' = 200, lastHTTPCode' = "",
    uploaded' = uploaded.union(Set(t)), present' = present.union(Set(t)), expired' = expired,
    uploadEpoch' = uploadEpoch.set(t, restarts), consumptionCount' = consumptionCount,
    clientGeneration' = clientGeneration.set(t, 1), clientMode' = clientMode.set(t, m),
    clientCurrentCount' = clientCurrentCount.set(t, businessIds.size()),
    clientAddedCount' = clientAddedCount.set(t, importedIds(t).exclude(businessIds).size()),
    clientSkippedCount' = clientSkippedCount.set(t, importedIds(t).intersect(businessIds).size()),
    previewRevision' = previewRevision.set(t, dbRevision),
    keepBusiness, keepBudgets, keepChecks
  }

  action preview(t, m) = all {
    TOKENS.contains(t), uploaded.contains(t), modes.contains(m),
    (not(live(t)) or clientGeneration.get(t) < MAX_GENERATIONS),
    command("preview", t, m, if (live(t)) clientGeneration.get(t) + 1 else 0, false),
    lastHTTPStatus' = if (live(t)) 200 else 410,
    lastHTTPCode' = if (live(t)) "" else "IMPORT_EXPIRED",
    clientGeneration' = if (live(t)) clientGeneration.set(t, clientGeneration.get(t) + 1) else clientGeneration,
    clientMode' = if (live(t)) clientMode.set(t, m) else clientMode,
    clientCurrentCount' = if (live(t)) clientCurrentCount.set(t, businessIds.size()) else clientCurrentCount,
    clientAddedCount' = if (live(t)) clientAddedCount.set(t, importedIds(t).exclude(businessIds).size()) else clientAddedCount,
    clientSkippedCount' = if (live(t)) clientSkippedCount.set(t, importedIds(t).intersect(businessIds).size()) else clientSkippedCount,
    previewRevision' = if (live(t)) previewRevision.set(t, dbRevision) else previewRevision,
    // Preview does NOT touch the upload timer, expiry or process epoch.
    keepTokenState, keepBusiness, keepBudgets, keepChecks
  }

  action commit(t, m, g, fails) = {
    val matching = live(t) and modes.contains(m) and requestMatches(t, m, g)
    val accepted = matching and (revisionMatches(t) or MUTATION == "skip_version")
    val success = accepted and not(fails)
    all {
      TOKENS.contains(t), uploaded.contains(t), requestModes.contains(m),
      g >= 0, g <= MAX_GENERATIONS,
      consumptionCount.get(t) < 2,
      // The one-shot fault is injected after writes at COMMIT, never armed on a
      // rejected request. SQLite rollback restores rows but not total_changes.
      (not(fails) or (qualified(t, m, g) and failures < MAX_FAILURES)),
      command("commit", t, m, g, fails),
      lastHTTPStatus' = if (not(live(t))) 410 else if (not(modes.contains(m))) 400
        else if (not(accepted)) 409 else if (fails and m == "replace") 500
        else if (fails) 409 else 200,
      lastHTTPCode' = if (not(live(t))) "IMPORT_EXPIRED" else if (not(modes.contains(m))) "INVALID_IMPORT_MODE"
        else if (not(accepted)) "IMPORT_PREVIEW_STALE" else if (fails and m == "replace") "RESTORE_FAILED"
        else if (fails) "APPEND_FAILED" else "",
      businessIds' = if (success) resultingIds(businessIds, t, m) else businessIds,
      dbRevision' = dbRevision + (if (accepted) 1 else 0),
      // retain_token deliberately removes BOTH defenses, not consumed alone:
      // deleting the Map entry still prevents replay if only consumed is absent.
      present' = if (success and MUTATION != "retain_token") present.exclude(Set(t)) else present,
      consumptionCount' = consumptionCount.set(t, consumptionCount.get(t) + (if (success) 1 else 0)),
      uploaded' = uploaded, expired' = expired, uploadEpoch' = uploadEpoch,
      writes' = writes, restarts' = restarts, failures' = failures + (if (fails) 1 else 0),
      versionAccepted' = (not(success) or revisionMatches(t)),
      expiryAccepted' = (not(success) or not(expired.contains(t))),
      modeAccepted' = (not(success) or m == clientMode.get(t)),
      generationAccepted' = (not(success) or g == clientGeneration.get(t)),
      epochAccepted' = (not(success) or uploadEpoch.get(t) == restarts),
      beforeBusinessIds' = businessIds, keepClientMetadata,
      previewRevision' = if (accepted) TOKENS.mapBy(_ => -1) else previewRevision
    }
  }

  // A delivered callback of the original 900000-ms upload timer. No claim that
  // callbacks run at their nominal deadline, that time is fair, or that preview
  // grants a fresh TTL. Re-preview then expire is explicitly reachable.
  action expire(t) = all {
    TOKENS.contains(t), live(t), not(expired.contains(t)),
    command("expire", t, "", 0, false),
    present' = if (MUTATION == "skip_expiry") present else present.exclude(Set(t)),
    expired' = expired.union(Set(t)), uploaded' = uploaded,
    uploadEpoch' = uploadEpoch, consumptionCount' = consumptionCount,
    keepClients, keepBusiness, keepBudgets, keepHTTP, keepChecks
  }

  action write(connection) = all {
    Set("same", "other").contains(connection), writes < MAX_WRITES,
    command(if (connection == "same") "same_write" else "other_write", -1, "", 0, false),
    writes' = writes + 1, dbRevision' = dbRevision + 1,
    // Actual fixture writes a title/child row and also checks full row snapshots.
    businessIds' = businessIds, restarts' = restarts, failures' = failures,
    keepTokenState, keepClientMetadata, previewRevision' = TOKENS.mapBy(_ => -1), keepHTTP, keepChecks
  }

  action restart = all {
    restarts < MAX_RESTARTS,
    command("restart", -1, "", 0, false),
    restarts' = restarts + 1, present' = Set(), dbRevision' = dbRevision + 1,
    uploaded' = uploaded, expired' = expired, uploadEpoch' = uploadEpoch,
    consumptionCount' = consumptionCount, businessIds' = businessIds,
    writes' = writes, failures' = failures, keepClientMetadata,
    previewRevision' = TOKENS.mapBy(_ => -1), keepHTTP, keepChecks
  }

  // Abstract completion of asynchronous file deletion, or a general idle step.
  // Both preserve every public business/HTTP field and all qualification state.
  action noEffect(a, t) = all {
    command(a, t, "", 0, false), keepTokenState, keepClients,
    keepBusiness, keepBudgets, keepHTTP, keepChecks
  }
  action cleanup(t) = all { TOKENS.contains(t), uploaded.contains(t), not(live(t)), noEffect("cleanup", t) }
  action stutter = noEffect("stutter", -1)

  action step = any {
    { nondet t = TOKENS.oneOf(); nondet m = modes.oneOf(); upload(t, m) },
    { nondet t = TOKENS.oneOf(); nondet m = modes.oneOf(); preview(t, m) },
    { nondet t = TOKENS.oneOf(); nondet m = requestModes.oneOf(); nondet g = 0.to(MAX_GENERATIONS).oneOf(); commit(t, m, g, false) },
    { nondet t = TOKENS.oneOf(); commit(t, clientMode.get(t), clientGeneration.get(t), true) },
    { nondet t = TOKENS.oneOf(); expire(t) },
    { nondet c = Set("same", "other").oneOf(); write(c) },
    restart,
    { nondet t = TOKENS.oneOf(); cleanup(t) },
    stutter
  }

  val versionBound = versionAccepted
  val expiryBound = expiryAccepted
  val modeBound = modeAccepted
  val generationBound = generationAccepted
  val restartBound = epochAccepted
  val singleConsumption = TOKENS.forall(t => consumptionCount.get(t) <= 1)
  val refusedCommitUnchanged = lastAction != "commit" or lastHTTPStatus == 200 or businessIds == beforeBusinessIds
  val successfulCommitResult = lastAction != "commit" or lastHTTPStatus != 200 or
    businessIds == (if (requestedMode == "replace") Set(actor + 1) else beforeBusinessIds.union(Set(actor + 1)))
  val tokenDomains = present.subseteq(uploaded) and uploaded.subseteq(TOKENS) and expired.subseteq(uploaded)
  val finiteDomain = writes >= 0 and writes <= MAX_WRITES and restarts >= 0 and restarts <= MAX_RESTARTS and
    failures >= 0 and failures <= MAX_FAILURES and dbRevision >= 0 and
    dbRevision <= MAX_WRITES + MAX_RESTARTS + MAX_FAILURES + (2 * TOKENS.size()) and
    businessIds.subseteq(TOKENS.map(t => t + 1).union(Set(0))) and TOKENS.forall(t =>
      clientGeneration.get(t) >= 0 and clientGeneration.get(t) <= MAX_GENERATIONS and
      consumptionCount.get(t) >= 0 and consumptionCount.get(t) <= 2)
  val safety = versionBound and expiryBound and modeBound and generationBound and restartBound and
    singleConsumption and refusedCommitUnchanged and successfulCommitResult and tokenDomains and finiteDomain
}
