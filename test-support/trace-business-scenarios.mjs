import assert from 'node:assert/strict';
import { traceBusinessFixture, knowledgeItem, deferred } from './trace-business-fixture.mjs';
import { deadline } from './lifecycle.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
export const workflowScenarioNames = ['knowledge-empty', 'knowledge-partial', 'knowledge-retry', 'knowledge-notification-sink',
  'knowledge-cancel-late', 'relation-empty', 'relation-filtered', 'relation-partial', 'relation-retry', 'relation-notification'];

export function checkWorkflowCapture(capture, { domain, state, calls, items, accepted, rejected, queryState, outcome, next }) {
  const { report, business, query, snapshot } = capture;
  assert.equal(report.completeness, 'complete'); assert.equal(snapshot.active_spans, 0); assert.equal(capture.activeCount, 0);
  assert.equal(business.tasks.length, 1, 'Repeated dispatches must remain one business object');
  const task = business.tasks[0];
  assert.equal(task.domain, domain); assert.equal(task.job, query.jobId); assert.equal(task.state, state);
  assert.equal(task.quality, 'consistent'); assert.equal(task.calls, calls); assert.equal(capture.calls.length, calls);
  assert.ok(capture.calls.every(row => row.authorized));
  assert.ok(report.spans.every(span => span.listening === query.listeningId && span.job === query.jobId));
  assert.equal(business.domains.find(row => row.key === domain).objectCount, 1);
  if (domain === 'knowledge') {
    assert.equal(query.checkpoint.job.state, queryState); assert.equal(query.checkpoint.job.outcome, outcome);
    assert.equal(query.detail.knowledge.length, items); assert.equal(Boolean(query.next), next);
    assert.equal(query.checkpoint.parts.reduce((n, part) => n + (part.stats.request_count || 0), 0), calls);
  } else {
    assert.equal(query.job.state, queryState); assert.equal(query.job.accepted_count, accepted); assert.equal(query.job.rejected.length, rejected);
    assert.equal(query.ledger.length, calls); assert.equal(query.job.request_count, calls);
    assert.equal(query.graph.relations.length, accepted);
  }
  return true;
}

