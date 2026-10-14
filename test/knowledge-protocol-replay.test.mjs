import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeProtocolAdapter } from '../test-support/knowledge-protocol-adapter.mjs';

async function dispatch(adapter, actor, response, commit = 'commit') {
  if (!adapter.project().ready) await adapter.act({ action: 'advance_time', actor: -1 });
  await adapter.act({ action: 'admit', actor });
  await adapter.act({ action: 'send', actor });
  await adapter.act({ action: 'response', actor, response });
  if (adapter.project().stage === 'received') await adapter.act({ action: commit, actor });
  assert.deepEqual(adapter.check(), []);
}

test('knowledge checkpoints reserve before invocation and commit accepted data before targeted repair', async t => {
  const a = await createKnowledgeProtocolAdapter(); t.after(() => a.close());
  await a.act({ action: 'admit', actor: 0 });
  assert.equal(a.project().initial_requests[0], 1); assert.equal(a.project().extract_calls[0], 0);
  assert.equal(a.project().phase[0], 'extract_inflight');
  await a.act({ action: 'send', actor: 0 });
  await a.act({ action: 'response', actor: 0, response: 'partial' });
  assert.deepEqual(a.project().accepted[0], []);
  await a.act({ action: 'commit', actor: 0 });
  assert.deepEqual(a.project().accepted[0], [0]); assert.deepEqual(a.project().anchored[0], [1]);
  assert.equal(a.project().phase[0], 'repair_pending'); assert.equal(a.project().ready, false);
  await dispatch(a, 0, 'ok');
  assert.equal(a.project().outcome, 'ok'); assert.deepEqual(a.project().accepted[0], [0, 1]);
  assert.equal(a.project().repair_reserved[0], 1); assert.equal(a.project().repair_calls[0], 1);
  assert.equal(a.project().extra_requests, 0); assert.equal(a.observe().knowledge.length, 3);
});

test('empty and unrepairable outputs never request a correction or destroy existing knowledge', async t => {
  for (const response of ['empty', 'unrepairable']) await t.test(response, async sub => {
    const a = await createKnowledgeProtocolAdapter(); sub.after(() => a.close());
    await dispatch(a, 0, response);
    assert.equal(a.project().stage, 'done'); assert.equal(a.project().repair_calls[0], 0);
    assert.equal(a.project().outcome, response === 'empty' ? 'empty' : 'invalid');
    assert.equal(a.observe().knowledge.length, 1);
  });
});

test('two parts share extra and protocol retry budgets while keeping the successful first result', async t => {
  const a = await createKnowledgeProtocolAdapter({ parts: 2 }); t.after(() => a.close());
  await dispatch(a, 0, 'ok');
  await dispatch(a, 1, 'transient');
  await dispatch(a, 1, 'protocol');
  await dispatch(a, 1, 'protocol');
  const p = a.project();
  assert.equal(p.extra_requests, 2); assert.equal(p.protocol_retries, 1);
  assert.deepEqual(p.extract_calls, { 0: 1, 1: 3 }); assert.deepEqual(p.accepted[0], [0]);
  assert.equal(p.outcome, 'partial'); assert.equal(p.stage, 'done');
});

test('failed extract and repair reservations roll back durable occupancy with zero new provider calls', async t => {
  for (const repair of [false, true]) await t.test(repair ? 'repair' : 'extract', async sub => {
    const a = await createKnowledgeProtocolAdapter(); sub.after(() => a.close());
    if (repair) { await dispatch(a, 0, 'partial'); await a.act({ action: 'advance_time', actor: -1 }); }
    await a.act({ action: 'reserve_fail', actor: 0 });
    const p = a.project();
    assert.equal(p.stage, 'done'); assert.equal(p.extract_calls[0], repair ? 1 : 0); assert.equal(p.repair_calls[0], 0);
    assert.equal(p.initial_requests[0], repair ? 1 : 0); assert.equal(p.repair_reserved[0], 0);
    assert.equal(p.outcome, repair ? 'partial' : 'invalid');
    assert.match(a.observe().errors.map(error => error.message).join('\n'), /reservation failure/);
    assert.deepEqual(a.check(), []);
  });
});

