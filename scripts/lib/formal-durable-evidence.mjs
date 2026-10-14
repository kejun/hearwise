import assert from 'node:assert/strict';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const indices = rows => rows.map(row => row.sourceIndex).sort((a, b) => a - b);

function relationProjection(durable, state, valid) {
  assert.ok(integer(durable.clock)); assert.ok(Array.isArray(durable.actors) && [1, 3].includes(durable.actors.length));
  const rows = durable.actors;
  assert.deepEqual(rows.map(row => row.actor), rows.map((_, i) => i));
  const identities = rows.map(row => [row.identity?.listeningId, row.identity?.windowId]);
  assert.ok(identities.flat().every(text));
  if (state.identities) assert.deepEqual(identities, state.identities); else state.identities = identities;
  for (const row of rows) {
    assert.ok(object(row.window) && Array.isArray(row.journal) && Array.isArray(row.relations));
    assert.ok(integer(row.budget) && integer(row.calls) && integer(row.knowledgeCount) && integer(row.notifications));
    assert.ok(row.job === null || (object(row.job) && integer(row.job.request_count) && integer(row.job.ready_at) && text(row.identity.jobId)));
    assert.ok(row.journal.every(entry => integer(entry.attempt) && entry.attempt > 0));
    if (!valid) continue; // A negative replay must retain its actual broken durable state.
    assert.equal(row.budget, row.journal.length); assert.ok(row.budget <= 3 && row.calls <= row.budget);
    if (['reserved', 'inflight', 'received'].includes(row.phase)) {
      assert.equal(row.job?.state, state.allowUnreserved ? 'pending' : 'running'); assert.equal(row.window.state, 'pending');
      if (state.allowUnreserved) { assert.equal(rows.length, 1); assert.equal(row.phase, 'reserved'); assert.equal(row.budget, 0); assert.equal(row.calls, 0); assert.equal(row.job.request_count, 0); assert.equal(row.relations.length, 0); }
    } else if (row.phase === 'committed' || (row.phase === 'done' && ['ok', 'empty'].includes(row.outcome))) {
      assert.equal(row.job?.state, 'complete'); assert.equal(row.window.state, 'complete'); assert.equal(row.job.last_error, null);
      assert.equal(row.journal.at(-1)?.outcome, 'complete');
    } else if (row.phase === 'done' && row.outcome === 'failed') {
      assert.equal(row.job?.state, 'failed'); assert.equal(row.window.state, 'failed');
    } else if (['retry_wait', 'reserve_failed'].includes(row.phase) || (row.phase === 'idle' && row.job)) {
      assert.equal(row.job?.state, 'pending'); assert.equal(row.window.state, 'pending');
    } else if (row.phase === 'waiting_nodes') { assert.equal(row.job, null); assert.equal(row.window.state, 'waiting_nodes'); }
    else if (row.phase === 'idle') { assert.equal(row.job, null); assert.equal(row.window.state, 'dirty'); }
  }
  return Object.fromEntries(['phase', 'counts', 'calls', 'relations', 'outcome', 'replies', 'ready'].map(field => [field,
    Object.fromEntries(rows.map(row => [row.actor, field === 'counts' ? row.budget : field === 'relations' ? row.relations.length :
      field === 'replies' ? row.reply : field === 'ready' ? !(row.job?.ready_at > durable.clock) : row[field]]))]));
}
function knowledgeProjection(durable, state, valid) {
  const cp = durable.checkpoint;
  assert.ok(integer(durable.clock) && object(cp?.job) && object(cp.progress) && Array.isArray(cp.parts) && [1, 2].includes(cp.parts.length));
  assert.ok(Array.isArray(durable.knowledge) && Array.isArray(durable.calls) && Array.isArray(durable.replies));
  assert.deepEqual(cp.parts.map(part => part.part_no), cp.parts.map((_, i) => i));
  assert.equal(durable.calls.length, cp.parts.length); assert.equal(durable.replies.length, cp.parts.length);
  const identity = [cp.job.id, cp.job.listening_id]; assert.ok(identity.every(text));
  if (state.identity) assert.deepEqual(identity, state.identity); else state.identity = identity;
  if (!state.baseline) { assert.equal(durable.knowledge.length, 1); state.baseline = structuredClone(durable.knowledge[0]); }
  if (valid) {
    assert.deepEqual(durable.knowledge.find(row => row.id === state.baseline.id), state.baseline);
    assert.equal(cp.progress.cycle, 1); assert.ok(integer(cp.progress.extra_requests) && cp.progress.extra_requests <= 2);
    assert.ok(integer(cp.progress.protocol_retries) && cp.progress.protocol_retries <= 1);
    assert.equal(cp.progress.extra_requests, cp.parts.reduce((sum, part) => sum + Math.max(0, part.initial_requests - 1), 0));
    if (durable.stage === 'idle') assert.equal(cp.job.state, 'pending');
    if (['reserved', 'inflight', 'received'].includes(durable.stage)) assert.equal(cp.job.state, 'running');
    if (durable.stage === 'done') { assert.ok(['ok', 'empty', 'partial', 'invalid'].includes(cp.job.outcome)); assert.equal(cp.job.state, cp.job.outcome === 'invalid' ? 'failed' : 'complete'); }
  }
  state.initialReplies ||= {}; state.accepted ||= new Map();
  for (const part of cp.parts) {
    const id = part.part_no, calls = durable.calls[id];
    assert.equal(part.job_id, cp.job.id); assert.ok(Array.isArray(part.results) && Array.isArray(part.unresolved) && Array.isArray(part.focus_refs) && part.focus_refs.length && object(part.stats));
    assert.ok(integer(part.initial_requests) && integer(part.repair_reserved) && integer(calls?.extract) && integer(calls?.repair));
    assert.ok([...part.results, ...part.unresolved].every(row => integer(row.sourceIndex) && row.sourceIndex <= 1));
    if (durable.stage === 'received' && part.phase === 'extract_inflight') state.initialReplies[id] = durable.replies[id];
    if (!valid) continue;
    assert.ok(calls.extract <= part.initial_requests && calls.repair <= part.repair_reserved && part.repair_reserved <= 1);
    assert.equal(part.stats.request_count || 0, part.initial_requests + part.repair_reserved);
    const accepted = new Set(indices(part.results)); assert.equal(accepted.size, part.results.length);
    assert.ok(part.unresolved.every(row => !accepted.has(row.sourceIndex)));
    for (const result of part.results) {
      const saved = durable.knowledge.find(row => row.id === result.itemId);
      const name = `${state.initialReplies[id] === 'rejected' || result.sourceIndex === 1 ? 'Nova' : 'Atlas'} ${id}`;
      assert.equal(saved?.content_version, 1); assert.equal(saved?.canonical_name, name);
      assert.equal(saved?.dialogue_summary, `原文正在讨论${name}。`); assert.equal(saved?.facts?.length, 1);
      assert.equal(saved.facts[0].content, `原文正在讨论${name}。`); assert.equal(saved.facts[0].surface_text, name);
      assert.equal(saved.facts[0].segment_id, part.focus_refs[0].segment_id);
      if (state.accepted.has(result.itemId)) assert.deepEqual(saved, state.accepted.get(result.itemId)); else state.accepted.set(result.itemId, structuredClone(saved));
    }
  }
  const map = select => Object.fromEntries(cp.parts.map(part => [part.part_no, select(part)]));
  const readyAt = Math.max(durable.nextJob?.ready_at || 0, durable.nextJob?.retry_at ? Date.parse(durable.nextJob.retry_at) : 0);
  assert.ok(Number.isFinite(readyAt));
  return { stage: durable.stage, outcome: cp.job.outcome || 'none', ready: durable.stage !== 'idle' || readyAt <= durable.clock,
    extra_requests: cp.progress.extra_requests, protocol_retries: cp.progress.protocol_retries, cycle: cp.progress.cycle,
    phase: map(part => part.phase), initial_requests: map(part => part.initial_requests), repair_reserved: map(part => part.repair_reserved),
    extract_calls: map(part => durable.calls[part.part_no].extract), repair_calls: map(part => durable.calls[part.part_no].repair),
    initial_complete: map(part => Boolean(part.stats.initial_complete)), retry_kind: map(part => part.stats.retry_kind || 'none'),
    accepted: map(part => indices(part.results)), unresolved: map(part => indices(part.unresolved)), anchored: map(part => indices(part.unresolved.filter(row => row.anchor))),
    replies: map(part => durable.replies[part.part_no]) };
}
// Recompute from the recorded SQLite/workflow observations. The adapter's actual
// projection and its cached violation array are never accepted as independent proof.
export function validateDurableReplay(kind, replay, { negative = false } = {}) {
  assert.ok(['relation-protocol', 'knowledge-protocol'].includes(kind));
  assert.ok(Array.isArray(replay.observations) && replay.observations.length > 0);
  const project = kind === 'relation-protocol' ? relationProjection : knowledgeProjection, state = {};
  let clock = 0;
  for (const [i, observation] of replay.observations.entries()) {
    assert.equal(observation.step, i - 1); assert.ok(object(observation.durable));
    assert.ok(observation.durable.clock >= clock); clock = observation.durable.clock;
    state.allowUnreserved = negative && kind === 'relation-protocol' && observation.step === replay.difference?.step;
    assert.deepEqual(project(observation.durable, state, true), observation.actual);
  }
  if (negative) {
    assert.equal(replay.difference?.step, 0); assert.equal(replay.observations.length, 2);
    const last = replay.observations.at(-1); assert.equal(last.step, replay.difference?.step);
    assert.deepEqual(last.actual, replay.difference.actual); assert.notDeepEqual(replay.difference.actual, replay.difference.expected);
    assert.deepEqual(replay.counterexample?.steps?.at(-1)?.expected, replay.difference.expected);
  }
  return true;
}
