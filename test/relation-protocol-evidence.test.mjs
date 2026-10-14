import { syntheticFormalTap } from '../test-support/synthetic-formal-tap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { normalizeProtocolTrace, projectionFields } from '../scripts/lib/protocol-replay.mjs';
import { modelRoot, protocolCoverage, protocolMetadata, protocolPlan, validateProtocolEvidence } from '../scripts/lib/relation-protocol-evidence.mjs';

// These deliberately synthetic files exercise the report gate, not Quint, TLC,
// Apalache or implementation correctness. Never publish them as model evidence.
// Only source/configuration metadata is read from the current checkout.
const testOnly = 'TEST ONLY: synthetic gate-unit fixture; NOT model-checker or implementation evidence';
const execution = { code: 0, signal: null, timedOut: false, interrupted: false };
const timestamp = '2026-01-01T00:00:00.000Z';
const tap = await syntheticFormalTap('relation-protocol');
const traceOptions = main => ({ actors: main.includes('multi_') ? 3 : 1, capacity: main.includes('cap2') ? 2 : 1 });
const json = value => JSON.stringify(value, null, 2) + '\n';
const encode = value => typeof value === 'number' ? { '#bigint': String(value) } : value && typeof value === 'object' ?
  { '#map': Object.entries(value).map(([key, entry]) => [encode(Number(key)), encode(entry)]) } : value;

function syntheticITF(main) {
  const { actors } = traceOptions(main);
  const initial = Object.fromEntries(Object.entries({ phase: 'idle', counts: 0, calls: 0, relations: 0, outcome: 'none', replies: 'none', ready: true })
    .map(([field, value]) => [field, Object.fromEntries(Array.from({ length: actors }, (_, actor) => [actor, value]))]));
  let projection = structuredClone(initial);
  const states = [], vars = ['lastAction', 'actor', 'response', 'mode', ...projectionFields];
  const append = (action, updates = {}, response = '') => {
    projection = structuredClone(projection);
    for (const [field, value] of Object.entries(updates)) projection[field][0] = value;
    const state = { lastAction: action, actor: action === 'init' || action === 'advance_time' ? -1 : 0, response, mode: 'valid', ...projection };
    states.push(Object.fromEntries(vars.map(field => [`testOnly::protocol::${field}`, encode(state[field])])));
  };
  append('init');
  append('admit', { phase: 'reserved', counts: main === 'mutant_send_without_reserve' ? 0 : 1 });
  if (main === 'mutant_send_without_reserve') append('send', { phase: 'inflight', calls: 1 });
  if (main === 'mutant_retry_commit_failure') {
    append('send', { phase: 'inflight', calls: 1 });
    append('response', { phase: 'received', replies: 'ok' }, 'ok');
    append('commit_fail', { phase: 'retry_wait', outcome: 'failed', ready: false });
  }
  if (main === 'mutant_fourth_request') for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      append('advance_time', { phase: 'idle', ready: true });
      append('admit', { phase: 'reserved', counts: attempt, replies: 'none' });
    }
    append('send', { phase: 'inflight', calls: attempt });
    append('response', { phase: 'retry_wait', replies: 'transient', ready: false }, 'transient');
  }
  return { '#meta': { description: testOnly }, vars: vars.map(field => `testOnly::protocol::${field}`), states };
}

