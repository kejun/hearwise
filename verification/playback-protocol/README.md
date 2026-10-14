# Playback protocol: exact finite scope

KEJ-75 / specification 1.0. The formal cards HW-08-02 through HW-08-05 are
independent of the existing HW-08-01 umbrella card and of browser/device results.
They do not turn the entire HW-08 or KEJ-61 acceptance green.

## Reproduce

Use Node 24, `npm ci --ignore-scripts`, `npm run build`, and the pinned existing
`node scripts/setup-relation-protocol.mjs` tool installer. Then, from this checkout:

- `node scripts/verify-playback-protocol.mjs --release`
- `node scripts/verify-playback-protocol-report.mjs DIRECTORY --release`
- `node scripts/verify-playback-protocol.mjs --release --deep` is a separate,
  optional deeper bounded profile. A fast report never proves the deep profile.

`QUINT_HOME` defaults to `/tmp/hearwise-quint`. `PLAYBACK_PROTOCOL_EVIDENCE_DIR`
can select a directory outside the source tree. The default is the already-ignored
`verification-evidence/playback-protocol`. Each run gets a new directory. The
report and raw artifacts bind the exact Git source SHA, clean state, model,
actual adapter, production boundaries, regression driver, lockfile and toolchain.
There are no paid provider calls. Browser and audible-quality checks are separate.

The default full runner has a 480-second parent deadline, 60-second TLC/witness/
simulation/negative/driver process deadlines, 240-second bounded-check deadlines,
and process-group cleanup. Each in-process real replay action has a 3-second
bound; the adapter's cleanup has its own bounded settlement and restores globals.
Regression commands run in the repository directory, not the evidence directory.
The optional deep run has its own 1,200-second parent bound. Interrupted, timed
out, incomplete or missing evidence fails closed; a longer budget is not a retry
policy for making a failed run green.

## Three complete finite configurations

All legal enabled transitions in each configuration are enumerated by TLC. No
fixed scenario routing, random sample or successful witness substitutes for that
complete exploration. Apalache checks the same labelled configuration to the
reported depth; this is bounded checking, not induction.

| Configuration | Owners | Records / start | Provider PCM allowance | Claim |
| --- | --- | --- | --- | --- |
| `single` | 1 | A or B, position 1 or 2, paused or unpaused | Two units | Full finite accepted-text suffix and consumption, pause/resume and frame rejection |
| `pair` | 2 | A or B, position 1 or 2, paused or unpaused; seek/switch allowed | At most one PCM per owner | Concurrent old/new owner, provider completion, paused seek, late unlock/resume/settlement, frame ownership |
| `aba` | 3 | A only, position 1, unpaused start; no seek/record switch | No PCM | Same-record rapid three-owner wire-ABA control; explicit pause/resume/stop and late callbacks remain |

Both records contain two archived SQLite translations: A = `甲。`, `乙。`;
B = `丙。`, `丁。`. Position 2 accepts only the final unit. A successful provider
unit emits exactly one two-sample frame before completion. It may ignore close
and deliver that frame/completion after cancellation. There is one explicit
resume per run, one initial explicit/system pause credit, and a second pause may
cancel the pending resume. Starts are bounded by the owner count. Legal waiting
is allowed forever, and there is no unbounded liveness or fairness theorem.

The wire is accelerated to modulus 2 through a checked copy of the actual
controller; local owner objects never repeat. An A-to-B start executes both the
record-change stop and start's stop, so even the two-owner domain can have equal
wire epochs. `oldProviderAfterSwitchTest` explicitly requires that equality,
zero old transmitted frames after late provider output, and completion of the
new record's two units. The real uint32 maximum/wrap and JavaScript safe-integer
boundaries are separate implementation contracts, not inferred from this model.

The broader three-owner/one-PCM domain was probed and did not finish in 60 seconds,
even after removing trace labels from state identity. The broader three-owner/
zero-PCM domain also did not finish at that limit. Those remain incomplete;
`cost-probes/` preserves the raw logs, and `cost-probes.json` records the scope and
last available progress. The final narrower same-record `aba` domain is not a
pass for either wider domain.

## Label quotient and checked implementation correspondence

`configurations.qnt` and `complete.qnt` import exactly the same protocol,
constants, guards, business-state updates and Safety predicate. The sole
semantic difference is `TRACK_ACTIONS`: TLC erases `lastAction`, `actor`, `choice`
while labelled ITF retains them. These variables are never read by an action
guard, business update or Safety predicate. Erasing them maps every labelled
transition to the same business transition; conversely the same enabled action
choice constructs a labelled transition for every erased one. Structural
regressions require this independence and exact module equivalence after only
module-name/flag normalization. No provider, callback or fault transition is
removed by this quotient. TLC, BMC and negative source modules are in separate
files to stay below the tool's RPC JSON-size limit; they share `protocol.qnt`.

