import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { traceReleaseFixture } from '../test-support/release-trace-fixture.mjs';
import { validateTraceReleaseEvidence } from '../scripts/lib/trace-release-evidence.mjs';
import { validateQualityInfrastructureEvidence } from '../scripts/lib/quality-release-evidence.mjs';
import { runOfflineQuality } from '../test-support/quality-offline.mjs';
import { inspectOfflineQualityEvidence } from '../scripts/lib/quality-offline-evidence.mjs';
import { qualitySources } from '../scripts/lib/quality-collector.mjs';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { hashEvidenceFiles } from '../scripts/lib/runner-evidence-contract.mjs';
const json = (file, value) => writeFile(file, JSON.stringify(value));
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function temporary(t, prefix) { const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
test('Trace release reader independently reconstructs real business observations and rejects rehashed contradictions', { timeout: 30000 }, async t => {
  const directory = await temporary(t, 'trace-release-'), baseline = await traceReleaseFixture(directory);
  const first = await validateTraceReleaseEvidence(directory, { release: false }); assert.equal(first.ok, true, JSON.stringify(first));
  const originals = new Map();
  for (const name of ['report.json', 'observations.json', 'business-observations.json', 'trace-browser.json', 'trace-safe-export.json', 'regressions.log', 'worker.log', 'trace-full.html']) originals.set(name, await readFile(path.join(directory, name)));
  for (const [name, mutate] of [
    ['empty durable', async value => { const data = await readJson(path.join(directory, 'business-observations.json')); data.workflows[0].captures[0].query = {}; await json(path.join(directory, 'business-observations.json'), data); }],
    ['changed compiled mutation', async value => { value.mutations[0].mutantSha256 = '0'.repeat(64); }],
    ['wrong browser identity', async value => { value.browser.identityObservations[0].jobId = 'unrelated'; await json(path.join(directory, 'trace-browser.json'), value.browser); }],
    ['false export', async value => { await json(path.join(directory, 'trace-safe-export.json'), { current: { eventCount: baseline.business.boundaries.find(row => row.name === 'full-public-boundary').report.eventCount } }); }],
    ['different rendered HTML', async value => { await writeFile(path.join(directory, 'trace-full.html'), 'wrong renderer'); }],
    ['wrong same-count regressions', async value => { const log = (await readFile(path.join(directory, 'regressions.log'), 'utf8')).replace(/^ok 1 - .*/m, 'ok 1 - unrelated test'); await writeFile(path.join(directory, 'regressions.log'), log); value.checks[1].execution.tail = log.slice(-12000); }],
    ...['not ok 99 - injected failed test', '    not ok 1 - injected failed child'].map(line => [line, async value => { const log = (await readFile(path.join(directory, 'regressions.log'), 'utf8')).replace('TAP version 13\n', `TAP version 13\n${line}\n`); await writeFile(path.join(directory, 'regressions.log'), log); value.checks[1].execution.tail = log.slice(-12000); }]),
    ['child timeout', async value => { value.checks[2].execution.timedOut = true; }],
    ['source changed dirty to dirty', async value => { value.sourceEnd.digests['server.mjs'] = '0'.repeat(64); }]
  ]) {
    for (const [file, bytes] of originals) await writeFile(path.join(directory, file), bytes);
    const observations = structuredClone(baseline.observations); await mutate(observations);
    observations.businessArtifact.sha256 = digest(await readFile(path.join(directory, 'business-observations.json')));
    observations.browser.artifacts = await hashEvidenceFiles(directory, observations.browser.artifacts.map(row => row.path));
    observations.browser.reports = await hashEvidenceFiles(directory, observations.browser.reports.map(row => row.path));
    await json(path.join(directory, 'trace-browser.json'), observations.browser);
    await json(path.join(directory, 'observations.json'), observations);
    const worker = (await Promise.all(observations.checks.map(async row => `CHECK ${row.name}\n${await readFile(path.join(directory, row.name + '.log'), 'utf8')}`))).join('\n');
    await writeFile(path.join(directory, 'worker.log'), worker);
    const report = structuredClone(baseline.report), artifacts = await hashEvidenceFiles(directory, ['observations.json', 'worker.log']);
    for (const row of report.results) row.artifacts = artifacts; await json(path.join(directory, 'report.json'), report);
    assert.equal((await validateTraceReleaseEvidence(directory, { release: false })).ok, false, name);
  }
});
test('offline quality infrastructure validates real loopback artifacts but can never claim quality acceptance', { timeout: 20000 }, async t => {
  const directory = await temporary(t, 'quality-release-');
  const collection = await runOfflineQuality(path.join(directory, 'collection'));
  await json(path.join(directory, 'provider-ledger.json'), collection.actualStubRequests);
  const summary = await inspectOfflineQualityEvidence(directory, await qualitySources()); assert.equal(summary.infrastructurePassed, true);
  await json(path.join(directory, 'offline-summary.json'), summary);
  const passed = await validateQualityInfrastructureEvidence(directory, { release: false }); assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.equal(passed.qualityStatus, 'not_run'); assert.equal(passed.qualityEvaluated, false); assert.equal(passed.fullQualityAcceptance, false);
  assert.ok(passed.scope.properties.every(row => row.status === 'not_run' && row.complete === false));
  for (const patch of [{ qualityStatus: 'passed' }, { qualityEvaluated: true }, { liveCalls: 1 }, { fullQualityAcceptance: true }]) {
    await json(path.join(directory, 'offline-summary.json'), { ...summary, ...patch });
    assert.equal((await validateQualityInfrastructureEvidence(directory, { release: false })).ok, false);
  }
  await json(path.join(directory, 'offline-summary.json'), summary);
  for (const [name, mutate] of [
    ['unrelated MT request', ledger => { ledger.find(row => row.kind === 'mt').body = { model: 'unrelated', messages: [{ role: 'user', content: 'unrelated' }] }; }],
    ['missing ASR body', ledger => { ledger.find(row => row.kind === 'asr').body = {}; }],
    ['duplicate ASR identity', ledger => { const rows = ledger.filter(row => row.kind === 'asr'); rows[1].body.header.task_id = rows[0].body.header.task_id; }],
    ['wrong ASR parameter', ledger => { ledger.find(row => row.kind === 'asr').body.payload.parameters.sample_rate = 8000; }],
    ['reordered provider requests', ledger => { [ledger[1], ledger[2]] = [ledger[2], ledger[1]]; }]
  ]) {
    const changed = structuredClone(collection.actualStubRequests); mutate(changed);
    await json(path.join(directory, 'provider-ledger.json'), changed);
    // Recompute all recorded hashes: rejection must come from raw request validation.
    await json(path.join(directory, 'offline-summary.json'), await inspectOfflineQualityEvidence(directory, await qualitySources()));
    assert.equal((await validateQualityInfrastructureEvidence(directory, { release: false })).ok, false, name);
  }
  await json(path.join(directory, 'offline-summary.json'), summary);
  const ledger = structuredClone(collection.actualStubRequests); ledger.find(row => row.kind === 'audio').bytes = 1;
  await json(path.join(directory, 'provider-ledger.json'), ledger);
  assert.equal((await validateQualityInfrastructureEvidence(directory, { release: false })).ok, false);
});