async function fixture(t, profile = 'fast') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-TEST-ONLY-protocol-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(path.join(modelRoot, 'config.json'), 'utf8'));
  const pinned = JSON.parse(await readFile(path.join(modelRoot, 'toolchain.json'), 'utf8'));
  const witnessSource = await readFile(path.join(modelRoot, config.witnesses.specification), 'utf8');
  const witnessNames = Object.fromEntries([...witnessSource.matchAll(/module (\w+) \{([\s\S]*?)(?=\nmodule |$)/g)]
    .map(([, main, body]) => [main, [...body.matchAll(/\brun (\w+)\s*=/g)].map(([, name]) => name)]));
  const report = { ...await protocolMetadata(), fixturePurpose: testOnly, profile, startedAt: timestamp, finishedAt: timestamp,
    complete: true, ok: true, execution: { ...execution, complete: true }, domain: config, propertyCoverage: protocolCoverage(config),
    tools: { quint: pinned.quint.version, apalache: pinned.apalache.version, tlc: pinned.apalache.bundledTlcVersion,
      apalacheJarSha256: pinned.apalache.jarSha256, apalacheArchiveSha256: pinned.apalache.archiveSha256,
      java: `openjdk version "${pinned.java.minimumMajor}.0.0" TEST ONLY`, node: 'v24.0.0', sqlite: 'TEST ONLY' }, results: [], artifacts: [] };
  const files = new Map();
  const put = async (file, text) => {
    files.set(file, text);
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), text);
    const previous = report.artifacts.find(artifact => artifact.path === file);
    if (previous) previous.sha256 = digest(text);
    else report.artifacts.push({ path: file, sha256: digest(text) });
  };
  const result = id => report.results.find(row => row.id === id);
  for (const entry of protocolPlan(config)) {
    const row = { ...entry, startedAt: timestamp, finishedAt: timestamp, complete: true, status: 'passed', log: `${entry.id}.log` };
    report.results.push(row);
    if (entry.kind.startsWith('implementation-') && entry.kind !== 'implementation-regression') continue;
    row.execution = { ...execution, code: entry.kind === 'model-negative' ? 1 : 0 };
    let log = `${testOnly}\n`;
    if (entry.kind === 'finite-state-complete') log += 'Model checking completed. No error has been found.\n160 states generated, 112 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 15.\n';
    if (entry.kind === 'bounded-model-check') {
      row.bound = config.profiles[profile].apalacheDepth[entry.id.slice('bounded-'.length)];
      log += `Step ${row.bound}: picking a transition\nThe outcome is: NoError\n[ok] No violation found\n`;
    }
    if (entry.kind === 'simulation') log += '[ok] No violation found\n';
    if (entry.kind === 'model-negative') log += 'error: found a counterexample\n';
    if (entry.kind === 'implementation-regression') log = tap;
    await put(row.log, log);
    if (!['model-witness', 'simulation', 'model-negative'].includes(entry.kind)) continue;
    const main = entry.id.replace(/^(witnesses|simulation|negative)-/, '');
    const names = entry.kind === 'model-witness' ? witnessNames[main].map(name => `${main}-${name}-0`) :
      entry.kind === 'simulation' ? Array.from({ length: config.simulation.selectedTraces }, (_, index) => `${main}-${index}`) : [main];
    row.traces = [];
    for (const name of names) {
      const file = `${entry.kind}/${name}.itf.json`;
      row.traces.push(file);
      await put(file, json(syntheticITF(main)));
    }
  }
  for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) {
    const row = result(id), negative = id === 'negative-replay';
    const sources = report.results.filter(source => source.kind === (id === 'replay-simulation' ? 'simulation' : 'model-witness'));
    const replays = sources.flatMap(source => source.traces.filter(file => !negative || file.includes('normalSuccessTest-')).map(file => {
      const raw = files.get(file), trace = normalizeProtocolTrace(JSON.parse(raw), traceOptions(source.id));
      const states = [trace.initial, ...trace.steps.map(step => step.expected)];
      const replay = { fixturePurpose: testOnly, startedAt: timestamp, finishedAt: timestamp, complete: true, ok: !negative,
        classification: negative ? 'implementation_mismatch' : 'matched', sourceTrace: file, sourceTraceSha256: digest(raw),
        semanticTraceSha256: digest(JSON.stringify(trace)), steps: trace.steps.length,
        observations: states.map((actual, index) => ({ step: index - 1, actual: structuredClone(actual), durable: { fixturePurpose: testOnly }, durableViolations: [] })) };
      if (negative) {
        const actual = structuredClone(states[1]); actual.counts[0] = 0;
        replay.observations[1].actual = actual;
        replay.difference = { step: 0, expected: states[1], actual, durableViolations: [] };
        replay.counterexample = { ...trace, steps: trace.steps.slice(0, 1), minimality: 'first-divergence-prefix' };
      }
      return replay;
    }));
    row.data = `${id}.json`; row.traces = replays.map(replay => replay.sourceTrace);
    row.samples = replays.length; row.steps = replays.reduce((sum, replay) => sum + replay.steps, 0);
    await put(row.data, json(replays));
    await put(row.log, json(replays.map(replay => ({ fixturePurpose: testOnly, trace: replay.sourceTrace,
      classification: replay.classification, complete: replay.complete, ok: replay.ok, steps: replay.steps }))));
  }
  const save = () => writeFile(path.join(directory, 'report.json'), json(report));
  const check = async options => { await save(); return validateProtocolEvidence(directory, options); };
  const editReplays = async (id, edit) => { const file = result(id).data, data = JSON.parse(files.get(file)); edit(data); await put(file, json(data)); };
  await save();
  return { directory, report, files, result, put, save, check, editReplays };
}

