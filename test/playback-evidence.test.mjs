import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from '../scripts/lib/process.mjs';
import { nestedProfileDeadlineMs, nestedProfileTestDeadlineMs } from '../scripts/lib/test-schedule.mjs';
import { profileEvidenceDirectory } from '../test-support/profile-test-evidence.mjs';
import { metadata, validateResult } from '../scripts/lib/verification-evidence.mjs';
import { playbackProfile } from '../verification/playback-properties.mjs';
import { playbackProvenance, playbackServedFiles, stablePlaybackSources } from '../test-support/playback-provenance.mjs';
import { playbackWorkletFiles } from '../test-support/playback-worklet-responses.mjs';
import { playbackGolden } from '../test-support/playback-speech-fixture.mjs';
import { speechIntervalLedger } from '../test-support/playback-text-contract.mjs';
import { playbackAssets, playbackCounts, playbackTap, checkPlaybackBrowser, writePlaybackEvidence, checkPlaybackEvidence,
  summarizePlaybackResults, runPlaybackChecks } from '../test-support/playback-evidence.mjs';

const tap = (tests, { pass = tests, fail = 0, skipped = 0, todo = 0, cancelled = 0 } = {}) => `1..${tests}\n` +
  Object.entries({ tests, suites: 0, pass, fail, cancelled, skipped, todo, duration_ms: 1 }).map(([key, value]) => `# ${key} ${value}\n`).join('');
const execution = changes => ({ code: 0, signal: null, ok: true, timedOut: false, interrupted: false, ...changes });
function syntheticBrowser(provenance) {
  const cut = playbackGolden.indexOf('。') + 1;
  const requests = [playbackGolden.slice(0, cut), playbackGolden.slice(cut).trim().slice(0, -4), 'END'];
  const served = mutant => {
    const fixtureId = randomUUID(), origin = 'http://127.0.0.1:12345';
    return { fixtureId, origin, errors: [], responses: playbackServedFiles.map(file => ({ fixtureId, origin, file, status: 200,
      source: playbackWorkletFiles.includes(file) ? 'server-response-finish' : 'page-response', method: 'GET', path: file.slice('public'.length),
      bytes: mutant && file === 'public/speech-controller.js' ? provenance.mutantControllerBytes : provenance.servedBytes[file],
      sha256: mutant && file === 'public/speech-controller.js' ? provenance.mutantControllerSha256 : provenance.snapshot.digests[file] })) };
  };
  const socket = { id: 1, readyState: 3, sent: [{ type: 'speech.transcript', epoch: 1 }, { type: 'speech.progress', epoch: 1, playedUnit: 3, consumedSamples: 18000 }],
    received: requests.flatMap((text, i) => [{ type: 'speech.unit', epoch: 1, unit: i + 1, text }, { type: 'pcm', epoch: 1, unit: i + 1, frame: 0, samples: 6000, bytes: 12016 },
      { type: 'speech.unit-end', epoch: 1, unit: i + 1, samples: 6000 }]).concat({ type: 'speech.finished', epoch: 1 }) };
  const paused = { enabled: true, paused: true, status: 'paused', contexts: ['closed', 'suspended'], contextIds: [1, 2],
    sockets: [{ id: 1, readyState: 3, sent: [], received: [] }, { id: 2, readyState: 1, sent: [{ paused: true, startPosition: 2 }], received: [] }] };
  const finished = { ...structuredClone(paused), enabled: false, contexts: ['closed', 'closed'] }; finished.sockets[1].readyState = 3;
  const unlocked = { enabled: true, paused: false, contexts: ['closed', 'running'], contextIds: [1, 2], sockets: [{ id: 1, readyState: 1, sent: [], received: [] }] };
  const stopped = { ...structuredClone(unlocked), enabled: false, contexts: ['closed', 'closed'] }; stopped.sockets[0].readyState = 3;
  return { complete: true, chromium: 'synthetic-contract-only', sourceStart: structuredClone(provenance.snapshot), sourceEnd: structuredClone(provenance.snapshot),
    mutation: { mutation: provenance.mutation, normalControllerSha256: provenance.normalControllerSha256, mutantControllerSha256: provenance.mutantControllerSha256 },
    widths: [1280, 390].map(width => ({ width, cases: [
      { scenario: 'text', normalized: playbackGolden, requests, ledger: speechIntervalLedger(playbackGolden, requests, { graphemeSafe: true }),
        state: { enabled: false, contexts: ['closed'], contextIds: [1], sockets: [structuredClone(socket)] }, served: served(false), errors: [] },
      { scenario: 'paused-seek', paused: structuredClone(paused), afterLate: structuredClone(paused), finished: structuredClone(finished),
        commitsWhilePaused: ['甲。'], commitsAfterLate: ['甲。'], commits: ['甲。', '乙。'], served: served(false), errors: [] },
      { scenario: 'unlock-race', before: structuredClone(unlocked), after: structuredClone(unlocked), stopped: structuredClone(stopped), commits: ['丙。'], served: served(false), errors: [] }
    ] })), negative: { caught: true, mutation: 'late-unlock', expectedSockets: 1, actualSockets: 2, before: structuredClone(unlocked),
      after: { ...structuredClone(unlocked), sockets: [...structuredClone(unlocked.sockets), { id: 2, readyState: 1, sent: [], received: [] }] }, served: served(true), errors: [] } };
}

