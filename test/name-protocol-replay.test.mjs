import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { once } from 'node:events';
import { nameWitnesses, nameLifecycleTests } from '../scripts/lib/name-protocol-evidence.mjs';
import { nameDeadlineAt, nameRemainingMs } from '../scripts/lib/name-protocol-budget.mjs';
import { deadline, closeServer } from '../test-support/lifecycle.mjs';
const fileDeadline = nameDeadlineAt(80000);
process.env.HEARWISE_NAME_DEADLINE_AT = String(fileDeadline);
import { runProcess } from '../scripts/lib/process.mjs';
import { normalizeNameTrace, validateNameTrace, replayNameTrace, expectedNameMutationViolation } from '../scripts/lib/name-protocol-replay.mjs';
import { inspectMatchedNameDurable, validMatchedNameDurable, inspectNameBusinessTables, inspectNameNegativeDurable } from '../scripts/lib/name-protocol-durable.mjs';
import { createNameProtocolAdapter } from '../test-support/name-protocol-adapter.mjs';

let directory;
const traces = new Map();
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'name-quint-witnesses-'));
  const root = fileURLToPath(new URL('..', import.meta.url)), env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  for (const main of ['independent_witnesses', 'reuse_witnesses']) {
    const run = await runProcess(process.execPath, [path.join(root, 'node_modules/@informalsystems/quint/dist/src/cli.js'), 'test',
      path.join(root, 'verification/name-protocol/witnesses.qnt'), '--main', main, '--backend', 'typescript', '--seed', '71', '--max-samples', '1',
      '--out-itf', path.join(directory, `${main}-{test}-{seq}.itf.json`)], { cwd: directory, env, timeoutMs: nameRemainingMs(fileDeadline, 20000, 5000), logFile: path.join(directory, `${main}.log`) });
    assert.equal(run.ok, true, run.tail);
  }
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.itf.json')).sort()) {
    const itf = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    const name = file.match(/witnesses-(.+)-\d+\.itf\.json$/)[1], config = { mode: file.startsWith('independent') ? 'independent' : 'reuse' };
    traces.set(name, { itf, config, trace: normalizeNameTrace(itf, config) });
  }
  assert.equal(traces.size, 22, 'All frozen genuine Quint witnesses must be emitted');
}, { timeout: 45000 });
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const testDeadline = () => Math.min(fileDeadline, Date.now() + 25000);
const replay = name => replayNameTrace(traces.get(name).trace, createNameProtocolAdapter, { deadlineAt: testDeadline() });
for (const name of Object.values(nameWitnesses).flat()) test(`actual Quint witness: ${name}`, { timeout: 30000 }, async () => {
  const { trace, config } = traces.get(name);
  const result = await replayNameTrace(trace, createNameProtocolAdapter, { timeoutMs: 25000, deadlineAt: fileDeadline });
  assert.equal(result.ok, true, JSON.stringify({ classification: result.classification, error: result.error, difference: result.difference,
    raw: result.observations.length ? inspectMatchedNameDurable(result.observations.at(-1), config) : null }));
  assert.equal(result.complete, true); assert.equal(result.cleanupComplete, true);
  assert.equal(result.observations.length, trace.steps.length + 1); assert.equal(result.classification, 'matched');
});

test('real source-copy negatives break fingerprint, atomic receipt, revision and active-anchor contracts', { timeout: 30000 }, async t => {
  const deadlineAt = testDeadline();
  for (const [name, mutation] of [['rawFingerprintConflictTest', 'bypass_fingerprint'], ['receiptRollbackTest', 'non_atomic_receipt'],
    ['revisionRecheckTest', 'bypass_revision'], ['anchorRecheckTest', 'bypass_anchor']]) await t.test(mutation, async () => {
    const { trace } = traces.get(name), result = await replayNameTrace(trace, config => createNameProtocolAdapter({ ...config, mutation }), { deadlineAt });
    assert.equal(result.classification, 'implementation_mismatch'); assert.equal(result.complete, true); assert.equal(result.ok, false);
    assert.equal(result.difference.durableValid, false, 'Independent durable gate must detect the real broken contract');
    assert.equal(result.counterexample.minimality, 'first-divergence-prefix');
    const raw = result.observations.at(-1).durable;
    assert.notEqual(raw.mutation.sourceDigest, raw.mutation.mutatedDigest);
    const checked = inspectNameNegativeDurable(result.observations.at(-1), trace.config, result.observations.at(-2), mutation);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    for (const change of [value => { value.durable.tables.knowledge_facts[0].content = 'forged'; },
      value => { value.durable.events.at(-1).response.status = 418; }, value => { value.actual.phase[0] = 'unknown'; },
      value => { value.durable.tables.knowledge_edit_jobs[0].fingerprint = 'f'.repeat(64); }]) {
      const changed = structuredClone(result.observations.at(-1)); change(changed);
      assert.equal(inspectNameNegativeDurable(changed, trace.config, result.observations.at(-2), mutation).ok, false);
    }
    if (mutation === 'non_atomic_receipt') {
      assert.equal(result.counterexample.steps.at(-1).action, 'transaction');
      assert.equal(result.counterexample.steps.at(-1).argument, 'receipt_fail');
      assert.equal(raw.snapshot.item.canonical_name, 'Tibo', 'Changed-name writes persist in deliberately broken source copy');
      assert.equal(raw.tables.knowledge_edit_jobs[0].state, 'running');
      assert.notDeepEqual(raw.events.at(-1).before, raw.events.at(-1).after);
      // This is the actual split transaction, not the abstract mutant's
      // single sourceVersion increment or a claim those states are identical.
    }
  });
});

