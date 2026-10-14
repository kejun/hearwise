import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { relationResultProfile } from '../verification/relation-result-properties.mjs';
import { validateResult, checkArtifacts, metadata } from '../scripts/lib/verification-evidence.mjs';

test('node-only relation result evidence cannot turn missing browser coverage into a pass', { timeout: 40000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relation-result-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const execution = await runProcess(process.execPath, ['scripts/verify-relation-result-browser.mjs', '--node-only'], {
    env: { ...process.env, RELATION_RESULT_EVIDENCE_DIR: directory }, timeoutMs: 35000
  });
  assert.equal(execution.code, 1, execution.tail);
  assert.equal(execution.timedOut, false);
  const children = await readdir(directory); assert.equal(children.length, 1);
  const evidence = path.join(directory, children[0]);
  const report = JSON.parse(await readFile(path.join(evidence, 'report.json'), 'utf8'));
  assert.equal(report.ok, false); assert.equal(report.complete, true);
  const observations = JSON.parse(await readFile(path.join(evidence, 'observations.json'), 'utf8'));
  assert.deepEqual(observations.checks.map(check => check.name), ['source-integrity', 'http-results']);
  assert.ok(observations.checks[0].execution.testCount >= 80, 'Existing source regressions must actually run');
  assert.equal(observations.checks[1].execution.testCount, 1, 'The six-scenario HTTP test must actually run');
  assert.ok(observations.checks.every(check => !check.execution.tail.includes('skipping running files')));
  assert.deepEqual(report.results.map(result => result.property.id), relationResultProfile);
  assert.equal(report.results.find(result => result.property.id === 'HW-05-02').status, 'passed');
  assert.equal(report.results.filter(result => result.status === 'not_run').length, 2);
  for (const result of report.results) {
    assert.equal(validateResult(result), true);
    assert.equal(await checkArtifacts(evidence, result), true);
  }
  assert.equal((await readdir(evidence)).some(name => name.startsWith('temporary-runtime-')), false);
});

// Synthetic bytes test evidence packaging only. They are not Chromium observations.
test('complete browser asset packaging respects the two-artifact contract and verifies referenced files', async t => {
  const { writeRelationResultEvidence, checkRelationResultEvidence } = await import('../test-support/relation-result-evidence.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relation-asset-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scenarios = ['shortage', 'empty', 'filtered', 'qualified', 'partial', 'error'];
  const browser = { complete: true, widths: [1280, 390].map(width => ({ width, results: scenarios.map(scenario => ({ scenario })) })) };
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify(browser));
  for (const { width, results } of browser.widths) for (const { scenario } of results)
    await writeFile(path.join(directory, `relations-${width}-${scenario}.png`), 'synthetic image bytes, not a UI result');
  await writeFile(path.join(directory, 'browser.log'), 'synthetic packaging check');
  const artifacts = await writeRelationResultEvidence(directory, { checks: [{ name: 'browser' }], browser });
  const result = { ...await metadata(), property: { id: 'HW-11-03', version: 1 },
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), complete: true, status: 'passed',
    scope: { description: 'Synthetic artifact contract only', scenario: 'unit-test', samples: 1, seed: null }, artifacts };
  assert.equal(validateResult(result), true, 'Browser attachments must not expand the public two-artifact result contract');
  assert.equal(artifacts.length, 2);
  assert.equal(await checkRelationResultEvidence(directory, result), true);
  const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
  assert.equal(observations.attachments.length, 13);
  const screenshot = path.join(directory, 'relations-390-empty.png');
  await writeFile(screenshot, 'changed');
  assert.equal(await checkRelationResultEvidence(directory, result), false, 'A changed referenced screenshot invalidates evidence');
  await rm(screenshot);
  assert.equal(await checkRelationResultEvidence(directory, result), false, 'A missing referenced screenshot invalidates evidence');
  await assert.rejects(writeRelationResultEvidence(directory, { checks: [{ name: 'browser' }], browser }), /ENOENT/);
});

test('relation evidence rejects skipped, todo, missing, cancelled or inconsistent TAP coverage', async () => {
  const { relationTapSummary } = await import('../test-support/relation-result-evidence.mjs');
  const tap = ({ tests = 2, pass = 2, fail = 0, cancelled = 0, skipped = 0, todo = 0 } = {}) =>
    `1..${tests}\n` + Object.entries({ tests, suites: 0, pass, fail, cancelled, skipped, todo, duration_ms: 1 }).map(([key, value]) => `# ${key} ${value}\n`).join('');
  assert.deepEqual(relationTapSummary(tap()), { testCount: 2, testComplete: true, ok: true });
  for (const text of [tap({ pass: 0, skipped: 2 }), tap({ pass: 0, todo: 2 }), tap({ pass: 1, cancelled: 1 }),
    tap({ tests: 0, pass: 0 }), tap().replace('# pass 2\n', ''), tap({ pass: 1 })]) {
    assert.equal(relationTapSummary(text).ok, false, text);
    assert.equal(relationTapSummary(text).testComplete, false, text);
  }
  assert.deepEqual(relationTapSummary(tap({ pass: 1, fail: 1 })), { testCount: 2, testComplete: true, ok: false });
});

