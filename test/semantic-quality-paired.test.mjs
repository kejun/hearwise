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
import { semanticDatabase, semanticUnits } from '../scripts/lib/semantic-quality-capture.mjs';
import { hashBytes } from '../scripts/lib/quality-contract.mjs';
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

for (const [table, field, value] of [['relation_assertions','conditions','FORGED unconditional purchase'],
  ['relation_assertions','polarity','positive'], ['relation_assertions','modality','uncertain'],
  ['knowledge_facts','content','FORGED acquisition completed'], ['knowledge_items','short_description','FORGED biography']])
test(`paired reader rejects coordinated persisted ${table}.${field} forgery even with refreshed snapshots and hash`, async () => {
  const dir = path.join(directory, 'baseline/qualified-0'), file = path.join(dir, 'store.sqlite'), reportFile = path.join(dir, 'capture.json');
  const bytes = await readFile(file), reportBytes = await readFile(reportFile), capture = JSON.parse(reportBytes);
  const db = new DatabaseSync(file);
  const row = db.prepare(`SELECT * FROM ${table} ORDER BY id LIMIT 1`).get();
  db.prepare(`UPDATE ${table} SET ${field}=? WHERE id=?`).run(value === row[field] ? 'negative' : value, row.id); db.close();
  capture.after = semanticDatabase(file); capture.before.tables[table] = capture.after.tables[table];
  capture.units = semanticUnits(capture.after); capture.artifacts[0].sha256 = hashBytes(await readFile(file));
  await writeFile(reportFile, JSON.stringify(capture));
  try { assert.equal((await inspectSemanticPairedOffline(directory, source)).infrastructurePassed, false); }
  finally { await writeFile(file, bytes); await writeFile(reportFile, reportBytes); }
});
test('cancellation after an actual reservation preserves spent money across reopen and never completes the pair', { timeout: 10000 }, async () => {
  const dir = path.join(root, 'cancel-after-spend'), controller = new AbortController(); let spent = 0;
  const timer = setInterval(() => {
    let db;
    try { db = new DatabaseSync(path.join(dir, 'budget.sqlite'), { readOnly: true });
      spent = db.prepare('SELECT count(*) AS n FROM attempts').get().n; if (spent) controller.abort();
    } catch { /* Ledger has not been created yet. */ } finally { db?.close(); }
  }, 2);
  let run; try { run = await runSemanticPairedOffline(dir, { signal: controller.signal }); } finally { clearInterval(timer); }
  assert.ok(spent > 0); assert.equal(run.complete, false); assert.equal(run.errorCode, 'SEMANTIC_PAIR_CANCELLED');
  const plan = JSON.parse(await readFile(path.join(dir, 'freeze.json')));
  for (let i = 0; i < 3; i++) {
    const ledger = openSemanticQualityBudget(path.join(dir, 'budget.sqlite'), plan.budget, run.freezeDigest);
    try { assert.ok(ledger.snapshot().reservedMicros >= spent); assert.equal(ledger.snapshot().runs[0].state, 'incomplete'); }
    finally { ledger.close(); }
  }
  assert.equal((await inspectSemanticPairedOffline(dir, source)).infrastructurePassed, false);
});
