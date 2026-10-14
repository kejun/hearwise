// KEJ-75. Finite platform/provider schedule, real controller/service boundaries.
// The provider produces exactly one 2-sample PCM frame before successful completion.
// Owner object identities never repeat; the transport epoch deliberately wraps modulo 2.
// Pause/resume are bounded by explicit environment credits, not silently assumed fair.
module protocol {
  const OWNERS: Set[int]
  const MAX_PCM: int
  const TRACK_ACTIONS: bool
  const CONTROL_ABA: bool
  const MUTATION: str
  var lastAction: str
  var actor: int
  var choice: str
  var created: int
  var active: int
  var selectedRecord: str
  var paused: bool
  var resuming: bool
  var wire: int
  var pauseUsed: bool
  var resumeUsed: bool
  var pauseCancelled: bool
  var isolationViolation: bool
  var pauseViolation: bool
  var record: int -> str
  var position: int -> int
  var ownerEpoch: int -> int
  var epoch: int -> int
  var unlocked: int -> bool
  var unlockDone: int -> bool
  var requested: int -> int
  var accepted: int -> int
  var emitted: int -> int
  var returned: int -> int
  var completed: int -> int
  var frames: int -> int
  var received: int -> int
  var consumed: int -> int
  var played: int -> int
  var closed: int -> bool
  var playerPaused: int -> bool
  var providerClosed: int -> bool
  var finished: int -> bool
  var settling: int -> bool
  var settleDone: int -> bool
  var pending: int -> bool

  pure def bump(n, amount) = (n + amount - 1) % 2 + 1
  def hasOwner(g) = OWNERS.contains(g) and g <= created
  def live(g) = active == g and not(closed.get(g))
  def total(g) = 3 - position.get(g)
  val stopping = OWNERS.mapBy(g => closed.get(g) or g == active)
  val stoppingProvider = OWNERS.mapBy(g => providerClosed.get(g) or (g == active and unlocked.get(g)))
  def nextRequest(g) = live(g) and not(providerClosed.get(g)) and not(paused) and requested.get(g) == returned.get(g) and requested.get(g) < total(g)

  action init = all {
    lastAction' = (if (TRACK_ACTIONS) ("init") else ""),
    actor' = (if (TRACK_ACTIONS) (0) else 0),
    choice' = (if (TRACK_ACTIONS) ("") else ""),
    created' = (0),
    active' = (0),
    selectedRecord' = ("A"),
    paused' = (false),
    resuming' = (false),
    wire' = (0),
    pauseUsed' = (false),
    resumeUsed' = (false),
    pauseCancelled' = (false),
    isolationViolation' = (false),
    pauseViolation' = (false),
    record' = (OWNERS.mapBy(_ => "")),
    position' = (OWNERS.mapBy(_ => 0)),
    ownerEpoch' = (OWNERS.mapBy(_ => 0)),
    epoch' = (OWNERS.mapBy(_ => 0)),
    unlocked' = (OWNERS.mapBy(_ => false)),
    unlockDone' = (OWNERS.mapBy(_ => false)),
    requested' = (OWNERS.mapBy(_ => 0)),
    accepted' = (OWNERS.mapBy(_ => 0)),
    emitted' = (OWNERS.mapBy(_ => 0)),
    returned' = (OWNERS.mapBy(_ => 0)),
    completed' = (OWNERS.mapBy(_ => 0)),
    frames' = (OWNERS.mapBy(_ => 0)),
    received' = (OWNERS.mapBy(_ => 0)),
    consumed' = (OWNERS.mapBy(_ => 0)),
    played' = (OWNERS.mapBy(_ => 0)),
    closed' = (OWNERS.mapBy(_ => false)),
    playerPaused' = (OWNERS.mapBy(_ => false)),
    providerClosed' = (OWNERS.mapBy(_ => false)),
    finished' = (OWNERS.mapBy(_ => false)),
    settling' = (OWNERS.mapBy(_ => false)),
    settleDone' = (OWNERS.mapBy(_ => false)),
    pending' = (OWNERS.mapBy(_ => false))
  }

