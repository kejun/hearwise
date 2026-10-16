# KEJ-81: offline realtime baseline

This is a bounded measurement entrypoint, not complete KEJ-81 acceptance. It reuses
`speechFixture`, the production HTTP/WebSocket server, real SQLite, the existing
process-group runner and bounded fixture cleanup. No production API is added.
Only synthetic PCM/text and loopback ASR/MT/TTS are used. No vendor credentials,
paid requests, user content, microphone or speaker are accessed.

## Reproduce

Use the repository's Node 24 setup and development-workflow instructions.

```sh
npm ci --ignore-scripts
npm run verify:realtime-baseline
npm run verify:realtime-baseline -- --profile=smoke
npm run verify:realtime-baseline -- --profile=smoke --negative=retain-asr-socket
node scripts/verify-realtime-baseline.mjs --report=verification-evidence/realtime/<run-directory>
```

The negative must exit 1 with `negativeDetected: true`; it retains a real upstream
ASR WebSocket after stop by overriding only that transport's close in a test-only
preload. The same production stop flow and same cleanup observation detect it.
The outer process still terminates the server and removes the temporary SQLite.
A timeout, missing result or unrelated failure cannot count as this negative.

`verification/realtime-baseline.json` version 2 fixes measurement inputs before
candidate collection: baseline has three independent runs, 2 s warmup, a 30 s
continuous phase at four 3200-byte PCM frames/s, four stop/start cycles, four
switching runs with old background work still pending, a 12-sentence background burst, and export/replace-import then
continued use. Smoke uses a distinct abbreviated profile and is not comparable.
Each profile has per-operation, cleanup-observation and worker deadlines. The
3 s cleanup deadline is a measurement observation window, not an approved product
SLO. The baseline is intentionally short; multi-hour stability remains not_run.

## What timestamps mean

- `audioToCaptionMs`: client sends synthetic PCM to actual application WS, local
  ASR receives it, fixture emits deterministic final, client receives segment-final.
  Includes up to 10 ms driver polling overhead. It is not microphone-to-DOM paint.
- `finalToTranslationMs`, `audioToTranslationMs`: same client receives the final
  translation event. MT fixture delay is fixed at 20 ms.
- `finalToKnowledgeMs`, `audioToKnowledgeMs`: same client's knowledge-upserted
  event for the corresponding synthetic name. Not DOM paint or semantic quality.
- `*HttpObservedMs`: after consumer stop, the first HTTP detail query observing
  the completed translation/knowledge. These polling upper bounds are summarized
  separately, never mixed with WebSocket event latencies.
- Each run records `startToFirstPcmMs` from speech.start and `audioToFirstPcmMs`
  from its first synthetic PCM input to the first TTS binary frame received. This
  is a transport first-frame proxy, never actual audible first sound.

All worker timing deltas use one monotonic clock. Server resource sampling uses
its own elapsed clock plus UTC timestamps; do not subtract clocks across processes.
Warmup samples remain raw but are excluded from latency quantiles. Quantiles are
nearest rank, p50/p95/p99; reports include counts, min/max and every raw sample.
Phases include observed elapsed duration, input count and caption throughput;
post-stop draining is included in the reported phase elapsed duration.

## Resources and evidence

The test-only preload samples server RSS/heap/external/array buffers, cumulative
CPU user/system microseconds, Node active resource types and Linux file descriptor
categories every 100 ms. No descriptor paths are retained. Non-Linux descriptor
counts are unavailable/null. The sampler's own interval is unref'ed. Raw public
processing events and HTTP snapshots preserve pending translations, knowledge
jobs/buffers and relation status. These are observable workloads, not private
scheduler container instrumentation. Server logs retain Trace task lifecycles.
This is four synthetic 100 ms PCM frames per second, not continuous microphone
audio at full sample-rate throughput. ASR provider sockets are observed directly in the existing fixture. Quiescent
samples follow every stop/drain; all consumer sockets must close and the ASR
provider must have zero connections within the observation window. Every switching
run must observe pending work before stop, and every adjacent new record must
observe the previous record still pending after its own run opens. Each record
involved in switching gets its own post-drain resource checkpoint; readback binds
these observations to the actual phase, listening and run rather than accepting
checkpoints from unrelated phases. Version 2 uses the existing asynchronous model
fixture hook to hold each switching knowledge response until the next record is
open and the old pending work is observed; the final response releases before
drain. Each hold is bounded by the unchanged phase timeout and released in final
cleanup. This controlled provider scheduling is recorded raw and is not a real
vendor latency measurement. Version 1 reports remain historical and are not
comparable candidate baselines.

Reports live in `verification-evidence/realtime/<profile>-*/`; the integration
regression retains them under `test-evidence/nested-profiles/` for existing CI
artifact upload. Each report binds source SHA/dirty state, plan hash, lock hash,
actual runtime/OS/CPU, start/end time, child exit and hashes of raw artifacts:
`events.jsonl`, `resources.jsonl`, `server.log`, `worker.log`, `result.json`.
The offline readback verifies required artifact hashes, current plan/source/lock and
built-runtime identity, and Trace build metadata. It independently reconstructs
samples, phase load/durations, first-frame timing, quantiles, resource statistics
and cleanup observations from the raw sequences. Whitelisted raw inputs cannot
prefill derived measurements. Post-stop translation lookup uses stable segment
IDs in batches of 50, including records beyond the detail API's first 100 rows.
Readback rejects stale source/build, missing observations and fabricated summaries.
The outer runner separately checks that the server PID is gone and its owned
database root is removed.