test('response then SQLite commit failure uses the actual scheduler failure path without replaying the request', async t => {
  for (const repair of [false, true]) await t.test(repair ? 'repair' : 'extract', async sub => {
    const a = await createKnowledgeProtocolAdapter(); sub.after(() => a.close());
    if (repair) await dispatch(a, 0, 'partial');
    await dispatch(a, 0, 'ok', 'commit_fail');
    assert.equal(a.project().stage, 'done'); assert.equal(a.project().extract_calls[0], 1);
    assert.equal(a.project().repair_calls[0], repair ? 1 : 0);
    assert.equal(a.project().outcome, repair ? 'partial' : 'invalid');
    assert.equal(a.observe().knowledge.length, repair ? 2 : 1);
  });
});

test('throwing observers cannot rollback success or own scheduler cleanup', async t => {
  const a = await createKnowledgeProtocolAdapter(); t.after(() => a.close());
  await dispatch(a, 0, 'ok', 'commit_notify_failure');
  assert.equal(a.project().stage, 'done'); assert.equal(a.project().outcome, 'ok');
  assert.equal(a.observe().knowledge.length, 2); assert.equal(a.project().extract_calls[0], 1);
  assert.ok(a.observe().notifications.failed > 0);
});

test('checkpoint reopen preserves an already reserved extraction budget and automatic cycle', async t => {
  const a = await createKnowledgeProtocolAdapter(); t.after(() => a.close());
  await a.act({ action: 'admit', actor: 0 });
  assert.equal(a.project().initial_requests[0], 1);
  await a.reopen();
  assert.equal(a.project().phase[0], 'extract_pending'); assert.equal(a.project().cycle, 1);
  assert.equal(a.project().initial_requests[0], 1); assert.equal(a.project().extra_requests, 0);
  await dispatch(a, 0, 'ok');
  assert.equal(a.project().initial_requests[0], 2); assert.equal(a.project().extra_requests, 1);
  assert.equal(a.project().extract_calls[0], 1); assert.equal(a.project().outcome, 'ok');
});

test('checkpoint reopen never resends a reserved repair; only explicit retry begins another cycle', async t => {
  const a = await createKnowledgeProtocolAdapter(); t.after(() => a.close());
  await dispatch(a, 0, 'partial'); await a.act({ action: 'advance_time', actor: -1 });
  await a.act({ action: 'admit', actor: 0 });
  assert.equal(a.project().repair_reserved[0], 1); assert.equal(a.project().repair_calls[0], 0);
  await a.reopen();
  assert.equal(a.project().phase[0], 'done'); assert.equal(a.project().repair_reserved[0], 1);
  assert.equal(a.project().cycle, 1); assert.deepEqual(a.project().accepted[0], [0]);
  await a.act({ action: 'advance_time', actor: -1 }); await a.act({ action: 'admit', actor: -1 });
  assert.equal(a.project().outcome, 'partial'); assert.equal(a.project().repair_calls[0], 0);
  assert.equal(a.manualRetry(), 1); assert.equal(a.manualRetry(), 0);
  assert.equal(a.project().cycle, 2); assert.equal(a.project().repair_reserved[0], 0);
  assert.deepEqual(a.project().accepted[0], [0]); assert.deepEqual(a.project().unresolved[0], [1]);
  assert.equal(a.project().extra_requests, 0); assert.equal(a.project().protocol_retries, 0);
});

