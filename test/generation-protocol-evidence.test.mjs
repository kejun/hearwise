import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedTrace } from '../test-support/generation-trace-fixture.mjs';
import { createGenerationProtocolAdapter } from '../test-support/generation-protocol-adapter.mjs';
import { replayGenerationTrace } from '../scripts/lib/generation-protocol-replay.mjs';
import { validateGenerationReplayEvidence } from '../scripts/lib/generation-protocol-evidence.mjs';

for (const protocol of ['knowledge', 'relation']) test(`${protocol} raw generation evidence rejects fabricated persistence, responses and admission observations`, { timeout: 15000 }, async t => {
  const trace = await fixedTrace(t, protocol, 1, 1, 'normalSuccessTest', true);
  const actual = await replayGenerationTrace(trace, createGenerationProtocolAdapter);
  assert.equal(actual.ok, true); assert.equal(validateGenerationReplayEvidence(trace, actual).ok, true);
  const corruptions = [
    value => { value.observations.pop(); },
    value => { value.observations.at(-1).durable.raw.durable = {}; },
    value => { value.observations.at(-1).durable.raw.calls = []; },
    value => { value.observations.at(-1).durable.raw.durable.listening_runs = []; },
    value => { value.observations.at(-1).durable.raw.durable.listening_runs[0].state = 'complete'; },
    value => { value.observations.at(-1).durable.raw.calls[0].response = 'empty'; },
    value => { value.observations.at(-1).durable.raw.calls[0].name = 'Forged actor'; },
    value => { value.observations.at(-1).durable.raw.calls[0].listeningId = 'different'; },
    value => { value.observations.at(-1).durable.raw.calls[0].jobId = 'different'; },
    value => { value.observations.at(-1).durable.raw.ledger = value.observations.at(-1).durable.raw.ledger.filter(row => row.event !== 'admission_consumed'); },
    value => { value.observations.at(-1).durable.raw.ledger.find(row => row.event === 'admission_readiness').readyAt = 0; },
    value => { value.observations.at(-1).durable.raw.executions[0].settled = false; },
    value => { value.observations.at(-1).durable.raw.database.file += '-different'; },
    value => { value.observations.at(-1).durable.bindings.requests[0].id = 2; },
    value => { value.observations.at(-1).durable.raw.queries = {}; },
    value => { value.observations.at(-1).actual.business[0] = []; },
    value => { value.finishedAt = 'invalid'; },
    value => { for (const observation of value.observations) for (const query of Object.values(observation.durable.raw.queries)) { query.detail = {}; query.graph = {}; } },
    value => { for (const observation of value.observations) for (const call of observation.durable.raw.calls) if (call.responseValue !== null) call.responseValue = { forged: true }; },
    value => { for (const observation of value.observations) for (const call of observation.durable.raw.calls) for (const segment of call.input.focus_segments) segment.text += ' FORGED'; },
    value => { value.observations.at(-1).durable.raw.durable.segments[0].original_text += ' FORGED'; },
    value => { for (const observation of value.observations) for (const call of observation.durable.raw.calls) if (call.responseWire !== null) call.responseWire = '{"items":[]}'; },
    value => { Object.values(value.observations.at(-1).durable.raw.queries)[0].graph.nodes[0].facts[0].content = 'FORGED'; },
    value => { for (const observation of value.observations) for (const row of observation.durable.raw.ledger.filter(row => row.event === 'provider_started')) Object.assign(row, { index: 99, jobId: 'forged', listeningId: 'unrelated' }); },
    value => { for (const observation of value.observations) for (const row of observation.durable.raw.ledger.filter(row => row.event === 'provider_delivery')) Object.assign(row, { index: 99, response: 'failure', delivery: 42 }); },
    value => { for (const observation of value.observations) for (const row of observation.durable.raw.executions) Object.assign(row, { listeningId: 'unrelated', attempt: 999 }); }
  ];
  if (protocol === 'knowledge') corruptions.push(
    value => { value.observations.at(-1).durable.raw.durable.jobs[0].parts = []; },
    value => { value.observations.at(-1).durable.raw.durable.jobs[0].state = 'failed'; },
    value => { value.observations.at(-1).durable.raw.durable.facts[0].content = 'forged'; },
    value => { for (const observation of value.observations) for (const job of observation.durable.raw.durable.jobs) for (const part of job.parts) part.repair_reserved = 99; },
    value => { for (const observation of value.observations) for (const job of observation.durable.raw.durable.jobs) { job.progress.extra_requests = 2; job.progress_json = JSON.stringify(job.progress); } }
  );
  else corruptions.push(
    value => { value.observations.at(-1).durable.raw.durable.relation_requests = []; },
    value => { value.observations.at(-1).durable.raw.durable.relation_jobs[0].state = 'failed'; },
    value => { value.observations.at(-1).durable.raw.durable.relation_supports[0].quote = 'forged'; }
  );
  for (const [index, mutate] of corruptions.entries()) {
    const changed = structuredClone(actual); mutate(changed);
    assert.equal(validateGenerationReplayEvidence(trace, changed).ok, false, `raw mutation ${index}`);
  }
});

