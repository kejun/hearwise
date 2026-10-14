import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { metadata, digest } from '../scripts/lib/verification-evidence.mjs';
import { securitySourceSnapshot, stableSecuritySources, securityPropertyState, summarizeSecurity, validSecurityBrowserCheck, verifySecurityBrowserArtifacts, securityTableNames, securityScreenshotNames } from '../test-support/security-evidence.mjs';
import { securityProperties } from '../verification/security-properties.mjs';
const execution = { ok: true, code: 0, signal: null, timedOut: false, interrupted: false, testComplete: true, testCount: 30 };
const checks = ['credentials', 'boundaries', 'negative', 'browser'].map(name => ({ name, execution: { ...execution } }));
const expectedRenderingMutation = { normalAppSha256: 'a'.repeat(64), mutantAppSha256: 'b'.repeat(64), anchor: 'fixture-textContent', replacement: 'fixture-innerHTML', replacements: 1 };
const zero = { executionCount: 0, injectedNodeCount: 0, probeRequests: 0, externalRequests: 0, credentialFindings: 0, observationErrors: 0, pageErrors: 0 };
function browserFixture() {
  const tableRows = Object.fromEntries(securityTableNames.map(name => [name, 1])); Object.assign(tableRows, { listenings: 2, listening_runs: 2, segments: 3, knowledge_items: 2 });
  const rowCount = Object.values(tableRows).reduce((a, b) => a + b, 0);
  return { chromium: 'synthetic-unit-fixture-only', browserBuildSource: {}, cleanupFailures: [], checks: [
    { id: 'stored-external-text', status: 'passed', complete: true, counts: { metadataWrites: 1, nameReplacementWrites: 1, modelRegenerationWrites: 1, browserReloads: 1, serverRestarts: 1, knowledgeCards: 4, graphDetails: 4 }, observations: { final: zero } },
    { id: 'live-provider-text', status: 'passed', complete: true, counts: { asrFinals: 1, persistedSegments: 1, modelTranslations: 1, browserReloads: 1 }, observations: { final: zero } },
    { id: 'credential-surfaces', status: 'passed', complete: true, counts: { exports: 5, providerAuthorizations: 9, sqliteTables: securityTableNames.length, sqliteRows: rowCount, runtimeFiles: 1, traceEvents: 1 }, observations: { final: zero, storage: { tableRows, tables: securityTableNames.length, rows: rowCount, files: 1, bytes: 10, fileNames: ['business.sqlite'], traceEvents: 1 }, exports: ['original', 'original', 'translation', 'translation', 'database'].map(kind => ({ kind, bytes: 1 })), allowed: { keyStorage: true, fishStorage: true, keyInput: true, fishInput: true, masked: true } } },
    { id: 'dangerous-rendering-control', status: 'passed', complete: true, counts: { mutants: 1, replacements: 1, mutantResourceResponses: 1, injectedNodes: 1, probeRequests: 1, scriptExecutions: 0 }, observations: { ...expectedRenderingMutation, expectedFailure: true, normal: zero, mutated: { ...zero, injectedNodeCount: 1, probeRequests: 1 }, detected: ['unexpected-nodes', 'probe-request'] } }
  ] };
}
test('security property rows retain independent completed scopes and fail closed on missing/browser cleanup/source evidence', () => {
  const browser = browserFixture(), options = { checks, browser, sourceStable: true, cleanupOk: true, browserArtifactsValid: true, expectedRenderingMutation };
  for (const { id } of securityProperties) assert.equal(securityPropertyState(id, options).status, 'passed');
  const failed = structuredClone(browser); failed.checks[3].status = 'failed';
  assert.equal(securityPropertyState('HW-12-03', { ...options, browser: failed }).status, 'failed');
  assert.equal(securityPropertyState('HW-12-05', { ...options, browser: failed }).status, 'passed');
  assert.equal(securityPropertyState('HW-12-02', { ...options, browser: failed }).status, 'passed');
  for (const patch of [{ sourceStable: false }, { cleanupOk: false }, { checks: [] }]) for (const { id } of securityProperties) assert.equal(securityPropertyState(id, { ...options, ...patch }).status, 'incomplete');
  for (const patch of [{ browserArtifactsValid: false }, { browser: { ...browser, cleanupFailures: ['failed'] } }, { browser: { ...browser, checks: [] } }]) {
    assert.equal(securityPropertyState('HW-12-03', { ...options, ...patch }).status, 'incomplete');
    assert.equal(securityPropertyState('HW-12-05', { ...options, ...patch }).status, 'incomplete');
  }
  assert.equal(securityPropertyState('HW-12-03', { ...options, nodeOnly: true }).status, 'not_run');
  const missingCount = structuredClone(checks); missingCount[0].execution.testCount = 0;
  assert.equal(securityPropertyState('HW-12-02', { ...options, checks: missingCount }).status, 'incomplete');
});
test('browser gate requires actual writes/restart/provider calls, clean surfaces and observed implementation mutation', () => {
  for (const check of browserFixture().checks) {
    assert.equal(validSecurityBrowserCheck(check, expectedRenderingMutation), true);
    for (const field of Object.keys(check.counts)) { const bad = structuredClone(check); delete bad.counts[field]; if (field !== 'scriptExecutions') assert.equal(validSecurityBrowserCheck(bad, expectedRenderingMutation), false, `${check.id}.${field}`); }
    const marker = { id: check.id, complete: true, status: 'passed', counts: {}, observations: {} }; assert.equal(validSecurityBrowserCheck(marker, expectedRenderingMutation), false);
  }
});
test('source binding rehashes actual files and rejects changed or missing digests, including dirty-to-dirty changes', async () => {
  const before = await securitySourceSnapshot(); assert.equal(stableSecuritySources(before, before), true);
  for (const change of [copy => { copy.digests['server.mjs'] = 'a'.repeat(64); }, copy => { delete copy.digests['test-support/security-evidence.mjs']; }, copy => { copy.source.sha = 'a'.repeat(40); }]) {
    const after = structuredClone(before); change(after); assert.equal(stableSecuritySources(before, after), false);
  }
  const missing = structuredClone(before); delete missing.digests['server.mjs']; assert.equal(stableSecuritySources(missing, missing), false);
});
test('security artifact checks reject missing, altered, duplicate and escaped files', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'security-artifact-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of securityScreenshotNames) await writeFile(path.join(dir, name), 'synthetic unit bytes');
  const all = securityScreenshotNames.map(path => ({ path, sha256: digest('synthetic unit bytes') })), artifact = all[0];
  assert.equal(await verifySecurityBrowserArtifacts(dir, { artifacts: all }), true);
  assert.equal(await verifySecurityBrowserArtifacts(dir, { artifacts: all.slice(1) }), false);
  for (const artifacts of [[], [artifact, artifact], [{ ...artifact, path: '../shot.png' }], [{ ...artifact, sha256: 'a'.repeat(64) }], [{ ...artifact, path: 'missing.png' }]]) assert.equal(await verifySecurityBrowserArtifacts(dir, { artifacts }), false);
});
test('security summary refuses stale, missing, interrupted, dirty-release and false-complete reports', async () => {
  const context = await metadata(), now = new Date().toISOString();
  const results = securityProperties.map(property => ({ ...context, source: { ...context.source, dirty: false }, property: { id: property.id, version: property.version },
    startedAt: now, finishedAt: now, complete: true, status: 'passed', scope: { description: property.domain, scenario: 'synthetic-gate-unit-only', samples: 1, seed: null },
    artifacts: ['observations.json', 'worker.log'].map(path => ({ path, sha256: 'a'.repeat(64) })) }));
  const options = { results, checks, target: { ...context.source, dirty: false }, sourceStable: true, cleanupOk: true, artifactsValid: results.map(() => true), release: true };
  assert.equal(summarizeSecurity(options).ok, true);
  for (const patch of [{ results: results.slice(1) }, { target: { sha: '0'.repeat(40), dirty: false } }, { sourceStable: false }, { cleanupOk: false },
    { artifactsValid: results.map(() => false) }, { target: { ...context.source, dirty: true } },
    { checks: checks.map(row => ({ ...row, execution: { ...row.execution, timedOut: true } })) }]) assert.equal(summarizeSecurity({ ...options, ...patch }).ok, false);
});