test('independent gate rejects raw-table/HTTP corruption despite unchanged projections and empty cached violations', { timeout: 30000 }, async () => {
  const result = await replay('successTest'); assert.equal(result.ok, true);
  const original = result.observations.at(-1), config = traces.get('successTest').config;
  const cases = [
    ['missing table', raw => { delete raw.tables.extraction_parts; }],
    ['deleted original stale', raw => { raw.tables.relation_supports = raw.tables.relation_supports.filter(row => row.id !== raw.identities.staleId); }],
    ['reactivated original stale', raw => { raw.tables.relation_supports.find(row => row.id === raw.identities.staleId).state = 'active'; }],
    ['changed other listening', raw => { raw.tables.listenings.find(row => row.id === raw.identities.unrelatedId).notes = 'wrong'; }],
    ['changed other descendant', raw => { raw.tables.knowledge_facts.find(row => row.id !== raw.identities.factId).content = 'wrong'; }],
    ['changed unlinked source', raw => { raw.tables.segments.find(row => row.id === raw.identities.unlinkedId).original_text = 'wrong'; }],
    ['changed item identity', raw => { raw.tables.knowledge_items.find(row => row.id === raw.identities.itemId).id = raw.identities.cameraId; }],
    ['changed relation endpoint', raw => { raw.tables.relations.find(row => row.listening_id === raw.identities.listeningId).object_item_id = raw.identities.itemId; }],
    ['changed source', raw => { raw.tables.segments.find(row => row.id === raw.identities.segmentId).original_text += '!'; }],
    ...['source_revision', 'start', 'end', 'quote', 'state', 'segment_id'].map(field => [`changed support ${field}`, raw => {
      const support = raw.tables.relation_supports.find(row => row.segment_id === raw.identities.segmentId && row.state === 'active');
      support[field] = typeof support[field] === 'number' ? support[field] + 1 : 'wrong';
    }]),
    ...['fingerprint', 'revision', 'name', 'source', 'state', 'operation', 'result_json', 'item_id'].map(field => [`changed receipt ${field}`, raw => { raw.tables.knowledge_edit_jobs[0][field] = 'wrong'; }]),
    ['changed name revision', raw => { raw.tables.knowledge_revisions[0].old_value = 'wrong'; }],
    ['missing transaction', raw => { raw.events = raw.events.filter(event => event.action !== 'transaction'); }],
    ['false HTTP receipt', raw => { const response = raw.attempts[0].actualResponse, body = JSON.parse(response.text); body.job.saved = false; response.text = JSON.stringify(body); }],
    ['changed request raw bytes', raw => { raw.attempts[0].actualRequest.name = ' Tibo '; }],
    ['changed receipt owner', raw => { raw.operations[0].receiptOwner = 1; }],
    ['wrong source ordinal', raw => { raw.versions[0] = 'f'.repeat(64); }],
    ['unexpected provider request', raw => { raw.providerCalls = 1; }],
    ['changed atomic history', raw => { raw.events.find(event => event.action === 'transaction').after.knowledge_facts[0].content = 'wrong'; }]
  ];
  for (const [label, mutate] of cases) {
    const observation = structuredClone(original); observation.durableViolations = []; mutate(observation.durable);
    assert.equal(validMatchedNameDurable(observation, config), false, label);
  }
  for (const input of [undefined, null, {}, { actual: {}, durable: {} }]) assert.equal(validMatchedNameDurable(input, config), false);
});

