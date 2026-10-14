import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { formalPlan } from '../scripts/lib/formal-protocol-evidence.mjs';
import { normalizeImportTrace } from '../scripts/lib/import-protocol-replay.mjs';
import { importModelRoot, importMetadata, importCoverage, importMutationViolation, validateImportEvidence } from '../scripts/lib/import-protocol-evidence.mjs';

// Synthetic gate unit fixtures only, never checker or implementation evidence.
const purpose = 'TEST ONLY: synthetic import gate fixture, not verification evidence';
const stamp = '2026-01-01T00:00:00.000Z', execution = { code: 0, signal: null, timedOut: false, interrupted: false };
const json = value => JSON.stringify(value, null, 2) + '\n';
const configuration = main => ({ tokens: main.includes('two_tokens') ? 2 : 1 });
const encode = value => typeof value === 'number' ? { '#bigint': String(value) } : Array.isArray(value) ? { '#set': value.map(encode) } :
  value && typeof value === 'object' ? { '#map': Object.entries(value).map(([key, item]) => [encode(Number(key)), encode(item)]) } : value;
function syntheticTrace(main) {
  const { tokens } = configuration(main), map = value => Object.fromEntries(Array.from({ length: tokens }, (_, index) => [index, value]));
  const initial = { lastAction: 'init', actor: -1, requestedMode: '', requestedGeneration: 0, fault: false,
    lastHTTPStatus: 0, lastHTTPCode: '', businessIds: [0], clientGeneration: map(0), clientMode: map(''),
    clientCurrentCount: map(0), clientAddedCount: map(0), clientSkippedCount: map(0),
    versionAccepted: true, expiryAccepted: true, consumptionCount: map(0) };
  const upload = structuredClone(initial); Object.assign(upload, { lastAction: 'upload', actor: 0, requestedMode: 'append', requestedGeneration: 1, lastHTTPStatus: 200 });
  upload.clientGeneration[0] = 1; upload.clientMode[0] = 'append'; upload.clientCurrentCount[0] = 1; upload.clientAddedCount[0] = 1;
  const write = { ...structuredClone(upload), lastAction: 'other_write', actor: -1, requestedMode: '', requestedGeneration: 0 };
  const commit = { ...structuredClone(write), lastAction: 'commit', actor: 0, requestedMode: 'append', requestedGeneration: 1,
    lastHTTPStatus: 409, lastHTTPCode: 'IMPORT_PREVIEW_STALE' };
  if (main === 'mutant_skip_version') commit.versionAccepted = false;
  if (main === 'mutant_skip_expiry') commit.expiryAccepted = false;
  if (main === 'mutant_retain_token') commit.consumptionCount[0] = 2;
  const vars = Object.keys(initial);
  return { '#meta': { description: purpose }, vars: vars.map(field => `testOnly::${field}`),
    states: [initial, upload, write, commit].map(state => Object.fromEntries(vars.map(field => [`testOnly::${field}`, encode(state[field])])) ) };
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-TEST-ONLY-import-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(path.join(importModelRoot, 'config.json'), 'utf8'));
  const pin = JSON.parse(await readFile(path.join(importModelRoot, 'toolchain.json'), 'utf8'));
  const witnessSource = await readFile(path.join(importModelRoot, 'witnesses.qnt'), 'utf8');
  const names = Object.fromEntries([...witnessSource.matchAll(/module (\w+) \{([\s\S]*?)(?=\nmodule |$)/g)]
    .map(([, main, body]) => [main, [...body.matchAll(/\brun (\w+)\s*=/g)].map(([, name]) => name)]));
  const report = { ...await importMetadata(), fixturePurpose: purpose, profile: 'fast', startedAt: stamp, finishedAt: stamp,
    complete: true, ok: true, execution: { ...execution, complete: true }, domain: config, propertyCoverage: importCoverage(config),
    tools: { quint: pin.quint.version, apalache: pin.apalache.version, tlc: pin.apalache.bundledTlcVersion,
      apalacheJarSha256: pin.apalache.jarSha256, apalacheArchiveSha256: pin.apalache.archiveSha256,
      java: `openjdk version "${pin.java.minimumMajor}.0.0" TEST ONLY`, node: 'v24.0.0', sqlite: 'TEST ONLY' }, results: [], artifacts: [] };
  const files = new Map(), row = id => report.results.find(result => result.id === id);
  const put = async (file, content) => {
    files.set(file, content); await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
    const artifact = report.artifacts.find(item => item.path === file);
    if (artifact) artifact.sha256 = digest(content); else report.artifacts.push({ path: file, sha256: digest(content) });
  };
  for (const entry of formalPlan(config)) {
    const result = { ...entry, startedAt: stamp, finishedAt: stamp, complete: true, status: 'passed', log: `${entry.id}.log` };
    report.results.push(result);
    if (['implementation-replay', 'implementation-negative'].includes(entry.kind)) continue;
    result.execution = { ...execution, code: entry.kind === 'model-negative' ? 1 : 0 };
    let log = `${purpose}\n`;
    if (entry.kind === 'finite-state-complete') log += 'Model checking completed. No error has been found.\n100 states generated, 80 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 10.\n';
    if (entry.kind === 'bounded-model-check') log += 'Step 8: transition\nThe outcome is: NoError\n[ok] No violation found\n';
    if (entry.kind === 'simulation') log += '[ok] No violation found\n';
    if (entry.kind === 'model-negative') log += 'error: found a counterexample\n';
    if (entry.kind === 'implementation-regression') log += 'TAP version 13\nok 1 - synthetic gate-only fixture\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.0\n';
    await put(result.log, log);
    if (!['model-witness', 'simulation', 'model-negative'].includes(entry.kind)) continue;
    const main = entry.id.replace(/^(witnesses|simulation|negative)-/, '');
    const traceNames = entry.kind === 'model-witness' ? names[main].map(name => `${main}-${name}-0`) :
      entry.kind === 'simulation' ? Array.from({ length: config.simulation.selectedTraces }, (_, index) => `${main}-${index}`) : [main];
    result.traces = traceNames.map(name => `${entry.kind}/${name}.itf.json`);
    for (const file of result.traces) await put(file, json(syntheticTrace(main)));
  }
  for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) {
    const result = row(id), negative = id === 'negative-replay';
    const sources = report.results.filter(source => source.kind === (id === 'replay-simulation' ? 'simulation' : 'model-witness'));
    const replays = sources.flatMap(source => source.traces.filter(file => !negative || file.includes('staleOtherConnectionTest-')).map(file => {
      const raw = files.get(file), trace = normalizeImportTrace(JSON.parse(raw), configuration(source.id));
      const states = [trace.initial, ...trace.steps.map(step => step.expected)];
      const replay = { fixturePurpose: purpose, complete: true, ok: !negative, classification: negative ? 'implementation_mismatch' : 'matched',
        sourceTrace: file, sourceTraceSha256: digest(raw), semanticTraceSha256: digest(JSON.stringify(trace)), steps: trace.steps.length,
        observations: states.map((actual, index) => ({ step: index - 1, actual, durable: { fixturePurpose: purpose }, durableViolations: [] })) };
      if (negative) { replay.difference = { step: 2, expected: states[3], actual: { ...states[3], lastHTTPStatus: 200, lastHTTPCode: '', businessIds: [0, 1] } }; replay.counterexample = trace; }
      return replay;
    }));
    result.data = `${id}.json`; result.traces = replays.map(replay => replay.sourceTrace);
    await put(result.data, json(replays)); await put(result.log, json({ fixturePurpose: purpose, samples: replays.length }));
  }
  const check = async options => { await writeFile(path.join(directory, 'report.json'), json(report)); return validateImportEvidence(directory, options); };
  return { directory, report, config, row, files, put, check };
}