  action start(r, p, pos) = {
    val w = bump(wire, if (active > 0 and r != selectedRecord) 2 else 1)
    all {
      created < OWNERS.size(),
      not(CONTROL_ABA) or (r == "A" and not(p) and pos == 1),
      Set("A", "B").contains(r),
      Set(1, 2).contains(pos),
      lastAction' = (if (TRACK_ACTIONS) ("start") else ""),
      actor' = (if (TRACK_ACTIONS) (created + 1) else 0),
      choice' = (if (TRACK_ACTIONS) (if (r == "A") { if (p) { if (pos == 1) "A-paused-1" else "A-paused-2" } else { if (pos == 1) "A-playing-1" else "A-playing-2" } } else { if (p) { if (pos == 1) "B-paused-1" else "B-paused-2" } else { if (pos == 1) "B-playing-1" else "B-playing-2" } }) else ""),
      created' = (created + 1),
      active' = (created + 1),
      selectedRecord' = (r),
      paused' = (p),
      resuming' = (false),
      wire' = (w),
      pauseUsed' = (pauseUsed),
      resumeUsed' = (resumeUsed),
      pauseCancelled' = (pauseCancelled),
      isolationViolation' = (isolationViolation),
      pauseViolation' = (pauseViolation),
      record' = (record.set(created + 1, r)),
      position' = (position.set(created + 1, pos)),
      ownerEpoch' = (ownerEpoch.set(created + 1, w)),
      epoch' = (epoch),
      unlocked' = (unlocked),
      unlockDone' = (unlockDone),
      requested' = (requested),
      accepted' = (accepted),
      emitted' = (emitted),
      returned' = (returned),
      completed' = (completed),
      frames' = (frames),
      received' = (received),
      consumed' = (consumed),
      played' = (played),
      closed' = (stopping),
      playerPaused' = (playerPaused.set(created + 1, p)),
      providerClosed' = (stoppingProvider),
      finished' = (finished),
      settling' = (settling),
      settleDone' = (settleDone),
      pending' = (pending)
    }
  }

  action seek(pos) = {
    val r = selectedRecord
    val p = paused
    val w = bump(wire, 1)
    all {
      not(CONTROL_ABA),
      active > 0,
      unlocked.get(active),
      created < OWNERS.size(),
      Set(1, 2).contains(pos),
      lastAction' = (if (TRACK_ACTIONS) ("seek") else ""),
      actor' = (if (TRACK_ACTIONS) (created + 1) else 0),
      choice' = (if (TRACK_ACTIONS) (if (pos == 1) "1" else "2") else ""),
      created' = (created + 1),
      active' = (created + 1),
      selectedRecord' = (selectedRecord),
      paused' = (if (MUTATION == "seek_unpaused") false else paused),
      resuming' = (false),
      wire' = (w),
      pauseUsed' = (pauseUsed),
      resumeUsed' = (resumeUsed),
      pauseCancelled' = (pauseCancelled),
      isolationViolation' = (isolationViolation),
      pauseViolation' = (pauseViolation or (MUTATION == "seek_unpaused" and paused)),
      record' = (record.set(created + 1, selectedRecord)),
      position' = (position.set(created + 1, pos)),
      ownerEpoch' = (ownerEpoch.set(created + 1, w)),
      epoch' = (epoch),
      unlocked' = (unlocked),
      unlockDone' = (unlockDone),
      requested' = (requested),
      accepted' = (accepted),
      emitted' = (emitted),
      returned' = (returned),
      completed' = (completed),
      frames' = (frames),
      received' = (received),
      consumed' = (consumed),
      played' = (played),
      closed' = (stopping),
      playerPaused' = (playerPaused.set(created + 1, paused)),
      providerClosed' = (stoppingProvider),
      finished' = (finished),
      settling' = (settling),
      settleDone' = (settleDone),
      pending' = (pending)
    }
  }

