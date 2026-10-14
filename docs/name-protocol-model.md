# Name-replacement protocol model (KEJ-71)

This is the finite protocol part of KEJ-71 / specification v1.0. It targets the
current manual `name-replacements` API and `knowledge-name-replacement.mjs`, not
legacy automatic regeneration. Property cards are HW-07-07..10; KEJ-70's
HW-07-02..06 coordinate properties and KEJ-69's editing/browser checks remain
separate evidence. Model success alone is not full HW-07, HW-11, or KEJ-71 acceptance.

The initial implementation base is PR #79 head
`271cd966a0d4eee13f69d53edd29828b6feb23b8`, tree
`6c7e8a5e46ffc9a2e077fe640bebff5972b02bd9`. KEJ-70 was already on main;
KEJ-69/PR #79 was not merged when this model was developed. That dependency must
be reconciled by the integration change and evidence rerun against its exact
committed source. The last pre-implementation main read was
`f3af525cb1284dff6e4508e7b930cdeb7bb99d3b`; it is not the model's target SHA.

## Finite domain and real boundaries

Both complete configurations have exactly two explicit HTTP-attempt slots,
operation IDs `{0,1}`, names `Deebo/Tibo/Mira`, no initial name override, and at
most one independent background event. They are not two independently mutable
client sessions with unbounded retry loops.

- `independent`: each attempt has its own operation ID and chooses a new or
  current name. Preparing both before either commits exposes stale-version races.
- `reuse`: the second attempt reuses the first ID with the exact original body,
  a padded raw name with the same trimmed target, or a changed revision token.
  Either queued request may execute first. Whichever actually commits first owns
  the receipt and its immutable fingerprint.

`prepare` freezes a body without sending. `send` represents an explicit POST,
then `transaction` executes the actual synchronous SQLite operation as one atomic
action. It includes the synchronous, best-effort notification before returning to
the HTTP handler. No transaction-internal await or network interleaving is invented.
Response delivery/loss is separate and can occur after another completed request.

Receipt lookup is first inside the transaction. Matching ID and exact raw-name /
revision fingerprint return the established receipt without rerunning current
revision or source-anchor checks. Matching an ID with a different fingerprint
rejects. A padded name is not fingerprint-equivalent simply because trimming
would produce the same target. This finite tuple abstraction does not prove
SHA256 collision freedom; the real adapter binds the tuple to the production hash.
Cross-listening/item/operation-type identity rejection belongs to actual API/store
regressions rather than the one-item finite domain.

Only a new operation checks the current knowledge revision. Changed linked source
text also checks active support hashes, safe-integer UTF-16 bounds and quote slices.
The `anchor` background event corrupts an active support while leaving knowledge
revision unchanged. The `revision` event changes a linked translation without
changing the canonical name. They are serialized between complete transactions.

Associated-write faults trigger only when a replacement actually changes data.
A no-op skips those writes and still succeeds with a receipt. Receipt-write faults
trigger on every new operation, including no-op. Exact duplicate replay reaches
neither write boundary. The two fault labels abstract classes of failures; the
implementation must separately test its concrete writes and deferred COMMIT
failure. SQLite reopen is not process termination or power-loss evidence.

## Projection and recovery meaning

`trace-contract.json` lists every field and action. The model uses the same ITF
variables `state/lastAction/actor/argument` as the editing protocol. Name/revision
ordinals are bound to actual persisted values by the adapter, not invented DB
columns. Associated/source/evidence generations are independently read and checked
against real rows. Receipt ownership and commit-time revision are observer
bookkeeping; no production schema fields are added.

`protectedRecords` is an implementation-boundary obligation. The finite model
assumes its scoped atomic operation preserves unrelated/stale/identity records;
it does not prove the SQL predicates or general UTF-16 algorithm. The adapter must
compare complete unrelated records, historical stale supports, identities and
relation endpoints after each action. Generated Unicode sequences and the KEJ-70
Lean/JS/SQLite differential provide the complementary coordinate/text evidence.

Lost and proxy-502 responses permit a GET receipt lookup. `reply=receipt` means
that the original operation identified by that ID was found. It does not certify
that a deliberately mismatched retry body succeeded. POST `reply=ok` has the
stronger exact-body meaning. The actual editor generates a fresh UUID for each
explicit save; adversarial ID reuse is an API negative, not its ordinary path.
Unavailable/missing receipt results stay unknown. A later explicit exact-body
POST is represented as the second attempt; there is no autonomous resend action.
`refresh` reads current persisted values even when an older response arrives late.

This is safety plus finite reachable-witness coverage. There is no liveness claim
under permanent network unavailability, no fairness assumption, no unbounded retry
proof, and no automatic promotion of protocol-driver behavior to actual browser
interaction evidence.

## Tools and repeatable commands

Use the checkout's own Node 24 dependencies. The existing pinned tool setup checks
Quint 0.33.0 and Apalache 0.62.1 archive/JAR hashes; the JAR includes TLC 1.8.0 and
Z3 4.14.1. Java 21 is required. Do not borrow another checkout's `node_modules`.

