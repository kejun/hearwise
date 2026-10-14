import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../scripts/lib/process.mjs';
import { normalizeNameTrace, validateNameTrace, replayNameTrace, expectedNameMutationViolation } from '../scripts/lib/name-protocol-replay.mjs';
import { inspectMatchedNameDurable, validMatchedNameDurable, inspectNameBusinessTables } from '../scripts/lib/name-protocol-durable.mjs';
import { createNameProtocolAdapter } from '../test-support/name-protocol-adapter.mjs';

let directory;
const traces = new Map();
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'name-quint-witnesses-'));
  const root = fileURLToPath(new URL('..', import.meta.url)), env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  for (const main of ['independent_witnesses', 'reuse_witnesses']) {
    const run = await runProcess(process.execPath, [path.join(root, 'node_modules/@informalsystems/quint/dist/src/cli.js'), 'test',
      path.join(root, 'verification/name-protocol/witnesses.qnt'), '--main', main, '--backend', 'typescript', '--seed', '71', '--max-samples', '1',
      '--out-itf', path.join(directory, `${main}-{test}-{seq}.itf.json`)], { cwd: directory, env, timeoutMs: 20000, logFile: path.join(directory, `${main}.log`) });
    assert.equal(run.ok, true, run.tail);
  }
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.itf.json')).sort()) {
    const itf = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    const name = file.match(/witnesses-(.+)-\d+\.itf\.json$/)[1], config = { mode: file.startsWith('independent') ? 'independent' : 'reuse' };
    traces.set(name, { itf, config, trace: normalizeNameTrace(itf, config) });
  }
  assert.equal(traces.size, 22, 'All frozen genuine Quint witnesses must be emitted');
}, { timeout: 30000 });
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const replay = name => replayNameTrace(traces.get(name).trace, createNameProtocolAdapter);
test('all 22 genuine Quint witnesses replay every action through real HTTP and SQLite full-table checks', { timeout: 30000 }, async t => {
  for (const [name, { trace, config }] of traces) await t.test(name, async () => {
    const result = await replayNameTrace(trace, createNameProtocolAdapter);
    assert.equal(result.ok, true, JSON.stringify({ classification: result.classification, error: result.error, difference: result.difference,
      raw: result.observations.length ? inspectMatchedNameDurable(result.observations.at(-1), config) : null }));
    assert.equal(result.complete, true); assert.equal(result.observations.length, trace.steps.length + 1);
    assert.equal(result.classification, 'matched');
  });
});

test('real source-copy negatives break fingerprint, atomic receipt, revision and active-anchor contracts', { timeout: 15000 }, async t => {
  for (const [name, mutation] of [['rawFingerprintConflictTest', 'bypass_fingerprint'], ['receiptRollbackTest', 'non_atomic_receipt'],
    ['revisionRecheckTest', 'bypass_revision'], ['anchorRecheckTest', 'bypass_anchor']]) await t.test(mutation, async () => {
    const { trace } = traces.get(name), result = await replayNameTrace(trace, config => createNameProtocolAdapter({ ...config, mutation }));
    assert.equal(result.classification, 'implementation_mismatch'); assert.equal(result.complete, true); assert.equal(result.ok, false);
    assert.equal(result.difference.durableValid, false, 'Independent durable gate must detect the real broken contract');
    assert.equal(result.counterexample.minimality, 'first-divergence-prefix');
    const raw = result.observations.at(-1).durable;
    assert.notEqual(raw.mutation.sourceDigest, raw.mutation.mutatedDigest);
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

test('independent gate rejects raw-table/HTTP corruption despite unchanged projections and empty cached violations', { timeout: 10000 }, async () => {
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

test('raw business gate is usable by browser consumers and independently detects protected-row changes', { timeout: 10000 }, async () => {
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

test('real successful projection cannot pass replay with fabricated or missing durable observations', { timeout: 10000 }, async () => {
  const { trace } = traces.get('successTest');
  const result = await replayNameTrace(trace, async config => {
    const adapter = await createNameProtocolAdapter(config);
    return { ...adapter, check: () => [], observe: () => ({ ...adapter.observe(), tables: {} }) };
  });
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

test('driver separates unavailable, timeout and cleanup failure from implementation mismatch', { timeout: 10000 }, async () => {
  const { trace } = traces.get('successTest');
  for (const action of ['throw', 'timeout', 'cleanup']) {
    const result = await replayNameTrace(trace, async config => {
      const adapter = await createNameProtocolAdapter(config);
      return { ...adapter, ...(action === 'throw' ? { act: () => { throw new Error('Unavailable real action'); } } :
        action === 'timeout' ? { act: () => new Promise(() => {}) } : { close: async () => { await adapter.close(); throw new Error('Unverified cleanup'); } }) };
    }, { stepTimeoutMs: action === 'timeout' ? 500 : 5000 });
    assert.equal(result.complete, false); assert.equal(result.ok, false); assert.equal(result.classification, 'driver_cannot_replay');
    if (action === 'timeout') assert.match(result.error.message, /name action 0/);
    if (action === 'cleanup') assert.equal(result.cleanupError, 'Unverified cleanup');
  }
});