function rejected(summary, reason, id) {
  assert.equal(summary.ok, false, 'The gate must reject incomplete or altered evidence');
  const reasons = id ? summary.rows.find(row => row.id === id)?.reasons : summary.reasons;
  assert.ok(reasons?.includes(reason), `Expected ${id || 'report'} reason ${reason}; got ${JSON.stringify(summary)}`);
}

test('TEST ONLY complete gate fixtures pass the selected shape, without claiming full acceptance or another profile', async t => {
  for (const profile of ['fast', 'deep']) await t.test(profile, async sub => {
    const f = await fixture(sub, profile), summary = await f.check({ requireProfile: profile });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(summary.fullProjectAcceptance, false);
    assert.equal(summary.rows.length, protocolPlan(f.report.domain).length);
    assert.ok(summary.rows.every(row => row.status === 'passed'));
    assert.ok(summary.propertyRows.length > 0 && summary.propertyRows.every(row => row.status === 'passed'));
    assert.deepEqual(summary.otherProfiles, [{ profile: profile === 'fast' ? 'deep' : 'fast', status: 'not_run_in_this_report' }]);
  });
});

test('gate recomputes required evidence instead of trusting cached passing flags or omitted lists', async t => {
  for (const [name, mutate, reason, id] of [
    ['missing result', f => { f.report.results = f.report.results.filter(row => row.id !== 'tlc-single'); f.report.required = []; }, 'missing_result', 'tlc-single'],
    ['duplicate result', f => f.report.results.push(structuredClone(f.result('tlc-single'))), 'duplicate_result', 'tlc-single'],
    ['missing artifact manifest entry', f => { f.report.artifacts = f.report.artifacts.filter(row => row.path !== 'tlc-single.log'); }, 'missing_log', 'tlc-single'],
    ['missing artifact file', f => rm(path.join(f.directory, 'tlc-single.log')), 'missing_artifact'],
    ['changed artifact bytes', f => writeFile(path.join(f.directory, 'tlc-single.log'), testOnly), 'changed_artifact'],
    ['duplicate artifact path', f => f.report.artifacts.push({ ...f.report.artifacts[0] }), 'invalid_artifact'],
    ['parent artifact path', f => { f.report.artifacts[0].path = '../outside-test-artifact.log'; }, 'invalid_artifact'],
    ['absolute artifact path', f => { f.report.artifacts[0].path = path.join(f.directory, 'absolute-test-artifact.log'); }, 'invalid_artifact'],
    ['missing child execution', f => { delete f.result('tlc-single').execution; }, 'raw_check_not_passed', 'tlc-single'],
    ['missing trace list', f => { delete f.result('witnesses-single_witnesses').traces; }, 'missing_or_duplicate_trace', 'witnesses-single_witnesses'],
    ['duplicate trace', f => { const row = f.result('simulation-single'); row.traces[1] = row.traces[0]; }, 'missing_or_duplicate_trace', 'simulation-single'],
    ['missing trace artifact', f => rm(path.join(f.directory, f.result('simulation-single').traces[0])), 'invalid_trace', 'simulation-single'],
    ['missing replay artifact', f => rm(path.join(f.directory, f.result('replay-witnesses').data)), 'missing_replay', 'replay-witnesses'],
    ['failed row with cached ok', f => { f.result('tlc-single').status = 'failed'; f.report.summary = { ok: true }; }, 'not_passed', 'tlc-single'],
    ['incomplete row', f => { f.result('tlc-single').complete = false; }, 'not_passed', 'tlc-single']
  ]) await t.test(name, async sub => { const f = await fixture(sub); await mutate(f); rejected(await f.check(), reason, id); });
  await t.test('missing and invalid report', async sub => {
    const f = await fixture(sub); await rm(path.join(f.directory, 'report.json'));
    rejected(await validateProtocolEvidence(f.directory), 'missing_or_invalid_report');
    await writeFile(path.join(f.directory, 'report.json'), '{broken');
    rejected(await validateProtocolEvidence(f.directory), 'missing_or_invalid_report');
  });
});

test('malformed JSON shapes fail closed with a diagnostic rather than throwing', async t => {
  for (const [name, malformed] of [
    ['null report', () => null], ['array report', () => []], ['primitive report', () => 1],
    ['non-array results', report => ({ ...report, results: {} })],
    ['non-array artifacts', report => ({ ...report, artifacts: {} })],
    ['null result', report => ({ ...report, results: [null] })],
    ['null artifact', report => ({ ...report, artifacts: [null] })],
    ['array result', report => ({ ...report, results: [[]] })]
  ]) await t.test(name, async sub => {
    const f = await fixture(sub); await writeFile(path.join(f.directory, 'report.json'), json(malformed(f.report)));
    rejected(await validateProtocolEvidence(f.directory), 'invalid_report_shape');
  });
});