const executionFixture = (changes = {}) => ({ code: 0, signal: null, ok: true, timedOut: false, interrupted: false, ...changes });
test('unrelated failing checks preserve each independently verified property while the profile fails', async () => {
  const { summarizeRelationResults } = await import('../test-support/relation-result-evidence.mjs');
  const context = await metadata(), time = new Date().toISOString();
  const makeResults = statuses => relationResultProfile.map((id, i) => ({ ...context, property: { id, version: 1 },
    startedAt: time, finishedAt: time, complete: true, status: statuses[i],
    scope: { description: 'Unit execution classification', scenario: 'synthetic-gate', samples: 1, seed: null },
    artifacts: ['observations.json', 'worker.log'].map(path => ({ path, sha256: '0'.repeat(64) })) }));
  for (const [failed, expected] of [['browser', ['passed', 'failed', 'failed']],
    ['http-results', ['passed', 'failed', 'passed']], ['source-integrity', ['failed', 'failed', 'passed']]]) {
    const checks = ['source-integrity', 'http-results', 'browser'].map(name => ({ name,
      execution: executionFixture(name === failed ? { code: 1, ok: false } : {}) }));
    const { summary, execution } = summarizeRelationResults({ results: makeResults(expected), checks, target: context.source,
      required: relationResultProfile, artifactsValid: [true, true, true], release: false, sourceStable: true });
    assert.equal(execution.code, 1); assert.equal(summary.ok, false);
    assert.deepEqual(summary.rows.map(row => row.status), expected, failed);
  }
  const checks = ['source-integrity', 'http-results', 'browser'].map(name => ({ name, execution: executionFixture() }));
  const complete = makeResults(['passed', 'passed', 'passed']);
  for (const results of [complete.slice(0, 2), [...complete, complete[0]]]) {
    const { summary } = summarizeRelationResults({ results, checks, target: context.source, required: relationResultProfile,
      artifactsValid: results.map(() => true), sourceStable: true });
    assert.equal(summary.ok, false, 'Missing/duplicate required properties remain fail closed');
    assert.ok(summary.rows.some(row => row.reasons.includes('missing') || row.reasons.includes('duplicate')));
  }
  const stopped = summarizeRelationResults({ results: complete, checks: [checks[0], { name: 'http-results',
    execution: executionFixture({ code: null, ok: false, timedOut: true }) }], target: context.source,
    required: relationResultProfile, artifactsValid: [true, true, true], sourceStable: true });
  assert.equal(stopped.execution.complete, false); assert.equal(stopped.summary.ok, false);
  assert.deepEqual(stopped.summary.rows.map(row => row.status), ['passed', 'incomplete', 'incomplete']);
});

test('a timed-out child stops later work, cleans runtime resources and leaves time to write a terminal report', { timeout: 5000 }, async t => {
  const { runRelationChecks } = await import('../test-support/relation-result-evidence.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relation-deadline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'runtime'); await (await import('node:fs/promises')).mkdir(runtime);
  const calls = [], started = Date.now();
  const run = await runRelationChecks([{ name: 'stall', timeoutMs: 200 }, { name: 'must-not-start', timeoutMs: 200 }],
    async (specification, timeoutMs) => {
      calls.push(specification.name);
      return runProcess(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'],
        { timeoutMs, logFile: path.join(directory, specification.name + '.log') });
    }, { budgetMs: 500, cleanup: () => rm(runtime, { recursive: true, force: true }) });
  assert.deepEqual(calls, ['stall']);
  assert.equal(run.checks[0].execution.timedOut, true);
  assert.ok(Date.now() - started < 3000, 'Parent must retain cleanup/report headroom');
  assert.equal((await readdir(directory)).includes('runtime'), false);
  const pid = Number(run.checks[0].execution.tail.match(/^\d+/m)?.[0]); assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'No stalled process survives cleanup');
  await writeFile(path.join(directory, 'terminal.json'), JSON.stringify({ complete: false, ok: false, checks: run.checks }));
  assert.equal(JSON.parse(await readFile(path.join(directory, 'terminal.json'), 'utf8')).complete, false);
});

test('one fixed total check deadline bounds all nested limits below the parent watchdog', async () => {
  const { runRelationChecks } = await import('../test-support/relation-result-evidence.mjs');
  let time = 0; const assigned = [];
  await runRelationChecks([{ name: 'source', timeoutMs: 40000 }, { name: 'http', timeoutMs: 40000 }, { name: 'browser', timeoutMs: 100000 }],
    async (_specification, timeoutMs) => { assigned.push(timeoutMs); time += timeoutMs; return executionFixture(); }, { now: () => time });
  assert.deepEqual(assigned, [40000, 40000, 70000]);
  assert.equal(assigned.reduce((a, b) => a + b, 0), 150000);
});