test('playback profile runs the exact actual Node stages but keeps missing Chromium not_run', { timeout: nestedProfileTestDeadlineMs }, async t => {
  const root = await profileEvidenceDirectory('playback');
  const result = await runProcess(process.execPath, ['scripts/verify-playback-browser.mjs', '--node-only'], {
    env: { ...process.env, PLAYBACK_EVIDENCE_DIR: root }, timeoutMs: nestedProfileDeadlineMs });
  assert.equal(result.code, 1, result.tail); assert.equal(result.timedOut, false);
  const directories = await readdir(root); assert.equal(directories.length, 1); const directory = path.join(root, directories[0]);
  const report = JSON.parse(await readFile(path.join(directory, 'report.json')));
  const observations = JSON.parse(await readFile(path.join(directory, 'observations.json')));
  assert.equal(report.complete, true, JSON.stringify(report)); assert.equal(report.ok, false);
  assert.deepEqual(report.results.map(row => row.property.id), playbackProfile);
  assert.ok(report.results.every(row => row.status === 'not_run'));
  assert.deepEqual(observations.checks.map(row => row.name), Object.keys(playbackCounts));
  for (const check of observations.checks) { assert.equal(check.execution.ok, true, JSON.stringify(check)); assert.equal(check.execution.testCount, playbackCounts[check.name]); }
  for (const row of report.results) { assert.equal(validateResult(row), true); assert.equal(await checkPlaybackEvidence(directory, row), true); }
  assert.ok(!(await readdir(directory)).some(name => name.startsWith('temporary-runtime-')));
});

test('playback TAP checks bind the canonical final footer to the exact declared test count', () => {
  for (const [name, count] of Object.entries(playbackCounts)) {
    assert.equal(playbackTap(tap(count), name).ok, true);
    for (const log of [tap(count - 1), tap(count + 1), tap(count, { pass: 0, skipped: count }), tap(count, { pass: 0, todo: count }),
      tap(count, { pass: count - 1, cancelled: 1 }), tap(count).replace(`# pass ${count}\n`, ''), `# tests ${count}\n# pass ${count}\n`, tap(count, { pass: count - 1, fail: 1 })])
      assert.equal(playbackTap(log, name).ok, false, name + ': ' + log);
  }
});