export async function runWorkflowScenario(name) {
  assert.ok(workflowScenarioNames.includes(name));
  const domain = name.split('-')[0], fault = name.includes('notification');
  const h = await traceBusinessFixture({ domain, notifyThrows: fault, sinkThrows: name === 'knowledge-notification-sink', coverageLimited: name === 'relation-partial' });
  const captures = []; let cleanup = false;
  const capture = (label, expected) => { const row = h.capture(label); checkWorkflowCapture(row, { domain, ...expected }); captures.push(row); return row; };
  try {
    if (name === 'knowledge-cancel-late') {
      const received = deferred(), response = deferred(); let requestContext;
      const task = h.start({ extract: async (_key, _input, _endpoint, context) => {
        requestContext = context; received.resolve(); return response.promise;
      } });
      await deadline(() => received.promise, 2000, 'Ignored-abort provider entry');
      task.cancel('application_shutdown'); await assert.rejects(task.promise, { code: 'TASK_CANCELLED' });
      const before = h.capture('cancelled');
      assert.equal(before.query.checkpoint.job.state, 'running');
      assert.equal(before.query.checkpoint.parts[0].phase, 'extract_inflight');
      assert.equal(before.business.tasks[0].state, 'cancelled'); assert.equal(before.activeCount, 0);
      // Cancellation describes execution; the durable inflight checkpoint is not fabricated as successful.
      response.resolve({ accepted: [], rejected: [], normalized: [], returnedCount: 0 }); await tick();
      requestContext.event('checkpoint_committed', { accepted_count: 99 }); await tick();
      const after = h.capture('late ignored response');
      assert.deepEqual(after.query, before.query); assert.deepEqual(after.snapshot, before.snapshot);
      h.reopen(); const recovered = h.capture('SQLite recovery projection');
      assert.equal(recovered.query.checkpoint.job.state, 'pending');
      assert.equal(recovered.query.checkpoint.parts[0].initial_requests, 1);
      assert.equal(recovered.query.detail.knowledge.length, 0); assert.equal(h.calls.length, 0);
      captures.push(before, after, recovered);
    } else if (domain === 'knowledge') {
      if (name === 'knowledge-partial') h.setReply(input => input.focus_segments ? {
        items: [knowledgeItem('Atlas', input), knowledgeItem('Nova', input, { role: null })]
      } : { corrections: [] });
      else if (name === 'knowledge-retry') h.setReply(() => h.calls.length === 1 ? { httpStatus: 429 } : { items: [] });
      else if (fault) h.setReply(input => ({ items: [knowledgeItem('Atlas', input)] }));
      const first = await h.dispatch();
      if (['knowledge-partial', 'knowledge-retry'].includes(name)) {
        assert.equal(first.kind, 'continue');
        capture('waiting after first dispatch', { state: 'waiting', calls: 1, items: name === 'knowledge-partial' ? 1 : 0,
          queryState: 'pending', outcome: null, next: true });
        if (name === 'knowledge-partial') h.setReply(() => ({ corrections: [] }));
        const result = await h.dispatch();
        assert.equal(result.outcome, name === 'knowledge-partial' ? 'partial' : 'empty');
        capture('terminal after continuation', { state: name === 'knowledge-partial' ? 'partial' : 'recovered', calls: 2,
          items: name === 'knowledge-partial' ? 1 : 0, queryState: 'complete', outcome: result.outcome, next: false });
      } else {
        assert.equal(first.outcome, fault ? 'ok' : 'empty');
        const row = capture('committed terminal', { state: 'succeeded', calls: 1, items: fault ? 1 : 0,
          queryState: 'complete', outcome: first.outcome, next: false });
        if (fault) {
          assert.ok(row.notifications.attempted >= 3); assert.equal(row.notifications.delivered, 0);
          assert.ok(row.snapshot.sink_errors > 0); assert.equal(row.snapshot.sink_complete, false);
          assert.equal(row.snapshot.complete, true, 'The intact in-memory buffer is distinct from its failed external sink');
        }
      }
      const before = h.query(); h.reopen(); const recovered = h.capture('durable result reopened');
      assert.deepEqual(recovered.query.detail.knowledge, before.detail.knowledge);
      assert.equal(recovered.query.checkpoint.job.outcome, before.checkpoint.job.outcome);
      assert.equal(recovered.query.next, null); captures.push(recovered);
    } else {
      if (name === 'relation-retry') h.setReply(input => h.calls.length === 1 ? { httpStatus: 429 } : {
        contract_version: input.contract_version, evidence_version: input.evidence_version, relations: [] });
      else if (name === 'relation-filtered') h.setReply(input => ({ contract_version: input.contract_version,
        evidence_version: input.evidence_version, relations: [{ subject_item_id: input.candidates[0].id, object_item_id: input.candidates[1].id,
          predicate: 'released', modality: 'asserted', status: 'active', evidence_ids: [input.evidence[0].id] }] }));
      const result = await h.dispatch();
      if (name === 'relation-retry') {
        assert.equal(result.kind, 'continue');
        const waiting = h.capture('retry waiting');
        assert.equal(waiting.query.job.state, 'pending'); assert.equal(waiting.business.tasks[0].state, 'waiting');
        assert.equal(waiting.calls.length, 1); assert.equal(waiting.query.ledger.length, 1); captures.push(waiting);
        assert.equal((await h.dispatch()).outcome, 'empty');
      }
      const partial = name === 'relation-partial';
      const row = capture('relation terminal', { state: partial ? 'partial' : name === 'relation-retry' ? 'recovered' : 'succeeded',
        calls: name === 'relation-retry' ? 2 : 1, queryState: partial ? 'partial' : 'complete', accepted: 0, rejected: name === 'relation-filtered' ? 1 : 0 });
      if (fault) {
        assert.equal(row.notifications.attempted, 2); assert.equal(row.notifications.delivered, 0);
        assert.equal(row.snapshot.events.filter(event => event.event === 'notification_sent').length, 0,
          'A failed notification callback cannot be recorded as a sent notification');
      } else assert.equal(row.snapshot.events.filter(event => event.event === 'notification_sent').length, 1);
      const before = h.query(); h.reopen(); const recovered = h.capture('durable relation reopened');
      assert.equal(recovered.query.job.state, before.job.state); assert.deepEqual(recovered.query.ledger, before.ledger);
      assert.deepEqual(recovered.query.graph.relations, before.graph.relations); captures.push(recovered);
    }
  } finally { await h.close(); cleanup = true; }
  return { name, complete: true, ok: true, cleanup, captures };
}
