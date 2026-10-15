import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { runSemanticPairedOffline, inspectSemanticPairedOffline } from '../scripts/lib/semantic-quality-paired.mjs';
import { qualitySources } from '../scripts/lib/quality-collector.mjs';
import { openSemanticQualityBudget } from '../scripts/lib/quality-budget.mjs';
let root, directory, source;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'semantic-pair-')); directory = path.join(root, 'run');
  const run = await runSemanticPairedOffline(directory); assert.equal(run.complete, true, run.errorCode); source = await qualitySources();
}, { timeout: 40000 });
after(() => rm(root, { recursive: true, force: true }));
test('paired production workflows traverse gateway and persistent budget, independently reopened with no quality claim', async () => {
  const r = await inspectSemanticPairedOffline(directory, source); assert.equal(r.infrastructurePassed, true, JSON.stringify(r));
  assert.deepEqual(r.scope, { pairs: 4, captures: 8, attempts: 12, reservedMicros: 12 });
  assert.equal(r.comparison, 'same-source-rehearsal'); assert.equal(r.qualityStatus, 'not_run');
  assert.equal(r.fullQualityAcceptance, false); assert.equal(r.releaseEligible, false); assert.equal(r.liveCalls, 0);
});
const changes = [
  ['freeze.json', 'source', r => { r.source.sha = '0'.repeat(40); }],
  ['freeze.json', 'frozen input', r => { r.samples[0].segments[0] += ' changed'; }],
  ['freeze.json', 'raised budget', r => { r.budget.ceilingMicros++; }],
  ['paired.json', 'missing candidate', r => { r.captures.pop(); }],
  ['paired.json', 'swapped role', r => { r.captures[0].role = 'candidate'; }],
  ['paired.json', 'invented quality', r => { r.qualityStatus = 'passed'; }],
  ['paired.json', 'missing snapshot', r => { r.roleSnapshots.pop(); }],
  ['baseline/qualified-0/capture.json', 'missing budget receipt', r => { r.transport.budgetBindings.pop(); }],
  ['baseline/qualified-0/capture.json', 'aliased trial', r => { r.transport.budgetBindings[0].trialId = 'candidate:qualified:0'; }],
  ['baseline/qualified-0/capture.json', 'changed wire', r => { r.transport.observations[0].requestWire += ' '; }],
  ['baseline/qualified-0/capture.json', 'send before reservation', r => { r.transport.observations[0].forwardedAt = '2000-01-01T00:00:00.000Z'; }],
  ['baseline/qualified-0/capture.json', 'duplicate reservation', r => { r.transport.budgetBindings[1].attemptId = r.transport.budgetBindings[0].attemptId; }],
];
for (const [filename, name, mutate] of changes) test(`paired reader rejects ${name}`, async () => {
  const full = path.join(directory, filename), bytes = await readFile(full), value = JSON.parse(bytes); mutate(value);
  await writeFile(full, JSON.stringify(value));
  try { assert.equal((await inspectSemanticPairedOffline(directory, source)).infrastructurePassed, false); }
  finally { await writeFile(full, bytes); }
});
test('ledger reopen cannot replay either completed role or refund consumed spend', async () => {
  const plan = JSON.parse(await readFile(path.join(directory, 'freeze.json'))), run = JSON.parse(await readFile(path.join(directory, 'paired.json')));
  const ledger = openSemanticQualityBudget(path.join(directory, 'budget.sqlite'), plan.budget, run.freezeDigest);
  try {
    assert.equal(ledger.snapshot().reservedMicros, 12);
    for (const role of ['baseline','candidate']) {
      assert.throws(() => ledger.claimRun({ role, sourceSha: source.sha, directory: path.join(directory, role), expectedSnapshot: ledger.snapshot() }), /RUN_ORDER/);
      assert.throws(() => ledger.reserve({ kind: 'knowledge', trialId: `${role}:qualified:0` }), /RUN_CLAIM_MISSING/);
    }
  } finally { ledger.close(); }
  assert.equal((await inspectSemanticPairedOffline(directory, source)).infrastructurePassed, true);
});
test('independent reader detects ledger mutation or missing SQLite and never repairs evidence', async () => {
  const filename = path.join(directory, 'budget.sqlite'), bytes = await readFile(filename);
  const db = new DatabaseSync(filename); db.prepare('UPDATE attempts SET reserved_micros=0 WHERE id=1').run(); db.close();
  try { assert.equal((await inspectSemanticPairedOffline(directory, source)).infrastructurePassed, false); }
  finally { await writeFile(filename, bytes); }
  const capture = path.join(directory, 'candidate/qualified-0/store.sqlite'), original = await readFile(capture); await rm(capture);
  try { assert.equal((await inspectSemanticPairedOffline(directory, source)).infrastructurePassed, false); }
  finally { await writeFile(capture, original); }
  assert.equal((await inspectSemanticPairedOffline(directory, source)).infrastructurePassed, true);
});
test('cancelled pair stays incomplete and an existing output cannot be overwritten or resumed as complete', async () => {
  const cancelled = path.join(root, 'cancelled');
  const r = await runSemanticPairedOffline(cancelled, { signal: AbortSignal.abort() });
  assert.equal(r.complete, false); assert.equal(r.qualityStatus, 'not_run'); assert.equal(r.errorCode, 'SEMANTIC_PAIR_CANCELLED');
  assert.equal((await inspectSemanticPairedOffline(cancelled, source)).infrastructurePassed, false);
  await assert.rejects(runSemanticPairedOffline(directory), /EEXIST/);
});
test('CLI reopens complete paired evidence and refuses live even for the paired command', () => {
  const check = spawnSync(process.execPath, ['scripts/evaluate-semantic-quality.mjs', 'check-paired-offline', '--out', directory], { encoding: 'utf8', timeout: 10000 });
  assert.equal(check.status, 0, check.stderr); assert.equal(JSON.parse(check.stdout).infrastructurePassed, true);
  const live = spawnSync(process.execPath, ['scripts/evaluate-semantic-quality.mjs', 'paired-offline', '--live'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(live.status, 1); assert.match(live.stderr, /LIVE_SEMANTIC_ADAPTER_NOT_IMPLEMENTED_OR_AUTHORIZED/);
});