// Synthetic records and bytes exercise packaging/schema only, never count as UI evidence.
test('playback packaging verifies every referenced asset and preserves the shared two-artifact contract', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'playback-asset-contract-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const provenance = await playbackProvenance(), browser = syntheticBrowser(provenance); assert.equal(checkPlaybackBrowser(browser, provenance), true);
  const checks = Object.entries(playbackCounts).map(([name, count]) => ({ name, execution: execution(playbackTap(tap(count), name)) }));
  checks.push({ name: 'browser', execution: execution() });
  for (const [name, count] of Object.entries(playbackCounts)) await writeFile(path.join(directory, `${name}.log`), tap(count));
  await writeFile(path.join(directory, 'browser.log'), 'synthetic browser packaging only');
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify(browser));
  for (const file of playbackAssets.filter(name => name.endsWith('.png'))) await writeFile(path.join(directory, file), 'synthetic image bytes');
  const result = { ...await metadata(), property: { id: playbackProfile[0], version: 1 }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    complete: true, status: 'passed', scope: { description: 'Synthetic artifact contract only', scenario: 'unit-test', samples: 1, seed: null },
    artifacts: await writePlaybackEvidence(directory, { sourceStart: provenance.snapshot, sourceEnd: provenance.snapshot, browser, checks }) };
  assert.equal(validateResult(result), true); assert.equal(result.artifacts.length, 2); assert.equal(await checkPlaybackEvidence(directory, result), true);
  for (const file of playbackAssets) {
    const original = await readFile(path.join(directory, file)); await writeFile(path.join(directory, file), 'tampered');
    assert.equal(await checkPlaybackEvidence(directory, result), false, file); await writeFile(path.join(directory, file), original);
    await rm(path.join(directory, file)); assert.equal(await checkPlaybackEvidence(directory, result), false, file);
    await assert.rejects(writePlaybackEvidence(directory, { sourceStart: provenance.snapshot, sourceEnd: provenance.snapshot, browser, checks }), /ENOENT/);
    await writeFile(path.join(directory, file), original);
  }
  await writeFile(path.join(directory, 'identity.log'), tap(1));
  result.artifacts = await writePlaybackEvidence(directory, { sourceStart: provenance.snapshot, sourceEnd: provenance.snapshot, browser, checks });
  assert.equal(await checkPlaybackEvidence(directory, result), false, 'Rehashing cannot hide a replaced raw TAP log');
});

test('playback browser contract rejects false completion, missing coverage and inconsistent raw frames or text', async () => {
  const provenance = await playbackProvenance();
  const mutations = [
    b => { b.complete = false; }, b => { b.widths.pop(); }, b => { b.widths[1].width = 1280; }, b => { b.widths[0].cases.pop(); },
    b => { b.widths[0].cases[0].requests.pop(); }, b => { b.widths[0].cases[0].ledger.accepted[0].start = 1; },
    b => { b.widths[0].cases[0].state.sockets[0].received.find(e => e.type === 'pcm').epoch = 999; },
    b => { b.widths[0].cases[0].state.sockets[0].received.find(e => e.type === 'pcm').frame = 1; },
    b => { b.widths[0].cases[0].state.sockets[0].sent.at(-1).consumedSamples = 0; },
    b => { b.widths[0].cases[1].afterLate.enabled = false; }, b => { b.widths[0].cases[1].afterLate.paused = false; },
    b => { b.widths[0].cases[2].after.sockets.push({}); }, b => { b.widths[0].cases[2].stopped.contexts = ['running']; },
    b => { b.widths[0].cases[0].state.sockets[0].received.find(e => e.type === 'speech.unit').unit = 999; },
    b => { const end = b.widths[0].cases[0].state.sockets[0].received.find(e => e.type === 'speech.unit-end'); end.unit = 999; end.samples = 1; },
    b => { b.widths[0].cases[0].state.sockets[0].readyState = 1; },
    b => { b.widths[0].cases[1].finished.contexts = ['running']; },
    b => { b.widths[0].cases[1].afterLate.sockets = [{}, {}, {}]; },
    b => { delete b.widths[0].cases[2].stopped.contexts; },
    b => { b.widths[0].cases[1].commitsWhilePaused.push('乙。'); },
    b => { b.widths[0].cases[1].afterLate.contextIds[1] = 999; },
    b => { b.widths[0].cases[0].served.responses[0].sha256 = '0'.repeat(64); },
    b => { b.widths[0].cases[0].served.responses.pop(); },
    b => { b.widths[0].cases[0].served.responses.at(-1).source = 'page-response'; },
    b => { b.widths[0].cases[0].served.responses[0].source = 'server-response-finish'; },
    b => { b.widths[0].cases[0].served.responses.at(-1).method = 'HEAD'; },
    b => { b.widths[0].cases[0].served.responses.at(-1).path = '/unrelated.js'; },
    b => { b.widths[0].cases[0].served.responses.at(-1).status = 404; },
    b => { b.widths[0].cases[0].served.responses.at(-1).bytes = 0; },
    b => { b.widths[0].cases[0].served.responses.at(-1).bytes++; },
    b => { b.widths[0].cases[0].served.responses.at(-1).fixtureId = randomUUID(); },
    b => { b.widths[0].cases[0].served.responses.at(-1).origin = 'http://127.0.0.1:54321'; },
    b => { b.widths[0].cases[0].served.responses.at(-1).source = 'server-response-close'; },
    b => { b.widths[0].cases[0].served.fixtureId = randomUUID(); },
    b => { b.widths[0].cases[1].served = structuredClone(b.widths[0].cases[0].served); },
    b => { b.negative.served.responses.find(row => row.file === 'public/speech-controller.js').sha256 = provenance.normalControllerSha256; },
    b => { b.sourceEnd.digests['public/app.js'] = '0'.repeat(64); },
    b => { b.mutation.mutantControllerSha256 = b.mutation.normalControllerSha256; },
    b => { b.widths[0].cases[1].paused.contexts[1] = 'running'; b.widths[0].cases[1].afterLate.contexts[1] = 'running'; },
    b => { b.widths[0].cases[1].paused.sockets[1].readyState = 3; b.widths[0].cases[1].afterLate.sockets[1].readyState = 3; },
    b => { b.widths[0].cases[2].before.contexts[1] = 'suspended'; b.widths[0].cases[2].after.contexts[1] = 'suspended'; },
    b => { b.widths[0].cases[0].state.sockets[0].received.unshift({ type: 'speech.error', epoch: 1 }); },
    b => { b.negative.caught = false; }, b => { b.negative.after.sockets.pop(); }, b => { b.negative.errors.push('page crash'); }
  ];
  for (const mutate of mutations) { const browser = syntheticBrowser(provenance); mutate(browser); assert.equal(checkPlaybackBrowser(browser, provenance), false, mutate.toString()); }
});