test('gate binds reports to current source, contract, domain, toolchain and requested profile', async t => {
  const cases = [
    ['source SHA', f => { f.report.source.sha = '0'.repeat(40); }, 'stale'],
    ['model digest', f => { f.report.modelDigest = '0'.repeat(64); }, 'stale'],
    ['lock digest', f => { f.report.lockDigest = '0'.repeat(64); }, 'stale'],
    ['schema version', f => { f.report.schemaVersion++; }, 'invalid_contract'],
    ['specification version', f => { f.report.specificationVersion = '0.0'; }, 'invalid_contract'],
    ['model version', f => { f.report.modelVersion++; }, 'invalid_contract'],
    ['domain', f => { f.report.domain.single.cap++; }, 'invalid_domain'],
    ['unknown profile', f => { f.report.profile = 'unregistered'; }, 'invalid_profile'],
    ['inherited object name is not a profile', f => { f.report.profile = 'toString'; }, 'invalid_profile'],
    ['missing environment', f => { delete f.report.environment; }, 'missing_environment'],
    ['empty environment field', f => { f.report.environment.arch = ''; }, 'missing_environment'],
    ['missing property coverage', f => { delete f.report.propertyCoverage; }, 'invalid_property_coverage'],
    ['omitted property check', f => { f.report.propertyCoverage[0].checks.pop(); }, 'invalid_property_coverage'],
    ['missing start timestamp', f => { delete f.report.startedAt; }, 'invalid_timestamps'],
    ['invalid finish timestamp', f => { f.report.finishedAt = 'not a timestamp'; }, 'invalid_timestamps'],
    ['reversed timestamps', f => { f.report.finishedAt = '2025-12-31T23:59:59.000Z'; }, 'invalid_timestamps'],
    ...['quint', 'apalache', 'tlc', 'apalacheJarSha256', 'apalacheArchiveSha256', 'sqlite'].map(key =>
      [`tool ${key}`, f => { f.report.tools[key] = ''; }, 'invalid_toolchain']),
    ['old Java', f => { f.report.tools.java = 'openjdk version "20.0.0"'; }, 'invalid_toolchain'],
    ['wrong Node', f => { f.report.tools.node = 'v22.0.0'; }, 'invalid_toolchain']
  ];
  for (const [name, mutate, reason] of cases) await t.test(name, async sub => {
    const f = await fixture(sub); mutate(f); rejected(await f.check(), reason);
  });
  await t.test('fast cannot satisfy an explicitly required deep run', async sub => {
    const f = await fixture(sub); rejected(await f.check({ requireProfile: 'deep' }), 'invalid_profile');
  });
  await t.test('renaming fast to deep does not supply the deeper raw bound', async sub => {
    const f = await fixture(sub); f.report.profile = 'deep';
    rejected(await f.check({ requireProfile: 'deep' }), 'raw_check_not_passed', 'bounded-multi_cap2');
  });
  await t.test('release rejects dirty source even when every row passes', async sub => {
    const f = await fixture(sub); f.report.source.dirty = true;
    rejected(await f.check({ release: true }), 'uncommitted_source');
  });
  await t.test('each result needs a valid interval', async sub => {
    const f = await fixture(sub); delete f.result('tlc-single').finishedAt;
    rejected(await f.check(), 'invalid_timestamps', 'tlc-single');
  });
});

test('timeouts, interruptions and unfinished exploration cannot be relabeled passed', async t => {
  for (const [name, mutate] of [
    ['missing execution', f => { delete f.report.execution; }],
    ['incomplete report', f => { f.report.complete = false; }],
    ['incomplete execution', f => { f.report.execution.complete = false; }],
    ['timeout', f => { f.report.execution.timedOut = true; }],
    ['interruption', f => { f.report.execution.interrupted = true; }],
    ['signal', f => { f.report.execution.signal = 'SIGTERM'; }],
    ['nonzero exit', f => { f.report.execution.code = 1; }]
  ]) await t.test(name, async sub => { const f = await fixture(sub); mutate(f); rejected(await f.check(), 'incomplete_execution'); });
  for (const [name, change] of [['timeout', { timedOut: true }], ['interruption', { interrupted: true }], ['signal', { signal: 'SIGTERM' }], ['failure', { code: 1 }]]) {
    await t.test(`child ${name}`, async sub => {
      const f = await fixture(sub); Object.assign(f.result('bounded-multi_cap2').execution, change);
      rejected(await f.check(), 'raw_check_not_passed', 'bounded-multi_cap2');
    });
  }
  await t.test('TLC queue is not empty', async sub => {
    const f = await fixture(sub), file = f.result('tlc-single').log;
    await f.put(file, f.files.get(file).replace('0 states left', '1 states left'));
    rejected(await f.check(), 'raw_check_not_passed', 'tlc-single');
  });
});