test('late unsafe observations, forged mutation counts/hashes and reduced browser scope cannot pass', () => {
  const browser = browserFixture(), options = { checks, browser, sourceStable: true, cleanupOk: true, browserArtifactsValid: true, expectedRenderingMutation };
  const late = { ...browser, lateObservationFailure: true, complete: false, ok: false };
  for (const id of ['HW-12-03', 'HW-12-05']) assert.equal(securityPropertyState(id, { ...options, browser: late }).status, 'failed');
  assert.equal(securityPropertyState('HW-12-02', { ...options, browser: late }).status, 'passed');
  const mutation = browser.checks[3];
  for (const change of [row => { row.observations.mutated = zero; }, row => { row.observations.mutated.credentialFindings = 1; },
    row => { row.observations.normalAppSha256 = 'c'.repeat(64); }, row => { row.observations.anchor = 'other'; }, row => { row.observations.detected = ['unexpected-nodes']; }]) {
    const bad = structuredClone(mutation); change(bad); assert.equal(Boolean(validSecurityBrowserCheck(bad, expectedRenderingMutation)), false);
  }
  for (const [index, field] of [[0, 'knowledgeCards'], [0, 'graphDetails'], [2, 'exports'], [2, 'providerAuthorizations'], [2, 'sqliteTables']]) {
    const bad = structuredClone(browser.checks[index]); bad.counts[field] = 1; assert.equal(validSecurityBrowserCheck(bad, expectedRenderingMutation), false);
  }
});