  action unlock(g) = all {
    hasOwner(g),
    not(unlockDone.get(g)),
    lastAction' = (if (TRACK_ACTIONS) ("unlock") else ""),
    actor' = (if (TRACK_ACTIONS) (g) else 0),
    choice' = (if (TRACK_ACTIONS) ("") else ""),
    created' = (created),
    active' = (active),
    selectedRecord' = (selectedRecord),
    paused' = (paused),
    resuming' = (resuming),
    wire' = (wire),
    pauseUsed' = (pauseUsed),
    resumeUsed' = (resumeUsed),
    pauseCancelled' = (pauseCancelled),
    isolationViolation' = (isolationViolation),
    pauseViolation' = (pauseViolation),
    record' = (record),
    position' = (position),
    ownerEpoch' = (ownerEpoch),
    epoch' = (epoch.set(g, if (live(g)) ownerEpoch.get(g) else 0)),
    unlocked' = (unlocked.set(g, live(g))),
    unlockDone' = (unlockDone.set(g, true)),
    requested' = (requested.set(g, if (live(g) and not(paused)) 1 else 0)),
    accepted' = (accepted.set(g, if (live(g) and not(paused)) 1 else 0)),
    emitted' = (emitted),
    returned' = (returned),
    completed' = (completed),
    frames' = (frames),
    received' = (received),
    consumed' = (consumed),
    played' = (played),
    closed' = (closed),
    playerPaused' = (playerPaused),
    providerClosed' = (providerClosed),
    finished' = (finished),
    settling' = (settling),
    settleDone' = (settleDone),
    pending' = (pending)
  }

  action stop = all {
    active > 0,
    lastAction' = (if (TRACK_ACTIONS) ("stop") else ""),
    actor' = (if (TRACK_ACTIONS) (active) else 0),
    choice' = (if (TRACK_ACTIONS) ("") else ""),
    created' = (created),
    active' = (0),
    selectedRecord' = (selectedRecord),
    paused' = (false),
    resuming' = (false),
    wire' = (bump(wire, 1)),
    pauseUsed' = (pauseUsed),
    resumeUsed' = (resumeUsed),
    pauseCancelled' = (pauseCancelled),
    isolationViolation' = (isolationViolation),
    pauseViolation' = (pauseViolation),
    record' = (record),
    position' = (position),
    ownerEpoch' = (ownerEpoch),
    epoch' = (epoch),
    unlocked' = (unlocked),
    unlockDone' = (unlockDone),
    requested' = (requested),
    accepted' = (accepted),
    emitted' = (emitted),
    returned' = (returned),
    completed' = (completed),
    frames' = (frames),
    received' = (received),
    consumed' = (consumed),
    played' = (played),
    closed' = (stopping),
    playerPaused' = (playerPaused),
    providerClosed' = (stoppingProvider),
    finished' = (finished),
    settling' = (settling),
    settleDone' = (settleDone),
    pending' = (pending)
  }

  action switchRecord(r) = all {
    not(CONTROL_ABA),
    Set("A", "B").contains(r),
    r != selectedRecord,
    lastAction' = (if (TRACK_ACTIONS) ("switchRecord") else ""),
    actor' = (if (TRACK_ACTIONS) (active) else 0),
    choice' = (if (TRACK_ACTIONS) (r) else ""),
    created' = (created),
    active' = (0),
    selectedRecord' = (r),
    paused' = (false),
    resuming' = (false),
    wire' = (if (active > 0) bump(wire, 1) else wire),
    pauseUsed' = (pauseUsed),
    resumeUsed' = (resumeUsed),
    pauseCancelled' = (pauseCancelled),
    isolationViolation' = (isolationViolation),
    pauseViolation' = (pauseViolation),
    record' = (record),
    position' = (position),
    ownerEpoch' = (ownerEpoch),
    epoch' = (epoch),
    unlocked' = (unlocked),
    unlockDone' = (unlockDone),
    requested' = (requested),
    accepted' = (accepted),
    emitted' = (emitted),
    returned' = (returned),
    completed' = (completed),
    frames' = (frames),
    received' = (received),
    consumed' = (consumed),
    played' = (played),
    closed' = (stopping),
    playerPaused' = (playerPaused),
    providerClosed' = (stoppingProvider),
    finished' = (finished),
    settling' = (settling),
    settleDone' = (settleDone),
    pending' = (pending)
  }