for (const protocol of ['knowledge', 'relation']) test(`${protocol} late-response evidence keeps old physical work separate from the new owner`, { timeout: 15000 }, async t => {
  const trace = await fixedTrace(t, protocol, 1, 1, 'oldResponseWhileNewActiveTest', true);
  const actual = await replayGenerationTrace(trace, createGenerationProtocolAdapter);
  assert.equal(actual.ok, true); assert.equal(validateGenerationReplayEvidence(trace, actual).ok, true);
  const corruptions = [
    value => { value.observations.at(-1).durable.raw.calls[0].aborted = false; },
    value => { value.observations.at(-1).durable.raw.calls[1].aborted = true; },
    value => { value.observations.at(-1).durable.raw.executions[1].settled = true; },
    value => { value.observations.at(-1).durable.bindings.actors[0].generation = 0; },
    value => { value.observations.at(-1).durable.raw.calls[0].response = 'failure'; },
    value => { value.observations.at(-1).durable.raw.calls[1].input.focus_segments[0].text = 'Unrelated transcript'; },
    value => { value.observations.at(-1).durable.raw.durable.knowledge_aliases.push({ item_id: 'forged', alias: 'old callback alias', normalized_alias: 'old callback alias' }); },
    value => { value.observations.at(-1).durable.raw.durable.segments[0].translation_text = 'Old callback changed a source'; }
  ];
  if (protocol === 'knowledge') corruptions.push(value => { value.observations.at(-1).durable.raw.durable.jobs[1].state = 'complete'; });
  else corruptions.push(
    value => { value.observations.at(-1).durable.raw.durable.relation_jobs[1].state = 'complete'; },
    value => { const rows = value.observations.at(-1).durable.raw.durable.relation_requests; rows[1].usage_json = rows[0].usage_json; rows[0].usage_json = null; }
  );
  for (const [index, mutate] of corruptions.entries()) { const changed = structuredClone(actual); mutate(changed); assert.equal(validateGenerationReplayEvidence(trace, changed).ok, false, `late raw mutation ${index}`); }
});

for (const protocol of ['knowledge', 'relation']) test(`${protocol} restart evidence binds real new process, closed resources and public deletion`, { timeout: 35000 }, async t => {
  // Two native witnesses share one 30s pool including both actual replays; the
  // final 5s belongs to cleanup. Each tool invocation still has its 10s cap.
  const deadlineAt = performance.now() + 30000;
  const withinDeadline = () => assert.ok(performance.now() < deadlineAt, 'Restart evidence exceeded its shared deadline');
  const trace = await fixedTrace(t, protocol, 1, 1, 'deleteRestartLateTest', true, { deadlineAt });
  const actual = await replayGenerationTrace(trace, createGenerationProtocolAdapter);
  assert.equal(actual.ok, true); assert.deepEqual(validateGenerationReplayEvidence(trace, actual), { ok: true, reasons: [] });
  withinDeadline();
  const retainedTrace = await fixedTrace(t, protocol, 1, 1, 'successfulRestartTest', true, { deadlineAt });
  const retained = await replayGenerationTrace(retainedTrace, createGenerationProtocolAdapter);
  withinDeadline();
  const serialized = JSON.parse(JSON.stringify(retained));
  assert.equal(retained.ok, true);
  assert.deepEqual(validateGenerationReplayEvidence(retainedTrace, serialized), { ok: true, reasons: [] });
  assert.deepEqual(validateGenerationReplayEvidence(retainedTrace, retained), { ok: true, reasons: [] }, 'native SQLite row prototypes must not change the full-field JSON evidence verdict');
  const mutateRestart = (value, mutate) => { for (const observation of value.observations)
    for (const row of observation.durable.raw.ledger.filter(row => row.event === 'restart_http')) mutate(row); };
  const corruptions = [
    row => { row.pid = row.parentPid; }, row => { row.exit = { code: 73, signal: null }; },
    row => { row.finishedAt = 'invalid'; }, row => { row.queries = {}; },
    row => { row.startedAt = '2000-01-01T00:00:00Z'; row.finishedAt = '2000-01-01T00:00:01Z'; },
    row => { row.exit.pid++; }, row => { row.parentPid++; },
    row => { Object.values(row.queries)[0].detail.status = 200; },
    row => { Object.values(row.queries)[0].graph.body = { revived: true }; }
  ];
  for (const mutate of corruptions) { const changed = structuredClone(actual); mutateRestart(changed, mutate); assert.equal(validateGenerationReplayEvidence(trace, changed).ok, false); }
  const active = structuredClone(actual);
  for (const observation of active.observations) for (const row of observation.durable.raw.ledger.filter(row => row.event === 'local_resources_closed')) row.activeExecutions = 1;
  assert.equal(validateGenerationReplayEvidence(trace, active).ok, false);
  withinDeadline();
});
