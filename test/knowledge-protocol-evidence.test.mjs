import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { formalPlan } from '../scripts/lib/formal-protocol-evidence.mjs';
import { normalizeKnowledgeTrace } from '../scripts/lib/knowledge-protocol-replay.mjs';
import { knowledgeModelRoot, knowledgeMetadata, knowledgeCoverage, knowledgeMutationViolation, validateKnowledgeEvidence } from '../scripts/lib/knowledge-protocol-evidence.mjs';
import { validateProtocolEvidence } from '../scripts/lib/relation-protocol-evidence.mjs';

// Synthetic gate-unit fixtures only. These logs and traces are NOT formal
// verification evidence; actual checker/replay evidence comes from the runner.
const testOnly = 'TEST ONLY: synthetic knowledge gate fixture, not model or implementation evidence';
const stamp = '2026-01-01T00:00:00.000Z';
const execution = { code: 0, signal: null, timedOut: false, interrupted: false };
const json = value => JSON.stringify(value, null, 2) + '\n';
const traceConfig = id => ({ parts: id.includes('two_parts') ? 2 : 1 });
const encode = value => typeof value === 'number' ? { '#bigint': String(value) } : Array.isArray(value) ? { '#set': value.map(encode) } :
  value && typeof value === 'object' ? { '#map': Object.entries(value).map(([key, entry]) => [encode(Number(key)), encode(entry)]) } : value;

function syntheticTrace(main) {
  const { parts } = traceConfig(main), map = value => Object.fromEntries(Array.from({ length: parts }, (_, index) => [index, structuredClone(value)]));
  const initial = { lastAction: 'init', actor: -1, response: '', stage: 'idle', outcome: 'none', ready: true, extra_requests: 0, protocol_retries: 0, cycle: 1,
    phase: map('extract_pending'), initial_requests: map(0), repair_reserved: map(0), extract_calls: map(0), repair_calls: map(0),
    initial_complete: map(false), retry_kind: map('none'), accepted: map([]), unresolved: map([]), anchored: map([]), replies: map('none'),
    accepted_ever: map([]), apply_counts: map(0) };
  const next = structuredClone(initial); Object.assign(next, { lastAction: 'admit', actor: 0, stage: 'reserved' });
  next.phase[0] = 'extract_inflight'; next.initial_requests[0] = 1;
  if (main === 'mutant_send_without_reserve') { next.initial_requests[0] = 0; next.extract_calls[0] = 1; next.stage = 'inflight'; next.lastAction = 'send'; }
  if (main === 'mutant_third_extra') { next.extra_requests = 3; next.initial_requests[0] = 4; }
  if (main === 'mutant_accepted_loss') { next.accepted_ever[0] = [0]; next.apply_counts[0] = 1; }
  if (main === 'mutant_wrong_terminal_outcome') {
    next.stage = 'done'; next.phase[0] = 'done'; next.outcome = 'partial'; next.initial_complete[0] = true;
    next.accepted[0] = [0]; next.accepted_ever[0] = [0]; next.apply_counts[0] = 1;
  }
  const vars = Object.keys(initial);
  return { '#meta': { description: testOnly }, vars: vars.map(field => `testOnly::${field}`), states: [initial, next]
    .map(state => Object.fromEntries(vars.map(field => [`testOnly::${field}`, encode(state[field])])) ) };
}