  action pause = all {
    active > 0,
    not(pauseUsed) or (resuming and not(pauseCancelled)),
    lastAction' = (if (TRACK_ACTIONS) ("pause") else ""),
    actor' = (if (TRACK_ACTIONS) (active) else 0),
    choice' = (if (TRACK_ACTIONS) ("") else ""),
    created' = (created),
    active' = (active),
    selectedRecord' = (selectedRecord),
    paused' = (true),
    resuming' = (false),
    wire' = (wire),
    pauseUsed' = (true),
    resumeUsed' = (resumeUsed),
    pauseCancelled' = (pauseCancelled or resuming),
    isolationViolation' = (isolationViolation),
    pauseViolation' = (pauseViolation),
    record' = (record),
    position' = (position),
    ownerEpoch' = (ownerEpoch),
    epoch' = (epoch),
    unlocked' = (unlocked),
    unlockDone' = (unlockDone),
    requested' = (requested),
    accepted' = (accepted),
    emitted' = (emitted),
    returned' = (returned),
    completed' = (completed),
    frames' = (frames),
    received' = (received),
    consumed' = (consumed),
    played' = (played),
    closed' = (closed),
    playerPaused' = (playerPaused.set(active, true)),
    providerClosed' = (providerClosed),
    finished' = (finished),
    settling' = (settling),
    settleDone' = (settleDone),
    pending' = (pending)
  }

  action resume = all {
    active > 0,
    unlocked.get(active),
    paused,
    not(resuming),
    not(resumeUsed),
    lastAction' = (if (TRACK_ACTIONS) ("resume") else ""),
    actor' = (if (TRACK_ACTIONS) (active) else 0),
    choice' = (if (TRACK_ACTIONS) ("") else ""),
    created' = (created),
    active' = (active),
    selectedRecord' = (selectedRecord),
    paused' = (paused),
    resuming' = (true),
    wire' = (wire),
    pauseUsed' = (pauseUsed),
    resumeUsed' = (true),
    pauseCancelled' = (pauseCancelled),
    isolationViolation' = (isolationViolation),
    pauseViolation' = (pauseViolation),
    record' = (record),
    position' = (position),
    ownerEpoch' = (ownerEpoch),
    epoch' = (epoch),
    unlocked' = (unlocked),
    unlockDone' = (unlockDone),
    requested' = (requested),
    accepted' = (accepted),
    emitted' = (emitted),
    returned' = (returned),
    completed' = (completed),
    frames' = (frames),
    received' = (received),
    consumed' = (consumed),
    played' = (played),
    closed' = (closed),
    playerPaused' = (playerPaused.set(active, false)),
    providerClosed' = (providerClosed),
    finished' = (finished),
    settling' = (settling),
    settleDone' = (settleDone),
    pending' = (pending.set(active, true))
  }

