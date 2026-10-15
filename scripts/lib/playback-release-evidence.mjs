import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validatePlaybackEvidence, loadPlaybackConfig } from './playback-protocol-evidence.mjs';
import { sourceSnapshot, sameSourceSnapshot, validBuildSource, evidenceFiles } from './runner-evidence-contract.mjs';
import { metadata, sourceVersion } from './verification-evidence.mjs';
import { validateFlatTap } from './release-tap-evidence.mjs';
import { checkPlaybackEvidence, summarizePlaybackResults, playbackAssets } from '../../test-support/playback-evidence.mjs';
import { playbackProfile } from '../../verification/playback-properties.mjs';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export const playbackNestedChecks = [
  { name: 'identity', files: ['test/speech-generation-boundary.test.mjs', 'test/qwen-response-ownership.test.mjs', 'test/playback-protocol-adapter.test.mjs'], timeoutMs: 30000 },
  { name: 'text', files: ['test/playback-text-contract.test.mjs'], timeoutMs: 20000 },
  { name: 'transports', files: ['test/playback-websocket.test.mjs', 'test/speech-integration.test.mjs'], timeoutMs: 30000 },
  { name: 'browser', timeoutMs: 100000 }
];
export const playbackNestedFiles = ['observations.json', 'worker.log', ...playbackNestedChecks.map(row => row.name + '.log'), ...playbackAssets];
export async function playbackTestNames(files) {
  return (await Promise.all([...files].sort().map(async file => {
    const text = await readFile(file, 'utf8'); const names = [];
    for (const match of text.matchAll(/(?:^|\b)test\((['`])([^\n]+?)\1,/gm)) {
      if (match[1] === "'") names.push(match[2]);
      else {
        assert.equal(file, 'test/qwen-response-ownership.test.mjs'); assert.equal(match[2], 'a retired Qwen response ${label} cannot own a new task');
        names.push(...['after the current created event', 'before the current created event', 'from earlier completed history'].map(label => match[2].replace('${label}', label)));
      }
    }
    return names;
  }))).flat();
}
export function validatePlaybackExecutionContract(report) {
  const context = report.executionContext; assert.equal(context.repositoryRoot, report.execution.repositoryRoot);
  for (const field of ['repositoryRoot', 'evidenceDirectory', 'executable']) assert.ok(path.isAbsolute(context[field]) && path.normalize(context[field]) === context[field]);
  assert.equal(context.jvmArgs, '-Xmx2G');
  for (const row of report.results.filter(row => row.execution)) {
    assert.deepEqual(row.executionContext, { cwd: row.kind === 'implementation-regression' ? context.repositoryRoot : context.evidenceDirectory, executable: context.executable, jvmArgs: '-Xmx2G' });
    assert.equal(row.timeoutMs, row.kind === 'bounded-model-check' ? report.profile === 'deep' && row.id !== 'bounded-single' ? 900000 : 240000 : 60000);
    const out = row.argv.indexOf('--out-itf');
    if (out !== -1) {
      const main = row.id.replace(/^(?:witnesses|simulation|negative)-/, '');
      const expected = row.kind === 'model-witness' ? ['witnesses', `${main}-{test}-{seq}.itf.json`] : row.kind === 'simulation' ? ['simulation', `${main}-{seq}.itf.json`] : ['negative', `${main}.itf.json`];
      assert.equal(row.argv[out + 1], path.join(context.evidenceDirectory, ...expected));
    }
  }
  return true;
}
export async function validatePlaybackReleaseEvidence(directory, { release = true, requireProfile = 'fast' } = {}) {
  const checked = await validatePlaybackEvidence(directory, { release, requireProfile });
  const result = { ...checked, kind: 'playback-protocol', source: null, status: 'not_run', ok: false, stale: checked.reasons.includes('stale'),
    methods: ['complete-labelled-finite-domains', 'bounded-model-check', 'real-player-http-sqlite-replay'], fullProjectAcceptance: false };
  let report; try { report = await json(path.join(directory, 'report.json')); } catch { return result; }
  result.source = report.source; result.status = checked.rows.some(row => row.status === 'failed') ? 'failed' : 'incomplete';
  try {
    assert.equal(checked.ok, true); await evidenceFiles(directory); assert.deepEqual(report.source, sourceVersion());
    assert.ok(sameSourceSnapshot(report.sourceStart, report.sourceEnd) && validBuildSource(report.sourceStart) && validBuildSource(report.sourceEnd));
    assert.deepEqual(report.sourceStart.source, report.source); assert.deepEqual(report.sourceEnd, await sourceSnapshot());
    assert.equal(path.basename(report.executionContext.evidenceDirectory), path.basename(directory)); validatePlaybackExecutionContract(report);
    const config = await loadPlaybackConfig(), row = report.results.find(row => row.id === 'implementation-regressions');
    const names = await playbackTestNames(config.regression.files); assert.equal(names.length, config.regression.expectedTests);
    validateFlatTap(await readFile(path.join(directory, row.log), 'utf8'), names);
    for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) {
      const stage = report.results.find(row => row.id === id), values = await json(path.join(directory, stage.data));
      assert.deepEqual(await json(path.join(directory, stage.log)), values.map(value => ({ trace: value.sourceTrace, classification: value.classification, complete: value.complete, ok: value.ok, steps: value.steps })));
    }
    result.scope = { profile: report.profile, domain: report.domain, propertyRows: checked.propertyRows };
    result.status = 'passed'; result.ok = true;
  } catch (error) { result.reasons.push(error.message); }
  return result;
}
export async function validatePlaybackBrowserReleaseEvidence(directory, { release = true } = {}) {
  const result = { kind: 'playback', source: null, status: 'not_run', ok: false, stale: false, reasons: [], fullProjectAcceptance: false };
  let report; try { report = await json(path.join(directory, 'report.json')); } catch { result.reasons.push('missing_playback_browser_report'); return result; }
  result.source = report.source; result.status = 'incomplete';
  try {
    const context = await metadata(), observations = await json(path.join(directory, 'observations.json'));
    assert.equal(report.profile, 'playback'); assert.equal(report.complete, true); assert.equal(report.ok, true);
    for (const key of ['source', 'specification', 'tools', 'environment']) assert.deepEqual(report[key], context[key]);
    const executionContext = observations.executionContext;
    for (const field of ['repositoryRoot', 'evidenceDirectory', 'executable']) assert.ok(path.isAbsolute(executionContext[field]) && path.normalize(executionContext[field]) === executionContext[field]);
    assert.equal(path.basename(executionContext.executable), process.platform === 'win32' ? 'node.exe' : 'node');
    assert.equal(path.resolve(executionContext.repositoryRoot, executionContext.outputArgument), executionContext.evidenceDirectory);
    assert.equal(path.basename(executionContext.evidenceDirectory), path.basename(directory));
    assert.deepEqual(observations.checks.map(row => row.name), playbackNestedChecks.map(row => row.name));
    for (const [index, check] of observations.checks.entries()) {
      const expected = playbackNestedChecks[index], log = await readFile(path.join(directory, check.name + '.log'), 'utf8');
      assert.equal(check.execution.tail, log.slice(-12000));
      assert.equal(check.execution.ok, true); assert.equal(check.execution.code, 0); assert.equal(check.execution.signal, null);
      assert.equal(check.execution.timedOut, false); assert.equal(check.execution.interrupted, false);
      assert.equal(check.configuredTimeoutMs, expected.timeoutMs); assert.ok(Number.isSafeInteger(check.execution.effectiveTimeoutMs) && check.execution.effectiveTimeoutMs > 0 && check.execution.effectiveTimeoutMs <= expected.timeoutMs); assert.equal(check.command[0], executionContext.executable);
      assert.deepEqual(check.executionContext, { cwd: executionContext.repositoryRoot, executable: executionContext.executable });
      if (expected.files) {
        assert.deepEqual(check.files, expected.files); assert.deepEqual(check.command.slice(1), ['--test', '--test-reporter=tap', '--test-timeout=30000', ...expected.files]);
        validateFlatTap(log, await playbackTestNames(expected.files));
      } else { assert.equal(check.command[1], 'test-support/playback-browser.mjs'); assert.equal(check.command.length, 3); assert.equal(check.command[2], executionContext.outputArgument); }
    }
    assert.equal(report.results.length, playbackProfile.length);
    const artifactsValid = await Promise.all(report.results.map(row => checkPlaybackEvidence(directory, row))); assert.ok(artifactsValid.every(Boolean));
    const { execution, summary } = summarizePlaybackResults({ results: report.results, target: context.source, checks: observations.checks, nodeOnly: false,
      budgetExpired: false, required: playbackProfile, sourceStable: true, release, artifactsValid });
    assert.equal(summary.ok, true); assert.deepEqual(report.execution, execution); assert.deepEqual(report.summary.rows, summary.rows);
    result.status = 'passed'; result.ok = true; result.propertyRows = summary.rows;
  } catch (error) { result.reasons.push(error.message); result.stale = JSON.stringify(report.source) !== JSON.stringify(sourceVersion()); }
  return result;
}
