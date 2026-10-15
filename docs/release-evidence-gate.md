# Change impact and release evidence (KEJ-86)

This implements HW-15-10/11/12 under the original enhanced-verification v1.0 specification. Inventory is not evidence. Reports retain their original source and finite scope.

## Fixed purposes

- `foundation-demo` requires actual current relation-protocol Quint/SQLite replay and revision Lean/JavaScript bridge reports. A successful demonstration explicitly has `fullProjectAcceptance: false` and is not PR/release approval.
- `pr` requires all eighteen current technical suites: complete Node file discovery, pilot, all twenty Chromium profiles, relation protocol, knowledge protocol, revision, name-interval, import protocol, edit protocol, process-crash recovery and offline quality infrastructure, playback protocol, scheduler protocol, offline semantic review infrastructure, import atomicity, name protocol, cancellation generations, and isolated installation/historical upgrade recovery. All existing CI jobs remain unconditional; the offline aggregation job additionally requires the import/edit/crash/playback/scheduler/name artifacts plus the dedicated install-upgrade artifact, semantic summary and Node-only atomicity report inside the existing Node artifact. No paid service is invoked.
- `release` requires the same technical suites plus all fifteen original business domains and the separate real ASR/MT/knowledge/relation/TTS quality, performance, physical-device and upgrade/recovery obligations. On this baseline those whole-domain/external validators or frozen thresholds are not registered. They remain `not_run`; full release cannot pass. Unmerged local branches are not capabilities of this baseline.

Purpose is explicit in every output. Switching to `foundation-demo` cannot produce a release-eligible result. Unknown suites, missing/duplicate reports, unsupported profiles and ambiguous artifact discovery fail closed. Every submitted attempt is checked: a failed or incomplete deep report cannot be hidden behind a fast pass.

## Impact and history

`npm run verify:impact -- --base FULL_BASE_SHA [--profile fast|deep]` traverses every commit and every merge parent. Renames, deletions, dependency changes and A→B→A changes remain visible. Unknown paths/ancestry expand to all fifteen domains. Shared runtime changes include security/performance; CSS includes interaction/security/performance. Ordinary documentation adds no semantic domain and never schedules paid/device checks. Existing required CI remains required even for docs.

Historical entries are optional supplemental `historical` rows in the manifest. The relation-protocol, knowledge-protocol and revision suites support historical validation. Legacy name-interval reports do not record a verifiable execution origin, while their runnable mutation hashes contain absolute source import URLs. Cross-checkout reuse is explicitly unavailable (`original_execution_origin_not_recorded`); current-source name-interval acceptance remains available. The capability output exposes this limitation, and the reader does not relax runnable-hash validation to accept such legacy reports. The reader obtains the original source from the report, checks actual Git ancestry and the complete impact chain, and revalidates the original artifacts in an isolated detached worktree. It also requires an identical conservative non-document source dependency closure, policy, models, tools, configuration, corpus, technical-threshold scope and environment. Actual runtime/environment bindings come from the validated original report; expected bindings come from the explicitly compared target environment. The current reader machine cannot overwrite the original measured OS, architecture or kernel. This intentionally rejects some harmless changes rather than guessing a missing dependency. The temporary worktree is cleaned after validation.

The current reader is used only with this identical source closure. Historical output preserves `originalSource`, labels `sourceMode: historical`, and explains continuing applicability. It does not rewrite SHA, claim a rerun, or replace mandatory current-source PR reports. Missing objects, changed/unknown context, dirty sources or an unsupported external measurement validator refuse reuse. Merely supplying matching hashes or a cached passing verdict in a manifest grants nothing.

## Raw evidence contracts