  action resumeComplete(g) = {
    val ok = live(g) and resuming and not(playerPaused.get(g))
    all {
      hasOwner(g),
      pending.get(g),
      lastAction' = (if (TRACK_ACTIONS) ("resumeComplete") else ""),
      actor' = (if (TRACK_ACTIONS) (g) else 0),
      choice' = (if (TRACK_ACTIONS) ("") else ""),
      created' = (created),
      active' = (active),
      selectedRecord' = (selectedRecord),
      paused' = (if (ok) false else paused),
      resuming' = (if (ok) false else resuming),
      wire' = (wire),
      pauseUsed' = (pauseUsed),
      resumeUsed' = (resumeUsed),
      pauseCancelled' = (pauseCancelled),
      isolationViolation' = (isolationViolation),
      pauseViolation' = (pauseViolation),
      record' = (record),
      position' = (position),
      ownerEpoch' = (ownerEpoch),
      epoch' = (epoch),
      unlocked' = (unlocked),
      unlockDone' = (unlockDone),
      requested' = (requested.set(g, requested.get(g) + (if (ok and requested.get(g) == returned.get(g) and requested.get(g) < total(g) and not(providerClosed.get(g))) 1 else 0))),
      accepted' = (accepted.set(g, accepted.get(g) + (if (ok and requested.get(g) == returned.get(g) and requested.get(g) < total(g) and not(providerClosed.get(g))) 1 else 0))),
      emitted' = (emitted),
      returned' = (returned),
      completed' = (completed),
      frames' = (frames),
      received' = (received),
      consumed' = (consumed),
      played' = (played),
      closed' = (closed),
      playerPaused' = (playerPaused),
      providerClosed' = (providerClosed),
      finished' = (finished),
      settling' = (settling),
      settleDone' = (settleDone),
      pending' = (pending.set(g, false))
    }
  }

  action pcm(g) = all {
    hasOwner(g),
    returned.get(g) < requested.get(g),
    emitted.get(g) == returned.get(g),
    emitted.get(g) < MAX_PCM,
    lastAction' = (if (TRACK_ACTIONS) ("pcm") else ""),
    actor' = (if (TRACK_ACTIONS) (g) else 0),
    choice' = (if (TRACK_ACTIONS) ("") else ""),
    created' = (created),
    active' = (active),
    selectedRecord' = (selectedRecord),
    paused' = (paused),
    resuming' = (resuming),
    wire' = (wire),
    pauseUsed' = (pauseUsed),
    resumeUsed' = (resumeUsed),
    pauseCancelled' = (pauseCancelled),
    isolationViolation' = (isolationViolation),
    pauseViolation' = (pauseViolation),
    record' = (record),
    position' = (position),
    ownerEpoch' = (ownerEpoch),
    epoch' = (epoch),
    unlocked' = (unlocked),
    unlockDone' = (unlockDone),
    requested' = (requested),
    accepted' = (accepted),
    emitted' = (emitted.set(g, emitted.get(g) + 1)),
    returned' = (returned),
    completed' = (completed),
    frames' = (frames.set(g, frames.get(g) + (if (live(g) and not(providerClosed.get(g))) 1 else 0))),
    received' = (received.set(g, received.get(g) + (if (live(g) and not(providerClosed.get(g))) 2 else 0))),
    consumed' = (consumed),
    played' = (played),
    closed' = (closed),
    playerPaused' = (playerPaused),
    providerClosed' = (providerClosed),
    finished' = (finished),
    settling' = (settling),
    settleDone' = (settleDone),
    pending' = (pending)
  }