Failures preserve their phase and partial sequences; no retries are performed.
Workers have isolated process groups; parent cleanup removes the owned database
root even after forced exit. Normal fixture close confirms child exit, closed
sockets and removal of SQLite and transfer files.

Memory growth can reflect intentionally growing persisted data, V8/SQLite caches,
fixture and polling load. This runner reports it without calling it stable or
leak-free. It does not establish all timer/task ownership after stop; raw resource
counts and Trace are diagnostic evidence, while cleanup acceptance budgets remain
unapproved. Forced process termination is teardown, not proof of in-process
resource reclamation.

## Acceptance gaps

Release owner must freeze device/support matrix, resource budgets, latency limits,
permitted variability and candidate-comparison plan before judging performance.
Those fields remain null and acceptanceStatus is always not_run. Real vendor
end-to-end latency, caption rendering, audible output, real desktop/mobile and
lockscreen behavior, multi-hour growth and approved candidate comparison remain
not_run. This harness cannot mark KEJ-81 Done or fullProjectAcceptance true.

## Bounded candidate comparison (current KEJ-81 technical scope)

The following is a finite loopback scheduling/resource regression comparison.
Real vendor quality, actual audible output, physical-device/background behavior
and final release thresholds are consolidated in KEJ-87. Multi-hour stability is
deferred. Neither a comparison pass nor process teardown proves those properties.
The earlier acceptance-gap paragraph records the original product scope, not a
requirement to add more helper PRs.

1. On a clean baseline checkout, build and collect the existing `baseline` profile
   (3 independent 30-second continuous phases) or `smoke` for a tooling check.
   Run the existing report reader before freezing. Keep all raw files.
2. Prepare a JSON object with every key returned by `realtimeMetrics(report)` from
   `scripts/lib/realtime-comparison.mjs`. Each value is either
   `{"maxAbsolute": number, "maxIncrease": number}` or `null` (unknown).
   Both limits use the metric's own units. The increase is candidate minus
   baseline, not a percentage. Do not infer product limits from a candidate.
3. Freeze once, before collecting the candidate:

   ```sh
   node scripts/compare-realtime.mjs freeze BASELINE LIMITS.json POLICY.json
   ```

   The new policy file is exclusive-create, contains the clean baseline report
   hash/source/build identity, fixed load/profile/plan/runtime/environment, and a
   timestamp. It cannot overwrite an old freeze. Copy the policy and untouched
   baseline evidence to the candidate checkout when comparing different commits.
4. Build the clean candidate, then bind that policy at collection start:

   ```sh
   npm run verify:realtime-baseline -- --profile=baseline --policy=/absolute/POLICY.json
   node scripts/compare-realtime.mjs compare BASELINE CANDIDATE POLICY.json COMPARISON.json
   node scripts/compare-realtime.mjs audit BASELINE CANDIDATE POLICY.json COMPARISON.json
   ```

   Use `--profile=smoke` only if the frozen baseline also uses smoke. Historical
   baseline source/build are validated against the already-frozen report identity;
   the candidate must match the actual current checkout/build. Runtime, lock,
   measurement plan and environment must match. Source commits may differ.
   A same-source comparison is a harness calibration, not evidence of a code change.

The reader replays raw event/resource sequences and checks attachment hashes for
both sides before evaluating any metric. The comparison report's audit re-runs
those readers and reconstructs every comparison; edited summaries fail audit.
Missing evidence, timeout, source changes or incompatible environments are
`incomplete`. An unknown budget is `not_run`. Complete known budgets yield
`passed` or `failed`. CLI compare exits 0/1/3 respectively for passed/failed/not
fully evaluated, and always retains `fullProjectAcceptance: false`.

Measurements include pooled nearest-rank p95 for the separately labelled event,
HTTP observation and transport-first-PCM latencies (excluding warmup), maximum
elapsed time per measured phase (including drain), maximum post-stop RSS/heap/
external/array-buffer bytes, descriptors and active resource counts, upstream ASR
connections and per-run cumulative CPU microseconds. Raw sequences and counts
remain in the original packages. Missing platform descriptor values are not zero.
Absolute post-stop memory/descriptor limits are workload-specific; they do not
prove zero ownership leaks or long-term stability. Transport first PCM is never
labelled audible first sound. Genuine retained-ASR transport detection remains in
the existing negative-control integration test; forced server exit is cleanup.

No product limit ships by default. The integration regression freezes deliberately
broad synthetic test limits and a zero-ASR-connections limit solely to exercise
comparison plumbing. These values must not be adopted as release policy. Two
smoke captures plus the existing retained-socket test are bounded, run serially,
and fit within the 10-minute daily performance budget; no long CI matrix is added.

HTTP fallback is conditional: if WebSocket delivered every result, there is no
HTTP latency sample. Its separate diagnostic percentile is `not_applicable`
when either side did not exercise that channel, never fabricated as zero. Raw
readback still requires delivery evidence for every input. Other missing metrics
remain incomplete. Candidate policy binding is also written as the very first
hashed raw runtime event before any workload, and reconstructed by readback;
backdating a policy and editing only report summaries cannot change that binding.