```sh
npm ci --ignore-scripts
npm run preflight
QUINT_HOME=/tmp/hearwise-quint node scripts/setup-relation-protocol.mjs
```

The integration runner should execute every stage in a unique evidence directory,
using absolute model/CLI paths and a fresh local server port. Reuse
`scripts/lib/process.mjs:runProcess` for per-stage deadlines and process-group
cleanup, and impose the configured 480-second overall deadline. These are direct
command examples; shell commands alone do not replace the runner's timeout wrapper:

```sh
ROOT="$PWD"
Q="$ROOT/node_modules/@informalsystems/quint/dist/src/cli.js"
M="$ROOT/verification/name-protocol"
for file in protocol configurations witnesses; do
  node "$Q" typecheck "$M/$file.qnt"
done
# Replace PORT with a fresh local port for each invocation.
QUINT_HOME=/tmp/hearwise-quint JVM_ARGS=-Xmx2G node "$Q" verify "$M/configurations.qnt" \
  --main independent --init Init --step Step --invariant Safety \
  --backend tlc --tlc-config "$M/tlc.json" --apalache-version 0.62.1 \
  --server-endpoint 127.0.0.1:PORT --verbosity 3
QUINT_HOME=/tmp/hearwise-quint JVM_ARGS=-Xmx2G node "$Q" verify "$M/configurations.qnt" \
  --main independent --init Init --step Step --invariant Safety \
  --backend apalache --max-steps 6 --apalache-version 0.62.1 \
  --server-endpoint 127.0.0.1:PORT --verbosity 3
node "$Q" test "$M/witnesses.qnt" --main independent_witnesses \
  --backend typescript --seed 71 --max-samples 1 \
  --out-itf 'independent-{test}-{seq}.itf.json'
node "$Q" run "$M/configurations.qnt" --main independent \
  --init Init --step Step --invariant Safety --backend typescript \
  --seed 2026101471 --max-samples 100 --max-steps 20 --n-traces 3 \
  --out-itf 'independent-simulation-{seq}.itf.json'
```

Repeat TLC/BMC/simulation for `reuse` and witnesses for `reuse_witnesses`.
`config.json` is the full stage/domain/timeout declaration: two complete TLC
configurations; depth6 BMC for each; 13+9 deterministic tests; 100 simulation
samples per configuration, maximum20 transitions and three retained ITF traces.
The initial state is step0; a 20-transition simulation has 21 states.

For each configured negative main, run Apalache with its declared `maxSteps`
and `--out-itf counterexample.itf.json`. A negative passes only when the backend
normally exits with a counterexample, the ITF file decodes, and its final state
violates the named property. An error, timeout, absent trace, or different
property violation is not a detected guard. Ordinary positive stages require
normal exit0 and complete backend output. TLC must report zero remaining states,
not just a bounded-depth progress line.

Quint 0.33.0's TLC path accepts `--out-itf` but does not actually write ITF. The
preserved TLC-negative probes have valid textual counterexamples but cannot
satisfy an ITF/replay requirement. The frozen negative configuration therefore
uses Apalache at bounds6/3/3/4/4. No TLA+ text has been hand-converted into ITF.

## Costs, evidence and limits

`name-protocol-cost-probes/manifest.json` preserves the development history,
including the failed initial CLI path, the failed shared init/step helper
translation, the old no-op fault candidate, and TLC's missing ITF export. None of
these is silently replaced by later success. Early logs without source digests
are development cost information only.

After correcting the real no-op boundary, complete TLC explored 58,387 distinct
states (`independent`) and 40,691 (`reuse`), both with zero remaining states and
complete graph depth15. Candidate depth6 BMC finished in 74.897s and 65.438s under
the already selected 120s stage limit. The domain was not reduced. No larger BMC
depth was attempted or claimed. Measurements choose a feasible bounded check;
they are not evidence for an unbounded protocol or another source SHA.

The final integration report must contain exact committed source/tree, clean-worktree
status, file/profile hashes before and after, tool/environment versions, complete
stage exits, actual state/sample/depth counts, seeds, exported ITF and artifact
hashes. All selected witnesses/simulation traces still need real SQLite/HTTP replay.
The scope-preservation checks, concrete transaction faults, production-copy
negatives, generated Unicode cases and actual browser list/detail/graph/reopen
results are distinct required implementation evidence. A missing or interrupted
stage remains missing/incomplete; model files existing is not acceptance.

After the original environment recovered, the same files produced 22/22 fresh
witness ITFs. Five Apalache-negative cost probes then produced independently
checked terminal counterexamples at the declared bounds: fingerprint6 (38.886s),
associated rollback3 (15.176s), receipt3 (15.253s), revision4 (16.506s), and anchor4
(20.129s). All had normal expected exit1, no timeout/signal, and a decoded final
state violating the intended property. Those pre-freeze runs still had a dirty
worktree and are preserved as cost/negative-development evidence, not release
acceptance. The source commitment and clean final run must be reported separately.