  action complete(g) = {
    val again = live(g) and not(providerClosed.get(g)) and not(paused) and requested.get(g) < total(g)
    all {
      hasOwner(g),
      returned.get(g) < requested.get(g),
      emitted.get(g) > returned.get(g),
      lastAction' = (if (TRACK_ACTIONS) ("complete") else ""),
      actor' = (if (TRACK_ACTIONS) (g) else 0),
      choice' = (if (TRACK_ACTIONS) ("") else ""),
      created' = (created),
      active' = (active),
      selectedRecord' = (selectedRecord),
      paused' = (paused),
      resuming' = (resuming),
      wire' = (wire),
      pauseUsed' = (pauseUsed),
      resumeUsed' = (resumeUsed),
      pauseCancelled' = (pauseCancelled),
      isolationViolation' = (isolationViolation),
      pauseViolation' = (pauseViolation),
      record' = (record),
      position' = (position),
      ownerEpoch' = (ownerEpoch),
      epoch' = (epoch),
      unlocked' = (unlocked),
      unlockDone' = (unlockDone),
      requested' = (requested.set(g, requested.get(g) + (if (again) 1 else 0))),
      accepted' = (accepted.set(g, if (MUTATION == "accepted_loss" and live(g)) 0 else accepted.get(g) + (if (again) 1 else 0))),
      emitted' = (emitted),
      returned' = (returned.set(g, returned.get(g) + 1)),
      completed' = (completed.set(g, completed.get(g) + (if (live(g) and not(providerClosed.get(g))) 1 else 0))),
      frames' = (frames),
      received' = (received),
      consumed' = (consumed),
      played' = (played),
      closed' = (closed),
      playerPaused' = (playerPaused),
      providerClosed' = (providerClosed),
      finished' = (finished),
      settling' = (settling),
      settleDone' = (settleDone),
      pending' = (pending)
    }
  }

  action consume(g) = {
    val running = live(g) and not(paused) and not(resuming)
    val n = if (not(running) or consumed.get(g) >= completed.get(g) * 2) consumed.get(g) else completed.get(g) * 2 + (if (frames.get(g) > completed.get(g)) 1 else 0)
    val done = running and completed.get(g) == total(g)
    all {
      hasOwner(g),
      unlocked.get(g),
      lastAction' = (if (TRACK_ACTIONS) ("consume") else ""),
      actor' = (if (TRACK_ACTIONS) (g) else 0),
      choice' = (if (TRACK_ACTIONS) ("") else ""),
      created' = (created),
      active' = (active),
      selectedRecord' = (selectedRecord),
      paused' = (paused),
      resuming' = (resuming),
      wire' = (wire),
      pauseUsed' = (pauseUsed),
      resumeUsed' = (resumeUsed),
      pauseCancelled' = (pauseCancelled),
      isolationViolation' = (isolationViolation),
      pauseViolation' = (pauseViolation),
      record' = (record),
      position' = (position),
      ownerEpoch' = (ownerEpoch),
      epoch' = (epoch),
      unlocked' = (unlocked),
      unlockDone' = (unlockDone),
      requested' = (requested),
      accepted' = (accepted),
      emitted' = (emitted),
      returned' = (returned),
      completed' = (completed),
      frames' = (frames),
      received' = (received),
      consumed' = (consumed.set(g, n)),
      played' = (played.set(g, if (running) completed.get(g) else played.get(g))),
      closed' = (closed),
      playerPaused' = (playerPaused),
      providerClosed' = (providerClosed.set(g, providerClosed.get(g) or done)),
      finished' = (finished.set(g, finished.get(g) or done)),
      settling' = (settling.set(g, settling.get(g) or done)),
      settleDone' = (settleDone),
      pending' = (pending)
    }
  }

  action settled(g) = all {
    hasOwner(g),
    settling.get(g),
    not(settleDone.get(g)),
    lastAction' = (if (TRACK_ACTIONS) ("settled") else ""),
    actor' = (if (TRACK_ACTIONS) (g) else 0),
    choice' = (if (TRACK_ACTIONS) ("") else ""),
    created' = (created),
    active' = (if (live(g)) 0 else active),
    selectedRecord' = (selectedRecord),
    paused' = (if (live(g)) false else paused),
    resuming' = (if (live(g)) false else resuming),
    wire' = (if (live(g)) bump(wire, 1) else wire),
    pauseUsed' = (pauseUsed),
    resumeUsed' = (resumeUsed),
    pauseCancelled' = (pauseCancelled),
    isolationViolation' = (isolationViolation),
    pauseViolation' = (pauseViolation),
    record' = (record),
    position' = (position),
    ownerEpoch' = (ownerEpoch),
    epoch' = (epoch),
    unlocked' = (unlocked),
    unlockDone' = (unlockDone),
    requested' = (requested),
    accepted' = (accepted),
    emitted' = (emitted),
    returned' = (returned),
    completed' = (completed),
    frames' = (frames),
    received' = (received),
    consumed' = (consumed),
    played' = (played),
    closed' = (if (live(g)) stopping else closed),
    playerPaused' = (playerPaused),
    providerClosed' = (if (live(g)) stoppingProvider else providerClosed),
    finished' = (finished),
    settling' = (settling),
    settleDone' = (settleDone.set(g, true)),
    pending' = (pending)
  }

