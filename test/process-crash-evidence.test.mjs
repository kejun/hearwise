import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { formalPlan } from '../scripts/lib/formal-protocol-evidence.mjs';
import { normalizeProcessTrace } from '../scripts/lib/process-crash-replay.mjs';
import { processModelRoot, processModelFiles, processMetadata, processTraceConfig, processCoverage, processMutationViolation,
  projectProcessObservation, validateProcessReplayEvidence, validateProcessWitnessCoverage, validateProcessEvidence } from '../scripts/lib/process-crash-evidence.mjs';

// These intentionally small synthetic SQL/process records exercise the gate.
// They are NOT checker output, a real killed process, or release evidence.
const testOnly = 'TEST ONLY: synthetic process-crash evidence gate fixture';
const stamp = '2026-10-01T00:00:00.000Z';
const clone = value => structuredClone(value), json = value => JSON.stringify(value, null, 2) + '\n';
const execution = { code: 0, signal: null, timedOut: false, interrupted: false };
const encode = value => typeof value === 'number' ? { '#bigint': String(value) } : Array.isArray(value) ? { '#set': value.map(encode) } :
  value && typeof value === 'object' ? { '#map': Object.entries(value).map(([key, entry]) => [encode(Number(key)), encode(entry)]) } : value;
function toITF(trace, mutation) {
  const states = [trace.initial, ...trace.steps.map(step => step.expected)].map((expected, i) => {
    const state = { ...clone(expected), lastAction: i ? trace.steps[i - 1].action : 'init', actor: i ? trace.steps[i - 1].actor : -1,
      response: i ? trace.steps[i - 1].response : '' };
    if (trace.config.protocol === 'relation') { state.mode = trace.config.mode; state.reserved_ever = clone(state.counts); }
    else { state.initial_ever = clone(state.initial_requests); state.repair_ever = clone(state.repair_reserved); state.protocol_ever = state.protocol_retries;
      state.accepted_ever = clone(state.accepted); state.apply_counts = Object.fromEntries(Object.entries(state.accepted).map(([key, slots]) => [key, slots.length])); }
    return state;
  });
  const final = states.at(-1);
  if (mutation === 'mutant_relation_reset_on_recovery') final.counts[0] = 0;
  if (mutation === 'mutant_knowledge_reset_on_recovery') final.initial_requests[0] = 0;
  if (mutation === 'mutant_knowledge_reapply_committed') final.apply_counts[0]++;
  const vars = Object.keys(states[0]);
  return { '#meta': { description: testOnly }, vars: vars.map(field => `fixture::${field}`),
    states: states.map(state => Object.fromEntries(vars.map(field => [`fixture::${field}`, encode(state[field])])) ) };
}
function synthetic(config, { boundary = 'reserved', repair = false, noCrash = false, global = '' } = {}) {
  config = { ...config, ...(config.protocol === 'relation' ? { mode: 'valid' } : {}) };
  const raw = { fixturePurpose: testOnly, processState: 'up', generation: 0, crashes: 0, pid: 101, clock: 10000, schedulerReadyAt: 0,
    evidenceIdentity: { databasePath: '/TEST-ONLY/store.sqlite', ledgerPath: '/TEST-ONLY/provider.ndjson', providerPid: 999, providerUrl: 'http://127.0.0.1:19000' },
    launches: [{ generation: 0, pid: 101, startedAt: stamp }], exits: [], history: [], ledger: [], boundary: null };
  if (config.protocol === 'relation') {
    raw.tasks = Array.from({ length: config.actors }, (_, actor) => ({ actor, phase: 'idle', outcome: 'none', reply: 'none' }));
    raw.durable = { actors: raw.tasks.map(({ actor }) => ({ actor, session: actor === 1 ? 1 : 0, windowId: `window-${actor}`, listeningId: `session-${actor === 1 ? 1 : 0}`,
      nodes: [`atlas-${actor}`, `nova-${actor}`], names: [`Atlas ${actor}`, `Nova ${actor}`], knowledge: [{ id: `seed-${actor}`, canonical_name: `Atlas ${actor}` }],
      jobs: [], journal: [], budget: 0, window: { id: `window-${actor}`, state: 'pending' }, relations: [] })) };
  } else {
    raw.stage = 'idle'; raw.replies = Array(config.parts).fill('none');
    raw.durable = { checkpoint: { job: { id: 'job', listening_id: 'session', state: 'pending', outcome: null, retry_at: null },
      progress: { cycle: 1, extra_requests: 0, protocol_retries: 0 }, parts: Array.from({ length: config.parts }, (_, part_no) => ({ job_id: 'job', part_no,
        phase: 'extract_pending', initial_requests: 0, repair_reserved: 0, ready_at: 0, stats: {}, results: [], unresolved: [], focus_refs: [{ segment_id: `segment-${part_no}`, start: 0, end: 80 }] })) },
    knowledge: [{ id: 'baseline', canonical_name: 'Baseline seed', content_version: 1, facts: [], mentions: [] }] };
  }
  const trace = { schemaVersion: 1, specificationVersion: '1.0', protocol: 'process-crash', config, initial: null, steps: [] };
  const replay = { fixturePurpose: testOnly, startedAt: stamp, finishedAt: stamp, complete: true, ok: true, classification: 'matched', observations: [] };
  const sync = () => { if (config.protocol === 'knowledge') raw.durable.checkpoint.job.progress_json = JSON.stringify(raw.durable.checkpoint.progress); };
  const save = (action, actor = -1, response = '') => {
    sync(); const expected = projectProcessObservation(raw, config);
    if (action === 'init') trace.initial = clone(expected); else trace.steps.push({ action, actor, response, expected: clone(expected) });
    replay.observations.push({ step: trace.steps.length - 1, actual: clone(expected), durable: clone(raw), durableViolations: [] });
  };
  const act = (action, actor = 0, response = '') => {
    if (action === 'crash') {
      const before = clone(raw); delete before.history;
      const exit = { generation: raw.generation, pid: raw.pid, signal: 'SIGKILL', code: null, reason: 'crash', at: stamp };
      raw.exits.push(exit); raw.crashes++; raw.processState = 'down'; raw.boundary = null;
      for (const call of raw.ledger) call.closed = true;
      raw.history.push({ action, generation: raw.generation, pid: raw.pid, before, exit: clone(exit), after: clone(raw.durable) }); actor = -1;
    } else if (action === 'recover') {
      const before = clone(raw.durable); raw.processState = 'up'; raw.generation++; raw.pid++;
      raw.launches.push({ generation: raw.generation, pid: raw.pid, startedAt: stamp });
      if (config.protocol === 'relation') for (const row of raw.durable.actors) {
        const task = raw.tasks[row.actor]; task.reply = 'none';
        if (task.phase === 'committed') task.phase = 'done';
        else if (['reserved', 'inflight', 'received'].includes(task.phase)) { task.phase = 'idle'; row.jobs.at(-1).state = 'pending'; }
      } else {
        raw.stage = 'idle'; raw.replies.fill('none'); raw.schedulerReadyAt = 0; raw.durable.checkpoint.job.state = 'pending';
        for (const part of raw.durable.checkpoint.parts) {
          if (part.phase === 'extract_inflight') part.phase = 'extract_pending';
          if (part.phase === 'repair_inflight') { part.phase = 'done'; part.stats.repair_error = 'REPAIR_INTERRUPTED';
            part.unresolved.forEach(target => { target.issues = [{ code: 'REPAIR_INTERRUPTED' }]; }); }
        }
      }
      sync(); raw.history.push({ action, generation: raw.generation, pid: raw.pid, before, after: clone(raw.durable) }); actor = -1;
    } else if (action === 'advance_time') { raw.clock += 2000; actor = -1; }
    else if (action === 'send') {
      const kind = config.protocol === 'relation' ? 'relation' : raw.durable.checkpoint.parts[actor].phase === 'repair_inflight' ? 'repair' : 'extract';
      raw.ledger.push({ id: raw.ledger.length + 1, generation: raw.generation, actor, kind, receivedAt: stamp, response: null, closed: false });
      if (config.protocol === 'relation') raw.tasks[actor].phase = 'inflight'; else raw.stage = 'inflight';
    } else if (action === 'response') {
      raw.ledger.at(-1).response = response;
      if (config.protocol === 'relation') { raw.tasks[actor].phase = 'received'; raw.tasks[actor].reply = response; }
      else { raw.stage = 'received'; raw.replies[actor] = response; }
    } else if (config.protocol === 'relation') {
      const row = raw.durable.actors[actor], task = raw.tasks[actor];
      if (action === 'admit') {
        row.jobs.push({ id: `job-${actor}`, request_count: 1, state: 'running', ready_at: 0 }); row.budget++;
        row.journal.push({ job_id: `job-${actor}`, attempt: 1, started_at: raw.clock, outcome: null }); task.phase = 'reserved';
      } else if (action === 'commit') {
        task.phase = 'committed'; task.outcome = 'ok'; row.jobs.at(-1).state = 'complete'; row.window.state = 'complete'; row.journal.at(-1).outcome = 'complete';
        row.relations.push({ id: `relation-${actor}`, predicate: 'released', version: 1, subject_item_id: row.nodes[0], object_item_id: row.nodes[1],
          assertions: [{ id: `assertion-${actor}`, relation_id: `relation-${actor}`, version: 1, polarity: 'positive', modality: 'asserted',
            supports: [{ assertion_id: `assertion-${actor}`, window_id: row.windowId, job_id: `job-${actor}`, segment_id: `segment-${actor}`, quote: `Atlas ${actor} launched Nova ${actor}.` }] }] });
      } else if (action === 'notify') { task.phase = 'done'; raw.boundary = null; }
    } else {
      const cp = raw.durable.checkpoint, part = cp.parts[actor];
      if (action === 'admit') {
        if (part.phase === 'extract_pending') { part.initial_requests++; part.phase = 'extract_inflight'; }
        else { part.repair_reserved++; part.phase = 'repair_inflight'; }
        part.stats.request_count = part.initial_requests + part.repair_reserved; cp.progress.last_request_at = raw.clock;
        cp.job.state = 'running'; raw.stage = 'reserved'; raw.replies[actor] = 'none'; raw.schedulerReadyAt = raw.clock + 2000;
      } else if (action === 'commit') {
        const repairing = part.phase === 'repair_inflight', slots = repairing ? [1] : [0];
        for (const sourceIndex of slots) {
          const itemId = `item-${actor}-${sourceIndex}`, name = `${sourceIndex ? 'Nova' : 'Atlas'} ${actor}`, segment_id = part.focus_refs[0].segment_id;
          part.results.push({ itemId, sourceIndex });
          raw.durable.knowledge.push({ id: itemId, canonical_name: name, content_version: 1,
            facts: [{ item_id: itemId, content: `原文正在讨论${name}。`, surface_text: name, segment_id }], mentions: [{ item_id: itemId, surface_text: name, segment_id }] });
        }
        part.stats.initial_complete = true; part.phase = raw.replies[actor] === 'partial' ? 'repair_pending' : 'done';
        part.unresolved = part.phase === 'repair_pending' ? [{ sourceIndex: 1, anchor: { itemId: part.results[0].itemId } }] : [];
        cp.job.state = 'pending'; raw.stage = 'committed';
      } else if (action === 'notify') { raw.stage = 'idle'; raw.boundary = null; }
    }
    sync();
    if (action === 'commit') {
      raw.boundary = { name: 'committed', id: `commit-${raw.history.length}`, generation: raw.generation, pid: raw.pid,
        resultNotifications: 0, durable: clone(raw.durable) };
      raw.history.push({ action, boundaryId: raw.boundary.id });
    }
    save(action, actor, response);
  };
  save('init');
  if (repair) { act('admit'); act('send'); act('response', 0, 'partial'); act('commit'); act('notify'); act('advance_time'); }
  act('admit');
  if (boundary !== 'reserved' || global) act('send');
  if (['received', 'committed'].includes(boundary) || global === 'reserved-committed') act('response', 0, 'ok');
  if (global) { act('admit', 1); if (global === 'two-inflight') act('send', 1); }
  if (boundary === 'committed' || global === 'reserved-committed') act('commit');
  if (noCrash) act('notify'); else { act('crash'); act('recover'); }
  return { trace, replay };
}
function namedFixture(main, name) {
  const config = processTraceConfig(main);
  const boundary = /Committed/.test(name) ? 'committed' : /Received/.test(name) ? 'received' : /Sent|TwoInflight/.test(name) ? 'inflight' : 'reserved';
  return synthetic(config, { boundary: name === 'relationNoCrashSuccessTest' ? 'committed' : boundary,
    noCrash: name === 'relationNoCrashSuccessTest', repair: /knowledgeRepair/.test(name),
    global: /GlobalTwoInflight/.test(name) ? 'two-inflight' : /GlobalReservedAndCommitted/.test(name) ? 'reserved-committed' : '' });
}
function negativeReplay(base) {
  const replay = clone(base.replay), trace = base.trace;
  Object.assign(replay, { ok: false, classification: 'implementation_mismatch' });
  const observation = replay.observations.at(-1), raw = observation.durable, row = raw.durable.actors[0];
  row.budget = 0; row.journal = []; row.jobs[0].request_count = 0; raw.history.at(-1).after = clone(raw.durable);
  observation.actual.counts[0] = 0;
  replay.difference = { step: 2, expected: clone(trace.steps[2].expected), actual: clone(observation.actual), durableViolations: [] };
  replay.counterexample = { ...clone(trace), steps: clone(trace.steps.slice(0, 3)), minimality: 'first-divergence-prefix' };
  return replay;
}
async function fixture(t, profile = 'fast') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-TEST-ONLY-process-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(path.join(processModelRoot, 'config.json'), 'utf8'));
  const pinned = JSON.parse(await readFile(path.join(processModelRoot, 'toolchain.json'), 'utf8'));
  const witnessSource = await readFile(path.join(processModelRoot, 'witnesses.qnt'), 'utf8');
  const names = Object.fromEntries([...witnessSource.matchAll(/module (\w+) \{([\s\S]*?)(?=\nmodule |$)/g)]
    .map(([, main, body]) => [main, [...body.matchAll(/\brun (\w+)\s*=/g)].map(([, name]) => name)]));
  const report = { ...await processMetadata(), fixturePurpose: testOnly, profile, startedAt: stamp, finishedAt: stamp,
    complete: true, ok: true, execution: { ...execution, complete: true }, domain: config, propertyCoverage: processCoverage(config),
    tools: { quint: pinned.quint.version, apalache: pinned.apalache.version, tlc: pinned.apalache.bundledTlcVersion,
      apalacheJarSha256: pinned.apalache.jarSha256, apalacheArchiveSha256: pinned.apalache.archiveSha256,
      java: `openjdk version "${pinned.java.minimumMajor}.0.0" TEST ONLY`, node: process.version, sqlite: 'TEST ONLY' }, results: [], artifacts: [] };
  const files = new Map(), replays = new Map(), row = id => report.results.find(row => row.id === id);
  const put = async (file, text) => {
    files.set(file, text); await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await writeFile(path.join(directory, file), text);
    const artifact = report.artifacts.find(row => row.path === file);
    if (artifact) artifact.sha256 = digest(text); else report.artifacts.push({ path: file, sha256: digest(text) });
  };
  for (const entry of formalPlan(config)) {
    const result = { ...entry, startedAt: stamp, finishedAt: stamp, complete: true, status: 'passed', log: `${entry.id}.log` };
    report.results.push(result);
    if (['implementation-replay', 'implementation-negative'].includes(entry.kind)) continue;
    result.execution = { ...execution, code: entry.kind === 'model-negative' ? 1 : 0 };
    let log = testOnly + '\n';
    if (entry.kind === 'finite-state-complete') log += 'Model checking completed. No error has been found.\n10 states generated, 8 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 6.\n';
    if (entry.kind === 'bounded-model-check') log += `Step ${config.profiles[profile].apalacheDepth[entry.id.slice('bounded-'.length)]}: transition\nThe outcome is: NoError\n[ok] No violation found\n`;
    if (entry.kind === 'simulation') log += '[ok] No violation found\n';
    if (entry.kind === 'model-negative') log += 'error: found a counterexample\n';
    if (entry.kind === 'implementation-regression') log += 'TAP version 13\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.0\n';
    await put(result.log, log);
    if (!['model-witness', 'simulation', 'model-negative'].includes(entry.kind)) continue;
    const main = entry.id.replace(/^(witnesses|simulation|negative)-/, '');
    const tests = entry.kind === 'model-witness' ? names[main] : entry.kind === 'simulation' ? Array.from({ length: config.simulation.selectedTraces }, (_, i) => String(i)) : ['negative'];
    result.traces = [];
    for (const name of tests) {
      const file = `${entry.kind}/${main}-${name}-0.itf.json`;
      const base = main === 'mutant_knowledge_reapply_committed' ? synthetic(processTraceConfig(main), { boundary: 'committed' }) : namedFixture(main, name);
      const itf = toITF(base.trace, entry.kind === 'model-negative' ? main : null), raw = json(itf);
      const trace = normalizeProcessTrace(itf, processTraceConfig(main));
      await put(file, raw); result.traces.push(file);
      const replay = { ...base.replay, sourceTrace: file, sourceTraceSha256: digest(raw), semanticTraceSha256: digest(JSON.stringify(trace)), steps: trace.steps.length };
      replays.set(file, replay);
    }
  }
  for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) {
    const result = row(id), negative = id === 'negative-replay';
    const sources = report.results.filter(row => row.kind === (id === 'replay-simulation' ? 'simulation' : 'model-witness')).flatMap(row => row.traces).filter(file => !negative || file.includes('normalSuccessTest-'));
    const values = sources.map(file => {
      const replay = clone(replays.get(file));
      if (!negative) return replay;
      const trace = normalizeProcessTrace(JSON.parse(files.get(file)), processTraceConfig(file));
      return { ...replay, ...negativeReplay({ trace, replay }) };
    });
    result.data = `${id}.json`; result.traces = sources;
    await put(result.data, json(values)); await put(result.log, json({ fixturePurpose: testOnly, samples: values.length }));
  }
  const save = () => writeFile(path.join(directory, 'report.json'), json(report));
  const check = async options => { await save(); return validateProcessEvidence(directory, options); };
  await save(); return { directory, report, files, row, put, check };
}
const rejected = result => assert.equal(result.ok, false, 'Tampered synthetic evidence must fail closed');

