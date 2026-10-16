import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { openQualityBudget, openSemanticQualityBudget } from '../scripts/lib/quality-budget.mjs';
import { createSemanticGateway } from '../scripts/lib/semantic-quality-gateway.mjs';
import { closeServer, deadline } from '../test-support/lifecycle.mjs';
const freeze = 'a'.repeat(64), source = 'b'.repeat(40);
const config = () => ({ id: 'synthetic-semantic-budget', currency: 'USD', ceilingMicros: 40,
  maxAttempts: { knowledge: 4, relation: 4 }, attemptMicros: { knowledge: 10, relation: 5 },
  maxTrialAttempts: { knowledge: 3, relation: 3 }, expiresAt: new Date(Date.now() + 60000).toISOString() });
async function setup(t, override = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'semantic-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'ledger.sqlite'), settings = { ...config(), ...override };
  return { directory, filename, settings };
}
function claim(budget, directory, role = 'baseline') {
  budget.claimRun({ role, sourceSha: source, directory: path.join(directory, role), expectedSnapshot: budget.snapshot() });
}
test('semantic ledger uses explicit domain limits and persists run order, failed costs and immutable binding', async t => {
  const { directory, filename, settings } = await setup(t);
  let budget = openSemanticQualityBudget(filename, settings, freeze); t.after(() => budget.close());
  assert.throws(() => budget.reserve({ kind: 'knowledge', trialId: 'baseline:s:0' }), /RUN_CLAIM_MISSING/);
  assert.throws(() => claim(budget, directory, 'candidate'), /RUN_ORDER/);
  claim(budget, directory);
  for (let i = 0; i < 3; i++) budget.observe(budget.reserve({ kind: 'knowledge', trialId: 'baseline:s:0' }), { status: i ? 'failed' : 'cancelled' });
  assert.throws(() => budget.reserve({ kind: 'knowledge', trialId: 'baseline:s:0' }), /TRIAL_ATTEMPT_LIMIT/);
  assert.throws(() => budget.reserve({ kind: 'mt', trialId: 'baseline:s:0' }), /INVALID_ATTEMPT/);
  budget.finishRun('baseline', true);
  const snapshot = budget.snapshot(); budget.close();
  budget = openSemanticQualityBudget(filename, settings, freeze); assert.deepEqual(budget.snapshot(), snapshot);
  claim(budget, directory, 'candidate');
  budget.reserve({ kind: 'relation', trialId: 'candidate:s:0' }); budget.reserve({ kind: 'relation', trialId: 'candidate:s:0' });
  assert.throws(() => budget.reserve({ kind: 'relation', trialId: 'candidate:s:1' }), /BUDGET_EXHAUSTED/);
  assert.equal(budget.snapshot().reservedMicros, 40);
  budget.finishRun('candidate', false); assert.throws(() => claim(budget, directory, 'candidate'), /RUN_ORDER/);
  assert.throws(() => openSemanticQualityBudget(filename, { ...settings, maxTrialAttempts: { knowledge: 4, relation: 3 } }, freeze), /BUDGET_BINDING_CHANGED/);
  assert.throws(() => openSemanticQualityBudget(filename, settings, 'c'.repeat(64)), /BUDGET_BINDING_CHANGED/);
});
test('semantic ledger refuses missing bounds, expiry, run-claim bypass and mixed-domain reuse', async t => {
  const { filename, settings } = await setup(t);
  for (const changed of [{ maxTrialAttempts: undefined }, { maxTrialAttempts: { knowledge: 0, relation: 3 } },
    { expiresAt: undefined }, { requireRunClaim: false }, { attemptMicros: { knowledge: Number.MAX_SAFE_INTEGER + 1, relation: 5 } }])
    assert.throws(() => openSemanticQualityBudget(filename, { ...settings, ...changed }, freeze), /INVALID_BUDGET/);
  const expired = openSemanticQualityBudget(filename, { ...settings, expiresAt: '2000-01-01T00:00:00Z' }, freeze);
  try { assert.throws(() => claim(expired, path.dirname(filename)), /BUDGET_APPROVAL_EXPIRED/); assert.equal(expired.snapshot().attempts.length, 0); } finally { expired.close(); }
  const mixed = { ...settings, requireRunClaim: true, budgetDomain: 'semantic-v1', maxAttempts: { ...settings.maxAttempts, asr: 1, mt: 1 }, attemptMicros: { ...settings.attemptMicros, asr: 1, mt: 1 } };
  const other = filename + '.other', legacy = openQualityBudget(other, mixed, freeze); legacy.close();
  assert.throws(() => openSemanticQualityBudget(other, mixed, freeze), /BUDGET_BINDING_CHANGED/);
});
test('legacy ASR/MT budget retains the exact original binding and trial limits', async t => {
  const { filename } = await setup(t);
  const settings = { id: 'legacy', currency: 'CNY', ceilingMicros: 100, maxAttempts: { asr: 10, mt: 10 }, attemptMicros: { asr: 1, mt: 1 } };
  const budget = openQualityBudget(filename, settings, freeze); t.after(() => budget.close());
  assert.equal(budget.snapshot().binding, createHash('sha256').update(JSON.stringify({ config: settings, freezeDigest: freeze })).digest('hex'));
  budget.reserve({ kind: 'asr', trialId: 's' }); budget.reserve({ kind: 'asr', trialId: 's' });
  assert.throws(() => budget.reserve({ kind: 'asr', trialId: 's' }), /TRIAL_ATTEMPT_LIMIT/);
  budget.reserve({ kind: 'mt', trialId: 's' }); assert.throws(() => budget.reserve({ kind: 'mt', trialId: 's' }), /TRIAL_ATTEMPT_LIMIT/);
});
test('independent processes race for one durable ceiling and restart cannot reclaim cancelled spend', { timeout: 10000 }, async t => {
  const { directory, filename, settings } = await setup(t, { ceilingMicros: 10 });
  const initial = openSemanticQualityBudget(filename, settings, freeze); claim(initial, directory); initial.close();
  const moduleUrl = new URL('../scripts/lib/quality-budget.mjs', import.meta.url).href;
  const program = `import {openSemanticQualityBudget} from ${JSON.stringify(moduleUrl)};
    process.on('message', data => { if(data.open) { globalThis.b=openSemanticQualityBudget(data.filename,data.settings,data.freeze); process.send('ready'); }
    else { try {const id=b.reserve({kind:'knowledge',trialId:'baseline:'+process.pid});b.observe(id,{status:'cancelled'});process.send({reserved:id});}
    catch(e){process.send({error:e.message});} finally {b.close();process.disconnect();} } });`;
  const children = [0, 1].map(() => fork('--input-type=module', ['--eval', program], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });
  await deadline(() => Promise.all(children.map(async child => {
    const ready = once(child, 'message'); child.send({ open: true, filename, settings, freeze }); assert.equal((await ready)[0], 'ready');
  })), 5000, 'budget processes ready');
  const replies = children.map(child => once(child, 'message')), exits = children.map(child => once(child, 'exit'));
  children.forEach(child => child.send({ reserve: true }));
  const results = (await deadline(() => Promise.all(replies), 5000, 'budget race')).map(row => row[0]);
  assert.equal(results.filter(row => row.reserved).length, 1); assert.equal(results.filter(row => row.error === 'BUDGET_EXHAUSTED').length, 1);
  for (const [code] of await deadline(() => Promise.all(exits), 5000, 'budget children exit')) assert.equal(code, 0);
  const reopened = openSemanticQualityBudget(filename, settings, freeze);
  try { assert.equal(reopened.snapshot().reservedMicros, 10); assert.equal(reopened.snapshot().attempts.length, 1);
    assert.throws(() => reopened.reserve({ kind: 'knowledge', trialId: 'baseline:restart' }), /BUDGET_EXHAUSTED/);
  } finally { reopened.close(); }
});
for (const outcome of ['http-error', 'timeout']) test(`real gateway ${outcome} keeps committed SQLite spend and exhaustion sends nothing`, { timeout: 5000 }, async t => {
  const { directory, filename, settings } = await setup(t, { ceilingMicros: 10 });
  const budget = openSemanticQualityBudget(filename, settings, freeze); t.after(() => budget.close()); claim(budget, directory);
  let received = 0;
  const server = http.createServer((_request, response) => {
    received++; const independent = openSemanticQualityBudget(filename, settings, freeze);
    try { assert.equal(independent.snapshot().reservedMicros, 10); assert.equal(independent.snapshot().attempts.length, 1); }
    finally { independent.close(); }
    if (outcome === 'http-error') { response.writeHead(503); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => closeServer(server, 'budget upstream'));
  const gateway = await createSemanticGateway({ mode: 'offline', upstream: { endpoint: `http://127.0.0.1:${server.address().port}`, key: 'synthetic-budget-key' },
    expected: { knowledgeModel: 'test-knowledge', relationModel: 'test-relation', maxRequests: 3, maxRequestBytes: 256, maxResponseBytes: 256, timeoutMs: outcome === 'timeout' ? 50 : 1000, expiresAt: settings.expiresAt },
    authorize: () => true, reserve: context => String(budget.reserve({ kind: context.kind, trialId: 'baseline:sample:0' })) });
  t.after(() => gateway.close());
  const request = () => fetch(gateway.knowledgeEndpoint, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}` },
    body: JSON.stringify({ model: 'test-knowledge', enable_thinking: false, messages: [{ role: 'system', content: 'Synthetic.' }, { role: 'user', content: '{}' }] }) });
  assert.equal((await request()).status, outcome === 'timeout' ? 502 : 503); assert.equal((await request()).status, 502); assert.equal(received, 1);
  assert.equal(budget.snapshot().reservedMicros, 10); assert.equal(gateway.observations()[0].attemptId, '1');
});

test('semantic forced run claim has one binding regardless of omitted or explicit flag position', async t => {
  const { filename, settings } = await setup(t);
  const budget = openSemanticQualityBudget(filename, settings, freeze), snapshot = budget.snapshot(); budget.close();
  const { id, ...rest } = settings;
  for (const equivalent of [{ requireRunClaim: true, ...settings }, { id, requireRunClaim: true, ...rest }, { ...settings, requireRunClaim: true }]) {
    const reopened = openSemanticQualityBudget(filename, equivalent, freeze);
    try { assert.deepEqual(reopened.snapshot(), snapshot); } finally { reopened.close(); }
  }
});

test('batch trial roster shares one ceiling but each exact trial keeps its own derived limits', async t => {
  const trialLimits = {
    'baseline:small:0': { knowledge: 1, relation: 1 }, 'baseline:large:0': { knowledge: 3, relation: 2 },
    'candidate:small:0': { knowledge: 1, relation: 1 }, 'candidate:large:0': { knowledge: 3, relation: 2 }
  };
  const { directory, filename, settings } = await setup(t, { ceilingMicros: 100,
    maxAttempts: { knowledge: 8, relation: 6 }, trialLimits });
  let budget = openSemanticQualityBudget(filename, settings, freeze); t.after(() => budget.close());
  claim(budget, directory);
  assert.throws(() => budget.reserve({ kind: 'knowledge', trialId: 'baseline:unknown:0' }), /INVALID_ATTEMPT/);
  assert.throws(() => budget.reserve({ kind: 'knowledge', trialId: 'baseline:small:1' }), /INVALID_ATTEMPT/);
  assert.throws(() => budget.reserve({ kind: 'knowledge', trialId: 'candidate:small:0' }), /RUN_CLAIM_MISSING/);
  const id = budget.reserve({ kind: 'knowledge', trialId: 'baseline:small:0' }); budget.observe(id, { status: 'cancelled' });
  trialLimits['baseline:small:0'].knowledge = 3; // caller mutation cannot expand the bound
  assert.throws(() => budget.reserve({ kind: 'knowledge', trialId: 'baseline:small:0' }), /TRIAL_ATTEMPT_LIMIT/);
  for (let i = 0; i < 3; i++) budget.reserve({ kind: 'knowledge', trialId: 'baseline:large:0' });
  assert.throws(() => budget.reserve({ kind: 'knowledge', trialId: 'baseline:large:0' }), /TRIAL_ATTEMPT_LIMIT/);
  assert.equal(budget.snapshot().reservedMicros, 40);
  trialLimits['baseline:small:0'].knowledge = 1;
  const snapshot = budget.snapshot(); budget.close(); budget = openSemanticQualityBudget(filename, settings, freeze);
  assert.deepEqual(budget.snapshot(), snapshot);
  assert.throws(() => budget.reserve({ kind: 'knowledge', trialId: 'baseline:small:0' }), /TRIAL_ATTEMPT_LIMIT/);
  budget.finishRun('baseline', true); claim(budget, directory, 'candidate');
  budget.reserve({ kind: 'knowledge', trialId: 'candidate:small:0' });
  assert.equal(budget.snapshot().reservedMicros, 50); assert.equal(budget.snapshot().runs.length, 2);
  assert.throws(() => claim(budget, directory, 'candidate'), /RUN_ORDER/);
  const changed = structuredClone(settings); changed.trialLimits['baseline:small:0'].knowledge = 2;
  assert.throws(() => openSemanticQualityBudget(filename, changed, freeze), /BUDGET_BINDING_CHANGED/);
});

test('batch roster descriptors, exact kinds, canonical IDs and finite bounds fail before opening a ledger', () => {
  const limits = () => ({ 'baseline:sample:0': { knowledge: 1, relation: 1 } });
  let reads = 0;
  const accessor = Object.defineProperty({}, 'baseline:sample:0', { enumerable: true, get() { reads++; return { knowledge: 1, relation: 1 }; } });
  const nestedAccessor = { 'baseline:sample:0': Object.defineProperty({ relation: 1 }, 'knowledge', { enumerable: true, get() { reads++; return 1; } }) };
  const hidden = Object.defineProperty(limits(), 'hidden', { value: { knowledge: 1, relation: 1 } });
  const symbol = { ...limits(), [Symbol('hidden')]: { knowledge: 1, relation: 1 } };
  for (const trialLimits of [undefined, null, {}, [], accessor, nestedAccessor, hidden, symbol,
    Object.create(limits()), { 'other:sample:0': { knowledge: 1, relation: 1 } },
    { 'baseline:sample:01': { knowledge: 1, relation: 1 } }, { 'baseline:sample:9007199254740992': { knowledge: 1, relation: 1 } },
    { 'baseline:sample:0': { knowledge: 0, relation: 1 } }, { 'baseline:sample:0': { knowledge: 4, relation: 1 } },
    { 'baseline:sample:0': { knowledge: 1, relation: 1, asr: 1 } },
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`baseline:sample:${index}`, { knowledge: 1, relation: 1 }]))]) {
    assert.throws(() => openSemanticQualityBudget(':memory:', { ...config(), trialLimits }, freeze), /INVALID_BUDGET/);
  }
  const settings = Object.defineProperty(config(), 'trialLimits', { enumerable: true, get() { reads++; return limits(); } });
  assert.throws(() => openSemanticQualityBudget(':memory:', settings, freeze), /INVALID_BUDGET/);
  assert.equal(reads, 0);
});

test('v1 semantic binding remains byte-for-byte unchanged without a batch roster', () => {
  const settings = config(), budget = openSemanticQualityBudget(':memory:', settings, freeze);
  try { assert.equal(budget.snapshot().binding, createHash('sha256').update(JSON.stringify({
    config: { ...settings, requireRunClaim: true }, freezeDigest: freeze, domain: 'semantic-v1'
  })).digest('hex')); } finally { budget.close(); }
});