  action late(g, kind) = {
    val suspend = kind == "suspended" and (live(g) or (MUTATION == "old_callback" and active > 0 and ownerEpoch.get(g) == ownerEpoch.get(active)))
    val failed = live(g) and (kind == "error" or kind == "socket-error" or (kind == "close" and not(finished.get(g))))
    all {
      hasOwner(g),
      Set("suspended", "error", "close", "socket-error").contains(kind),
      (kind != "close" and kind != "socket-error") or unlocked.get(g),
      not(live(g)) or kind != "suspended" or not(pauseUsed) or (resuming and not(pauseCancelled)),
      lastAction' = (if (TRACK_ACTIONS) ("late") else ""),
      actor' = (if (TRACK_ACTIONS) (g) else 0),
      choice' = (if (TRACK_ACTIONS) (kind) else ""),
      created' = (created),
      active' = (if (failed) 0 else active),
      selectedRecord' = (selectedRecord),
      paused' = (if (failed) false else if (suspend) true else paused),
      resuming' = (if (failed or suspend) false else resuming),
      wire' = (if (failed) bump(wire, 1) else wire),
      pauseUsed' = (pauseUsed or suspend),
      resumeUsed' = (resumeUsed),
      pauseCancelled' = (pauseCancelled or (suspend and resuming)),
      isolationViolation' = (isolationViolation or (suspend and not(live(g)))),
      pauseViolation' = (pauseViolation),
      record' = (record),
      position' = (position),
      ownerEpoch' = (ownerEpoch),
      epoch' = (epoch),
      unlocked' = (unlocked),
      unlockDone' = (unlockDone),
      requested' = (requested),
      accepted' = (accepted),
      emitted' = (emitted),
      returned' = (returned),
      completed' = (completed),
      frames' = (frames),
      received' = (received),
      consumed' = (consumed),
      played' = (played),
      closed' = (if (failed) stopping else closed),
      playerPaused' = (if (suspend) playerPaused.set(active, true) else playerPaused),
      providerClosed' = (if (failed) stoppingProvider else providerClosed),
      finished' = (finished),
      settling' = (settling),
      settleDone' = (settleDone),
      pending' = (pending)
    }
  }

  action frame(g, kind) = {
    val reject = live(g) and kind != "wrong-epoch"
    all {
      hasOwner(g),
      unlocked.get(g),
      Set("wrong-epoch", "reordered", "interleaved", "malformed", "duplicate").contains(kind),
      kind != "duplicate" or frames.get(g) > 0,
      lastAction' = (if (TRACK_ACTIONS) ("frame") else ""),
      actor' = (if (TRACK_ACTIONS) (g) else 0),
      choice' = (if (TRACK_ACTIONS) (kind) else ""),
      created' = (created),
      active' = (if (reject) 0 else active),
      selectedRecord' = (selectedRecord),
      paused' = (if (reject) false else paused),
      resuming' = (if (reject) false else resuming),
      wire' = (if (reject) bump(wire, 1) else wire),
      pauseUsed' = (pauseUsed),
      resumeUsed' = (resumeUsed),
      pauseCancelled' = (pauseCancelled),
      isolationViolation' = (isolationViolation),
      pauseViolation' = (pauseViolation),
      record' = (record),
      position' = (position),
      ownerEpoch' = (ownerEpoch),
      epoch' = (epoch),
      unlocked' = (unlocked),
      unlockDone' = (unlockDone),
      requested' = (requested),
      accepted' = (accepted),
      emitted' = (emitted),
      returned' = (returned),
      completed' = (completed),
      frames' = (frames),
      received' = (received.set(g, received.get(g) + (if (MUTATION == "wrong_frame" and live(g) and kind == "wrong-epoch") 2 else 0))),
      consumed' = (consumed),
      played' = (played),
      closed' = (if (reject) stopping else closed),
      playerPaused' = (playerPaused),
      providerClosed' = (if (reject) stoppingProvider else providerClosed),
      finished' = (finished),
      settling' = (settling),
      settleDone' = (settleDone),
      pending' = (pending)
    }
  }