test('raw business gate is usable by browser consumers and independently detects protected-row changes', { timeout: 30000 }, async () => {
  const result = await replay('lateResponseTest'); assert.equal(result.ok, true);
  const raw = result.observations.at(-1).durable, input = { baseline: raw.baseline, tables: raw.tables, identities: raw.identities };
  const verified = inspectNameBusinessTables(input);
  assert.equal(verified.ok, true, JSON.stringify(verified.violations)); assert.equal(verified.projection.name, 'Mira');
  for (const mutate of [value => { value.tables.relation_supports.find(row => row.id === value.identities.staleId).state = 'active'; },
    value => { value.tables.relations.find(row => row.listening_id === value.identities.listeningId).object_item_id = value.identities.itemId; },
    value => { value.tables.knowledge_facts.find(row => row.id !== value.identities.factId).content = 'wrong'; },
    value => { value.tables.knowledge_facts.find(row => row.id === value.identities.factId).content = 'wrong'; }]) {
    const changed = structuredClone(input); mutate(changed); assert.equal(inspectNameBusinessTables(changed).ok, false);
  }
});

test('real successful projection cannot pass replay with fabricated or missing durable observations', { timeout: 30000 }, async () => {
  const { trace } = traces.get('successTest');
  const result = await replayNameTrace(trace, async config => {
    const adapter = await createNameProtocolAdapter(config);
    return { ...adapter, check: () => [], observe: () => ({ ...adapter.observe(), tables: {} }) };
  }, { deadlineAt: testDeadline() });
  assert.equal(result.complete, true); assert.equal(result.classification, 'implementation_mismatch'); assert.equal(result.difference.step, -1);
  assert.equal(result.difference.durableValid, false);
});

test('name ITF normalization rejects missing variables, unsafe map keys, extra fields and unsupported actions', () => {
  const { itf, trace, config } = traces.get('successTest'); assert.equal(validateNameTrace(trace), true);
  const variable = suffix => itf.vars.find(value => value.endsWith(`::${suffix}`));
  for (const mutate of [value => value.vars.push('ambiguous::state'), value => { delete value.states[0][variable('actor')]; },
    value => { value.states[1][variable('actor')] = { '#bigint': '9007199254740993' }; },
    value => { value.states[1][variable('state')].requests['#map'].push([{ '#bigint': '0' }, { '#bigint': '1' }]); },
    value => { value.states[1][variable('state')].extra = 1; }, value => { value.states[1][variable('lastAction')] = 'fake_await_in_sql'; },
    value => { value.states[1][variable('argument')] = 'unsupported'; }, value => { value.states[0][variable('state')].name = { '#bigint': '2' }; }]) {
    const changed = structuredClone(itf); mutate(changed); assert.throws(() => normalizeNameTrace(changed, config));
  }
  assert.throws(() => normalizeNameTrace(itf, { mode: 'unknown' }));
  assert.equal(expectedNameMutationViolation('mutant_fingerprint', itf, config).ok, false, 'A normal witness is not a negative witness');
});

test('driver separates unavailable, timeout and cleanup failure from implementation mismatch', { timeout: 30000 }, async () => {
  const { trace } = traces.get('successTest');
  const deadlineAt = testDeadline();
  for (const action of ['throw', 'timeout', 'cleanup']) {
    const result = await replayNameTrace(trace, async config => {
      const adapter = await createNameProtocolAdapter(config);
      return { ...adapter, ...(action === 'throw' ? { act: () => { throw new Error('Unavailable real action'); } } :
        action === 'timeout' ? { act: () => new Promise(() => {}) } : { close: async () => { await adapter.close(); throw new Error('Unverified cleanup'); } }) };
    }, { stepTimeoutMs: action === 'timeout' ? 500 : 5000, deadlineAt });
    assert.equal(result.complete, false); assert.equal(result.ok, false); assert.equal(result.classification, 'driver_cannot_replay');
    if (action === 'timeout') assert.match(result.error.message, /name action 0/);
    if (action === 'cleanup') assert.equal(result.cleanupError, 'Unverified cleanup');
  }
});

test('raw client evidence rejects contradicted delivery, preparation and event chronology', { timeout: 30000 }, async () => {
  const result = await replay('successTest'); assert.equal(result.ok, true);
  const delivered = result.observations.find(value => value.durable.events.at(-1)?.action === 'deliver');
  const previous = result.observations[result.observations.indexOf(delivered) - 1], config = traces.get('successTest').config;
  for (const change of [
    value => { for (const field of ['phase', 'reply']) { value.actual[field][0] = 'unknown'; value.durable.attempts[0][field] = 'unknown'; } },
    value => { value.durable.events.at(-1).action = 'lose_response'; value.durable.events.at(-1).argument = 'lost'; },
    value => { value.actual.submittedName[0] = 2; value.durable.attempts[0].submittedName = 2; },
    value => { value.durable.events.at(-1).startedAtMs = -10; value.durable.events.at(-1).finishedAtMs = -20; },
    value => { value.durable.events.at(-1).client.result.job.saved = false; }
  ]) {
    const changed = structuredClone(delivered); change(changed);
    assert.equal(inspectMatchedNameDurable(changed, config, previous).ok, false);
  }
});