test('isolated reservation and durable-state mutations are detected without changing production behavior', async () => {
  const { replayKnowledgeTrace } = await import('../scripts/lib/knowledge-protocol-replay.mjs');
  const initial = { stage: 'idle', outcome: 'none', ready: true, extra_requests: 0, protocol_retries: 0, cycle: 1,
    phase: { 0: 'extract_pending' }, initial_requests: { 0: 0 }, repair_reserved: { 0: 0 }, extract_calls: { 0: 0 }, repair_calls: { 0: 0 },
    initial_complete: { 0: false }, retry_kind: { 0: 'none' }, accepted: { 0: [] }, unresolved: { 0: [] }, anchored: { 0: [] }, replies: { 0: 'none' } };
  let state = initial;
  const expected = changes => (state = { ...state, ...changes });
  const trace = { schemaVersion: 1, specificationVersion: '1.0', protocol: 'knowledge', config: { parts: 1 }, initial, steps: [
    { action: 'admit', actor: 0, expected: expected({ stage: 'reserved', phase: { 0: 'extract_inflight' }, initial_requests: { 0: 1 } }) },
    { action: 'send', actor: 0, expected: expected({ stage: 'inflight', extract_calls: { 0: 1 } }) },
    { action: 'response', actor: 0, response: 'ok', expected: expected({ stage: 'received', replies: { 0: 'ok' } }) },
    { action: 'commit', actor: 0, expected: expected({ stage: 'done', phase: { 0: 'done' }, outcome: 'ok', initial_complete: { 0: true }, accepted: { 0: [0] } }) }
  ] };
  for (const mutation of ['skip_reservation', 'corrupt_terminal_state']) {
    const result = await replayKnowledgeTrace(trace, options => createKnowledgeProtocolAdapter({ ...options, mutation }));
    assert.equal(result.classification, 'implementation_mismatch'); assert.equal(result.ok, false);
    assert.equal(result.counterexample.steps.length, mutation === 'skip_reservation' ? 1 : 4);
    if (mutation === 'corrupt_terminal_state') {
      assert.deepEqual(result.difference.actual, result.difference.expected);
      assert.match(result.difference.durableViolations.join('\n'), /terminal state/);
    }
  }
  assert.equal((await replayKnowledgeTrace(trace, createKnowledgeProtocolAdapter)).ok, true);
});

test('the actual scheduler blocks early repair and cross-part cooldown admission at exact persisted deadlines', async t => {
  for (const [name, cooldown] of [['part interval', 2000], ['repair rate limit', 7000], ['long repair rate limit', 301000]]) await t.test(name, async sub => {
    const a = await createKnowledgeProtocolAdapter({ parts: cooldown === 2000 ? 1 : 2 }); sub.after(() => a.close());
    await dispatch(a, 0, 'partial');
    if (cooldown !== 2000) await dispatch(a, 0, cooldown === 7000 ? 'rate_limit' : 'rate_limit_long');
    const before = a.observe(), actor = cooldown === 2000 ? 0 : 1;
    assert.equal(before.nextJob.ready_at - before.clock, cooldown);
    await a.act({ action: 'advance_time', actor: -1, milliseconds: cooldown - 1 });
    await a.act({ action: 'probe_admit', actor });
    assert.equal(a.project().stage, 'idle');
    assert.deepEqual(a.observe().calls, before.calls);
    assert.equal(a.observe().checkpoint.parts[actor].stats.request_count || 0, before.checkpoint.parts[actor].stats.request_count || 0);
    await a.act({ action: 'advance_time', actor: -1, milliseconds: 1 });
    await a.act({ action: 'admit', actor }); await a.act({ action: 'send', actor });
    assert.equal(cooldown === 2000 ? a.project().repair_calls[actor] : a.project().extract_calls[actor], 1);
  });
});

test('retention checks detect changed accepted content even when counts and versions remain unchanged', async t => {
  const a = await createKnowledgeProtocolAdapter({ mutation: 'corrupt_accepted_content' }); t.after(() => a.close());
  await dispatch(a, 0, 'partial');
  await a.act({ action: 'advance_time', actor: -1 });
  for (const action of ['admit', 'send']) await a.act({ action, actor: 0 });
  await a.act({ action: 'response', actor: 0, response: 'empty' }); await a.act({ action: 'commit', actor: 0 });
  assert.deepEqual(a.project().accepted[0], [0]);
  assert.equal(a.observe().knowledge.find(item => item.canonical_name === 'Atlas 0').content_version, 1);
  assert.match(a.check().join('\n'), /accepted content/);
});
