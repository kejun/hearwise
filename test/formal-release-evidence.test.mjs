import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRelationProtocolAdapter } from '../test-support/relation-protocol-adapter.mjs';
import { createKnowledgeProtocolAdapter } from '../test-support/knowledge-protocol-adapter.mjs';
import { validateDurableReplay } from '../scripts/lib/formal-durable-evidence.mjs';
import { formalCommandContract } from '../scripts/lib/formal-release-evidence.mjs';

async function record(adapter, actions) {
  const observations = [], capture = () => observations.push(JSON.parse(JSON.stringify({ step: observations.length - 1, durable: adapter.observe(), actual: adapter.project(), durableViolations: adapter.check() })));
  capture();
  for (const action of actions) { await adapter.act(action); capture(); }
  return { observations };
}

test('release reader reprojects real relation reservations, provider calls and durable commit rather than trusting cached checks', async t => {
  const adapter = await createRelationProtocolAdapter(); t.after(() => adapter.close());
  const result = await record(adapter, ['admit', 'send', 'response', 'commit', 'notify_fail'].map(action => ({ action, actor: 0, response: 'ok' })));
  assert.equal(validateDurableReplay('relation-protocol', result), true);
  for (const mutate of [r => { r.observations[1].durable = {}; }, r => { r.observations[2].durable.actors[0].calls = 3; },
    r => { r.observations[2].durable.actors[0].journal = []; }, r => { r.observations.at(-1).durable.actors[0].job.state = 'pending'; },
    r => { r.observations.at(-1).durable.actors[0].identity.listeningId = 'wrong-owner'; }]) {
    const changed = structuredClone(result); mutate(changed); assert.throws(() => validateDurableReplay('relation-protocol', changed));
  }
});
test('release reader rechecks real knowledge checkpoints, source facts, existing content and accepted identity', async t => {
  const adapter = await createKnowledgeProtocolAdapter(); t.after(() => adapter.close());
  const actions = ['admit', 'send', 'response', 'commit', 'advance_time', 'admit', 'send', 'response', 'commit'].map((action, i) => ({ action, actor: action === 'advance_time' ? -1 : 0, response: i < 4 ? 'partial' : 'ok' }));
  const result = await record(adapter, actions); assert.equal(validateDurableReplay('knowledge-protocol', result), true);
  for (const mutate of [r => { r.observations[1].durable = {}; }, r => { r.observations[2].durable.calls[0].extract = 3; },
    r => { r.observations[4].durable.knowledge[0].canonical_name = 'changed baseline'; },
    r => { const d = r.observations.at(-1).durable; d.knowledge.find(k => k.id === d.checkpoint.parts[0].results[0].itemId).facts[0].content = 'changed accepted fact'; },
    r => { r.observations.at(-1).durable.checkpoint.job.listening_id = 'other-owner'; }]) {
    const changed = structuredClone(result); mutate(changed); assert.throws(() => validateDurableReplay('knowledge-protocol', changed));
  }
});
test('negative replay keeps the actual broken reservation and requires a real expected/actual disagreement', async t => {
  for (const [kind, create] of [['relation-protocol', createRelationProtocolAdapter], ['knowledge-protocol', createKnowledgeProtocolAdapter]]) {
    const adapter = await create({ mutation: 'skip_reservation' }); t.after(() => adapter.close());
    const result = await record(adapter, [{ action: 'admit', actor: 0 }]);
    const actual = result.observations.at(-1).actual, expected = structuredClone(actual);
    (kind === 'relation-protocol' ? expected.counts : expected.initial_requests)[0] = 1;
    Object.assign(result, { difference: { step: 0, actual, expected }, counterexample: { steps: [{ expected }] } });
    assert.equal(validateDurableReplay(kind, result, { negative: true }), true);
    const brokenPrefix = structuredClone(result);
    if (kind === 'relation-protocol') brokenPrefix.observations[0].durable.actors[0].window.state = 'complete';
    else brokenPrefix.observations[0].durable.checkpoint.job.state = 'complete';
    assert.throws(() => validateDurableReplay(kind, brokenPrefix, { negative: true }));
    const changed = structuredClone(result); changed.difference.expected = changed.difference.actual;
    assert.throws(() => validateDurableReplay(kind, changed, { negative: true }));
    changed.observations[1].durable = {};
    assert.throws(() => validateDurableReplay(kind, changed, { negative: true }));
  }
});
test('formal command binding preserves portable roots, fixed tools, depth, tests and resource budgets', async () => {
  const repositoryRoot = '/a/different/ci/checkout', evidenceDirectory = '/ci-evidence/run-example', quintCli = `${repositoryRoot}/node_modules/@informalsystems/quint/dist/src/cli.js`;
  const pinned = JSON.parse(await readFile('verification/relation-protocol/toolchain.json'));
  const report = { profile: 'fast', tools: { node: process.version, sqlite: process.versions.sqlite },
    executionContext: { repositoryRoot, evidenceDirectory, quintCli, overallTimeoutMs: 480000, jvmArgs: '-Xmx2G' }, results: [
      { id: 'typecheck-protocol', kind: 'typecheck', timeoutMs: 60000, expectedFailure: false, argv: [quintCli, 'typecheck', `${repositoryRoot}/verification/relation-protocol/protocol.qnt`] },
      { id: 'bounded-single', kind: 'bounded-model-check', timeoutMs: 240000, bound: 15, expectedFailure: false,
        argv: [quintCli, 'verify', `${repositoryRoot}/verification/relation-protocol/configurations.qnt`, '--main', 'single', '--init', 'Init', '--step', 'Step', '--invariant', 'Safety', '--apalache-version', pinned.apalache.version, '--verbosity', '3', '--backend', 'apalache', '--max-steps', '15', '--server-endpoint', '127.0.0.1:12345'] },
      { id: 'implementation-regressions', kind: 'implementation-regression', timeoutMs: 60000, expectedFailure: false,
        argv: ['--test', '--test-reporter=tap', '--test-timeout=30000', `${repositoryRoot}/test/relation-protocol-replay.test.mjs`] }
    ] };
  report.results.forEach(row => { row.execution = { code: 0, ok: true }; });
  assert.equal(await formalCommandContract('relation-protocol', report), true);
  for (const mutate of [r => { r.results[1].argv[r.results[1].argv.indexOf('--max-steps') + 1] = '8'; }, r => { r.results[1].bound = 8; },
    r => { r.results[1].timeoutMs = 999999; }, r => { r.executionContext.overallTimeoutMs *= 2; }, r => { r.executionContext.jvmArgs = '-Xmx8G'; },
    r => { r.results[2].argv[3] = '/other/test/relation-protocol-replay.test.mjs'; }, r => { r.results[0].argv.push('--ignored'); },
    r => { r.results[0].execution.error = 'contradictory spawn failure'; }, r => { r.tools.node = 'v99.0.0'; }, r => { r.results[0].expectedFailure = true; }]) {
    const changed = structuredClone(report); mutate(changed); await assert.rejects(formalCommandContract('relation-protocol', changed));
  }
});