test('playback property execution remains scoped while the aggregate fails closed', async () => {
  const context = await metadata(), time = new Date().toISOString();
  const results = playbackProfile.map(id => ({ ...context, property: { id, version: 1 }, startedAt: time, finishedAt: time, complete: true, status: 'passed',
    scope: { description: 'Synthetic execution classification', scenario: 'unit-test', samples: 1, seed: null },
    artifacts: ['observations.json', 'worker.log'].map(path => ({ path, sha256: '0'.repeat(64) })) }));
  const checks = ['identity', 'text', 'transports', 'browser'].map(name => ({ name, execution: execution(name === 'identity' ? { code: 1, ok: false } : {}) }));
  const options = { results, checks, target: context.source, required: playbackProfile, artifactsValid: results.map(() => true), sourceStable: true };
  const { summary } = summarizePlaybackResults(options);
  assert.equal(summary.ok, false); assert.deepEqual(summary.rows.map(row => row.status), ['failed', 'passed', 'failed', 'failed']);
  for (const bad of [results.slice(1), [...results, results[0]]]) assert.equal(summarizePlaybackResults({ ...options, results: bad, artifactsValid: bad.map(() => true) }).summary.ok, false);
});

test('playback child budgets share the 150s deadline and stop after timeout with cleanup', async () => {
  let now = 0, cleaned = false; const budgets = [];
  const result = await runPlaybackChecks([{ name: 'identity', timeoutMs: 30000 }, { name: 'text', timeoutMs: 20000 }, { name: 'transports', timeoutMs: 30000 },
    { name: 'browser', timeoutMs: 100000 }, { name: 'must-not-start', timeoutMs: 1 }], async (spec, timeoutMs) => {
    budgets.push(timeoutMs); now += timeoutMs; return execution(spec.name === 'browser' ? { timedOut: true, ok: false, code: null } : {});
  }, { now: () => now, cleanup: () => { cleaned = true; } });
  assert.deepEqual(budgets, [30000, 20000, 30000, 70000]); assert.equal(cleaned, true);
  assert.equal(result.checks.length, 4); assert.equal(result.checks.at(-1).execution.timedOut, true);
});

test('playback source snapshots reject dirty-to-dirty content changes and missing build provenance', async () => {
  const { snapshot } = await playbackProvenance(); const start = structuredClone(snapshot); start.source.dirty = true;
  assert.equal(stablePlaybackSources(start, structuredClone(start)), true);
  for (const key of ['public/app.js', 'dist/server/index.js', 'test-support/playback-evidence.mjs', 'test-support/playback-worklet-preload.mjs']) {
    const changed = structuredClone(start); changed.digests[key] = '0'.repeat(64);
    assert.equal(stablePlaybackSources(start, changed), false);
    delete changed.digests[key]; assert.equal(stablePlaybackSources(changed, changed), false);
  }
});