Actual replay uses the existing `test-support/playback-protocol-adapter.mjs`:
real `createSpeechController`, `SpeechPlayer`, the actual AudioWorklet processor,
`SpeechBuffer`, `createSpeechService`, and a temporary file-backed `ListeningStore`.
Only browser-platform scheduling and provider completion are controlled. Every
expected projection comes from Quint ITF, never a JavaScript model transition.

- `start` and `seek` preserve the actual controller's stop/start boundaries.
- `unlock` is the initial native AudioContext await; a retired owner stays closed.
- `pause` permits an already-inflight provider request to finish, but prevents
  starting the next synthesis. Seeking while paused creates a paused player.
- `resume` begins a native await. The controller remains paused/resuming while
  `SpeechPlayer.paused` becomes false. `resumeComplete` is separate; a later
  pause/stop/replacement invalidates that continuation.
- `pcm` and `complete` are distinct provider events. Accepted text is sent at
  request admission; a unit-end is separate from accepted text and frame receipt.
- `consume` executes the actual 6,000-sample worklet render and progress event.
  A completed first unit can let that same render consume one sample of a
  following unfinished unit. The model preserves this distinction; received,
  consumed and buffered samples are not conflated.
- `settled` awaits the actual final device-drain promise. The service can be
  finished and provider-closed while the controller is still enabled. A late
  settlement must not stop a newer owner.
- `late` includes suspended/error/player callbacks and socket close/error.
- `frame` injects wrong epochs, reordered/interleaved units, malformed sample
  counts and a duplicate of the first actual frame. Wrong epochs are ignored;
  malformed current-owner frames stop locally before server acknowledgment.

Per step, raw attachments include real SQLite transcript rows and identities,
provider request text/owner/emitted/completed fields, actual incoming/outgoing
messages, native context and pending-resume state, player/worklet sample counters,
actual server-emitted binary headers/payload, and controller observations. A
read-only wrapper records each real server `client.send` Buffer and forwards the
same bytes unchanged; direct malformed-frame injections remain separate trace
inputs, not invented server packets. The gate checks header owner/epoch/unit/frame,
2-sample/20-byte shape and the fixture PCM payload, freezes SQLite and owner
identity across steps, requires append-only message histories, and rejects
contradictory error events in this successful-provider domain. It independently
reconstructs the projection and validates the raw records/text/owners/frame counts. Cached `actual` and an
empty violation list cannot substitute for raw observations. This is evidence
consistency checking, not a cryptographic proof that an arbitrary fabricated log
came from a trusted machine.

## Witnesses, negative controls and limits

The 19 deterministic witnesses have fixed names and seed 42. The separate
`isolation_witnesses` domain permits three owners and two PCM units per owner;
these are fixed reachable traces with actual replay, not complete exploration of
that wider domain. Simulation uses seed 20261014, 100 samples of up to 24 steps
per finite configuration, and replays five selected ITF traces per configuration.
The report states the seed, sample count, selected count and observed step totals.

Four expected-failure models break old-owner callback isolation, accepted-text
retention, paused seek, and wrong-epoch frame ownership. Their raw ITF must show
the exact registered violation. A separate actual controller-copy mutation
removes its owner fence; the ABA witness must diverge at the old suspended
callback with owner 3 still active and unexpectedly paused. This is an actual
production-source negative control, not a JavaScript model-only fake.

The gate rejects missing/stale source or model data, altered raw files even when
rehash metadata is changed, missing source traces, wrong semantic hashes,
wrong counterexamples, changed command/model/depth/driver counts, skipped/todo/
cancelled/missing TAP, and nonterminal tool outcomes. The driver has an exact
checked-in test count. Synthetic gate-unit checker logs are labelled TEST ONLY
and are not delivered as formal execution evidence.

Unicode, whitespace/markup normalization, long text, source rewrites, uint32
bounds, Qwen response-ID ownership/history rotation, browser wiring and real
WebSocket frames have separate actual-implementation tests owned by KEJ-75.
Qwen's one-inflight/first-unseen response-created assumption is not proved here.
No result here proves arbitrary text, arbitrary audio batching, arbitrary sample
rates, audible quality, real devices, live-provider semantic quality, process
crash recovery or the full project acceptance.
