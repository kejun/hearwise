import { userJourneyEvidenceFixture } from '../test-support/user-journey-evidence-fixture.mjs';
import { atomicityReleaseFixture } from '../test-support/release-atomicity-fixture.mjs';
import { releaseNameBrowserFixture } from '../test-support/release-name-fixture.mjs';
import { releasePlaybackFixture } from '../test-support/release-playback-fixture.mjs';
import { traceReleaseFixture } from '../test-support/release-trace-fixture.mjs';
import { addedNestedFixture } from '../test-support/release-added-profile-fixtures.mjs';
import { testExecutionPlan } from '../scripts/lib/test-schedule.mjs';
import { nodeTestArgv } from '../scripts/lib/node-test-evidence.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateNodeEvidence, validateBrowserEvidence, validateNestedBrowserEvidence } from '../scripts/lib/runner-report-evidence.mjs';
import { browserChecks, browserScreenshots, findNodeTests, sourceSnapshot, executionEnvironment, evidenceFiles, hashEvidenceFiles } from '../scripts/lib/runner-evidence-contract.mjs';
import { digest, metadata } from '../scripts/lib/verification-evidence.mjs';
import { tapSummary } from '../scripts/lib/tap-summary.mjs';
import { sessionProfile } from '../verification/session-properties.mjs';
import { relationResultProfile } from '../verification/relation-result-properties.mjs';
import { summarizeSessionResults } from '../test-support/session-evidence.mjs';
import { summarizeRelationResults, writeRelationResultEvidence } from '../test-support/relation-result-evidence.mjs';
import { resultScenarios } from '../test-support/relation-result-fixture.mjs';