  action stutter = all {
    lastAction' = (if (TRACK_ACTIONS) ("stutter") else ""),
    actor' = (if (TRACK_ACTIONS) (0) else 0),
    choice' = (if (TRACK_ACTIONS) ("") else ""),
    created' = (created),
    active' = (active),
    selectedRecord' = (selectedRecord),
    paused' = (paused),
    resuming' = (resuming),
    wire' = (wire),
    pauseUsed' = (pauseUsed),
    resumeUsed' = (resumeUsed),
    pauseCancelled' = (pauseCancelled),
    isolationViolation' = (isolationViolation),
    pauseViolation' = (pauseViolation),
    record' = (record),
    position' = (position),
    ownerEpoch' = (ownerEpoch),
    epoch' = (epoch),
    unlocked' = (unlocked),
    unlockDone' = (unlockDone),
    requested' = (requested),
    accepted' = (accepted),
    emitted' = (emitted),
    returned' = (returned),
    completed' = (completed),
    frames' = (frames),
    received' = (received),
    consumed' = (consumed),
    played' = (played),
    closed' = (closed),
    playerPaused' = (playerPaused),
    providerClosed' = (providerClosed),
    finished' = (finished),
    settling' = (settling),
    settleDone' = (settleDone),
    pending' = (pending)
  }

  val ownership = not(isolationViolation) and OWNERS.forall(g => g > created or
    (g == active or closed.get(g)))
  val intervals = OWNERS.forall(g => all {
    requested.get(g) == accepted.get(g),
    completed.get(g) <= returned.get(g), returned.get(g) <= emitted.get(g),
    emitted.get(g) <= requested.get(g), requested.get(g) <= (if (g <= created) total(g) else 0),
    not(finished.get(g)) or (completed.get(g) == total(g) and played.get(g) == total(g) and consumed.get(g) == total(g) * 2)
  })
  val pauseSafety = not(pauseViolation) and (active == 0 implies not(paused) and not(resuming)) and
    (resuming implies paused and pending.get(active))
  val frameOwnership = OWNERS.forall(g => received.get(g) == frames.get(g) * 2 and consumed.get(g) <= received.get(g))
  val safety = ownership and intervals and pauseSafety and frameOwnership
  action step = any {
    nondet r = Set("A", "B").oneOf()
    nondet p = Set(false, true).oneOf()
    nondet pos = Set(1, 2).oneOf()
    start(r, p, pos),
    nondet pos = Set(1, 2).oneOf()
    seek(pos),
    stop, pause, resume,
    nondet r = Set("A", "B").oneOf()
    switchRecord(r),
    nondet g = OWNERS.oneOf()
    any {
      unlock(g), resumeComplete(g), pcm(g), complete(g), consume(g), settled(g),
      nondet kind = Set("suspended", "error", "close", "socket-error").oneOf()
      late(g, kind),
      nondet kind = Set("wrong-epoch", "reordered", "interleaved", "malformed", "duplicate").oneOf()
      frame(g, kind)
    },
    stutter
  }
}