test('complete import-specific synthetic gate shape accepts, without claiming browser acceptance', async t => {
  const f = await fixture(t), result = await f.check(); assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.propertyRows.map(row => row.id), ['HW-09-02', 'HW-09-03', 'HW-09-04']);
  assert.equal(result.fullProjectAcceptance, false); assert.equal((await f.check({ requireProfile: 'deep' })).ok, false);
});

test('missing, stale, incomplete and skipped import evidence fails closed', async t => {
  const cases = [
    ['missing check', f => { f.report.results.pop(); }], ['missing mutant', f => { f.report.results = f.report.results.filter(row => row.id !== 'negative-mutant_skip_expiry'); }],
    ['changed digest map', f => { f.report.sourceDigests['server.mjs'] = '0'.repeat(64); }],
    ['stale source', f => { f.report.source.sha = '0'.repeat(40); }], ['stale input', f => { f.report.modelDigest = '0'.repeat(64); }],
    ['wrong tools', f => { f.report.tools.apalache = '0'; }], ['interrupted', f => { f.report.execution.interrupted = true; }],
    ['missing property', f => { f.report.propertyCoverage.pop(); }], ['wrong domain', f => { f.report.domain.single.tokens.push(1); }],
    ['TLC queue', f => f.put('tlc-two_tokens.log', f.files.get('tlc-two_tokens.log').replace('0 states left', '1 states left'))],
    ['missing trace', f => rm(path.join(f.directory, f.row('simulation-single').traces[0]))],
    ['changed artifact', f => writeFile(path.join(f.directory, 'tlc-single.log'), 'corrupted')],
    ['skipped test', f => f.put('implementation-regressions.log', f.files.get('implementation-regressions.log').replace('# pass 1', '# pass 0').replace('# skipped 0', '# skipped 1'))]
  ];
  for (const [name, mutate] of cases) await t.test(name, async sub => { const f = await fixture(sub); await mutate(f); assert.equal((await f.check()).ok, false); });
});

test('import replay hashes, projections and exact production-mutant difference remain bound after rehash', async t => {
  for (const [name, id, mutate] of [
    ['source hash', 'replay-witnesses', rows => { rows[0].sourceTraceSha256 = '0'.repeat(64); }],
    ['duplicate source', 'replay-witnesses', rows => { rows[1] = structuredClone(rows[0]); }],
    ['wrong persisted IDs', 'replay-witnesses', rows => { rows[0].observations[1].actual.businessIds = [1]; }],
    ['wrong negative', 'negative-replay', rows => { rows[0].difference.actual.lastHTTPStatus = 409; }],
    ['unreplayable', 'replay-simulation', rows => { rows[0].classification = 'unreplayable'; }]
  ]) await t.test(name, async sub => { const f = await fixture(sub), file = f.row(id).data, rows = JSON.parse(f.files.get(file)); mutate(rows); await f.put(file, json(rows)); assert.equal((await f.check()).ok, false); });
});

test('each import model mutant requires its own exact violation', async t => {
  const f = await fixture(t);
  for (const mutant of f.config.mutants) {
    assert.equal(importMutationViolation(mutant.main, syntheticTrace(mutant.main)).ok, true);
    assert.equal(importMutationViolation(mutant.main, syntheticTrace('single')).ok, false);
    const file = f.row(`negative-${mutant.main}`).traces[0]; await f.put(file, json(syntheticTrace('single')));
    assert.equal((await f.check()).ok, false);
  }
});
