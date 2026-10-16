import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { captureSemanticOffline } from '../scripts/lib/semantic-quality-capture.mjs';
import { openSemanticQualityBudget } from '../scripts/lib/quality-budget.mjs';
import { semanticFixtureSample, semanticFixtureResponse } from '../test-support/semantic-quality-fixture.mjs';

async function setup(t, { totalTimeoutMs = 12000 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-realtime-capture-'));
  const budget = { id: 'synthetic-realtime-test', currency: 'USD', ceilingMicros: 100,
    maxAttempts: { knowledge: 8, relation: 8 }, maxTrialAttempts: { knowledge: 8, relation: 8 },
    attemptMicros: { knowledge: 1, relation: 1 }, expiresAt: new Date(Date.now() + 60000).toISOString() };
  const ledger = openSemanticQualityBudget(path.join(root, 'budget.sqlite'), budget, 'a'.repeat(64));
  ledger.claimRun({ role: 'baseline', sourceSha: 'b'.repeat(40), directory: root, expectedSnapshot: ledger.snapshot() });
  t.after(async () => { ledger.close(); await rm(root, { recursive: true, force: true }); });
  const sample = { ...semanticFixtureSample(), kind: 'offline-text-corpus' };
  return { ledger, options: { directory: path.join(root, 'capture'), sample,
    corpusPlan: { limits: { maxRequestBytes: 128000, maxResponseBytes: 128000, requestTimeoutMs: 3000, totalTimeoutMs } },
    pairedBudget: { ledger, trialId: 'baseline:qualified:0', expiresAt: budget.expiresAt, maxCalls: 16 } } };
}
const realtime = onWait => ({ kind: 'realtime', async waitUntil(deadline, signal) {
  signal.throwIfAborted();
  onWait?.(deadline, signal);
  while (Date.now() < deadline) await delay(deadline - Date.now(), undefined, { signal });
} });
const envelope = value => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }) });

test('realtime loopback 503 retries respect knowledge and relation deadlines without changing budget bindings', { timeout: 20000 }, async t => {
  const { options, ledger } = await setup(t), fixture = semanticFixtureResponse(), attempts = [], waits = [];
  const result = await captureSemanticOffline({ ...options, scheduler: realtime(deadline => waits.push({ deadline, at: Date.now() })),
    response: context => {
      const previous = attempts.filter(row => row.kind === context.kind).length;
      attempts.push({ kind: context.kind, at: Date.now() });
      return previous === 0 ? { status: 503, body: '{}', retryAfter: '0.01' } : envelope(fixture(context));
    } });
  assert.equal(result.complete, true, JSON.stringify({ error: result.errorCode, results: result.results, errors: result.errors }));
  for (const [kind, minimum] of [['knowledge', 2000], ['relation', 3000]]) {
    const rows = attempts.filter(row => row.kind === kind);
    assert.equal(rows.length, 2);
    assert.ok(rows[1].at - rows[0].at >= minimum, `${kind} retry dispatched early`);
  }
  assert.ok(waits.some(row => row.deadline > row.at));
  assert.equal(result.clock, 'realtime workflow wall time; local provider bridge');
  assert.equal(result.mode, 'offline'); assert.equal(result.liveCalls, 0);
  assert.equal(result.transport.budgetBindings.length, 4);
  assert.equal(ledger.snapshot().attempts.length, 4);
  assert.ok(result.transport.observations.every(row => row.reservationStatus === 'confirmed' && row.forwardedAt));
});

for (const stop of ['cancel', 'timeout', 'early-return']) test(`realtime ${stop} during retry wait cannot dispatch a second request`, { timeout: 5000 }, async t => {
  const { options, ledger } = await setup(t, { totalTimeoutMs: stop === 'timeout' ? 500 : 12000 });
  const controller = new AbortController(); let calls = 0, waiting = false;
  const scheduler = stop === 'early-return' ? { kind: 'realtime', async waitUntil(deadline) { waiting ||= deadline > Date.now(); } }
    : realtime(deadline => {
      if (deadline > Date.now()) {
        waiting = true;
        if (stop === 'cancel') controller.abort();
      }
    });
  const result = await captureSemanticOffline({ ...options, signal: controller.signal, scheduler,
    response: () => { calls++; return { status: 503, body: '{}', retryAfter: '0.01' }; } });
  assert.equal(waiting, true); assert.equal(calls, 1);
  assert.equal(result.complete, false); assert.equal(result.cleanup, true);
  assert.equal(result.errorCode, stop === 'early-return' ? 'SEMANTIC_CAPTURE_INCOMPLETE' : 'TIMEOUT_OR_CANCELLED');
  assert.equal(ledger.snapshot().attempts.length, 1);
  assert.equal(result.transport.budgetBindings.length, 1);
});
