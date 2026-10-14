import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { releasePlaybackFixture, exactPlaybackTap } from '../test-support/release-playback-fixture.mjs';
import { validatePlaybackBrowserReleaseEvidence, validatePlaybackReleaseEvidence, validatePlaybackExecutionContract, playbackTestNames } from '../scripts/lib/playback-release-evidence.mjs';
import { sourceSnapshot } from '../scripts/lib/runner-evidence-contract.mjs';
import { writePlaybackEvidence } from '../test-support/playback-evidence.mjs';
import { gateFixture, realPlaybackTraces } from './playback-protocol-fixtures.mjs';
import { technicalSuites } from '../verification/release/policy.mjs';
const json = (file, value) => writeFile(file, JSON.stringify(value));
test('current playback is mandatory and browser reader rejects rehashed missing body, wrong frame and missing actual worklet source', { timeout: 15000 }, async t => {
  assert.ok(technicalSuites.includes('playback-protocol'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-playback-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const baseline = await releasePlaybackFixture(directory), result = await validatePlaybackBrowserReleaseEvidence(directory, { release: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  const log = await readFile(path.join(directory, 'identity.log'), 'utf8');
  for (const [name, mutate] of [
    ['footer only', async value => { const changed = log.replace(/^ok .+\n/gm, ''); await writeFile(path.join(directory, 'identity.log'), changed); value.checks[0].execution.tail = changed.slice(-12000); }],
    ['hidden failure', async value => { const changed = log.replace('TAP version 13\n', 'TAP version 13\n    not ok 1 - hidden failure\n'); await writeFile(path.join(directory, 'identity.log'), changed); value.checks[0].execution.tail = changed.slice(-12000); }],
    ['wrong frame', value => { value.browser.widths[0].cases[0].state.sockets[0].received[1].epoch = 999; }],
    ['missing worklet source', value => { value.browser.widths[0].cases[0].served.responses.pop(); }],
    ['wrong command', value => { value.checks[0].command[4] = 'test/unrelated.test.mjs'; }],
    ['wrong executable', value => { value.checks[0].command[0] = '/tmp/not-node'; }],
    ['same basename wrong output', value => { value.checks[3].command[2] = '/unrelated/' + path.basename(directory); }],
    ['wrong budget', value => { value.checks[0].configuredTimeoutMs++; }],
    ['failed child', value => { value.checks[2].execution.code = 1; }]
  ]) {
    await writeFile(path.join(directory, 'identity.log'), log);
    const value = structuredClone(baseline.observations); await mutate(value); await json(path.join(directory, 'browser.json'), value.browser);
    const artifacts = await writePlaybackEvidence(directory, value), report = structuredClone(baseline.report);
    report.results.forEach(row => { row.artifacts = artifacts; }); await json(path.join(directory, 'report.json'), report);
    assert.equal((await validatePlaybackBrowserReleaseEvidence(directory, { release: false })).ok, false, name);
  }
});
test('playback release reader retains raw model replay gate and binds runtime source, TAP body and commands', { timeout: 35000 }, async t => {
  const fixture = await gateFixture(t, await realPlaybackTraces()), report = fixture.report, directory = fixture.directory;
  report.sourceStart = report.sourceEnd = await sourceSnapshot();
  report.executionContext = { repositoryRoot: process.cwd(), evidenceDirectory: directory, executable: process.execPath, jvmArgs: '-Xmx2G' };
  for (const row of report.results) {
    if (['implementation-replay', 'implementation-negative'].includes(row.kind)) {
      delete row.execution;
      const replays = JSON.parse(await readFile(path.join(directory, row.data), 'utf8'));
      await fixture.put(row.log, replays.map(value => ({ trace: value.sourceTrace, classification: value.classification, complete: value.complete, ok: value.ok, steps: value.steps })));
    } else {
      row.executionContext = { cwd: row.kind === 'implementation-regression' ? process.cwd() : directory, executable: process.execPath, jvmArgs: '-Xmx2G' };
      row.timeoutMs = row.kind === 'bounded-model-check' ? 240000 : 60000;
      const out = row.argv.indexOf('--out-itf');
      if (out !== -1) { const main = row.id.replace(/^(?:witnesses|simulation|negative)-/, ''); row.argv[out + 1] = path.join(directory, row.kind === 'model-witness' ? 'witnesses' : row.kind === 'simulation' ? 'simulation' : 'negative', row.kind === 'model-witness' ? `${main}-{test}-{seq}.itf.json` : row.kind === 'simulation' ? `${main}-{seq}.itf.json` : `${main}.itf.json`); }
    }
  }
  const regression = report.results.find(row => row.id === 'implementation-regressions');
  const names = await playbackTestNames(report.domain.regression.files); assert.equal(names.length, 28);
  await fixture.put(regression.log, exactPlaybackTap(names)); await fixture.save();
  const result = await validatePlaybackReleaseEvidence(directory, { release: false }); assert.equal(result.ok, true, JSON.stringify(result));
  for (const mutate of [r => { r.sourceEnd = { ...r.sourceEnd, runtimeBuild: { ...r.sourceEnd.runtimeBuild, git_sha: '0'.repeat(40) } }; },
    r => { r.results.find(row => row.execution).timeoutMs++; }, r => { r.results.find(row => row.execution).executionContext.cwd += '-other'; }]) {
    const original = structuredClone(report); mutate(report); await fixture.save(); assert.equal((await validatePlaybackReleaseEvidence(directory, { release: false })).ok, false); Object.keys(report).forEach(key => delete report[key]); Object.assign(report, original);
  }
  await fixture.put(regression.log, exactPlaybackTap(names).replace(/^ok .+\n/gm, '')); await fixture.save();
  assert.equal((await validatePlaybackReleaseEvidence(directory, { release: false })).ok, false);
  assert.equal(validatePlaybackExecutionContract(report), true);
});