- Node/browser runners bind source content and built server/vendor outputs before and after execution, complete logs, actual argv and execution status. Actual disabled-runtime diagnostics bind embedded build SHA/dirty/instrumentation to the checkout; stable old bytes cannot pass. Native Node reporter events bind TAP body/plan/footer, parent/child numbers and actual entry/helper locations; stdout JSON cannot impersonate this channel. Node clears inherited `NODE_TEST_CONTEXT`, explicitly emits TAP, preserves the shared `testExecutionPlan`: four ordinary workers, 30s test deadlines, 90s ordinary-file watchdogs, and 190s watchdogs for the three nested profile drivers. Recorded start/end times independently enforce exclusive barriers and the four-worker bound and rejects a selected subset as full coverage.
- Browser aggregation requires all twenty registered profiles, known screenshot files and hashes, and complete nested session/relation-result/security/import/edit/trace-business/playback/import-atomicity/name/user-journey reports. Those nested readers reparse full TAP, bind raw child tails/worker logs, inspect concrete desktop/narrow observations, verify the strict two-artifact generic contract and all referenced assets. The journey additionally binds one continuous SQLite store per viewport across its 35 UI checkpoints and explicit backup restoration. Synthetic contract tests do not claim Chromium ran.
- Formal evidence retains the existing profile gate, then checks exact commands, model files, tools, seeds, sample counts, depths, expected negative exits and resource budgets. It independently reconstructs real relation/knowledge projections from raw durable observations, validates budgets/ledgers/terminal state and knowledge preservation, and requires actual negative expected/actual disagreement.
- Import evidence additionally binds immutable original backup snapshots, every imported table row, cumulative HTTP/lifecycle/clock histories and actual production mutation source. Its 42 regression tests (24 top-level, 18 nested) are matched as a full TAP tree in Node’s actual lexical file order. Import fast retains its actual 720s limit and two-token TLC240s limit.
- Import-atomicity evidence reuses the strict raw SQLite/HTTP crash-boundary matrix, all 36 regression TAP bodies, actual controls, runtime identity and browser observations. The release adapter derives the Node origin from the current repository root and the fixed Node-artifact run path. For the browser profile it derives the origin from the independently hash-bound outer log’s first line and the fixed outer/nested run paths. It requires the current root/executable, exact commands, artifacts, log tails and 55s child/150s shared/180s parent budgets. The original local report reader remains unchanged and still rejects moved reports; only this separate release adapter validates downloaded artifacts against the independently derived origin. Synthetic TAP/UI/PNG contract fixtures are not Chromium acceptance.
- Edit evidence binds the exact fixed 480s commands and all source/build digests, existing strict durable/ITF checks, and raw browser UI/table checkpoints for conflict, unknown close/reopen, rollback and late success. A requested deep edit profile is explicitly unsupported; the fixed report cannot substitute for a deep run.
- Process-crash evidence reuses the independent raw SQLite/HTTP/worker PID, boundary and immutable ledger validator for all 29 witnesses/28 actual SIGKILLs, then binds the precise commands and 36 regression names. Shared formal runs now bind all source/build bytes at both ends, including actual embedded build identity.
- Playback evidence reuses the complete raw controller/player/HTTP/SQLite validator and actual five-module browser provenance. It binds the fixed 28 formal regressions and 16/4/10 nested Node regressions as full TAP bodies, precise recorded commands, original execution roots and configured budgets. A moved artifact directory preserves its original execution origin; a different executable or output path is rejected.
- Name evidence directly reuses the strict domain readers for all 23 stages, complete 52-test nested TAP roster, full raw commands/cwd/model/input/build bindings, exact ITF and raw HTTP/SQLite replays, and actual production-copy negatives. The fixed 480s run retains two complete finite domains, depth-6 bounded checks, seeded simulation and 22 witnesses, with absolute stage/startup/action/cleanup deadlines. Its separate browser reader requires all six scenarios at 1280/390px plus the real double-submit negative, exact Node/browser commands, generic and nested asset hashes, full tables, HTTP/client observations and source provenance. A requested deep profile is unsupported. Older 47-test packages cannot pass the current contract.
- Scheduler evidence reuses the strict TLC/temporal/ITF and real scheduler replay validator. It adds exact command/cwd/budget bindings, chronological execution intervals, immutable raw assets, all 175 regression tests (136 roots with nested subtests), and replay-log cross-checks. The 90s Apalache diagnostic retains its measured outcome; a backend error is not a bounded proof and does not replace mandatory finite/temporal checks.
- Trace evidence reconstructs all real workflow/HTTP/WS business observations, two compiled production mutations, actual browser identities and six terminal labels; all eight HTML documents and the exported JSON are regenerated from raw inputs and compared byte-for-byte/content-for-content.
- Offline ASR/MT evidence rechecks real loopback collection, provider ledger and every trial/log. A technical infrastructure pass always retains `qualityStatus: not_run`, `qualityEvaluated: false`, and both real-quality property rows as not run. It cannot satisfy any external quality obligation.
- Semantic offline evidence directly reuses `inspectSemanticOffline` for all 11 real workflow captures, 56 raw assets, and eight deliberately incorrect synthetic outputs. The cached summary must exactly match the freshly reconstructed result. It remains `qualityStatus: not_run`, `qualityEvaluated: false`, `fullQualityAcceptance: false`, `releaseEligible: false` and zero live calls; HW-05-04 real-corpus/human-review acceptance stays not run.
- Lean evidence independently reads proof/oracle/axiom logs, current source hashes, concrete corpus projections and SQLite witness. Exact current 8/9 regression names and counts are required. Negative patches/source hashes/fixed witnesses are reconstructed; illegal-import before/after rows and boundary rosters are checked rather than trusting `detected` or `unchanged` flags. SHA collision freedom is not proved.
- Pilot independently checks the one real SQLite reservation/response/commit scenario. It is not general concurrency evidence.

