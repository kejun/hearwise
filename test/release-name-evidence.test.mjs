import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nameConfig, nameProtocolPlan, nameDriverRoster, nameStageCommand, nameInputBinding } from '../scripts/lib/name-protocol-evidence.mjs';
import { validateNameReleaseContract, validateNameBrowserReleaseEvidence } from '../scripts/lib/name-release-evidence.mjs';
import { readTechnicalEvidence, releaseEvidence } from '../scripts/lib/release-evidence.mjs';
import { validateNestedBrowserEvidence } from '../scripts/lib/runner-report-evidence.mjs';
import { technicalSuites, purposes, domainSuites, fullRequirements, externalRequirements } from '../verification/release/policy.mjs';
import { browserChecks, browserScreenshots } from '../scripts/lib/runner-evidence-contract.mjs';
import { nameBrowserAssets } from '../test-support/name-protocol-browser-evidence.mjs';
import { releaseNameBrowserFixture, nameContractTap } from '../test-support/release-name-fixture.mjs';
const time = offset => new Date(Date.UTC(2026, 9, 14) + offset).toISOString();
const json = (file, value) => writeFile(file, JSON.stringify(value));
async function temporary(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'release-name-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
async function formalFixture(t) {
  const directory = await temporary(t), config = await nameConfig(), origin = { repositoryRoot: '/original-ci/checkout', nodeExecutable: '/original-ci/node/bin/node', quintHome: '/original-ci/quint', evidenceDirectory: '/original-ci/evidence/' + path.basename(directory) };
  const report = { origin, repositoryRoot: origin.repositoryRoot, tools: { node: process.version, sqlite: process.versions.sqlite }, buildCurrent: true,
    overallTimeoutMs: config.limits.overallMs, artifacts: [], results: [] }, binding = nameInputBinding(report, config, report.tools);
  for (const [index, stage] of nameProtocolPlan(config).entries()) {
    const startedAt = time(index * 10), start = Date.parse(startedAt), log = stage.id + '.log';
    report.results.push({ ...stage, log, startedAt, finishedAt: time(index * 10 + 1), inputStart: binding, inputEnd: binding,
      invocation: nameStageCommand(stage, config, origin.evidenceDirectory, ['finite-state-complete', 'bounded-model-check', 'model-negative'].includes(stage.kind) ? '127.0.0.1:12345' : null, origin),
      execution: { code: 0, ok: true, signal: null, timedOut: false, interrupted: false, durationMs: 1, cleanupComplete: true, startedAt,
        budget: { timeoutMs: stage.timeoutMs, deadlineAt: start + stage.timeoutMs, childDeadlineAt: start + stage.timeoutMs - 1500 } } });
    await writeFile(path.join(directory, log), stage.kind === 'implementation-regression' ? nameContractTap(nameDriverRoster) : 'SYNTHETIC CONTRACT ONLY; no formal execution.\n');
    report.artifacts.push({ path: log });
  }
  await json(path.join(directory, 'report.json'), report); return { directory, report };
}
test('name adds one mandatory fixed suite and nineteenth browser without clearing full acceptance', async t => {
  assert.equal(technicalSuites.length, 18); assert.equal(technicalSuites.filter(row => row === 'name-protocol').length, 1);
  for (const purpose of ['pr', 'release']) assert.ok(purposes[purpose].includes('name-protocol'));
  for (const group of ['HW-07', 'HW-11']) assert.ok(domainSuites[group].includes('name-protocol'));
  assert.equal(browserChecks.length, 19); assert.equal(browserChecks.filter(row => row === 'name-protocol').length, 1);
  assert.deepEqual(browserScreenshots['name-protocol'], nameBrowserAssets.filter(row => row.endsWith('.png')));
  assert.equal(fullRequirements.length, 15); assert.equal(externalRequirements.length, 8);
  const absent = await readTechnicalEvidence('name-protocol', await temporary(t), { release: false }); assert.equal(absent.ok, false); assert.equal(absent.status, 'not_run');
  const gate = await releaseEvidence({ schemaVersion: 1, evidence: [] }, { release: false, purpose: 'release', base: 'HEAD' });
  assert.equal(gate.fullProjectAcceptance, false); assert.equal(gate.releaseEligible, false); assert.ok([...gate.requirements, ...gate.external].every(row => row.status === 'not_run'));
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8'); assert.match(workflow, /needs: \[[^\n]*name-protocol[^\n]*\]/); assert.match(workflow, /name: name-protocol-evidence-\$\{\{ github.sha \}\}/);
});
test('name release contract binds portable 23-stage commands and all 52 TAP tests but cannot replace its domain validator', async t => {
  const { directory, report } = await formalFixture(t); assert.equal(nameDriverRoster.length, 52);
  assert.equal(await validateNameReleaseContract(report, directory), true);
  const result = await readTechnicalEvidence('name-protocol', directory, { release: false }); assert.equal(result.ok, false); assert.equal(result.status, 'incomplete');
  const deep = await readTechnicalEvidence('name-protocol', directory, { release: false, profile: 'deep' }); assert.equal(deep.ok, false); assert.ok(deep.reasons.some(reason => reason.includes('name_has_only_a_fixed_profile')));
  for (const [label, mutate] of [
    ['wrong executable', r => { r.origin.nodeExecutable = '/tmp/not-node'; }],
    ['wrong root', r => { r.origin.repositoryRoot = '/other'; }], ['wrong output', r => { r.origin.evidenceDirectory += '-other'; }],
    ['wrong cwd', r => { r.results[0].invocation.cwd = '/other'; }], ['wrong command', r => { r.results[0].invocation.argv[0] += '-wrong'; }],
    ['wrong output command', r => { r.results.find(row => row.kind === 'simulation').invocation.argv.pop(); }],
    ['missing stage', r => { r.results.pop(); }], ['changed input', r => { r.results[0].inputEnd = { ...r.results[0].inputEnd, modelDigest: 'wrong' }; }],
    ['wrong budget', r => { r.results[0].invocation.timeoutMs++; }], ['reset deadline', r => { r.results[0].execution.budget.childDeadlineAt++; }],
    ['contradictory exit', r => { r.results[0].execution.ok = false; }], ['impossible stage duration', r => { r.results[0].execution.durationMs = 2; }],
    ['cleanup failed', r => { r.results[0].execution.cleanupComplete = false; }], ['incomplete native process', r => { r.results[0].execution.signal = 'SIGTERM'; }]
  ]) { const changed = structuredClone(report); mutate(changed); await assert.rejects(validateNameReleaseContract(changed, directory), undefined, label); }
  const file = path.join(directory, 'driver-regressions.log'), raw = await readFile(file, 'utf8');
  for (const changed of [raw.replace(/^\s*ok .*\n/gm, ''), raw.replace(/^ok 1 - (.+)$/m, 'ok 1 - $1 # SKIP'), raw.replace(/    ok 1 - .+/, '    ok 1 - wrong nested body'), nameContractTap(nameDriverRoster.slice(5))]) {
    await writeFile(file, changed); await assert.rejects(validateNameReleaseContract(report, directory), /wrong_name_tap_tree/);
  }
  await writeFile(file, raw); await symlink(file, path.join(directory, 'unsafe-link')); await assert.rejects(validateNameReleaseContract(report, directory), /unsafe path or symlink/);
});
test('name nested release reader rechecks full source/assets/HTTP/client/table data and exact child invocations', { timeout: 30000 }, async t => {
  const directory = await temporary(t), fixture = await releaseNameBrowserFixture(directory), baseline = structuredClone(fixture.observations);
  const good = await validateNestedBrowserEvidence('name-protocol', directory, { release: false }); assert.equal(good.ok, true, JSON.stringify(good)); assert.equal(good.fullProjectAcceptance, false);
  for (const [label, mutate] of [
    ['changed source', o => { o.sourceEnd.build.git_sha = '0'.repeat(40); }],
    ['wrong executable', o => { o.executionContext.executable = '/tmp/not-node'; for (const c of o.checks) c.execution.command[0] = '/tmp/not-node'; }],
    ['wrong cwd', o => { o.checks[0].execution.cwd = '/other'; }], ['wrong output', o => { o.checks[1].execution.command[2] = '/other/run'; }],
    ['wrong root', o => { o.executionContext.evidenceDirectory += '-other'; }], ['wrong budget', o => { o.checks[0].execution.configuredTimeoutMs++; }],
    ['children exceed aggregate', o => { o.checks[0].execution.durationMs = 29000; o.checks[1].execution.durationMs = 100000; }],
    ['process error', o => { o.checks[0].execution.error = 'failure'; }], ['invalid process duration', o => { o.checks[0].execution.durationMs = -1; }],
    ['false test count', o => { o.checks[0].execution.testCount++; }], ['missing check', o => { o.checks.pop(); }], ['missing observation', o => { o.browser.widths[1].results.pop(); }],
    ['wrong HTTP', o => { o.browser.widths[0].results[0].requests[0].body.revision = '0'.repeat(64); }],
    ['wrong client', o => { o.browser.widths[0].results[0].explicitSaves++; }],
    ['wrong table', o => { o.browser.widths[0].results[0].checkpoints.at(-1).tables.knowledge_edit_jobs = []; }],
    ['missing actual negative', o => { o.browser.negative.requests.pop(); }],
    ['wrong served source', o => { o.browser.widths[0].results[0].sources[0].sha256 = '0'.repeat(64); }]
  ]) { const changed = structuredClone(baseline); mutate(changed); await fixture.save(changed); assert.equal((await validateNameBrowserReleaseEvidence(directory, { release: false })).ok, false, label); }
  for (const mutate of [r => { r.source.sha = '0'.repeat(40); }, r => { r.results.pop(); }, r => { r.summary.rows[0].status = 'not_run'; }, r => { r.finishedAt = time(99999999); }]) {
    await fixture.save(structuredClone(baseline)); const changed = structuredClone(fixture.report); mutate(changed); await json(path.join(directory, 'report.json'), changed);
    assert.equal((await validateNameBrowserReleaseEvidence(directory, { release: false })).ok, false);
  }
  const logFile = path.join(directory, 'http.log'), raw = await readFile(logFile, 'utf8');
  for (const changed of [raw.replace(/^ok .+\n/gm, ''), raw.replace(/^ok 1 - (.+)$/m, 'ok 1 - $1 # SKIP'), raw.replace('# Subtest:', '# renamed:')]) {
    await writeFile(logFile, changed); const o = structuredClone(baseline); o.checks[0].execution.tail = changed.slice(-12000); await fixture.save(o);
    assert.equal((await validateNameBrowserReleaseEvidence(directory, { release: false })).ok, false);
  }
  await writeFile(logFile, raw); await fixture.save(structuredClone(baseline));
  await writeFile(path.join(directory, nameBrowserAssets[1]), 'tampered'); assert.equal((await validateNameBrowserReleaseEvidence(directory, { release: false })).ok, false);
});