const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test(nameLifecycleTests[0], { timeout: 30000 }, async t => {
  const { trace } = traces.get('successTest'), adapter = await createNameProtocolAdapter(trace.config); t.after(() => adapter.close());
  let closed = false;
  const result = await replayNameTrace(trace, async () => { await sleep(600); return { ...adapter,
    act: () => new Promise(() => {}), close: async () => { await adapter.close(); closed = true; } }; },
  { startupTimeoutMs: 2000, stepTimeoutMs: 100, cleanupTimeoutMs: 1000, timeoutMs: 5000, deadlineAt: fileDeadline });
  assert.match(result.error.message, /name action 0/); assert.equal(result.cleanupComplete, true); assert.equal(closed, true);
  assert.throws(() => adapter.observe(), /closed|not open/i);
});
async function lateServer(t) {
  const server = http.createServer((_, response) => response.end('actual resource'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => closeServer(server, 'late test server fallback'));
  assert.equal(await fetch(url).then(response => response.text()), 'actual resource');
  return { server, url };
}
test(nameLifecycleTests[1], { timeout: 5000 }, async t => {
  const { server, url } = await lateServer(t), { trace } = traces.get('successTest');
  const result = await replayNameTrace(trace, async () => { await sleep(80); return { close: () => closeServer(server, 'late owned server') }; },
    { startupTimeoutMs: 20, stepTimeoutMs: 1000, cleanupTimeoutMs: 500, timeoutMs: 1500, deadlineAt: fileDeadline });
  assert.match(result.error.message, /name adapter startup/); assert.equal(result.complete, false); assert.equal(result.cleanupComplete, true);
  assert.equal(server.listening, false); await assert.rejects(fetch(url));
});
test(nameLifecycleTests[2], { timeout: 5000 }, async t => {
  const { server, url } = await lateServer(t), { trace } = traces.get('successTest');
  let release, closed; const gate = new Promise(resolve => { release = resolve; }), cleanup = new Promise(resolve => { closed = resolve; });
  t.after(() => release());
  const result = await replayNameTrace(trace, async () => { await gate; return { close: async () => { await closeServer(server, 'overdue owned server'); closed(); } }; },
    { startupTimeoutMs: 10, stepTimeoutMs: 10, cleanupTimeoutMs: 50, timeoutMs: 100, deadlineAt: fileDeadline });
  assert.equal(result.complete, false); assert.equal(result.cleanupComplete, false); assert.match(result.cleanupError, /late adapter acquisition|deadline/);
  assert.equal(server.listening, true); release(); await deadline(() => cleanup, 1000, 'late cleanup really completed');
  assert.equal(server.listening, false); await assert.rejects(fetch(url));
  assert.equal(result.cleanupComplete, false, 'A returned incomplete cleanup claim is never retroactively upgraded');
});
test(nameLifecycleTests[3], { timeout: 5000 }, async t => {
  const { trace } = traces.get('successTest'), adapter = await createNameProtocolAdapter(trace.config); t.after(() => adapter.close());
  let actions = 0, closed = false; const started = Date.now();
  const result = await replayNameTrace(trace, async () => ({ ...adapter, act: async step => { actions++; await sleep(60); return adapter.act(step); },
    close: async () => { await adapter.close(); closed = true; } }),
  { startupTimeoutMs: 100, stepTimeoutMs: 1000, cleanupTimeoutMs: 500, timeoutMs: 650, deadlineAt: fileDeadline });
  assert.equal(result.complete, false); assert.equal(result.classification, 'driver_cannot_replay');
  assert.ok(actions < trace.steps.length); assert.ok(Date.now() - started < 1200); assert.equal(closed, true); assert.equal(result.cleanupComplete, true);
});


test(nameLifecycleTests[4], { timeout: 5000 }, async t => {
  const { server, url } = await lateServer(t), { trace } = traces.get('successTest');
  let closeCalls = 0, closed; const cleanup = new Promise(resolve => { closed = resolve; });
  const result = await replayNameTrace(trace, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    return { close: async () => { closeCalls++; await closeServer(server, 'acquired overdue server'); closed(); } };
  }, { startupTimeoutMs: 30, stepTimeoutMs: 30, cleanupTimeoutMs: 20, timeoutMs: 70, deadlineAt: fileDeadline });
  assert.equal(result.complete, false); assert.equal(result.cleanupComplete, false);
  await deadline(() => cleanup, 1000, 'expired resource still closes');
  assert.equal(closeCalls, 1); assert.equal(server.listening, false); await assert.rejects(fetch(url));
});
