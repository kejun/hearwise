import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { replaySchedulerTrace } from '../scripts/lib/scheduler-protocol-replay.mjs';
import { validateSchedulerReplayEvidence } from '../scripts/lib/scheduler-replay-evidence.mjs';
import { createSchedulerProtocolAdapter } from '../test-support/scheduler-protocol-adapter.mjs';

const serverSource = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const translation = { schemaVersion: 1, specificationVersion: '1.0', protocol: 'scheduler', config: { kind: 'translation' },
  initial: { queue: [], running: [], phase: { 0: 'fresh', 1: 'fresh', 2: 'fresh', 3: 'fresh' }, interim: 0, recentStarts: [] }, steps: [] };
const add = (trace, action, actor, argument, change) => {
  const expected = structuredClone(trace.steps.at(-1)?.expected || trace.initial); expected.recentStarts = [];
  change(expected); trace.steps.push({ action, actor, argument, expected });
};
add(translation, 'enqueue', 1, '', state => { state.queue = [1]; state.phase[1] = 'queued'; });
add(translation, 'pump', -1, '', state => { state.queue = []; state.running = [1]; state.phase[1] = 'running'; state.recentStarts = [1]; });
add(translation, 'settle_final', 1, 'success', state => { state.running = []; state.phase[1] = 'settled'; });
const knowledge = { schemaVersion: 1, specificationVersion: '1.0', protocol: 'scheduler', config: { kind: 'knowledge' }, initial: {
  phase: { 0: 'pending', 1: 'pending', 2: 'pending' }, durable: { 0: 'pending', 1: 'pending', 2: 'pending' }, running: [], lastServed: -1, recentStarts: [],
  translationWaiting: 0, translationRunning: 0, interim: 0, closed: false, listenings: [0, 1], keyAvailable: { 0: true, 1: true }
}, steps: [] };
add(knowledge, 'pump', -1, '', state => { state.running = [0, 2]; for (const actor of [0, 2]) state.phase[actor] = state.durable[actor] = 'running'; state.lastServed = 1; state.recentStarts = [0, 2]; });
add(knowledge, 'settle', 0, 'success', state => { state.running = [2]; state.phase[0] = state.durable[0] = 'complete'; });
add(knowledge, 'remove', 0, '', state => { for (const actor of [0, 1]) { state.phase[actor] = 'cancelled'; state.durable[actor] = 'deleted'; } state.listenings = [1]; state.keyAvailable[0] = false; });
add(knowledge, 'close', -1, '', state => { state.running = []; state.phase[2] = 'cancelled'; state.closed = true; });

test('actual translation observations reject independent raw source/counter/ledger/lifecycle corruption', async t => {
  const result = await replaySchedulerTrace(translation, createSchedulerProtocolAdapter);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(validateSchedulerReplayEvidence(translation, result, { serverSource }), { ok: true, reasons: [] });
  for (const [name, alter] of [
    ['missing raw observation', r => { r.observations[1].durable = null; }],
    ['wrong source', r => { r.observations[0].durable.binding.originalSha256 = '0'.repeat(64); }],
    ['wrong appended exports', r => { r.observations[0].durable.binding.exportSuffix += ' '; }],
    ['hidden platform injection', r => { delete r.observations[0].durable.platformControls; }],
    ['counter inflation', r => { r.observations[2].durable.service.final++; }],
    ['active slot leak', r => { r.observations[3].durable.service.active = 1; }],
    ['empty provider ledger', r => { r.observations[2].durable.ledger = []; }],
    ['provider actor rewrite', r => { r.observations[3].durable.ledger[0].actor = 2; }],
    ['wrong legitimate response', r => { r.observations[3].durable.ledger[0].delivery = 'error'; r.observations[3].durable.ledger[0].httpStatus = 500; }],
    ['invented timeout parameter', r => { r.observations[3].durable.ledger[0].timeoutMs = 30000; }],
    ['queue identity mismatch', r => { r.observations[1].durable.queuePresence[1] = false; }],
    ['fake dispatch order', r => { r.observations[2].durable.recentStarts = []; }],
    ['lost completion callbacks', r => { for (const observation of r.observations) observation.durable.completions = []; }],
    ['wrong completion outcome', r => { r.observations[3].durable.completions[0].outcome = 'error'; }],
    ['phase-only success', r => { r.observations[2].durable.phase[1] = 'settled'; }]
  ]) await t.test(name, () => { const changed = structuredClone(result); alter(changed); assert.equal(validateSchedulerReplayEvidence(translation, changed, { serverSource }).ok, false); });
});

