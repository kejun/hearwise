# Name protocol implementation replay (KEJ-71)

## Boundary and reproduction

`test-support/name-protocol-adapter.mjs` uses the existing synthetic speech fixture,
actual server HTTP routes and a real temporary SQLite database. A test-only proxy
holds each outbound POST before forwarding and each complete upstream response
before delivery. It never pauses inside synchronous SQLite transactions. The
`transaction` action releases one complete HTTP handler call. Faults are actual
SQLite triggers installed before that call, removed after it returns. No provider
request is allowed. Lost responses destroy the downstream connection; proxy 502s
carry non-JSON bodies; recovery uses the actual receipt GET and editor response
parser. Refresh is a real snapshot GET, not browser acceptance or process crash
recovery.

Run the existing bounded Node runner after installing this checkout's locked
dependencies and building:

```sh
npm ci --ignore-scripts
npm run preflight
npm run build
node scripts/run-tests.mjs test/name-transaction.test.mjs test/name-protocol-http.test.mjs test/name-protocol-replay.test.mjs
```

The replay regression generates all 22 current Quint witnesses using the locked
TypeScript backend, fixed seed 71, and one sample per witness. It normalizes their
actual ITF output and compares every action against the HTTP/SQLite adapter. It
does not synthesize expected projections from implementation output. These tests
do not replace the separately required complete TLC, bounded Apalache, seeded
simulation, interval proof/differential, browser or final evidence-profile runs.
The previous model-only report remains tied to its original source.

## Independent durable check

`scripts/lib/name-protocol-durable.mjs` exports:

- `inspectMatchedNameDurable(observation, config, previousObservation?)`: returns
  `{ok, reason}` after checking the raw evidence independently of cached adapter
  booleans or error claims.
- `validMatchedNameDurable(...)`: boolean version of the same gate.
- `inspectNameBusinessTables({baseline, tables, identities})`: browser/HTTP-only
  business check returning `{ok, violations, projection}` without model ordinals.
  Identity keys are `listeningId`, `itemId`, `segmentId`, `unlinkedId`,
  `unrelatedId`, `staleId`, `cameraId`, and `factId`.

Every replay observation includes the original complete table inventory and
rows, actual snapshot, exact posted name/revision values, upstream response,
operation IDs, and full before/after tables and snapshots for every action.
The gate verifies history continuity and independently constructs each permitted
full-table delta. All other tables, columns and rows must be unchanged. It checks
receipt fingerprint/input/scope/state, immutable first receipt on duplicates,
transaction rollback, original stale support IDs, entity/endpoint identities,
unlinked source and all other-listening descendants. Snapshot revisions are
recomputed from raw-bound business fields; receipt commit ordinals are recovered
from first actual commits rather than trusted from adapter counters.

Name text and UTF-16 support coordinates use the independent KEJ-70 reverse-splice
reference, not the production replacement function. The replay domain has three
ASCII names and one historical invalid stale support, four active supports, two
linked items, one fact, one assertion and a separate listening. The browser
business helper accepts arbitrary replacement strings within the existing
reference matching domain. It validates all active hashes, bounds, quotes, active
IDs and original stale rows. It does not independently authenticate fabricated
files or prove the entire Unicode matching table.

A background translation update invokes existing SQLite triggers: the listening's
graph revision increments, the affected relation window becomes dirty and its
revision increments. Those exact changes are checked, including the trigger's
millisecond timestamp within the observed update interval (2 ms tolerance for
SQLite `julianday` conversion). Active support invalidation is a separate
background action and does not change the knowledge revision. `protectedRecords`
being constant true in the abstract model is an assumption; the raw-table checks
and corruption regressions supply implementation evidence for that obligation.

## Classification and negative controls

`scripts/lib/name-protocol-replay.mjs` exports `normalizeNameTrace`,
`validateNameTrace`, `replayNameTrace`, and `expectedNameMutationViolation`.
Outcomes distinguish `matched`, `implementation_mismatch`, and
`driver_cannot_replay`; abstract negative witnesses are separately classified
`model_property_violation`. A mismatch records the first divergent prefix. Missing
observations, unsupported ITF, timeouts and failed cleanup never count as success.

Real source-copy controls are executed only in isolated fixture children:

| Source-copy mutation | Genuine normal witness | Expected detection |
| --- | --- | --- |
| `bypass_fingerprint` | `rawFingerprintConflictTest` | Different raw name string incorrectly accepted as duplicate |
| `non_atomic_receipt` | `receiptRollbackTest` | Modified name plus actual receipt-success SQL failure leaves writes and running receipt |
| `bypass_revision` | `revisionRecheckTest` | Changed translation revision incorrectly accepted |
| `bypass_anchor` | `anchorRecheckTest` | Invalid active source hash incorrectly accepted |

The split-transaction control is deliberately not declared equivalent to the
abstract `partial_rollback` or `receipt_without_commit` mutant state. It replays a
normal changed-name rollback witness and verifies the real partial durable output.
Production source is never modified by these controls. Raw-evidence corruption
regressions separately ensure false passing projections cannot hide changed
stale/scope/identity/source/support/receipt records.

Receipt lookup precedes revision and busy admission. A distinct direct storage
regression verifies an exact original input and operation ID return the original
receipt even after a newer name correction and while busy. Altering the original
raw name string (including padding) or revision rejects the same ID with 409.
Fingerprinting uses parsed raw name and revision values, not whitespace or key
order in the JSON HTTP serialization. Normal UI saves use fresh UUIDs; a recovery
GET proves the stored operation's outcome, not success of a deliberately mismatched
retry body.
