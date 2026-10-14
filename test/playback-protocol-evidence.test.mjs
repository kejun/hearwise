import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realPlaybackTraces, gateFixture } from './playback-protocol-fixtures.mjs';
import { validatePlaybackEvidence } from '../scripts/lib/playback-protocol-evidence.mjs';
let traces;
before(async () => { traces = await realPlaybackTraces(); });
const reject = summary => assert.equal(summary.ok, false, 'Corrupt or incomplete evidence must fail closed');

test('playback gate independently accepts the exact complete synthetic-log shape with genuine raw replays', async t => {
  const f = await gateFixture(t, traces); const result = await f.check(); assert.equal(result.ok, true, JSON.stringify(result));
});
test('playback gate rejects stale source, tools, missing results, extra drivers, incomplete and profile relabels', async t => {
  const f = await gateFixture(t, traces), original = structuredClone(f.report);
  for (const mutate of [report => { report.source.sha = '0'.repeat(40); }, report => { report.modelDigest = '0'.repeat(64); },
    report => { report.tools.quint = '0.0.0'; }, report => { report.results.pop(); }, report => { report.results.push({ ...report.results[0], id: 'unregistered-pass' }); },
    report => { report.execution.interrupted = true; }, report => { report.profile = 'deep'; }, report => { report.propertyCoverage.pop(); },
    report => { report.domain.finiteEnvironment.maximumExplicitResumesPerRun = 999; },
    report => { report.results.find(row => row.id === 'tlc-pair').argv[2] = '/tmp/other-model.qnt'; },
    report => { report.results.find(row => row.id === 'bounded-pair').bound = 3; },
    report => { report.results.find(row => row.id === 'tlc-pair').metrics.distinctStates = 999; },
    report => { report.results.find(row => row.id === 'replay-witnesses').samples = 1; }]) {
    Object.keys(f.report).forEach(key => delete f.report[key]); Object.assign(f.report, structuredClone(original)); mutate(f.report); reject(await f.check());
  }
});
test('playback gate rejects rehashed missing or altered raw evidence even when cached projections remain green', async t => {
  const f = await gateFixture(t, traces), data = f.row('replay-witnesses').data, original = JSON.parse(f.files.get(data));
  for (const mutate of [replays => { delete replays[0].observations[0].durable; }, replays => { replays[0].observations[0].durable = {}; },
    replays => { replays[0].observations[1].durable.records.A.rows[0].translation_text = 'changed'; },
    replays => { replays[0].observations[1].durable.generations[0].player.closed = true; },
    replays => { replays[0].observations[0].actual.active = 1; }, replays => { replays[0].semanticTraceSha256 = '0'.repeat(64); },
    replays => { replays[1] = structuredClone(replays[0]); }]) {
    const replays = structuredClone(original); mutate(replays); await f.put(data, replays); reject(await f.check());
  }
});
test('playback gate requires actual owner-copy counterexample raw detail and exact first divergence', async t => {
  const f = await gateFixture(t, traces), data = f.row('negative-replay').data, original = JSON.parse(f.files.get(data));
  for (const mutate of [replays => { replays[0].difference.step = 0; }, replays => { replays[0].difference.actual.paused = false; },
    replays => { replays[0].observations.at(-1).durable.generations[2].requests = []; }, replays => { replays[0].observations.pop(); },
    replays => { replays[0].classification = 'unreplayable'; }]) {
    const replays = structuredClone(original); mutate(replays); await f.put(data, replays); reject(await f.check());
  }
});
test('playback gate rejects skip, todo, missing TAP footer, wrong count and wrong regression command', async t => {
  const f = await gateFixture(t, traces), result = f.row('implementation-regressions'), original = f.files.get(result.log);
  for (const log of [original.replace('# skipped 0', '# skipped 1'), original.replace('# todo 0', '# todo 1'), original.replace(/# duration_ms.*\n$/, ''),
    original.replaceAll(String(f.config.regression.expectedTests), String(f.config.regression.expectedTests - 1))]) { await f.put(result.log, log); reject(await f.check()); }
  await f.put(result.log, original); result.argv.pop(); reject(await f.check());
});
test('playback gate does not treat missing artifacts or a changed trace hash as a pass', async t => {
  const f = await gateFixture(t, traces), file = f.row('witnesses-single_witnesses').traces[0];
  const original = f.report.artifacts; f.report.artifacts = original.filter(row => row.path !== file); reject(await f.check());
  f.report.artifacts = original; f.report.artifacts.find(row => row.path === file).sha256 = '0'.repeat(64); reject(await f.check());
});
test('playback missing report returns incomplete rows rather than trusting an absent cached result', async () => {
  reject(await validatePlaybackEvidence('/tmp/no-such-playback-evidence-report'));
});

test('playback gate rejects a fully rehashed later record-identity rewrite and non-append-only owner histories', async t => {
  const f = await gateFixture(t, traces), data = f.row('replay-witnesses').data, original = JSON.parse(f.files.get(data));
  for (const mutate of [raw => {
    const record = raw.records.A; record.runId = '11111111-1111-4111-8111-111111111111';
    for (const row of record.rows) row.run_id = record.runId;
    for (const generation of raw.generations) if (generation.record === 'A') for (const message of generation.outgoing) if (message.type === 'speech.transcript') message.runId = record.runId;
  }, raw => { raw.generations[0].outgoing[0].config.rate = 2; }]) {
    const replays = structuredClone(original), replay = replays.find(row => row.sourceTrace.includes('fullTextSuccessTest-'));
    mutate(replay.observations.at(-1).durable); await f.put(data, replays); reject(await f.check());
  }
});
test('playback gate rejects rehashed actual binary-header loss or corruption independently of sample counters', async t => {
  const f = await gateFixture(t, traces), data = f.row('replay-witnesses').data, original = JSON.parse(f.files.get(data));
  for (const mutate of [raw => { delete raw.generations[0].serverPackets; }, raw => { raw.generations[0].serverPackets[0].epoch = 999; },
    raw => { raw.generations[0].serverPackets[0].samples[0] = 0; }]) {
    const replays = structuredClone(original), replay = replays.find(row => row.sourceTrace.includes('fullTextSuccessTest-'));
    mutate(replay.observations.at(-1).durable); await f.put(data, replays); reject(await f.check());
  }
});

test('playback gate accepts a consistent recorded CI checkout root but rejects mixed and missing roots', async t => {
  const f = await gateFixture(t, traces), oldRoot = process.cwd(), ciRoot = `${oldRoot}-different-checkout`;
  assert.notEqual(ciRoot, oldRoot);
  f.report.execution.repositoryRoot = ciRoot;
  for (const result of f.report.results) if (Array.isArray(result.argv)) result.argv = result.argv.map(arg => arg.startsWith(`${oldRoot}/`) ? ciRoot + arg.slice(oldRoot.length) : arg);
  assert.equal((await f.check()).ok, true, 'A matching-source CI report is portable across checkout paths');
  const command = f.row('tlc-pair').argv, original = command[2]; command[2] = oldRoot + original.slice(ciRoot.length);
  assert.notEqual(command[2], original, 'The negative control must really change the model path on every host');
  reject(await f.check()); command[2] = original;
  delete f.report.execution.repositoryRoot; reject(await f.check());
});