The threat boundary is accidental mixing, stale/partial results and malformed or contradictory evidence from trusted execution. File hashes are not signatures, remote attestation or protection against an attacker fabricating an entire coherent evidence package.

## Frozen execution and methods

`verification/release/policy.mjs` records the existing budgets. Relation/knowledge/process-crash fast overall 480s/deep 1200s; import fast720s/deep1200s; edit fixed480s; ordinary commands 60s, bounded checks 240s (existing deep multi-case 900s); JVM 2 GiB. Scheduler retains 900s fast/1200s deep, per-check TLC deadlines, 60s ordinary commands and 90s regressions/diagnostic. Both Lean profiles retain independent 360s limits. Chromium retains 180s/profile and existing CI job limits. No domain/depth/timeout was reduced or inflated here. Deep is an explicit separate CLI run and never inferred from fast; its existing finite TLC domains remain unchanged.

Reports distinguish complete finite-state enumeration (with generated/distinct/queue/depth), bounded checking (exact bounds), seeded simulation, model witnesses, implementation replay/negative controls, Lean kernel proofs and finite JavaScript/SQLite differential evidence. Exclusions and assumptions remain attached. No unbounded induction, real semantic quality, physical audio/device or measured performance is inferred.

Cache keys bind fixed toolchain/lock/environment for compiled tools. Evidence identity additionally binds source, policy, profile and budgets. A compiled-tool cache is never a passing-report cache.

## Commands and demonstration

Run the existing build/tests and actual proof/model profiles first. Build once before parallel readers; evidence checks never download or execute proof tools.

```
npm test
npm run verify -- --release
npm run verify:relation-protocol -- --release
npm run verify:knowledge-protocol -- --release
npm run verify:import-protocol -- --release
npm run verify:edit-protocol -- --release
npm run verify:process-crash -- --release
npm run verify:generation-protocol -- --release
npm run verify:upgrade -- --release
mkdir -p verification-evidence
npm run verify:m1:report -- --relation RELATION_RUN --knowledge KNOWLEDGE_RUN --process PROCESS_RUN --generation GENERATION_RUN --release --output verification-evidence/m1-summary.json
npm run verify:playback-protocol -- --release
npm run verify:scheduler -- --release
npm run verify:name-protocol -- --release
npm run quality:asr-mt -- offline --release
npm run quality:semantic -- offline --release
npm run verify:import-atomicity -- --node-only --release
npm run verify:revision -- --release
npm run verify:name-interval -- --release
npm run test:browser
node scripts/release-gate.mjs --purpose=pr --manifest=MANIFEST.json --base=FULL_BASE_SHA --output=verification-evidence/release-summary.json
node scripts/release-gate.mjs --purpose=release --manifest=MANIFEST.json --base=FULL_BASE_SHA
node scripts/release-demo.mjs --relation=ACTUAL_RELATION_RUN --revision=ACTUAL_REVISION_RUN --output=verification-evidence
```

Manifest schema 1 contains `evidence: [{suite, directory}]`; paths resolve relative to the manifest. CI builds it from exact current-SHA named artifacts, refusing zero/multiple candidate reports. Optional historical rows have the same fields and are never trusted as validated output.

`release-demo.mjs` first requires the genuine current clean two-suite success. It then writes isolated, explicitly corrupted copies to demonstrate a raw regression failure and incomplete/timeout refusal. These copies are gate demonstrations, not additional formal executions. Original reports are untouched. All three outputs retain detailed causes, source, methods and remaining project gaps.

Real Chromium must run in CI. This task's local environment did not run Chromium. Current-source final evidence and independent review must be recorded separately from synthetic contract tests or reports belonging to earlier SHAs.

The earlier integration at main `2cf27f70` had sixteen technical suites and nineteen browser profiles. Those counts are historical: baseline `4631de0100d554ad9715cfdff2a1159156516e57` has eighteen suites and twenty profiles, including generation and install-upgrade. Final acceptance always requires evidence on the actual candidate, not an earlier integration snapshot. See [maintenance handoff](verification-handoff.md) for story coverage, actual three-state reproduction and remaining acceptance blockers.

Generation evidence reuses its complete 52-stage domain reader, including exact
native ITF identity, all 57 real replays, four negative boundaries and full TAP
rosters. Its thin release adapter preserves the fixed 35/70-minute profiles and
requires exact Node/SQLite runtime versions. M1 directly invokes the complete
relation, knowledge and process release readers as well; a cached passing domain
summary cannot substitute for its original durable frames. The aggregate waits
for the independent same-source AC-P01–P12 job but revalidates domain artifacts
itself rather than trusting that job's summary. Deep checks remain separate.
