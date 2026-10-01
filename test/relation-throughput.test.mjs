import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createRelationScheduler } from '../relation-queue.mjs';
import { createRelationWorkflow } from '../relation-workflow.mjs';
import { extractRelations, buildRelationRequest, buildRelationInput, RELATION_SYSTEM_PROMPT } from '../relations.mjs';
import { relationWireEnvelope, relationWireRow } from '../test-support/relation-wire-fixture.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));
function seed(t, count = 24, limits) {
  const dir = mkdtempSync(path.join(tmpdir(), 'relation-throughput-'));
  const store = new ListeningStore(path.join(dir, 'store.sqlite'));
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'synthetic throughput');
  let first;
  for (let i = 0; i < count; i++) {
    const s = store.addSegment(run.listeningId, run.runId, { id: `asr${i}`, text: 'Atlas launched Nova.' }).segment;
    store.setTranslation(s.id, 'Atlas 推出了 Nova。'); first ||= s;
  }
  for (const name of ['Atlas', 'Nova']) store.applyKnowledge(run.listeningId, [{ type: 'other', canonical_name: name, aliases: [],
    dialogue_summary: `${name} was discussed.`, background_note: null, certainty: 'clear', decision: 'create', existing_item_id: null,
    correction_reason: null, evidence: [{ segment_id: first.id, quote: name }] }]);
  store.finishRun(run.runId); store.enableRelations(run.listeningId, { limits });
  // Archived, unchanged history: the quiet window has already elapsed.
  store.db.prepare('UPDATE relation_windows SET dirty_at=? WHERE listening_id=?').run(Date.now() - 10000, run.listeningId);
  t.after(() => { store.close(); rmSync(dir, { force: true, recursive: true }); });
  return { store, id: run.listeningId };
}
async function syntheticRun(t, maxConcurrent) {
  const h = seed(t); let active = 0, peak = 0, calls = 0;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() + 1000 });
  const start = Date.now();
  const workflow = createRelationWorkflow({ store: h.store, endpoint: 'mock-provider', extract: (key, input, endpoint, options) =>
    extractRelations(key, input, endpoint, { ...options, fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body), wire = JSON.parse(body.messages[1].content);
      assert.equal(body.model, 'qwen3.8-flash'); assert.equal(body.enable_thinking, false);
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 25000)); active--;
      const subject = wire.candidates.find(n => n.canonical_name === 'Atlas'), object = wire.candidates.find(n => n.canonical_name === 'Nova');
      const s = wire.focus_segments[0];
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(relationWireEnvelope(wire, [relationWireRow(wire, {
        subject_item_id: subject.id, object_item_id: object.id, predicate: 'released', statement: 'Atlas 推出了 Nova', polarity: 'positive',
        modality: 'asserted', conditions: null, time_scope: null, attribution: null, status: 'active', correction_of: null,
        supports: [{ segment_id: s.id, quote: s.text, role: 'relation' }] })])) } }], usage: { total_tokens: 100 } }) };
    } }) });
  const queue = createRelationScheduler({ store: h.store, keyFor: () => 'mock-key', execute: workflow.execute, maxConcurrent });
  queue.schedule(h.id, true); await settle();
  while (queue.hasWork(h.id) && Date.now() - start < 115000) { t.mock.timers.tick(1000); await settle(); }
  const elapsed = Date.now() - start, graph = h.store.graph(h.id);
  queue.close(); t.mock.timers.reset();
  assert.equal(graph.status.progress.completedWindows, 4); assert.equal(graph.status.progress.remainingWindows, 0);
  assert.equal(graph.status.state, 'complete'); assert.equal(graph.status.round.stopReason, null);
  assert.equal(graph.status.round.requestCount, 4); assert.equal(graph.status.round.measuredRequests, 4);
  assert.equal(graph.relations.length, 1); assert.equal(graph.supports.length, 4);
  assert.equal(calls, 4); assert.equal(peak, maxConcurrent);
  assert.equal(graph.status.round.totalTokens, 400);
  return elapsed;
}

test('synthetic 25-second provider: four windows fully complete faster without extra calls or a cutoff', async t => {
  const serial = await syntheticRun(t, 1), parallel = await syntheticRun(t, 2);
  assert.equal(serial, 100000); assert.equal(parallel, 52000);
  t.diagnostic(`Synthetic fixed-latency provider only: four windows ${serial / 1000}s serial → ${parallel / 1000}s bounded parallel; four calls each, all evidence committed. Not a live-provider benchmark.`);
});

test('default two-slot scheduler staggers requests and cancellation fences both ignored-abort transports', async t => {
  const h = seed(t, 18), releases = [], signals = [];
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() + 1000 });
  const workflow = createRelationWorkflow({ store: h.store, extract: (_key, _input, _endpoint, { signal }) => {
    signals.push(signal); return new Promise(resolve => releases.push(resolve));
  } });
  const queue = createRelationScheduler({ store: h.store, keyFor: () => 'key', execute: workflow.execute });
  t.after(() => queue.close()); queue.schedule(h.id, true); await settle();
  assert.equal(signals.length, 1); t.mock.timers.tick(1999); await settle(); assert.equal(signals.length, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(signals.length, 2);
  queue.pump(); assert.equal(signals.length, 2);
  h.store.cancelRelations(h.id); queue.cancel(h.id); await settle();
  assert.ok(signals.every(s => s.aborted)); assert.equal(queue.hasWork(h.id), false);
  for (const release of releases) release({ relations: [], usage: { total_tokens: 8 } });
  await settle();
  assert.equal(h.store.relationProcessing(h.id).state, 'cancelled');
  assert.equal(h.store.relationProcessing(h.id).progress.completedWindows, 0);
  assert.equal(h.store.relationProcessing(h.id).usageLastHour.totalTokens, 16);
});

