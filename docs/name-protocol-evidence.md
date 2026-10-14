# KEJ-71 name protocol evidence

The scoped runner is `node scripts/verify-name-protocol.mjs --release`; re-read a retained run with `node scripts/verify-name-protocol-report.mjs RUN_DIRECTORY --release`. Run `npm ci --ignore-scripts`, `node scripts/setup-relation-protocol.mjs`, and `npm run build` first, on the exact committed checkout. `QUINT_HOME` can select an independent pinned tool cache. `NAME_PROTOCOL_EVIDENCE_DIR` selects the output directory. Both commands fail closed and return a nonzero exit when required evidence is absent or invalid.

The unchanged frozen configuration in `verification/name-protocol/config.json` gives the entire run 480 seconds. Exactly 23 stages execute:

- Three Quint type checks
- Complete TLC exploration of `independent` and `reuse`
- Apalache depth 6 for both configurations
- Two witness commands emitting all 22 named witnesses
- Two seeded simulation commands, 100 samples each and three retained traces each
- Five bounded abstract-model negative controls
- Actual HTTP/SQLite replay of all 22 witnesses and all six simulation traces
- Four independent production-source-copy negatives
- The fixed 52-test driver/HTTP/report regression roster

Every process uses the existing process-group runner, including actual replay. Each stage has a declared timeout and a 1.5-second process-group kill grace. Adapter step and cleanup deadlines remain active. An overall timeout or interruption preserves partial logs and cannot pass. No browser process, paid provider call or production debug endpoint is used by this profile.

## Source and evidence binding

The report records the original execution directory, executable, tool cache, commands, stage limits, tool versions, source SHA and dirty state. Content hashes cover every tracked/nonignored source input and actual generated server/vendor outputs. The built runtime's own diagnostic build identity and source-map contents are checked against the source. Every stage records input identity before and after execution; the final report repeats the end binding. Dirty development runs cannot serve as release evidence.

The reader rederives the checked-in plan, command arguments, witness names and artifact paths. It hashes raw artifacts; checks complete TLC/Apalache output; and requires the complete named nested TAP body, numbering, plans and footer. Summary counts and cached pass flags are insufficient. Retained evidence can be moved: commands remain bound to the recorded execution origin, while source/model/build content is checked against the current target checkout. It is never relabeled with a new source SHA.

Each replay is tied to its exact ITF file digest, normalized trace digest, configuration, expected state and observed action/actor/argument. The reader independently revalidates full HTTP/SQLite observations and their ordered event times. Each ordinary observation must satisfy the durable helper, including exact client delivery and preparation semantics, full transaction deltas, original stale evidence and unrelated rows.

The four implementation negatives use normal witnesses:

- `rawFingerprintConflictTest` → `bypass_fingerprint` → `exactReplay`
- `receiptRollbackTest` → `non_atomic_receipt` → `atomicRollback`
- `revisionRecheckTest` → `bypass_revision` → `revisionRechecked`
- `anchorRecheckTest` → `bypass_anchor` → `anchorsRechecked`

All observations before the first divergence must pass the normal helper. The final observation must pass a narrowly defined independent full-table negative check for the specified violated property. The report requires `implementation_mismatch`, a complete first-divergence counterexample and successful cleanup; `driver_cannot_replay` never passes. Mutated and runnable source hashes are independently reconstructed from the exact allowed source edits and original execution root. The actual non-atomic receipt mutation leaves changed business rows and a running receipt after failure. It is not equated to the abstract partial-rollback mutant, which may fail on a no-op.

## Scope

This evidence supports HW-07-07 through HW-07-10 only for the declared bounded protocol and actual replay scope. The separate KEJ-70 interval/Unicode proof and generated SQLite coverage remain required. Actual list/detail/graph/reopen browser evidence is separate. The report always has `fullProjectAcceptance: false`; it makes no unbounded, liveness, hash-collision, process-kill/power-loss, paid-provider or real-device claim.

## Actual browser boundary

The separate `verify:name-browser` profile records six actual editor/list/detail/graph scenarios at 1280px and 390px: held commit plus double submit, successful receipt recovery after a real commit followed by proxy 502, unavailable receipt after committed proxy 502 or lost response, real receipt-write rollback followed by explicit Unicode-name retry, and cancel/no-op. The rollback retry includes a fullwidth name with repeated whitespace; independent table normalization uses NFKC and whitespace folding. A production editor source copy removes only the `save` busy guard; two actual requests reveal the extra submission. No model-only flag substitutes for the browser.

The browser raw reader independently checks all full-table deltas, immutable identities/stale supports/unrelated listening, actual submitted bodies/UUIDs/receipts, visible draft/control states and list/detail/graph names. It binds the three actually loaded source modules, source/build bytes before and after, precise child commands and complete named HTTP TAP. Generic results keep exactly observations.json and worker.log; all thirteen screenshots plus browser.json are separately hashed and reread. The shared 150s child budget reserves 30s of the parent180s deadline for cleanup/reporting.

The Node contract fixture explicitly synthesizes UI observations around real HTTP/SQLite transactions. It is only a reader regression and is never evidence that Chromium or a physical device ran. Actual browser acceptance requires the separate current-source CI artifact.

The first genuine browser run exposed a view synchronization defect: after a committed save lost both its response and receipt lookup, reopening read the new name into the editor while the surrounding list still showed the old name. The editor now invokes its existing view-refresh callback when that guarded read returns a different canonical name, without another write. Actual-editor HTTP regressions cover the lost-response path, unchanged names, stale reads after a listening switch and refresh failure; the new fields remain available even if the surrounding refresh fails. The browser's list/detail/graph assertions remain required.


## Replay deadline hierarchy

Each of the 22 real witnesses is an independent top-level test with the original 30-second per-test limit. The two witness-generating compiler calls each keep their 20-second cap, share the file's absolute 80-second work/cleanup deadline, and have a 45-second hook ceiling. Real replay test groups share at most 25 seconds including cleanup inside their 30-second test ceiling; grouped negatives do not reset that deadline per case. The file watchdog remains 90 seconds. The complete serial driver stage has a 90-second shared process budget; its deadline is passed to every child file, rather than restarted for each witness. The overall profile remains 480 seconds and all model domains, exploration limits and depths remain unchanged.

Replay startup (15 seconds), each action/projection (15 seconds), and cleanup (5 seconds) are capped by one absolute per-trace deadline (at most 60 seconds) and the inherited remaining file/stage time. Cleanup is reserved before actions start. A factory resolving after startup timeout is still owned and closed; if the cleanup deadline expires, the result stays explicitly unverified even when a late-close handler later succeeds. The outer process-group watchdog remains the final bound for a never-settling factory. Real HTTP-resource regressions cover slow startup, late factory completion, cleanup expiry, and cumulative action timeout. A timed-out stage never starts a later stage.
