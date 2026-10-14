import { validateEditDurableReplay } from '../scripts/lib/edit-release-durable.mjs';
import { createEditProtocolAdapter } from '../test-support/edit-protocol-adapter.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addedNestedFixture, writeSyntheticImport } from '../test-support/release-added-profile-fixtures.mjs';
import { validateNestedBrowserEvidence } from '../scripts/lib/runner-report-evidence.mjs';
import { hashEvidenceFiles } from '../scripts/lib/runner-evidence-contract.mjs';
import { editBrowserAssets } from '../test-support/edit-consistency-evidence.mjs';
import { importProtocolFixture } from '../test-support/import-protocol-fixture.mjs';
import { validateImportDurableReplay, validateImportedRows } from '../scripts/lib/import-release-durable.mjs';
import { createImportProtocolAdapter } from '../test-support/import-protocol-adapter.mjs';
import { formalCommandContract, regressionNames } from '../scripts/lib/formal-release-evidence.mjs';
import { editCommandContract, validateEditReleaseEvidence } from '../scripts/lib/edit-release-evidence.mjs';
import { validateFlatTap } from '../scripts/lib/release-tap-evidence.mjs';
import { sourceVersion } from '../scripts/lib/verification-evidence.mjs';
const json = (file, value) => writeFile(file, JSON.stringify(value));
const read = file => readFile(file, 'utf8').then(JSON.parse);
async function directory(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-ONLY-added-release-readers-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function repack(kind, dir, observations, report) {
  if (kind === 'import-protocol') { await writeSyntheticImport(dir, observations); return; }
  await json(path.join(dir, 'browser.json'), observations.browser);
  if (kind === 'edit-consistency') observations.attachments = await hashEvidenceFiles(dir, editBrowserAssets);
  await json(path.join(dir, 'observations.json'), observations);
  for (const row of report.results) row.artifacts = await hashEvidenceFiles(dir, ['observations.json', 'worker.log']);
  await json(path.join(dir, 'report.json'), report);
}
// Complete synthetic packages exercise only the offline release reader. Rehashing
// every changed attachment deliberately prevents cached hashes masking bad raw data.
for (const kind of ['security', 'import-protocol', 'edit-consistency']) test(`${kind}: independently rejects rehashed missing or contradictory raw observations`, async t => {
  const dir = await directory(t), baseline = await addedNestedFixture(kind, dir), original = await read(path.join(dir, 'report.json'));
  const positive = await validateNestedBrowserEvidence(kind, dir, { release: false }); assert.equal(positive.ok, true, JSON.stringify(positive));
  const mutations = kind === 'security' ? [
    o => { o.browser.checks[0].counts.knowledgeCards = 1; }, o => { o.browser.checks[1].observations.final.credentialFindings = 1; },
    o => { o.browser.checks[2].observations.storage.tableRows.segments = 0; }, o => { o.browser.checks[3].observations.mutated.injectedNodeCount = 0; },
    o => { o.expectedRenderingMutation.normalAppSha256 = '0'.repeat(64); }, o => { o.browser.browserBuildSource.servedAppSha256 = '0'.repeat(64); },
    o => { o.sourceEnd.digests['public/app.js'] = '0'.repeat(64); }, o => { o.checks[0].command[4] = 'test/unrelated.test.mjs'; },
    o => { o.checks[0].execution.timedOut = true; }, o => { o.checks[1].configuredTimeoutMs *= 2; }, o => { o.browser.lateObservationFailure = true; }
  ] : kind === 'import-protocol' ? [
    o => { o.scenarios[0].http[0].fetch.requestBody.size++; },
    o => { o.scenarios[0].http[0].fetch.url += '&wrong=1'; },
    o => { o.scenarios[0].http[0].fetch.method = 'GET'; },
    o => { o.scenarios[0].http[0].fetch.index++; },
    o => { o.scenarios[0].http[0].responseIndex++; },
    o => { o.scenarios[0].http[0].request.uploadBytes = 1; },
    o => { o.scenarios[0].uploads[0].size++; },
    o => { o.scenarios[0].uploads = []; },
    o => { o.scenarios[0].http.find(row => row.path.endsWith('/commit')).status = 200; },
    o => { o.scenarios[0].snapshots.find(row => row.label === 'after-stale-rejection').database.rows.listenings.push({ id: 'unexpected' }); },
    o => { o.scenarios[0].http.find(row => row.path.endsWith('/preview')).response.previewTokenSha256 = o.scenarios[0].http[0].response.previewTokenSha256; },
    o => { o.scenarios[1].clock[1].timers[0].active = true; }, o => { o.scenarios.at(-1).ui.expiredRefresh.status = '预览已刷新'; },
    o => { o.scenarios[0].unfinishedAfterRestart.extraction[0].state = 'running'; }, o => { o.scenarios[0].providerCalls.push({ path: '/paid' }); },
    o => { o.scenarios[0].snapshots[0].database.schema = []; }, o => { o.sourceEnd.digests['public/app.js'] = '0'.repeat(64); }
  ] : [
    o => { o.browser.widths[0].results[0].evidence.find(row => row.label === 'conflict').client.writes = 2; },
    o => { o.browser.widths[0].results[1].evidence.find(row => row.label === 'unknown').ui.disabled.save = false; },
    o => { o.browser.widths[0].results[1].evidence.find(row => row.label === 'reopened').tables.segments.push('{"id":"invented-write"}'); },
    o => { o.browser.widths[0].results[3].evidence.find(row => row.label === 'rolled-back').tables.knowledge_items = []; },
    o => { o.browser.widths[0].results[4].evidence.find(row => row.label === 'reopened').ui.name = 'Tibo'; },
    o => { o.browser.negative.evidence[1].client.writes = 1; }, o => { o.browser.negative.sourceSha256 = '0'.repeat(64); },
    o => { o.browser.widths[0].results[0].evidence = []; }, o => { o.checks[0].execution.argv = ['--test', 'test/unrelated.test.mjs']; }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(baseline); mutate(changed); await repack(kind, dir, changed, structuredClone(original));
    assert.equal((await validateNestedBrowserEvidence(kind, dir, { release: false })).ok, false, mutate.toString());
  }
  await repack(kind, dir, baseline, original);
  if (kind !== 'import-protocol') {
    const name = baseline.checks[0].name, logFile = path.join(dir, name + '.log'), originalLog = await readFile(logFile, 'utf8');
    // Keep every cached field/hash coherent while adding contradictory TAP body.
    const corrupt = originalLog.replace('1..', 'not ok 999 - hidden failure\n1..'), changed = structuredClone(baseline); changed.checks[0].execution.tail = corrupt.slice(-12000);
    await writeFile(logFile, corrupt); await writeFile(path.join(dir, 'worker.log'), (await Promise.all(changed.checks.map(async row => `CHECK ${row.name}\n${await readFile(path.join(dir, row.name + '.log'), 'utf8')}`))).join('\n'));
    await repack(kind, dir, changed, original); assert.equal((await validateNestedBrowserEvidence(kind, dir, { release: false })).ok, false);
  }
});
async function record(adapter, actions) {
  const observations = [], capture = () => observations.push(structuredClone({ step: observations.length - 1, actual: adapter.project(), durable: adapter.observe(), durableViolations: adapter.check() }));
  capture(); for (const step of actions) { await adapter.act(step); capture(); } return { observations };
}
const step = (action, extra = {}) => ({ action, actor: -1, requestedMode: '', requestedGeneration: 0, fault: false, ...extra });
test('import durable reader accepts actual HTTP/SQLite ledgers and rejects cached-green tampering', async t => {
  for (const mode of ['append', 'replace']) {
    const adapter = await createImportProtocolAdapter(); t.after(() => adapter.close());
    const actions = [step('upload', { actor: 0, requestedMode: mode, requestedGeneration: 1 }), step('other_write'), step('commit', { actor: 0, requestedMode: mode, requestedGeneration: 1 }), step('preview', { actor: 0, requestedMode: mode, requestedGeneration: 2 }), step('commit', { actor: 0, requestedMode: mode, requestedGeneration: 2 }), step('restart')];
    const replay = await record(adapter, actions); assert.equal(await validateImportDurableReplay(replay), true);
    for (const mutate of [r => { r.observations[0].durable.snapshot.schema = []; }, r => { r.observations[2].durable.snapshot.rows.knowledge_facts = []; },
      r => { r.observations[3].durable.events.at(-1).result.status = 200; }, r => { r.observations[4].durable.providerCalls = [{ path: 'unexpected' }]; },
      r => { r.observations.at(-1).durable.lifecycle[1].signal = 'SIGTERM'; }, r => { r.observations[1].actual.clientGeneration[0] = 0; }, r => { r.observations[1].durable.lifecycle[0].pid++; },
      r => { const original = r.observations[0].durable.snapshot.rows.listenings[0].id; for (const observation of r.observations.slice(5)) for (const item of observation.durable.snapshot.rows.knowledge_items) if (item.listening_id !== original) item.canonical_name = 'CORRUPTED'; }]) {
      const bad = structuredClone(replay); mutate(bad); await assert.rejects(validateImportDurableReplay(bad));
    }
    await adapter.close();
  }
});
test('import durable negative requires real mutated source, first divergent state and actual persisted effect', async t => {
  const adapter = await createImportProtocolAdapter({ mutation: 'skip_http_revision' }); t.after(() => adapter.close());
  const replay = await record(adapter, [step('upload', { actor: 0, requestedMode: 'append', requestedGeneration: 1 }), step('other_write'), step('commit', { actor: 0, requestedMode: 'append', requestedGeneration: 1 })]);
  const actual = replay.observations.at(-1).actual, expected = { ...structuredClone(actual), businessIds: [0], lastHTTPStatus: 409, lastHTTPCode: 'IMPORT_PREVIEW_STALE' };
  Object.assign(replay, { difference: { step: 2, actual, expected }, counterexample: { steps: [{}, {}, { expected }] } });
  assert.equal(await validateImportDurableReplay(replay, { negative: true }), true);
  for (const mutate of [r => { r.observations[0].durable.mutation.mutantSha256 = '0'.repeat(64); }, r => { r.difference.expected = r.difference.actual; }, r => { r.observations.pop(); }]) {
    const bad = structuredClone(replay); mutate(bad); await assert.rejects(validateImportDurableReplay(bad, { negative: true }));
  }
});
test('import command binding uses its actual 720s budget and two-token TLC240s with unchanged fixed regression roster', async () => {
  const root = '/synthetic/checkout', directory = '/synthetic/run-contract', cli = `${root}/node_modules/@informalsystems/quint/dist/src/cli.js`, pin = await read('verification/import-protocol/toolchain.json');
  const report = { profile: 'fast', tools: { node: process.version, sqlite: process.versions.sqlite }, overallTimeoutMs: 720000,
    executionContext: { repositoryRoot: root, evidenceDirectory: directory, quintCli: cli, overallTimeoutMs: 720000, jvmArgs: '-Xmx2G' }, results: [{ id: 'tlc-two_tokens', kind: 'finite-state-complete', timeoutMs: 240000, expectedFailure: false, cwd: directory, execution: { code: 0, ok: true }, argv: [cli, 'verify', `${root}/verification/import-protocol/configurations.qnt`, '--main', 'two_tokens', '--init', 'Init', '--step', 'Step', '--invariant', 'Safety', '--apalache-version', pin.apalache.version, '--verbosity', '3', '--backend', 'tlc', '--tlc-config', `${root}/verification/import-protocol/tlc.json`, '--server-endpoint', '127.0.0.1:12345'] }] };
  assert.equal(await formalCommandContract('import-protocol', report), true);
  for (const mutate of [r => { r.executionContext.overallTimeoutMs = 480000; }, r => { r.overallTimeoutMs = 480000; }, r => { r.results[0].timeoutMs = 60000; }, r => { r.results[0].cwd = root; }]) { const bad = structuredClone(report); mutate(bad); await assert.rejects(formalCommandContract('import-protocol', bad)); }
  assert.equal((await Promise.all(['http', 'replay', 'evidence'].map(name => regressionNames(`test/import-protocol-${name}.test.mjs`)))).flat().length, 24);
});
test('edit fixed command budget is bound and deep requests cannot pass as fast evidence', async t => {
  const root = '/synthetic/checkout', dir = '/synthetic/run-contract', cli = `${root}/node_modules/@informalsystems/quint/dist/src/cli.js`;
  const report = { source: sourceVersion(), tools: { node: process.version, sqlite: process.versions.sqlite }, executionContext: { repositoryRoot: root, evidenceDirectory: dir, quintCli: cli, overallTimeoutMs: 480000, jvmArgs: '-Xmx2G' }, results: [{ id: 'driver-regressions', kind: 'implementation-regression', execution: { code: 0, ok: true }, argv: ['--test', '--test-reporter=tap', '--test-timeout=30000', `${root}/test/edit-protocol-evidence.test.mjs`], timeoutMs: 60000, cwd: root }] };
  assert.equal(await editCommandContract(report), true);
  for (const mutate of [r => { r.executionContext.overallTimeoutMs *= 2; }, r => { r.results[0].cwd = dir; }, r => { r.results[0].argv.pop(); }, r => { r.results[0].timeoutMs *= 2; }]) { const bad = structuredClone(report); mutate(bad); await assert.rejects(editCommandContract(bad)); }
  const location = await directory(t); await json(path.join(location, 'report.json'), report);
  const result = await validateEditReleaseEvidence(location, { release: false, requireProfile: 'deep' }); assert.equal(result.ok, false); assert.ok(result.reasons.some(reason => reason.startsWith('unsupported_profile:')));
});
test('fixed flat TAP refuses hidden failures, missing body, duplicate plans, skips and foreign rows', () => {
  const log = 'TAP version 13\nok 1 - expected\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n';
  assert.equal(validateFlatTap(log, ['expected']), true);
  for (const bad of [log.replace('ok 1 - expected\n', ''), log.replace('1..1', 'not ok 2 - hidden\n1..1'), log.replace('expected', 'foreign'), log.replace('expected', 'expected # SKIP'), log.replace('1..1', '1..1\n1..1')]) assert.throws(() => validateFlatTap(bad, ['expected']));
});

test('actual imported unfinished backup content is preserved with only the declared recovery transitions', async t => {
  for (const mode of ['append', 'replace']) {
    const fixture = await importProtocolFixture({ unfinished: true }); t.after(() => fixture.close());
    const before = fixture.snapshot(), review = (await fixture.upload(0, mode)).body;
    const result = await fixture.request('/api/data/import/commit', { body: { token: review.token, previewToken: review.previewToken, mode } });
    assert.equal(result.status, 200); const after = fixture.snapshot();
    assert.equal(validateImportedRows(fixture.backupSnapshots[0], before, after, mode, { stoppedWork: true }), true);
    const changed = structuredClone(after), importedId = fixture.backupSnapshots[0].rows.listenings[0].id;
    changed.rows.knowledge_items.find(row => row.listening_id === importedId).canonical_name = 'CORRUPTED';
    assert.throws(() => validateImportedRows(fixture.backupSnapshots[0], before, changed, mode, { stoppedWork: true }));
    await fixture.close();
  }
});

test('edit negative final frames bind real requests, revision tokens, transaction snapshots and immutable histories', async t => {
  const config = { clients: 2, codecs: { 0: 'v1', 1: 'v1' }, initialOverride: false, background: true };
  for (const mutation of ['bypass_revision', 'auto_revision_resend']) {
    const adapter = await createEditProtocolAdapter({ ...config, mutation }); t.after(() => adapter.close());
    const actions = [['read', 0, ''], ['edit', 0, 'new'], ['send', 0, ''], ['background_change', -1, ''], ['transaction', 0, 'ok'],
      ...(mutation === 'auto_revision_resend' ? [['deliver', 0, ''], ['refresh_stale', 0, '']] : [])].map(([action, actor, argument]) => ({ action, actor, argument }));
    const replay = await record(adapter, actions), actual = replay.observations.at(-1).actual, expected = structuredClone(actual);
    expected.requests[0] = mutation === 'auto_revision_resend' ? 1 : expected.requests[0];
    if (mutation === 'bypass_revision') expected.txResult[0] = 'conflict';
    Object.assign(replay, { difference: { step: actions.length - 1, actual, expected }, counterexample: { steps: actions.map((action, index) => ({ ...action, expected: index === actions.length - 1 ? expected : {} })) } });
    assert.equal(validateEditDurableReplay(replay, config, { negative: true, mutation }), true);
    for (const change of [r => { r.observations.at(-1).durable.clients[0].requests = 0; }, r => { r.observations.at(-1).durable.clients[0].actualRequest.revision = '0'.repeat(64); },
      r => { r.observations.at(-1).durable.events = []; }, r => { r.observations.at(-1).durable.clients[0].jobs = []; },
      r => { r.observations.at(-1).durable.versions[0] = '0'.repeat(64); }]) {
      const bad = structuredClone(replay); change(bad); assert.throws(() => validateEditDurableReplay(bad, config, { negative: true, mutation }));
    }
    await adapter.close();
  }
});
