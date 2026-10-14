import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { properties, pilot } from '../verification/properties.mjs';
import { summarize, validateResult } from '../scripts/lib/verification-evidence.mjs';
import { runProcess } from '../scripts/lib/process.mjs';

async function run(t, scenario) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearwise-verification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processResult = await runProcess(process.execPath, ['scripts/verify.mjs', `--scenario=${scenario}`], {
    env: { ...process.env, VERIFICATION_EVIDENCE_DIR: root }, timeoutMs: 20000
  });
  const directories = await readdir(root);
  assert.equal(directories.length, 1, processResult.tail);
  const directory = path.join(root, directories[0]);
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
  await assert.rejects(access(path.join(directory, 'temporary-database')), { code: 'ENOENT' });
  return { directory, report, observations, processResult };
}
test('all 15 capability cards map actual assets and implementation without claiming execution', async () => {
  assert.equal(properties.length, 15);
  assert.equal(new Set(properties.map(p => p.id)).size, 15);
  for (let i = 0; i < properties.length; i++) {
    const card = properties[i];
    assert.equal(card.group, `HW-${String(i + 1).padStart(2, '0')}`);
    for (const key of ['requirement', 'consequence', 'preconditions', 'state', 'domain', 'assumptions']) assert.ok(card[key]);
    for (const key of ['owners', 'methods', 'issues', 'invalidatedBy', 'acceptance', 'gaps']) assert.ok(card[key].length);
    for (const file of [...card.assets, ...card.implementation]) await access(file);
    assert.equal(card.evidenceStatus, 'not_run');
  }
});
test('real relation workflow produces durable business evidence; gate rejects absent, stale and malformed evidence', async t => {
  const { directory, report, observations, processResult } = await run(t, 'success');
  assert.equal(processResult.code, 0, processResult.tail);
  assert.equal(report.ok, true);
  assert.equal(report.complete, true);
  const result = report.results[0];
  assert.equal(validateResult(result), true);
  assert.equal(observations.providerCalls, 1);
  assert.equal(observations.checkpoints[0].job.request_count, 0);
  assert.equal(observations.checkpoints[1].job.request_count, 1);
  assert.equal(observations.checkpoints[1].journal.length, 1);
  assert.equal(observations.businessResult.outcome, 'ok');
  assert.equal(observations.checkpoints.at(-1).relations.length, 1);
  assert.equal(observations.checkpoints.at(-1).hasWork, false);
  assert.equal(report.summary.fullProjectAcceptance, false);
  assert.equal(report.summary.coverage.filter(row => row.status === 'not_run').length, 14);
  const input = { results: [result], target: result.source, required: pilot, execution: report.execution, artifactsValid: [true] };
  assert.equal(summarize({ ...input, results: [] }).rows[0].reasons[0], 'missing');
  for (const mutate of [value => { value.source.sha = '0'.repeat(40); },
    value => { value.specification.version = 'next'; }, value => { value.specification.digest = '0'.repeat(64); },
    value => { value.property.version++; }]) {
    const changed = structuredClone(result); mutate(changed);
    const summary = summarize({ ...input, results: [changed] });
    assert.equal(summary.ok, false); assert.equal(summary.rows[0].stale, true);
  }
  for (const field of ['schemaVersion', 'source', 'specification', 'tools', 'environment', 'scope', 'startedAt', 'finishedAt', 'complete', 'status', 'extensions', 'artifacts']) {
    const changed = structuredClone(result); delete changed[field];
    assert.equal(summarize({ ...input, results: [changed] }).ok, false, field);
  }
  for (const status of ['failed', 'not_run', 'incomplete', 'not_applicable', 'unknown']) {
    assert.equal(summarize({ ...input, results: [{ ...result, status }] }).ok, false, status);
  }
  assert.equal(summarize({ ...input, results: [result, result], artifactsValid: [true, true] }).ok, false);
  assert.equal(summarize({ ...input, execution: { ...report.execution, code: 7 } }).ok, false);
  assert.equal(summarize({ ...input, release: true, results: [{ ...result, source: { ...result.source, dirty: true } }] }).ok, false);
  assert.equal(summarize({ ...input, required: properties.map(p => p.id) }).ok, false);
  assert.equal(summarize({ ...input, results: [{ ...result, artifacts: result.artifacts.slice(1) }] }).ok, false);
  const cli = () => runProcess(process.execPath, ['scripts/verify-report.mjs', directory], { timeoutMs: 5000 });
  assert.equal((await cli()).code, 0);
  // Cached report.ok remains true: the independent reporter must re-read files.
  await rm(path.join(directory, 'result.json'));
  const missing = await cli(); assert.equal(missing.code, 1); assert.match(missing.tail, /missing/);
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result));
  await rm(path.join(directory, 'observations.json'));
  const missingArtifact = await cli(); assert.equal(missingArtifact.code, 1); assert.match(missingArtifact.tail, /missing_or_changed_artifact/);
  await writeFile(path.join(directory, 'observations.json'), '{}');
  const tampered = await cli(); assert.equal(tampered.code, 1); assert.match(tampered.tail, /missing_or_changed_artifact/);
});
test('business failure is a completed failing observation, not an incomplete run or a pass', async t => {
  const { report, observations, processResult } = await run(t, 'business-failure');
  assert.equal(processResult.code, 1);
  assert.equal(report.complete, true); assert.equal(report.ok, false);
  assert.equal(report.summary.rows[0].status, 'failed');
  assert.equal(observations.businessResult.outcome, 'failed');
  assert.equal(observations.providerCalls, 1);
  assert.equal(observations.checkpoints.at(-1).job.state, 'failed');
  assert.equal(observations.checkpoints.at(-1).job.last_error, 'HTTP_401');
  assert.equal(observations.checkpoints.at(-1).relations.length, 0);
});
for (const scenario of ['timeout', 'interrupt']) test(`${scenario} kills the real pending workflow and preserves incomplete evidence`, async t => {
  const { report, observations, processResult } = await run(t, scenario);
  assert.equal(processResult.code, 1);
  assert.equal(report.complete, false); assert.equal(report.ok, false);
  assert.equal(report.summary.rows[0].status, 'incomplete');
  assert.equal(report.execution[scenario === 'timeout' ? 'timedOut' : 'interrupted'], true);
  assert.equal(observations.providerCalls, 1);
  assert.equal(observations.checkpoints.at(-1).job.request_count, 1);
  assert.equal(observations.businessResult, undefined);
  assert.ok(processResult.durationMs < 10000);
});
