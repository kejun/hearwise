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
```

The negative must exit 1 with `negativeDetected: true`; it retains a real upstream
ASR WebSocket after stop by overriding only that transport's close in a test-only
preload. The same production stop flow and same cleanup observation detect it.
The outer process still terminates the server and removes the temporary SQLite.
A timeout, missing result or unrelated failure cannot count as this negative.

`verification/realtime-baseline.json` version 1 fixes measurement inputs before
candidate collection: baseline has three independent runs, 2 s warmup, a 30 s
continuous phase at four 3200-byte PCM frames/s, four stop/start cycles, four
record switches with old background work still pending, a 12-sentence background burst, and export/replace-import then
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
ASR provider sockets are observed directly in the existing fixture. Quiescent
samples follow every stop/drain; all consumer sockets must close and the ASR
provider must have zero connections within the observation window.

Reports live in `verification-evidence/realtime/<profile>-*/`; the integration
regression retains them under `test-evidence/nested-profiles/` for existing CI
artifact upload. Each report binds source SHA/dirty state, plan hash, lock hash,
actual runtime/OS/CPU, start/end time, child exit and hashes of raw artifacts:
`events.jsonl`, `resources.jsonl`, `server.log`, `worker.log`, `result.json`.
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
