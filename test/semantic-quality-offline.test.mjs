import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSemanticOffline, inspectSemanticOffline } from '../scripts/lib/semantic-quality-offline.mjs';
import { qualitySources } from '../scripts/lib/quality-collector.mjs';
import { captureSemanticOffline } from '../scripts/lib/semantic-quality-capture.mjs';
import { semanticFixtureSample, semanticFixtureResponse } from '../test-support/semantic-quality-fixture.mjs';
let root, directory, source;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'semantic-offline-test-')); directory = path.join(root, 'run');
  const run = await runSemanticOffline(directory); assert.equal(run.complete, true, run.errorCode); source = await qualitySources();
}, { timeout: 40000 });
after(() => rm(root, { recursive: true, force: true }));
test('all actual workflow outputs and deliberate semantic negatives are revalidated', async () => {
  const r = await inspectSemanticOffline(directory, source); assert.equal(r.infrastructurePassed, true, JSON.stringify(r));
  assert.deepEqual(r.scope, { cases: 11, positive: 3, semanticMutantsDetected: 8, artifacts: 56 });
  assert.equal(r.qualityStatus, 'not_run'); assert.equal(r.qualityEvaluated, false); assert.equal(r.fullQualityAcceptance, false);
  assert.equal(r.releaseEligible, false); assert.equal(r.liveCalls, 0); assert.equal(r.properties[0].status, 'not_run');
});
const changes = [
  ['run.json', 'quality label', r => { r.qualityStatus = 'passed'; }],
  ['run.json', 'live promotion', r => { r.mode = 'live'; }],
  ['run.json', 'missing case', r => { r.cases.pop(); }],
  ['run.json', 'self asserted detection', r => { r.cases[0].detected = true; }],
  ['run.json', 'missing source', r => { delete r.sourceEnd; }],
  ['qualified/review-template.json', 'prefilled template', r => { r.reviewer = 'invented'; }],
  ['qualified/synthetic-review.json', 'edited display output', r => { r.rows[0].output.value.canonical_name = 'changed'; }],
  ['qualified/synthetic-review.json', 'omitted output', r => { r.rows.pop(); }],
  ['qualified/synthetic-review.json', 'invented reviewer', r => { r.reviewer = 'real human'; }],
  ['qualified/synthetic-review.json', 'invented gold', r => { r.sample.gold.approved = true; }],
  ['mutant-number/synthetic-review.json', 'removed severe error', r => { r.rows.forEach(row => { row.severe.number = false; }); }],
  ['mutant-upstream-omission/synthetic-review.json', 'omitted missing gold', r => { r.missingGoldIds = []; }],
  ['mutant-number/assessment.json', 'self asserted normal score', r => { r.offlineReviewPassed = true; }],
  ['qualified/capture.json', 'changed provider output', r => { r.calls[0].response = { items: [] }; }],
  ['qualified/capture.json', 'changed raw request', r => { r.calls[0].requestWire += ' '; }],
  ['qualified/capture.json', 'missing raw calls', r => { r.calls = []; }],
  ['qualified/capture.json', 'missing reopen state', r => { delete r.before; }],
];
for (const [filename, name, mutate] of changes) test(`offline gate rejects ${name}`, async () => {
  const full = path.join(directory, filename), original = await readFile(full), report = JSON.parse(original); mutate(report);
  await writeFile(full, JSON.stringify(report));
  try { const r = await inspectSemanticOffline(directory, source); assert.equal(r.infrastructurePassed, false); assert.equal(r.complete, false); assert.equal(r.qualityStatus, 'not_run'); }
  finally { await writeFile(full, original); }
});
test('missing database or different source cannot pass the profile', async () => {
  const full = path.join(directory, 'qualified/store.sqlite'), original = await readFile(full); await rm(full);
  try { assert.equal((await inspectSemanticOffline(directory, source)).infrastructurePassed, false); }
  finally { await writeFile(full, original); }
  assert.equal((await inspectSemanticOffline(directory, { ...source, sha: '0'.repeat(40) })).infrastructurePassed, false);
});
test('cancellation preserves an incomplete capture and no quality claim', async () => {
  const r = await captureSemanticOffline({ directory: path.join(root, 'cancelled'), sample: semanticFixtureSample(), response: semanticFixtureResponse(), signal: AbortSignal.abort() });
  assert.equal(r.complete, false); assert.equal(r.cleanup, true); assert.equal(r.errorCode, 'TIMEOUT_OR_CANCELLED');
  assert.equal(r.qualityStatus, 'not_run'); assert.equal(r.calls.length, 0);
});
for (const args of [['collect'], ['collect','--live'], ['offline','--live'], ['plan','--live']]) test(`CLI rejects paid adapter path ${args.join(' ')}`, () => {
  const result = spawnSync(process.execPath, ['scripts/evaluate-semantic-quality.mjs', ...args], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /LIVE_SEMANTIC_ADAPTER_NOT_IMPLEMENTED_OR_AUTHORIZED/);
  assert.match(result.stderr, /"qualityStatus":"not_run"/);
});