// Synthetic report shapes exercise this offline reader only, never claim a browser
// ran or that copied TAP rows provide real production implementation evidence.
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const tap = count => 'TAP version 13\n' + Array.from({ length: count }, (_, i) => `ok ${i + 1} - synthetic contract row\n`).join('') +
  `1..${count}\n# tests ${count}\n# suites 0\n# pass ${count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
const execution = log => ({ code: 0, signal: null, timedOut: false, interrupted: false, ok: true, durationMs: 1, tail: log.slice(-12000) });
const json = (file, value) => writeFile(file, JSON.stringify(value));
async function temporary(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'release-runner-contract-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
async function aggregate(rows) {
  const snapshot = await sourceSnapshot();
  return { schemaVersion: 2, ...snapshot.source, sourceStart: snapshot, sourceEnd: snapshot, ...executionEnvironment(), complete: true, ok: true, results: rows };
}
async function nodeFixture(directory) {
  const files = await findNodeTests(), log = tap(1), rows = [];
  for (const file of files) {
    const name = file.replaceAll(/[\\/]/g, '_') + '.log'; await writeFile(path.join(directory, name), log);
    const events = `/different-ci-root/test-evidence/${name}.events.ndjson`;
    const counts = { tests: 1, failed: 0, passed: 1, cancelled: 0, skipped: 0, todo: 0, topLevel: 1, suites: 0 };
    const eventLog = [{ type: 'test:pass', data: { name: 'synthetic contract row', nesting: 0, testNumber: 1, testId: 1, parentId: 0, details: { type: 'test' }, line: 1, column: 1, file: `/different-ci-root/checkout/${file}` } },
      { type: 'test:plan', data: { nesting: 0, count: 1 } }, { type: 'test:summary', data: { success: true, counts, file: `/different-ci-root/checkout/${file}` } },
      { type: 'test:summary', data: { success: true, counts } }].map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(path.join(directory, name + '.events.ndjson'), eventLog);
    const start = Date.UTC(2026, 9, 14) + rows.length * 2;
    rows.push({ file, scheduling: testExecutionPlan(file), startedAt: new Date(start).toISOString(), finishedAt: new Date(start + 1).toISOString(), log: `/different-ci-root/test-evidence/${name}`, events, eventsSha256: digest(eventLog), argv: nodeTestArgv(file, events), logSha256: digest(log), ...execution(log) });
  }
  const report = { ...await aggregate(rows), executionRepositoryRoot: '/different-ci-root/checkout', selected: files.length, passed: files.length };
  await json(path.join(directory, 'results.json'), report); return report;
}
function browserObservations(kind) {
  if (kind === 'relation-result') return { complete: true, chromium: 'synthetic-contract', widths: [1280, 390].map(width => ({ width, errors: [], results: resultScenarios.map(s =>
    ({ scenario: s.name, state: s.state, nodes: s.nodes, edges: s.edges, providerRequests: s.requests, supports: [] })) })) };
  return { complete: true, chromium: 'synthetic-contract', widths: [1280, 390].map(width => ({ width, permissionRejected: true, keyboardRecovery: true,
    stopTail: true, duplicateFinalIdentity: true, conflictingFinalPreserved: true, oldSocketIgnored: true, microphoneReleased: true, reconnectRuns: 2,
    first: { segments: ['Rain 😀.', 'Stop tail 😀.', 'Reconnected run.'].map((original_text, i) => ({ original_text, run_id: i === 2 ? 'next-run' : 'first-run' })), runs: [{ state: 'complete' }, { state: 'interrupted' }] },
    next: { segments: ['New listening.', 'Stop tail 😀.'].map(original_text => ({ original_text })) } })),
  sourceVersion: { before: 'old-version', after: 'new-version', oldRequest: 'old source', newRequest: 'new source',
    persisted: { original_text: 'new source', translation_text: '新版本有效译文 😀', translation_state: 'complete' }, visibleText: true } };
}
async function nestedFixture(kind, directory) {
  await mkdir(directory, { recursive: true });
  const browser = browserObservations(kind), counts = kind === 'session' ? { 'identity-and-source': 6, 'caption-frontier': 53 } : { 'source-integrity': 100, 'http-results': 1 };
  const checks = [];
  for (const [name, count] of [...Object.entries(counts), ['browser', null]]) {
    const log = count ? tap(count) : 'synthetic browser contract\n'; await writeFile(path.join(directory, `${name}.log`), log);
    checks.push({ name, execution: { ...execution(log), ...(count ? tapSummary(log) : {}) } });
  }
  await json(path.join(directory, 'browser.json'), browser);
  for (const file of browserScreenshots[kind]) await writeFile(path.join(directory, file), png);
  const observations = { browser, checks };
  let artifacts;
  if (kind === 'relation-result') artifacts = await writeRelationResultEvidence(directory, observations);
  else {
    await json(path.join(directory, 'observations.json'), observations);
    await writeFile(path.join(directory, 'worker.log'), (await Promise.all(checks.map(async ({ name }) => `CHECK ${name}\n${await readFile(path.join(directory, `${name}.log`), 'utf8')}`))).join('\n'));
    artifacts = await hashEvidenceFiles(directory, ['observations.json', 'worker.log']);
  }
  const context = await metadata(), required = kind === 'session' ? sessionProfile : relationResultProfile, time = new Date().toISOString();
  const results = required.map(id => ({ ...context, property: { id, version: 1 }, status: 'passed', complete: true, startedAt: time, finishedAt: time,
    scope: { description: 'Synthetic contract fixture only', scenario: 'unit-test', samples: 1, seed: null }, artifacts }));
  const summarize = kind === 'session' ? summarizeSessionResults : summarizeRelationResults;
  const summary = summarize({ results, target: context.source, checks, required, nodeOnly: false, sourceStable: true, release: false, artifactsValid: results.map(() => true) });
  await json(path.join(directory, 'report.json'), { ...context, profile: kind, complete: true, ok: true, results, ...summary });
  return observations;
}
async function browserFixture(directory, { evidenceDirectory = path.join(process.cwd(), 'browser-evidence/run-contract') } = {}) {
  const run = 'run-contract'; await mkdir(path.join(directory, run));
  const rows = [];
  for (const name of browserChecks) {
    const log = `synthetic ${name} contract\n`; await writeFile(path.join(directory, run, `${name}.log`), log);
    rows.push({ name, log: path.join(evidenceDirectory, `${name}.log`), argv: [`scripts/verify-${name}-browser.mjs`], ...execution(log) });
    if (name === 'import-atomicity') {
      const fixture = await atomicityReleaseFixture(path.join(directory, run, 'run-atomicitycontract'), { outerRun: run, outerDirectory: evidenceDirectory });
      await writeFile(path.join(directory, run, `${name}.log`), fixture.outerLog); rows.at(-1).tail = fixture.outerLog;
      continue;
    }
    if (name === 'user-journey') {
      const fixture = await userJourneyEvidenceFixture(path.join(directory, run, 'user-journey-contract'), { outerRun: run, outerDirectory: evidenceDirectory });
      await writeFile(path.join(directory, run, `${name}.log`), fixture.outerLog); rows.at(-1).tail = fixture.outerLog; continue;
    }
    if (name === 'name-protocol') { await releaseNameBrowserFixture(path.join(directory, run, `${name}-contract`)); continue; }
    if (name === 'playback') { await releasePlaybackFixture(path.join(directory, run, `${name}-contract`)); continue; }
    if (name === 'trace-business') { await traceReleaseFixture(path.join(directory, run, `${name}-contract`)); continue; }
    if (['security', 'import-protocol', 'edit-consistency'].includes(name)) { await addedNestedFixture(name, path.join(directory, run, `${name}-contract`)); continue; }
    if (['session', 'relation-result'].includes(name)) { await nestedFixture(name, path.join(directory, run, `${name}-contract`)); continue; }
    const assets = name === 'speech' ? directory : path.join(directory, run, name); await mkdir(assets, { recursive: true });
    for (const file of browserScreenshots[name]) await writeFile(path.join(assets, file), png);
  }
  const report = { ...await aggregate(rows), evidenceDirectory, artifacts: await hashEvidenceFiles(directory, await evidenceFiles(directory)) };
  await json(path.join(directory, 'results.json'), report); return report;
}

test('Node release reader requires every current test file and full raw logs, not a selected green summary', async t => {
  const directory = await temporary(t), baseline = await nodeFixture(directory);
  assert.equal((await validateNodeEvidence(directory, { release: false })).ok, true);
  for (const mutate of [r => { r.results.pop(); }, r => { r.results[1] = r.results[0]; }, r => { r.results[0].argv = ['test/unrelated.test.mjs']; },
    r => { delete r.results[0].scheduling; }, r => { r.results[0].scheduling.timeoutMs++; }, r => { r.results[0].startedAt = 'invalid'; },
    r => { r.results[0].timedOut = true; }, r => { r.results[0].signal = 'SIGTERM'; }, r => { r.tools.sqlite = 'wrong-tool'; },
    r => { r.sourceEnd.digests['public/app.js'] = '0'.repeat(64); }, r => { r.sha = '0'.repeat(40); }]) {
    const changed = structuredClone(baseline); mutate(changed); await json(path.join(directory, 'results.json'), changed);
    assert.equal((await validateNodeEvidence(directory, { release: false })).ok, false);
  }
  const row = baseline.results[0], name = path.basename(row.log);
  for (const log of [tap(1).replace(/^ok 1 - .*\n/m, ''), tap(1).replace('# pass 1', '# pass 0').replace('# skipped 0', '# skipped 1'), 'no final TAP footer\n']) {
    const changed = structuredClone(baseline); changed.results[0].logSha256 = digest(log); changed.results[0].tail = log;
    await writeFile(path.join(directory, name), log); await json(path.join(directory, 'results.json'), changed);
    assert.equal((await validateNodeEvidence(directory, { release: false })).ok, false);
  }
});
test('browser aggregate binds all twenty suites, screenshots, child log tails and nested complete reports', { timeout: 80000 }, async t => {
  const startedAt = performance.now(), directory = await temporary(t), baseline = await browserFixture(directory), fixtureMs = performance.now() - startedAt;
  const good = await validateBrowserEvidence(directory, { release: false }); assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(baseline.results.length, 20);
  assert.deepEqual(good.nested.map(row => row.kind), ['session', 'relation-result', 'security', 'import-protocol', 'edit-consistency', 'trace-business', 'playback', 'import-atomicity', 'name-protocol', 'user-journey']);
  // Rebind only explicit synthetic origin envelopes; retain the one collected
  // HTTP/SQLite matrix and every browser/raw artifact without running it again.
  const originalOrigins = await Promise.all(['import-atomicity', 'user-journey'].map(async kind => {
    const nested = kind === 'import-atomicity' ? 'run-atomicitycontract' : 'user-journey-contract';
    const file = path.join(directory, 'run-contract', nested, 'report.json');
    const bytes = await readFile(file); return { kind, nested, file, bytes, report: JSON.parse(bytes) };
  }));
  for (const evidenceDirectory of ['/custom/browser-artifacts/run-contract', 'custom-browser-artifacts/run-contract']) {
    const rebound = structuredClone(baseline); rebound.evidenceDirectory = evidenceDirectory;
    for (const row of rebound.results) row.log = path.join(evidenceDirectory, `${row.name}.log`);
    for (const origin of originalOrigins) {
      const child = structuredClone(origin.report), expected = path.resolve(process.cwd(), evidenceDirectory, origin.nested);
      if (origin.kind === 'import-atomicity') {
        const previous = child.evidenceDirectory; child.evidenceDirectory = expected;
        for (const check of child.checks) check.command = check.command.map(value => value.replace(previous, expected));
      } else { child.executionContext.evidenceDirectory = expected; child.checks[0].command[2] = expected; }
      await json(origin.file, child);
      const log = origin.kind === 'import-atomicity' ? `Import atomicity evidence: ${path.join(evidenceDirectory, origin.nested)}\n` : `User journey browser evidence: ${expected}\n`;
      await writeFile(path.join(directory, 'run-contract', `${origin.kind}.log`), log);
      rebound.results.find(row => row.name === origin.kind).tail = log;
    }
    rebound.artifacts = await hashEvidenceFiles(directory, (await evidenceFiles(directory)).filter(file => file !== 'results.json'));
    await json(path.join(directory, 'results.json'), rebound);
    const configured = await validateBrowserEvidence(directory, { release: false }); assert.equal(configured.ok, true, JSON.stringify(configured));
    for (const kind of ['import-atomicity', 'user-journey']) assert.equal(configured.nested.find(row => row.kind === kind).ok, true);
    for (const changed of ['', '/forged/run-contract', 'custom-browser-artifacts/../run-contract', '/custom/run-other']) {
      await json(path.join(directory, 'results.json'), { ...rebound, evidenceDirectory: changed });
      assert.equal((await validateBrowserEvidence(directory, { release: false })).ok, false, changed);
    }
  }
  for (const origin of originalOrigins) {
    await writeFile(origin.file, origin.bytes);
    await writeFile(path.join(directory, 'run-contract', `${origin.kind}.log`), baseline.results.find(row => row.name === origin.kind).tail);
  }
  await json(path.join(directory, 'results.json'), baseline);
  assert.equal((await validateBrowserEvidence(directory, { release: false })).ok, true, 'original fixture restored byte-for-byte');
  t.diagnostic(`Full 20-profile fixture: ${Math.round(fixtureMs)}ms; origin validations: ${Math.round(performance.now() - startedAt - fixtureMs)}ms; total positive: ${Math.round(performance.now() - startedAt)}ms; test/file budgets: 80000/90000ms`);
  for (const mutate of [r => { r.results.pop(); }, r => { r.results[0].argv = ['scripts/unrelated.mjs']; }, r => { r.results[0].tail = 'wrong log'; },
    r => { r.artifacts = r.artifacts.filter(a => !a.path.endsWith('session-contract/browser.json')); }, r => { r.artifacts[0].sha256 = '0'.repeat(64); },
    r => { r.results[0].timedOut = true; }, r => { r.sourceStart.digests['dist/server/index.js'] = '0'.repeat(64); },
    r => { r.evidenceDirectory = '/different-artifacts/run-contract'; }]) {
    const changed = structuredClone(baseline); mutate(changed); await json(path.join(directory, 'results.json'), changed);
    assert.equal((await validateBrowserEvidence(directory, { release: false })).ok, false);
  }
  await json(path.join(directory, 'results.json'), baseline);
  await rm(path.join(directory, 'speech.png'));
  assert.equal((await validateBrowserEvidence(directory, { release: false })).ok, false);
});
test('nested profiles reject cached-green reports with rehashed missing TAP or contradictory browser observations', async t => {
  for (const kind of ['session', 'relation-result']) {
    const directory = path.join(await temporary(t), kind), baseline = await nestedFixture(kind, directory);
    assert.equal((await validateNestedBrowserEvidence(kind, directory, { release: false })).ok, true);
    const first = baseline.checks[0].name; await writeFile(path.join(directory, `${first}.log`), tap(1));
    assert.equal((await validateNestedBrowserEvidence(kind, directory, { release: false })).ok, false);
    await nestedFixture(kind, directory);
    const value = structuredClone(baseline); value.browser.widths[0][kind === 'session' ? 'microphoneReleased' : 'errors'] = kind === 'session' ? false : ['page error'];
    await json(path.join(directory, 'browser.json'), value.browser); await json(path.join(directory, 'observations.json'), value);
    const report = JSON.parse(await readFile(path.join(directory, 'report.json')));
    for (const row of report.results) row.artifacts = await hashEvidenceFiles(directory, ['observations.json', 'worker.log']);
    await json(path.join(directory, 'report.json'), report);
    assert.equal((await validateNestedBrowserEvidence(kind, directory, { release: false })).ok, false);
  }
});
