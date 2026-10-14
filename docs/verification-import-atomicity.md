# KEJ-73: import and safety-backup atomicity

This profile extends HW-09 with HW-09-06..09. It reuses the actual KEJ-72 server,
import fixture, read-only full-table/schema snapshot and fetch-clone observer,
and KEJ-65's synchronous file-marker/parent SIGKILL approach. The original
Quint token/revision protocol remains unchanged and independently required.
This is implementation fault evidence, not a new finite-state or unbounded proof.

## Run

Use Node 24 and the repository's normal `npm ci --ignore-scripts`, build,
preflight, deterministic tests and browser setup. Each checkout owns dependencies.

```sh
npm run verify:import-atomicity -- --node-only --release
npm run verify:import-atomicity -- --release
npm run verify:import-atomicity:report -- verification-evidence/import-atomicity/run-... --release # Add --node-only for a Node-only report
npm run test:browser -- import-atomicity
```

The Node profile cannot claim settings-page acceptance. Full CI's existing
Chromium job runs the full profile, preserves screenshots and raw observations,
and remains separate from all existing Node/model/proof jobs. No paid service,
real credential, production test API, database schema or product behavior changes.

## Actual boundaries

Both imports first create their safety backup with `VACUUM INTO`. Restore then
attaches the prepared source, disables foreign keys before `BEGIN IMMEDIATE`,
drops normal product triggers inside the transaction, deletes/copies business
rows, restores triggers and checks foreign keys/integrity before COMMIT. Append
previews before backup, then begins its copying transaction with deferred FKs,
selects whole new listening IDs, copies their complete descendants with normal
triggers temporarily removed, restores triggers and verifies before COMMIT.

The test-only Node preload wraps real synchronous SQLite `exec`. It writes a
complete marker using temporary-file + rename and synchronously waits with a
12-second deadline. It never inserts an `await` into production code. The parent
observes the marker, kills the whole application PID with SIGKILL, verifies that
exact PID and exit signal, reads raw SQLite without constructing ListeningStore,
and then starts a new PID on the same database.

Five boundaries per mode:

1. Before `VACUUM INTO`: no backup has been created and no business writes began.
2. After `VACUUM INTO` returns: its actual standalone output is read and validated.
   This is before `exportDatabase`'s follow-on inspection, not an invented atomic
   file rename or a claim of power-loss durability.
3. After the first real business-table mutation: uncommitted partial rows and
   dropped triggers exist only inside the killed process's transaction.
4. Immediately before real COMMIT: all import writes remain uncommitted.
5. Immediately after real COMMIT returns: the imported projection is durable for
   a process crash, before the server consumes its token or replies over HTTP.

Raw post-kill rows/schema must equal the old projection at boundaries 1..4 and
all intended imported rows at 5. A new process explicitly maps only
`listenings.relation_waiting_key = relation_enabled`, as the production
`recoverRelationJobs` does for these completed fixtures. Import preparation
explicitly maps this same column to 0. Every other column is compared; task rows
are not blanket-excluded. KEJ-72 separately checks unfinished imported jobs and
zero provider requests across restart; those tests remain unchanged.

The successfully produced safety file is actually reuploaded and restored through
HTTP, then history is edited through the product API. File existence alone never
counts as a valid backup. The failed-backup scenario writes an invalid destination
at the real pre-VACUUM barrier, checks actual SQLite failure, no business mutation,
and production removal of the residue. A crash inside SQLite's own VACUUM engine,
partial device writes, fsync ordering, disk-full, OS crash and power failure are
not covered. No database-file byte-equality or exactly-once HTTP delivery claim.

## Failures and negative controls

- Actual `PRAGMA query_only=ON` is set only before the second business-table write,
  after one real mutation. SQLite returns READONLY (8), then production ROLLBACK
  is verified against all rows/schema. It is never a pre-backup rejection stub.
- A separate parent connection holds `BEGIN IMMEDIATE` after the successful safety
  copy. The child's actual transaction acquisition hits its unchanged 3000-ms
  busy timeout and returns BUSY (5). The parent releases the lock and explicit
  fresh-preview import succeeds.
- A late child primary-key collision rolls back earlier inserted listening/run
  rows; foreign-key ownership and schema conflicts reject before copying. Exact
  all-table snapshots include restored triggers and FK/integrity results.
- Each mode has two deliberately broken transaction controls: commit the first
  business mutation early, then either SIGKILL or let the next real write fail.
  The saved raw projection diverges at the first failing prefix. This actual
  SQLite mutation proves the all-or-nothing oracle can detect partial writes;
  no expected model state is written into SQLite.

The rich round trip covers historical runs, original/translated segments,
metadata, knowledge/aliases/facts/mentions, relation assertions/supports and
request/task status. The same-ID append fixture deliberately changes backup title,
notes and child content, then adds another listening. An independent ownership
projection reconstructs every admitted incoming row while preserving every local
row, rather than accepting a mere subset or comparing only listening counts.

## Evidence and limitations

The frozen matrix contains seven data cases and twenty process/fault/negative
cases. The separate regression command has exactly 36 tests. Its entire TAP log
is parsed by the repository's canonical parser; NODE_TEST_CONTEXT is removed
before spawning. The profile bounds each command and the whole run (150 seconds),
cleans child process groups, HTTP/WebSocket fixtures, locks and temporary files.
The synchronous barrier has its own deadline. Reports include exact commands,
start/end times, full exit/signal/timeout/interruption, source SHA/dirty and all
tracked/generated source hashes at both ends, Node/SQLite/OS, raw observations,
logs and artifact digests. Independent report reads reconstruct projections,
PID/signal evidence and SQLite error conditions rather than trusting cached ok.
The local release reader also requires the recorded cwd to equal the current Git
repository root and its recorded evidence directory to equal the actual directory
being read. Expected commands are built from those independently resolved paths,
not from the report's own path declarations. Moving a report therefore invalidates
this local execution-location check; it does not itself mean its evidence is
corrupt. Downloaded CI bundles can still be independently inspected for raw
projections, source/build identity, artifacts and screenshots, but are not claimed
to pass the original-path local release reader.
Release requires clean unchanged source. Missing, changed, cancelled, timed-out
or incomplete evidence fails closed; browser results are independently scoped.

Cloud Chromium was verified unable to start because socket creation was denied.
Local full-browser results therefore remain failed/unrun until supported CI
actually runs them; authored test code is not acceptance. This profile does not
claim power-loss behavior or supported real-device/platform coverage.

## Independent audit regressions

Audit of clean head 9dc166d found three report-reader gaps: erasing real boundary
events, contradicting a COMMIT marker's SQL/count, or retaining only a passing
TAP footer could still pass. Commit e3a6f72 preserves these as three failing
regressions (0/3, exit 1). Their original reports are retained separately.
The repair binds parent-issued command ID, child PID, complete ordered SQL
boundary events, exact mutation counts and the atomic marker. New lifecycle
observations record ready/start, confirmed SIGKILL and restart timestamps.
A test-only preload queries actual diagnostics.build from the same compiled
runtime module loaded by the server, disposes that probe, and retains each PID's
real compiled git_sha/build_dirty/instrumentation_version. No production endpoint
or paid task is added. Independent readers compare these with the target source.
The shared TAP parser is unchanged; this profile additionally requires all 36
frozen test names, contiguous numbers and complete result bodies. The actual
command, four test files, working directory, original time budgets and log tail
are bound to a shared checked-in contract. The raw-evidence controls also reject
missing boundaries, contradictory markers and stale compiled runtimes.