test('process gate metadata binds all nine inputs, five domains and HW-04-10..13', async () => {
  assert.equal(processModelFiles.length, 9);
  const metadata = await processMetadata(); assert.equal(metadata.environment.node, process.version); assert.match(metadata.modelDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(processTraceConfig('relation_multi_cap2_witnesses'), { protocol: 'relation', actors: 3, capacity: 2 });
  assert.deepEqual(processTraceConfig('knowledge_two_parts'), { protocol: 'knowledge', parts: 2 });
  assert.throws(() => processTraceConfig('single'), /Unknown/);
  const config = JSON.parse(await readFile(path.join(processModelRoot, 'config.json'), 'utf8'));
  assert.deepEqual(processCoverage(config).map(row => row.id), ['HW-04-10', 'HW-04-11', 'HW-04-12', 'HW-04-13']);
});
test('synthetic complete process gate includes 28 exits, all four boundaries and repair/global matrices', async t => {
  for (const profile of ['fast', 'deep']) await t.test(profile, async sub => {
    const f = await fixture(sub, profile), result = await f.check({ requireProfile: profile });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.processCoverage.crashes, 28); assert.equal(result.processCoverage.recoveries, 28);
    assert.deepEqual(result.processCoverage.repair, ['committed', 'inflight', 'received', 'reserved']);
  });
});
test('three model mutants require a concrete recovery loss or extra sourceIndex application', () => {
  for (const main of ['mutant_relation_reset_on_recovery', 'mutant_knowledge_reset_on_recovery', 'mutant_knowledge_reapply_committed']) {
    const base = synthetic(processTraceConfig(main), { boundary: main.includes('reapply') ? 'committed' : 'reserved' });
    assert.equal(processMutationViolation(main, toITF(base.trace, main)).ok, true);
    assert.equal(processMutationViolation(main, toITF(base.trace)).ok, false);
  }
  const twoAccepted = synthetic({ protocol: 'knowledge', parts: 1 }, { repair: true, boundary: 'committed' });
  assert.equal(processMutationViolation('mutant_knowledge_reapply_committed', toITF(twoAccepted.trace)).ok, false, 'Two distinct accepted sourceIndex slots are not duplicate application');
});
test('implementation reset control is a raw recovery mismatch at step 2 with the shortest three-action prefix', () => {
  const base = synthetic({ protocol: 'relation', actors: 1, capacity: 1 });
  const replay = negativeReplay(base);
  assert.equal(validateProcessReplayEvidence(base.trace, replay, { negative: true }).ok, true);
  replay.classification = 'unreplayable'; rejected(validateProcessReplayEvidence(base.trace, replay, { negative: true }));
  replay.classification = 'model_violation'; rejected(validateProcessReplayEvidence(base.trace, replay, { negative: true }));
});