test('replay evidence must identify every source and every observed model state', async t => {
  for (const [name, edit, reason] of [
    ['duplicate source', rows => { rows[1] = structuredClone(rows[0]); }, 'wrong_replay_sources'],
    ['missing source', rows => { rows.pop(); }, 'wrong_replay_sources'],
    ['wrong raw source hash', rows => { rows[0].sourceTraceSha256 = '0'.repeat(64); }, 'wrong_replay_identity'],
    ['wrong semantic hash', rows => { rows[0].semanticTraceSha256 = '0'.repeat(64); }, 'wrong_replay_identity'],
    ['wrong step count', rows => { rows[0].steps++; }, 'wrong_replay_identity'],
    ['missing observation', rows => { rows[0].observations.pop(); }, 'wrong_replay_observations'],
    ['duplicate observation', rows => { rows[0].observations[1] = structuredClone(rows[0].observations[0]); }, 'wrong_replay_observations'],
    ['wrong observation index', rows => { rows[0].observations[0].step = 0; }, 'wrong_replay_observations'],
    ['changed observed projection', rows => { rows[0].observations[1].actual.counts[0] = 0; }, 'wrong_replay_observations'],
    ['durable violation', rows => { rows[0].observations[0].durableViolations.push('TEST ONLY injected violation'); }, 'wrong_replay_observations'],
    ['incomplete replay', rows => { rows[0].complete = false; }, 'invalid_replay'],
    ['unreplayable is not matched', rows => { rows[0].classification = 'unreplayable'; }, 'invalid_replay']
  ]) await t.test(name, async sub => {
    const f = await fixture(sub); await f.editReplays('replay-witnesses', edit);
    rejected(await f.check(), reason, 'replay-witnesses');
  });
});

test('negative controls require the expected violation and implementation mismatch', async t => {
  await t.test('another mutant counterexample does not satisfy the named expected violation', async sub => {
    const f = await fixture(sub), row = f.result('negative-mutant_send_without_reserve');
    await f.put(row.traces[0], json(syntheticITF('mutant_retry_commit_failure')));
    rejected(await f.check(), 'wrong_counterexample', row.id);
  });
  await t.test('a tool error is not a model counterexample', async sub => {
    const f = await fixture(sub), row = f.result('negative-mutant_send_without_reserve');
    await f.put(row.log, `${testOnly}\nerror: download failed\n`);
    rejected(await f.check(), 'raw_check_not_passed', row.id);
  });
  for (const [name, edit, reason] of [
    ['wrong expected count', rows => { rows[0].difference.expected.counts[0] = 2; }, 'wrong_implementation_counterexample'],
    ['wrong actual count', rows => { rows[0].difference.actual.counts[0] = 1; }, 'wrong_implementation_counterexample'],
    ['wrong first divergence', rows => { rows[0].difference.step = 1; }, 'wrong_implementation_counterexample'],
    ['empty counterexample prefix', rows => { rows[0].counterexample.steps = []; }, 'wrong_implementation_counterexample'],
    ['unreplayable negative', rows => { rows[0].classification = 'unreplayable'; }, 'invalid_replay']
  ]) await t.test(name, async sub => {
    const f = await fixture(sub); await f.editReplays('negative-replay', edit);
    rejected(await f.check(), reason, 'negative-replay');
  });
});

test('regression evidence must show executed, wholly passing TAP tests', async t => {
  for (const [name, log] of [
    ['empty output', ''],
    ['zero tests', tap.replace('1..1', '1..0').replace('ok 1 - synthetic gate fixture\n', '').replace('# tests 1', '# tests 0').replace('# pass 1', '# pass 0')],
    ['missing summary', 'TAP version 13\n'],
    ...['fail', 'cancelled', 'skipped', 'todo'].map(field => [field, tap.replace(`# ${field} 0`, `# ${field} 1`)])
  ]) await t.test(name, async sub => {
    const f = await fixture(sub); await f.put(f.result('implementation-regressions').log, log);
    rejected(await f.check(), 'raw_check_not_passed', 'implementation-regressions');
  });
});