async function fixture(t, profile = 'fast') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-TEST-ONLY-knowledge-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(path.join(knowledgeModelRoot, 'config.json'), 'utf8'));
  const pinned = JSON.parse(await readFile(path.join(knowledgeModelRoot, 'toolchain.json'), 'utf8'));
  const witnessSource = await readFile(path.join(knowledgeModelRoot, config.witnesses.specification), 'utf8');
  const witnessNames = Object.fromEntries([...witnessSource.matchAll(/module (\w+) \{([\s\S]*?)(?=\nmodule |$)/g)]
    .map(([, main, body]) => [main, [...body.matchAll(/\brun (\w+)\s*=/g)].map(([, name]) => name)]));
  const report = { ...await knowledgeMetadata(), fixturePurpose: testOnly, profile, startedAt: stamp, finishedAt: stamp,
    complete: true, ok: true, execution: { ...execution, complete: true }, domain: config, propertyCoverage: knowledgeCoverage(config),
    tools: { quint: pinned.quint.version, apalache: pinned.apalache.version, tlc: pinned.apalache.bundledTlcVersion,
      apalacheJarSha256: pinned.apalache.jarSha256, apalacheArchiveSha256: pinned.apalache.archiveSha256,
      java: `openjdk version "${pinned.java.minimumMajor}.0.0" TEST ONLY`, node: 'v24.0.0', sqlite: 'TEST ONLY' }, results: [], artifacts: [] };
  const files = new Map(), row = id => report.results.find(result => result.id === id);
  const put = async (file, text) => {
    files.set(file, text); await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await writeFile(path.join(directory, file), text);
    const artifact = report.artifacts.find(artifact => artifact.path === file);
    if (artifact) artifact.sha256 = digest(text); else report.artifacts.push({ path: file, sha256: digest(text) });
  };
  for (const entry of formalPlan(config)) {
    const result = { ...entry, startedAt: stamp, finishedAt: stamp, complete: true, status: 'passed', log: `${entry.id}.log` };
    report.results.push(result);
    if (['implementation-replay', 'implementation-negative'].includes(entry.kind)) continue;
    result.execution = { ...execution, code: entry.kind === 'model-negative' ? 1 : 0 };
    let log = `${testOnly}\n`;
    if (entry.kind === 'finite-state-complete') log += 'Model checking completed. No error has been found.\n846 states generated, 536 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 19.\n';
    if (entry.kind === 'bounded-model-check') log += `Step ${config.profiles[profile].apalacheDepth[entry.id.slice('bounded-'.length)]}: transition\nThe outcome is: NoError\n[ok] No violation found\n`;
    if (entry.kind === 'simulation') log += '[ok] No violation found\n';
    if (entry.kind === 'model-negative') log += 'error: found a counterexample\n';
    if (entry.kind === 'implementation-regression') log += 'TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
    await put(result.log, log);
    if (!['model-witness', 'simulation', 'model-negative'].includes(entry.kind)) continue;
    const main = entry.id.replace(/^(witnesses|simulation|negative)-/, '');
    const names = entry.kind === 'model-witness' ? witnessNames[main].map(name => `${main}-${name}-0`) :
      entry.kind === 'simulation' ? Array.from({ length: config.simulation.selectedTraces }, (_, index) => `${main}-${index}`) : [main];
    result.traces = names.map(name => `${entry.kind}/${name}.itf.json`);
    for (const file of result.traces) await put(file, json(syntheticTrace(main)));
  }
  for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) {
    const result = row(id), negative = id === 'negative-replay';
    const sources = report.results.filter(source => source.kind === (id === 'replay-simulation' ? 'simulation' : 'model-witness'));
    const replays = sources.flatMap(source => source.traces.filter(file => !negative || file.includes('normalSuccessTest-')).map(file => {
      const raw = files.get(file), trace = normalizeKnowledgeTrace(JSON.parse(raw), traceConfig(source.id));
      const states = [trace.initial, ...trace.steps.map(step => step.expected)];
      const replay = { fixturePurpose: testOnly, complete: true, ok: !negative, classification: negative ? 'implementation_mismatch' : 'matched',
        sourceTrace: file, sourceTraceSha256: digest(raw), semanticTraceSha256: digest(JSON.stringify(trace)), steps: trace.steps.length,
        observations: states.map((actual, index) => ({ step: index - 1, actual, durable: { fixturePurpose: testOnly }, durableViolations: [] })) };
      if (negative) {
        const actual = structuredClone(states[1]); actual.initial_requests[0] = 0;
        replay.difference = { step: 0, expected: states[1], actual }; replay.counterexample = { ...trace, steps: trace.steps.slice(0, 1) };
      }
      return replay;
    }));
    result.data = `${id}.json`; result.traces = replays.map(replay => replay.sourceTrace);
    await put(result.data, json(replays)); await put(result.log, json({ fixturePurpose: testOnly, samples: replays.length }));
  }
  const save = () => writeFile(path.join(directory, 'report.json'), json(report));
  const check = async options => { await save(); return validateKnowledgeEvidence(directory, options); };
  await save(); return { directory, report, config, row, files, put, save, check };
}
const rejected = summary => assert.equal(summary.ok, false, 'Tampered synthetic evidence must fail closed');