test('actual knowledge observations reject stale SQLite/admission/cancellation/response evidence', async t => {
  const result = await replaySchedulerTrace(knowledge, createSchedulerProtocolAdapter);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(validateSchedulerReplayEvidence(knowledge, result, { serverSource }), { ok: true, reasons: [] });
  for (const [name, alter] of [
    ['missing SQLite state', r => { r.observations[1].durable.jobs = {}; }],
    ['false persisted success', r => { r.observations[2].durable.jobs[0].job.state = 'failed'; }],
    ['forgotten attempt', r => { r.observations[1].durable.jobs[0].job.attempts = 0; }],
    ['fake empty calls', r => { r.observations[1].durable.calls = []; }],
    ['wrong legitimate executor response', r => { r.observations[2].durable.calls[0].response = 'retry'; }],
    ['terminal response rewritten later', r => { r.observations[3].durable.calls[0].response = 'rate_limit'; }],
    ['false runtime cancellation', r => { r.observations[4].durable.calls[1].signalAborted = false; }],
    ['invented close completion', r => { r.observations[4].durable.jobs[2].job.state = 'complete'; }],
    ['early admission', r => { r.observations[1].durable.admissions[0].providerReadyAt = r.observations[1].durable.clock + 1; }],
    ['new start over busy budget', r => { r.observations[1].durable.admissions[1].translation.final = 1; }],
    ['faked session rotation identity', r => { r.observations[1].durable.calls[1].session = 0; }],
    ['queue busy invented', r => { r.observations[1].durable.translation.service.queueLength = 1; }],
    ['keys survive deletion', r => { r.observations[3].durable.keyAvailable[0] = true; }],
    ['missing persisted parts', r => { for (const observation of r.observations) for (const checkpoint of Object.values(observation.durable.jobs)) if (checkpoint) checkpoint.parts = []; }],
    ['empty running-before history', r => { for (const observation of r.observations) for (const admission of observation.durable.admissions) admission.runningBefore = []; }],
    ['source identity replaced', r => { r.observations[2].durable.identity.jobs[0] = 'replacement'; }]
  ]) await t.test(name, () => { const changed = structuredClone(result); alter(changed); assert.equal(validateSchedulerReplayEvidence(knowledge, changed, { serverSource }).ok, false); });
});

test('actual shared-admission mutant is an exact first-divergence counterexample, never a normal pass', async () => {
  const trace = structuredClone(translation); trace.steps = [];
  for (const actor of [1, 2]) add(trace, 'enqueue', actor, '', state => { state.queue.push(actor); state.phase[actor] = 'queued'; });
  add(trace, 'pump', -1, '', state => { state.queue = []; state.running = [1, 2]; state.recentStarts = [1, 2]; state.phase[1] = state.phase[2] = 'running'; });
  add(trace, 'reject_interim', -1, 'busy', () => {});
  const result = await replaySchedulerTrace(trace, config => createSchedulerProtocolAdapter({ ...config, mutation: 'interim_queue_only' }));
  assert.equal(result.classification, 'implementation_mismatch'); assert.equal(result.difference.step, 3);
  assert.deepEqual(validateSchedulerReplayEvidence(trace, result, { serverSource, mutation: 'interim_queue_only' }), { ok: true, reasons: [] });
  assert.equal(validateSchedulerReplayEvidence(trace, result, { serverSource }).ok, false);
});

const retry = { ...structuredClone(knowledge), config: { kind: 'knowledge', jobs: [0] }, steps: [] };
retry.initial.phase = { 0: 'pending' }; retry.initial.durable = { 0: 'pending' };
add(retry, 'pump', -1, '', state => { state.running = [0]; state.phase[0] = state.durable[0] = 'running'; state.lastServed = 0; state.recentStarts = [0]; });
add(retry, 'settle', 0, 'retry', state => { state.running = []; state.phase[0] = state.durable[0] = 'pending'; });
add(retry, 'advance_time', -1, 'all_outstanding_deadlines', () => {});
add(retry, 'pump', -1, '', state => { state.running = [0]; state.phase[0] = state.durable[0] = 'running'; state.recentStarts = [0]; });
add(retry, 'settle', 0, 'success', state => { state.running = []; state.phase[0] = state.durable[0] = 'complete'; });

test('actual retry admission is bound to prior calls and pre-admission SQLite checkpoint', async t => {
  const result = await replaySchedulerTrace(retry, createSchedulerProtocolAdapter);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(validateSchedulerReplayEvidence(retry, result, { serverSource }), { ok: true, reasons: [] });
  for (const [name, alter] of [
    ['previous start erased', r => { for (const observation of r.observations) for (const admission of observation.durable.admissions) admission.previousStart = null; }],
    ['persisted ready deadline erased', r => { for (const observation of r.observations) for (const admission of observation.durable.admissions) admission.readyAt = 0; }],
    ['pre-admission checkpoint erased', r => { for (const observation of r.observations) for (const admission of observation.durable.admissions) delete admission.checkpointBefore; }],
    ['pre-admission attempt forged', r => { for (const observation of r.observations) for (const admission of observation.durable.admissions) if (admission.checkpointBefore) admission.checkpointBefore.job.attempts = 100; }],
    ['cooldown observation forged', r => { for (const observation of r.observations) observation.durable.deadlines.provider = [0, 1]; }]
  ]) await t.test(name, () => { const changed = structuredClone(result); alter(changed); assert.equal(validateSchedulerReplayEvidence(retry, changed, { serverSource }).ok, false); });
});
