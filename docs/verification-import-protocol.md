# Import preview/commit protocol (KEJ-72)

This verifies HW-09-02/03/04 with an independent Quint model, complete finite TLC
exploration, bounded Apalache checks, and actual HTTP/SQLite trace replay.
HW-09-05 additionally requires real Chromium evidence. A Node/model report never
claims browser or whole-project acceptance. The original HW-09-01 pilot is unchanged.

## Reproduce

Use Node 24, `npm ci --ignore-scripts`, Java 21 and the checksum-pinned toolchain:

```sh
npm run setup:relation-protocol
npm run verify:import-protocol -- --release
npm run verify:import-protocol:report -- verification-evidence/import-protocol/run-... --release
# Optional separate profile; an absent or interrupted deep report is not a pass.
npm run verify:import-protocol -- --release --deep
npm run test:browser -- import-protocol
```

`QUINT_HOME` selects the shared installation directory. The importer uses the same
fixed Quint 0.33.0, Apalache 0.62.1 and bundled TLC 1.8.0 as the relation and knowledge
protocols. It does not introduce an independent downloader or unpinned dependency.

## Model boundary and finite domains

`verification/import-protocol/config.json` declares every bound, witness, seed,
profile and exclusion. TLC must finish both domains with an empty queue:

- One independently uploaded token, then two independently uploaded tokens.
- Two successful preview generations per token, two external child-row writes
  (either connection independently), one process restart and one post-write fault.
- Both append and replace, all enabled request modes/generations, expirations,
  writes, token interactions and orderings; these are not fixed test scripts.
- Fast Apalache depth 8 and independent optional deep depth 12. Neither bound is an
  unbounded proof. Simulation uses seed 20261014, 100 samples per domain and five
  selected traces per domain. Thirty named witnesses are exported and replayed.

Revision hashes are abstracted by equality. Once an actual write changes the
current revision, every obsolete preview revision is quotiented to -1; all future
revision comparisons and public client metadata are preserved. No SHA injectivity
claim is made. The implementation still uses its actual revision hash.

The cost probes in config are sizing data, not final acceptance. Earlier incomplete
90-second TLC and 180-second Apalache probes remain explicitly recorded as such.
Every source-bound release report must establish its own complete results.
The import profile has a fixed12-minute fast or20-minute deep outer deadline;
TLC single is capped at60seconds and two_tokens at240seconds. Existing63/64
budgets are unchanged. CI gives this separate fast-profile job20minutes including
tool setup and failure artifact upload; it does not silently run the deep profile.

## Connection to actual implementation

The public server retains upload tokens in its process-local Map. A preview rotates
its opaque preview token and stores the current import revision. Commit checks the
mode and preview token and always supplies that stored revision to the storage API.
The storage API's optional direct-function argument does not make it optional over
HTTP. The negative implementation control changes exactly that production call
site in an isolated server copy, omitting `revision: pending.info.revision`; it
records source/mutated/runnable digests and detects an erroneous 200 plus real
persisted import at the first divergent step. It is not a toy implementation.

Request-body/upload awaits occur before each modeled HTTP action. Qualification,
SQLite transaction, consumed assignment and `discardImport` Map deletion execute
synchronously; deletion happens before the cleanup function's first await. The
model therefore uses one commit linearization step, with asynchronous filesystem
cleanup represented as a stutter. It does not invent an interruptible midpoint.

Expiry means delivery of the actual production 900000-ms callback. A test-only
child preload captures this callback, records its original requested delay and
executes it on command. It does not replace the expiry branch or add a production
endpoint. Preview registers no new timer. This proves behavior after callback
delivery, not a hard wall-clock deadline, timer fairness or eventual delivery.
Restart is a genuine server SIGKILL followed by a new process on the same database;
client-held tokens remain and the new server rejects them with 410.

The replay adapter sees public HTTP status/code, returned preview metadata and raw
SQLite rows. Normalized initial listening ID is 0; token t's backup ID is t+1.
The model gives each token a distinct backup not initially present, so its successful
commits change the database and skipped counts are zero. A separate actual HTTP
regression re-uploads an already imported backup: append returns changed:false,
preserves every business row, and leaves another token’s existing preview usable.
This no-op path is implementation evidence outside the finite unique-backup domain.
Client-generation numbers represent the actual opaque tokens returned by HTTP.
Internal Map state and modeled revision counters are never read or reconstructed
as observations. Same-connection mutation uses the public local-name replacement
endpoint and changes child content; other-connection mutation uses a separate raw
SQLite connection to change a fact. Parent `updated_at` is not the test oracle.
These exercise actual `total_changes()` and `PRAGMA data_version` invalidation.

Every rejected modeled HTTP action compares all business tables and schema before
and after, plus FK/integrity results and actual provider call counts. One controlled
fault throws at real SQLite COMMIT after production writes; the production catch
executes ROLLBACK. Rollback preserves rows but advances total_changes, so retry with
the same review must be stale and an explicit re-preview permits recovery. This is
a protocol boundary witness; complete import crash/trigger atomicity remains KEJ-73.

Concurrent duplicate real HTTP requests produce exactly one 200 and one 410. Model
interleavings abstract those completed synchronous critical sections, not arbitrary
external writes inside SQLite's transaction lock.

## Imported unfinished work

Separate real HTTP tests import backups containing unfinished translation,
extraction, relation rounds/jobs and knowledge edits in each mode. They query the
persisted failed/cancelled/paused outcomes, restart the process and query again.
Every ASR/MT/TTS endpoint is redirected to a local counting HTTP/WebSocket stub.
The actual request count must stay zero. These tests do not rely solely on final
job labels or absence of a UI spinner. Constructor recovery can update unrelated
waiting-key flags, so restart comparison uses the explicitly asserted stopped work
fields rather than falsely claiming byte-identical whole-database restart.

## Evidence and negative controls

The dedicated report includes exact source SHA/dirty state, declared-source digests,
model/config/lock identity, fixed tool versions, commands/bounds/time budgets,
start/end times, exit/signal/timeout/interruption, logs, traces and artifact hashes.
All declared sources are rehashed at the end, including dirty-to-dirty changes.
The independent report validator recomputes the checked-in plan, required trace
counts, public projections, source identities and negative controls; cached `ok`
flags cannot supply missing evidence. Only clean source can pass `--release`.

Three model mutations must produce their specific counterexamples: omit revision
qualification, retain an expired token after callback delivery, and retain a usable
token after successful commit. The last deliberately removes both consumption and
immediate Map deletion defenses; removing only the consumed assignment is equivalent
while the Map entry is still deleted and is not advertised as a killed mutant.

The actual server revision-omission mutation must diverge on the exported
`staleOtherConnectionTest` trace at the stale commit. Replays retain immutable raw
SQLite/HTTP observations, first divergence, and its shortest failing trace prefix.
Malformed traces, missing/changed artifacts, stale source, partial TLC, interrupted
runs, skipped regressions and wrong-domain counterexamples must fail closed.

Browser evidence is separate and required in CI. The cloud checkout cannot start
Chromium under its current sandbox, so local authored browser checks are not called
passes. CI must execute them against the actual UI/server and retain screenshots
and raw observations. No local sandbox bypass is used.