test('knowledge evidence gate accepts its declared complete shape, without confusing relation evidence', async t => {
  for (const profile of ['fast', 'deep']) await t.test(profile, async sub => {
    const f = await fixture(sub, profile); assert.equal((await f.check({ requireProfile: profile })).ok, true);
    rejected(await validateProtocolEvidence(f.directory));
  });
});

test('knowledge gate cannot borrow stale metadata or omit required domain coverage', async t => {
  const cases = [
    ['missing required mutant', f => { f.report.results = f.report.results.filter(row => row.id !== 'negative-mutant_wrong_terminal_outcome'); }],
    ['stale source', f => { f.report.source.sha = '0'.repeat(40); }],
    ['stale model', f => { f.report.modelDigest = '0'.repeat(64); }],
    ['wrong tools', f => { f.report.tools.quint = '0.0.0'; }],
    ['missing property', f => { f.report.propertyCoverage.pop(); }],
    ['wrong domain', f => { f.report.domain.single.maxExtraRequests = 3; }],
    ['missing execution', f => { delete f.row('tlc-single').execution; }],
    ['interrupted', f => { f.report.execution.interrupted = true; }],
    ['deep relabel', f => { f.report.profile = 'deep'; }],
    ['missing trace', f => { f.row('witnesses-single_witnesses').traces.pop(); }],
    ['missing artifact', f => rm(path.join(f.directory, f.row('simulation-single').traces[0]))]
  ];
  for (const [name, mutate] of cases) await t.test(name, async sub => { const f = await fixture(sub); await mutate(f); rejected(await f.check()); });
});

test('knowledge replay source, projections and reservation counterexample are bound even after artifact rehashing', async t => {
  for (const [name, id, mutate] of [
    ['semantic hash', 'replay-witnesses', replays => { replays[0].semanticTraceSha256 = '0'.repeat(64); }],
    ['duplicate source', 'replay-witnesses', replays => { replays[1] = structuredClone(replays[0]); }],
    ['different part domain', 'replay-witnesses', replays => { replays[0].observations[0].actual.initial_requests[1] = 0; }],
    ['changed accepted slot', 'replay-witnesses', replays => { replays[0].observations[1].actual.accepted[0] = [0]; }],
    ['wrong reservation difference', 'negative-replay', replays => { replays[0].difference.expected.initial_requests[0] = 0; }],
    ['unreplayable as success', 'replay-simulation', replays => { replays[0].classification = 'unreplayable'; }]
  ]) await t.test(name, async sub => {
    const f = await fixture(sub), data = f.row(id).data, replays = JSON.parse(f.files.get(data));
    mutate(replays); await f.put(data, json(replays)); rejected(await f.check());
  });
});

test('all four model-negative controls require their exact declared violation', async t => {
  const f = await fixture(t);
  for (const mutant of f.config.mutants) await t.test(mutant.main, async sub => {
    assert.equal(knowledgeMutationViolation(mutant.main, syntheticTrace(mutant.main)).ok, true);
    assert.equal(knowledgeMutationViolation(mutant.main, syntheticTrace('single')).ok, false);
    const copy = await fixture(sub), file = copy.row(`negative-${mutant.main}`).traces[0];
    await copy.put(file, json(syntheticTrace('single'))); rejected(await copy.check());
  });
});

test('knowledge ITF itself must satisfy its declared part domain, before replay or a cached pass can be trusted', () => {
  assert.throws(() => normalizeKnowledgeTrace(syntheticTrace('single'), { parts: 2 }), /contract/);
  const wrong = syntheticTrace('two_parts');
  wrong.states[1]['testOnly::accepted'] = { '#map': [[{ '#bigint': '0' }, { '#set': [{ '#bigint': '2' }] }], [{ '#bigint': '1' }, { '#set': [] }]] };
  assert.throws(() => normalizeKnowledgeTrace(wrong, { parts: 2 }), /contract/);
});