test('two-slot hung transports exhaust finite per-window retries and finish without a whole-run timeout', async t => {
  const h = seed(t, 18), signals = [];
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() + 1000 });
  const workflow = createRelationWorkflow({ store: h.store, extract: (_key, _input, _endpoint, { signal }) => { signals.push(signal); return new Promise(() => {}); } });
  const queue = createRelationScheduler({ store: h.store, keyFor: () => 'key', execute: workflow.execute });
  t.after(() => queue.close()); queue.schedule(h.id, true); await settle();
  for (let i = 0; i < 400 && queue.hasWork(h.id); i++) { t.mock.timers.tick(1000); await settle(); }
  assert.equal(signals.length, 9); assert.ok(signals.every(s => s.aborted)); assert.equal(queue.hasWork(h.id), false);
  const status = h.store.relationProcessing(h.id);
  assert.equal(status.state, 'failed'); assert.equal(status.failedJobs, 3); assert.equal(status.round.stopReason, null);
  queue.pump(); t.mock.timers.tick(600000); await settle(); assert.equal(signals.length, 9);
});

test('bounded v2 registry preserves full source and translations while removing durable bookkeeping', () => {
  const id = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const input = { listening_id: id(100), window_id: `${id(100)}:0`, window_revision: 42, input_fingerprint: 'f'.repeat(64),
    focus_segments: Array.from({ length: 6 }, (_, i) => ({ id: id(i), sequence_no: i + 4, text: `Company ${i} released Product ${i}.`, translation: `公司 ${i} 发布了产品 ${i}。` })),
    context_segments: Array.from({ length: 3 }, (_, i) => ({ id: id(i + 10), sequence_no: i + 1, text: `Company ${i} was introduced.`, translation: `介绍了公司 ${i}。` })),
    candidates: Array.from({ length: 24 }, (_, i) => ({ id: id(i + 20), canonical_name: `Company ${i}`, listening_id: id(100), aliases: [] })) };
  const request = buildRelationRequest(input), old = { model: 'qwen3.8-flash', enable_thinking: false, temperature: 0, max_tokens: 6000,
    messages: [{ role: 'system', content: RELATION_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(buildRelationInput(input)) }] };
  const before = Buffer.byteLength(JSON.stringify(old)), after = Buffer.byteLength(JSON.stringify(request.body));
  assert.ok(after <= 90000, 'registry remains within the request byte budget');
  const wire = JSON.parse(request.body.messages[1].content);
  assert.equal(wire.contract_version, 'relations-v2'); assert.ok(wire.evidence_version);
  assert.ok(wire.evidence.length > 0); assert.ok(wire.mentions.length > 0);
  assert.doesNotMatch(request.body.messages[1].content, /input_fingerprint|source_revision|window_revision|00000000-0000-4000/);
  assert.deepEqual(wire.focus_segments.map(s => s.text), input.focus_segments.map(s => s.text));
  assert.deepEqual(wire.context_segments.map(s => s.translation), input.context_segments.map(s => s.translation));
  console.info(JSON.stringify({ syntheticPayloadBytesBefore: before, syntheticPayloadBytesAfter: after, reductionPercent: Number(((before - after) / before * 100).toFixed(1)) }));
});

test('expired admission timestamp cannot hide a later quiet window behind an in-flight request', async t => {
  const h = seed(t, 12), gates = [];
  const base = Date.now();
  h.store.db.prepare('UPDATE relation_windows SET dirty_at=? WHERE listening_id=?').run(base, h.id);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: base + 1000 });
  const workflow = createRelationWorkflow({ store: h.store, extract: () => new Promise(resolve => gates.push(resolve)) });
  const queue = createRelationScheduler({ store: h.store, keyFor: () => 'key', execute: workflow.execute });
  t.after(() => { queue.close(); gates.forEach(resolve => resolve({ relations: [] })); });
  queue.schedule(h.id, true); await settle(); assert.equal(gates.length, 1);
  t.mock.timers.tick(2000); await settle(); assert.equal(gates.length, 1);
  t.mock.timers.tick(3000); await settle(); assert.equal(gates.length, 2, 'second starts when quiet time ends, without waiting for first completion');
});

test('an available second slot still yields to foreground work and provider cooldown', async t => {
  const h = seed(t, 12), gates = []; let busy = false, cooldownUntil = 0;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() + 1000 });
  const provider = { canStartBackground: () => !busy, readyAt: () => cooldownUntil };
  const workflow = createRelationWorkflow({ store: h.store, provider, extract: () => new Promise(resolve => gates.push(resolve)) });
  const queue = createRelationScheduler({ store: h.store, provider, keyFor: () => 'key', execute: workflow.execute });
  t.after(() => { queue.close(); gates.forEach(resolve => resolve({ relations: [] })); });
  queue.schedule(h.id, true); await settle(); busy = true;
  t.mock.timers.tick(4000); await settle(); assert.equal(gates.length, 1);
  busy = false; cooldownUntil = Date.now() + 3000; queue.pump();
  t.mock.timers.tick(2999); await settle(); assert.equal(gates.length, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(gates.length, 2);
});
