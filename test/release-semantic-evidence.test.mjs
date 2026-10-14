import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runSemanticOffline, inspectSemanticOffline } from '../scripts/lib/semantic-quality-offline.mjs';
import { qualitySources } from '../scripts/lib/quality-collector.mjs';
import { readTechnicalEvidence } from '../scripts/lib/release-evidence.mjs';
import { technicalSuites, purposes } from '../verification/release/policy.mjs';
import { sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { runProcess } from '../scripts/lib/process.mjs';
const json = (file, value) => writeFile(file, JSON.stringify(value));
async function temporary(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'release-semantic-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
const boundary = result => {
  assert.equal(result.qualityStatus, 'not_run'); assert.equal(result.qualityEvaluated, false); assert.equal(result.fullQualityAcceptance, false);
  assert.equal(result.releaseEligible, false); assert.equal(result.fullProjectAcceptance, false); assert.equal(result.liveCalls, 0);
};
test('semantic offline is mandatory and missing or ambiguous existing Node artifacts cannot silently disappear', async t => {
  for (const suites of [technicalSuites, purposes.pr, purposes.release]) assert.equal(suites.filter(suite => suite === 'semantic-offline').length, 1);
  const directory = await temporary(t), result = await readTechnicalEvidence('semantic-offline', directory, { release: false });
  assert.equal(result.ok, false); assert.equal(result.status, 'not_run'); boundary(result);
  const artifact = path.join(directory, `test-evidence-${sourceVersion().sha}`, 'verification-evidence/semantic-quality'), output = path.join(directory, 'manifest.json');
  for (const count of [0, 1, 2]) {
    if (count) { const candidate = path.join(artifact, `offline-${count}`); await mkdir(candidate, { recursive: true }); await json(path.join(candidate, 'summary.json'), { kind: 'semantic-offline-summary' }); }
    const run = await runProcess(process.execPath, ['scripts/release-manifest.mjs', `--artifact-root=${directory}`, `--output=${output}`], { timeoutMs: 10000 });
    assert.equal(run.ok, true, run.tail); const manifest = JSON.parse(await readFile(output, 'utf8')), row = manifest.evidence.find(row => row.suite === 'semantic-offline');
    assert.equal(manifest.evidence.length, 16);
    if (count === 1) { assert.equal(row.discoveryError, undefined); assert.equal(row.directory, path.join(artifact, 'offline-1')); }
    else assert.equal(row.discoveryError, count ? 'ambiguous_report_artifacts' : 'missing_report_artifact');
  }
  await writeFile(path.join(artifact, 'offline-2/summary.json'), '{malformed');
  const malformed = await runProcess(process.execPath, ['scripts/release-manifest.mjs', `--artifact-root=${directory}`, `--output=${output}`], { timeoutMs: 10000 });
  assert.equal(malformed.ok, true, malformed.tail);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).evidence.find(row => row.suite === 'semantic-offline').discoveryError, 'ambiguous_report_artifacts');
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow.slice(workflow.indexOf('  test:'), workflow.indexOf('  relation-protocol:')), /npm run quality:semantic -- offline --release/);
});
test('semantic release reader reuses actual offline workflow evidence and cannot promote synthetic review to real quality', { timeout: 30000 }, async t => {
  const directory = await temporary(t), runDirectory = path.join(directory, 'run');
  const run = await runSemanticOffline(runDirectory); assert.equal(run.complete, true, run.errorCode);
  const source = await qualitySources(), summary = await inspectSemanticOffline(runDirectory, source); assert.equal(summary.infrastructurePassed, true);
  const summaryFile = path.join(directory, 'summary.json'); await json(summaryFile, summary);
  const passed = await readTechnicalEvidence('semantic-offline', directory, { release: false }); assert.equal(passed.ok, true, JSON.stringify(passed)); boundary(passed);
  assert.deepEqual(passed.source, { sha: source.sha, dirty: source.dirty }); assert.equal(passed.stale, false);
  assert.equal(passed.scope.cases, 11); assert.equal(passed.scope.artifacts, 56); assert.equal(passed.scope.semanticMutantsDetected, 8);
  assert.ok(passed.scope.properties.every(row => row.status === 'not_run'));
  for (const patch of [{ qualityStatus: 'passed' }, { qualityEvaluated: true }, { fullQualityAcceptance: true }, { releaseEligible: true }, { liveCalls: 1 }, { infrastructurePassed: false }]) {
    await json(summaryFile, { ...summary, ...patch }); const rejected = await readTechnicalEvidence('semantic-offline', directory, { release: false }); assert.equal(rejected.ok, false); boundary(rejected);
  }
  await json(summaryFile, summary);
  for (const [file, mutate] of [
    ['run.json', r => { r.sourceEnd.sha = '0'.repeat(40); }],
    ['qualified/capture.json', r => { r.calls[0].requestWire += ' '; }],
    ['qualified/capture.json', r => { r.calls[0].response = { items: [] }; }],
    ['mutant-number/synthetic-review.json', r => { r.rows.forEach(row => { row.severe.number = false; }); }]
  ]) {
    const location = path.join(runDirectory, file), original = await readFile(location), changed = JSON.parse(original); mutate(changed); await json(location, changed);
    // Rehash/recompute summaries after corruption: cached claims cannot rescue raw evidence.
    await json(summaryFile, await inspectSemanticOffline(runDirectory, source));
    const rejected = await readTechnicalEvidence('semantic-offline', directory, { release: false }); assert.equal(rejected.ok, false, file); boundary(rejected);
    if (file === 'run.json') { assert.equal(rejected.stale, true); assert.deepEqual(rejected.source, passed.source); }
    await writeFile(location, original); await json(summaryFile, summary);
  }
  const database = path.join(runDirectory, 'qualified/store.sqlite'), bytes = await readFile(database); await rm(database);
  assert.equal((await readTechnicalEvidence('semantic-offline', directory, { release: false })).ok, false); await writeFile(database, bytes);
  await symlink(path.join(runDirectory, 'run.json'), path.join(directory, 'unbound-symlink'));
  assert.equal((await readTechnicalEvidence('semantic-offline', directory, { release: false })).ok, false);
});