test('independent raw audit rejects process, exit, ledger and content tampering despite cached matches', async t => {
  const cases = [
    ['graceful exit', 'relation', r => { r.observations.at(-1).durable.exits[0].signal = 'SIGTERM'; }],
    ['forged successful exit code', 'relation', r => { r.observations.at(-1).durable.exits[0].code = 0; }],
    ['missing exit', 'relation', r => { r.observations.at(-1).durable.exits = []; }],
    ['same pid', 'relation', r => { r.observations.at(-1).durable.pid = 101; r.observations.at(-1).durable.launches[1].pid = 101; }],
    ['launch before confirmed exit', 'relation', r => { r.observations.at(-1).durable.launches[1].startedAt = '2026-09-30T00:00:00.000Z'; }],
    ['swapped database', 'relation', r => { r.observations.at(-1).durable.evidenceIdentity.databasePath = '/other.sqlite'; }],
    ['swapped provider', 'relation', r => { r.observations.at(-1).durable.evidenceIdentity.providerPid++; }],
    ['missing raw process state', 'relation', r => { delete r.observations.at(-1).durable.processState; }],
    ['ledger reset', 'relation', r => { r.observations.at(-1).durable.ledger = []; }],
    ['budget reset', 'relation', r => { r.observations.at(-1).durable.durable.actors[0].jobs[0].request_count = 0; }],
    ['missing crash history', 'relation', r => { r.observations.at(-1).durable.history = []; }],
    ['after-notification commit', 'relation', r => { r.observations.find(o => o.durable.boundary).durable.boundary.resultNotifications = 1; }],
    ['lost relation graph support', 'relation', r => { for (const o of r.observations) for (const relation of o.durable.durable.actors[0].relations) relation.assertions[0].supports = []; }],
    ['accepted fact removed', 'knowledge', r => { for (const o of r.observations) for (const item of o.durable.durable.knowledge.filter(v => v.id !== 'baseline')) item.facts = []; }],
    ['accepted source mention removed', 'knowledge', r => { for (const o of r.observations) for (const item of o.durable.durable.knowledge.filter(v => v.id !== 'baseline')) item.mentions = []; }],
    ['accepted reapplied', 'knowledge', r => { r.observations.at(-1).durable.durable.knowledge[1].content_version = 2; }],
    ['lost checkpoint result', 'knowledge', r => { r.observations.at(-1).durable.durable.checkpoint.parts[0].results = []; }],
    ['initial request reset', 'knowledge', r => { r.observations.at(-1).durable.durable.checkpoint.parts[0].initial_requests = 0; }],
    ['cached ok on incomplete process', 'knowledge', r => { r.complete = false; }]
  ];
  for (const [name, protocol, mutate] of cases) await t.test(name, () => {
    const base = synthetic(protocol === 'relation' ? { protocol, actors: 1, capacity: 1 } : { protocol, parts: 1 }, { boundary: 'committed' });
    assert.equal(validateProcessReplayEvidence(base.trace, base.replay).ok, true);
    mutate(base.replay); rejected(validateProcessReplayEvidence(base.trace, base.replay));
  });
});
test('notify_fail requires evidence that the actual callback threw', () => {
  for (const protocol of ['relation', 'knowledge']) {
    const base = synthetic(protocol === 'relation' ? { protocol, actors: 1, capacity: 1 } : { protocol, parts: 1 }, { boundary: 'committed', noCrash: true });
    base.trace.steps.at(-1).action = 'notify_fail';
    const raw = base.replay.observations.at(-1).durable;
    const target = protocol === 'relation' ? raw.tasks[0] : raw;
    target.notificationFailures = 1;
    assert.equal(validateProcessReplayEvidence(base.trace, base.replay).ok, true);
    target.notificationFailures = 0;
    assert.ok(validateProcessReplayEvidence(base.trace, base.replay).reasons.some(reason => reason.endsWith('notification_failure_not_injected')));
  }
});
test('repair recovery must retain the real REPAIR_INTERRUPTED diagnostic', () => {
  const base = synthetic({ protocol: 'knowledge', parts: 1 }, { repair: true, boundary: 'received' });
  assert.equal(validateProcessReplayEvidence(base.trace, base.replay).ok, true);
  delete base.replay.observations.at(-1).durable.durable.checkpoint.parts[0].stats.repair_error;
  rejected(validateProcessReplayEvidence(base.trace, base.replay));
});
test('missing fixed crashes or a repair boundary cannot pass from aggregate cached counts', async t => {
  const f = await fixture(t), rows = JSON.parse(f.files.get(f.row('replay-witnesses').data));
  const entries = rows.map(replay => ({ replay, sourceTrace: replay.sourceTrace,
    trace: normalizeProcessTrace(JSON.parse(f.files.get(replay.sourceTrace)), processTraceConfig(replay.sourceTrace)) }));
  assert.equal(validateProcessWitnessCoverage(entries).ok, true);
  rejected(validateProcessWitnessCoverage(entries.slice(1)));
  const repairCommit = entries.find(entry => entry.sourceTrace.includes('knowledgeRepairCommittedCrashTest'));
  const replacement = synthetic({ protocol: 'knowledge', parts: 1 }, { repair: true, boundary: 'reserved' });
  Object.assign(repairCommit, replacement);
  assert.ok(validateProcessWitnessCoverage(entries).reasons.includes('missing_repair_boundary_matrix'));
});
test('full formal gate rejects rehashed raw evidence changes without trusting cached actual or ok', async t => {
  for (const [name, mutate] of [
    ['raw budget', r => { r.observations.at(-1).durable.durable.actors[0].jobs[0].request_count = 0; }],
    ['fake crash exit', r => { r.observations.at(-1).durable.exits[0].signal = null; }],
    ['no exit', r => { r.observations.at(-1).durable.exits = []; }],
    ['new database', r => { r.observations.at(-1).durable.evidenceIdentity.databasePath = '/replacement.sqlite'; }]
  ]) await t.test(name, async sub => {
    const f = await fixture(sub), data = f.row('replay-witnesses').data, replays = JSON.parse(f.files.get(data));
    mutate(replays.find(row => row.sourceTrace.includes('normalSuccessTest-')));
    await f.put(data, json(replays)); const result = await f.check(); rejected(result);
    assert.ok(result.rows.find(row => row.id === 'replay-witnesses').reasons.some(reason => reason.startsWith('process:')));
  });
});
test('formal process gate retains common source, toolchain, completion and domain checks', async t => {
  for (const [name, mutate] of [
    ['stale source', f => { f.report.source.sha = '0'.repeat(40); }],
    ['stale model', f => { f.report.modelDigest = '0'.repeat(64); }],
    ['missing node metadata', f => { delete f.report.environment.node; }],
    ['missing bounded row', f => { f.report.results = f.report.results.filter(row => row.id !== 'bounded-knowledge_two_parts'); }],
    ['interrupted', f => { f.report.execution.interrupted = true; }],
    ['changed domain', f => { f.report.domain.maxCrashes = 2; }],
    ['missing property', f => { f.report.propertyCoverage.pop(); }],
    ['relabeled deep', f => { f.report.profile = 'deep'; }]
  ]) await t.test(name, async sub => { const f = await fixture(sub); mutate(f); rejected(await f.check()); });
});
