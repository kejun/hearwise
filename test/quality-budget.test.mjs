import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path'; import { tmpdir } from 'node:os';
import { openQualityBudget } from '../scripts/lib/quality-budget.mjs';

test('attempt reservations persist before sending and never refund failures or restart', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-budget-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { id: 'test-approval', currency: 'CNY', ceilingMicros: 15, maxAttempts: { asr: 2, mt: 2 }, attemptMicros: { asr: 10, mt: 5 } };
  let budget = openQualityBudget(path.join(directory, 'budget.sqlite'), config, 'a'.repeat(64));
  const first = budget.reserve({ kind: 'asr', trialId: 'baseline:a:0' });
  assert.equal(budget.snapshot().reservedMicros, 10); assert.equal(first, 1);
  budget.observe(first, { status: 'cancelled' }); budget.close();
  budget = openQualityBudget(path.join(directory, 'budget.sqlite'), config, 'a'.repeat(64)); t.after(() => budget.close());
  assert.throws(() => budget.reserve({ kind: 'asr', trialId: 'candidate:a:0' }), /BUDGET_EXHAUSTED/);
  assert.equal(budget.reserve({ kind: 'mt', trialId: 'baseline:m:0' }), 2);
  assert.throws(() => budget.reserve({ kind: 'mt', trialId: 'candidate:m:0' }), /BUDGET_EXHAUSTED/);
  assert.equal(budget.snapshot().reservedMicros, 15); assert.equal(budget.snapshot().attempts.length, 2);
  assert.throws(() => openQualityBudget(path.join(directory, 'budget.sqlite'), config, 'b'.repeat(64)), /BUDGET_BINDING_CHANGED/);
});
test('two SQLite connections share one ceiling and changed or invalid approvals are rejected', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-budget-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { id: 'concurrent', currency: 'USD', ceilingMicros: 10, maxAttempts: { asr: 1, mt: 1 }, attemptMicros: { asr: 10, mt: 10 } };
  const filename = path.join(directory, 'budget.sqlite'), a = openQualityBudget(filename, config, 'c'.repeat(64)), b = openQualityBudget(filename, config, 'c'.repeat(64));
  t.after(() => { a.close(); b.close(); }); a.reserve({ kind: 'mt', trialId: 'a' });
  assert.throws(() => b.reserve({ kind: 'asr', trialId: 'b' }), /BUDGET_EXHAUSTED/);
  assert.equal(b.snapshot().attempts.length, 1);
  config.ceilingMicros = 1000; config.attemptMicros.asr = 1;
  assert.throws(() => b.reserve({ kind: 'asr', trialId: 'caller-mutation' }), /BUDGET_EXHAUSTED/);
  assert.throws(() => openQualityBudget(filename, { ...config, ceilingMicros: 20 }, 'c'.repeat(64)), /BUDGET_BINDING_CHANGED/);
  assert.throws(() => openQualityBudget(path.join(directory, 'invalid.sqlite'), { ...config, ceilingMicros: null }, 'c'.repeat(64)), /INVALID_BUDGET/);
});
test('expiry and per-trial attempts remain fail closed even with unused global money', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-budget-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { id: 'limits', currency: 'CNY', ceilingMicros: 100, maxAttempts: { asr: 10, mt: 10 }, attemptMicros: { asr: 1, mt: 1 } };
  const budget = openQualityBudget(path.join(directory, 'limit.sqlite'), config, 'a'.repeat(64)); t.after(() => budget.close());
  budget.reserve({ kind: 'asr', trialId: 'one' }); budget.reserve({ kind: 'asr', trialId: 'one' });
  assert.throws(() => budget.reserve({ kind: 'asr', trialId: 'one' }), /TRIAL_ATTEMPT_LIMIT/);
  budget.reserve({ kind: 'mt', trialId: 'one' }); assert.throws(() => budget.reserve({ kind: 'mt', trialId: 'one' }), /TRIAL_ATTEMPT_LIMIT/);
  const expired = openQualityBudget(path.join(directory, 'expired.sqlite'), { ...config, expiresAt: '2000-01-01T00:00:00Z' }, 'a'.repeat(64)); t.after(() => expired.close());
  assert.throws(() => expired.reserve({ kind: 'mt', trialId: 'one' }), /BUDGET_APPROVAL_EXPIRED/); assert.equal(expired.snapshot().attempts.length, 0);
  assert.throws(() => openQualityBudget(path.join(directory, 'invalid.sqlite'), { ...config, expiresAt: 'not-a-date' }, 'a'.repeat(64)), /INVALID_BUDGET/);
});
