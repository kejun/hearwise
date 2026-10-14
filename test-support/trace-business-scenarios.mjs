import assert from 'node:assert/strict';
import { traceBusinessFixture, knowledgeItem, deferred } from './trace-business-fixture.mjs';
import { deadline } from './lifecycle.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
export const workflowScenarioNames = ['knowledge-empty', 'knowledge-partial', 'knowledge-retry', 'knowledge-notification-sink',
  'knowledge-cancel-late', 'relation-empty', 'relation-filtered', 'relation-partial', 'relation-retry', 'relation-notification', 'relation-old-generation-usage'];

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
    if (name === 'relation-old-generation-usage') {
      const entries = [], start = () => {
        const entered = deferred(), response = deferred();
        const task = h.start({ extract: async (_key, input, _endpoint, options) => {
          entries.push({ input, options, response }); entered.resolve(); return response.promise;
        } });
        return { task, entered };
      };
      const oldJob = h.job, old = start(); await deadline(() => old.entered.promise, 2000, 'Old relation request');
      h.store.cancelRelations(h.run.listeningId); old.task.cancel(); await assert.rejects(old.task.promise);
      const cancelled = h.capture('durably cancelled');
      assert.equal(cancelled.query.processing.state, 'cancelled'); assert.equal(cancelled.business.tasks[0].state, 'cancelled');
      assert.equal(cancelled.activeCount, 0); captures.push(cancelled);
      const newJob = h.nextRelationGeneration(); assert.notEqual(newJob.id, oldJob.id); assert.ok(newJob.epoch > oldJob.epoch);
      const fresh = start(); await deadline(() => fresh.entered.promise, 2000, 'New relation request');
      const before = h.capture('new generation in flight');
      entries[0].options.onUsage({ total_tokens: 71 }); entries[0].options.onUsage({ total_tokens: 71 });
      entries[0].response.resolve({ ...h.parseRelation(entries[0].input), usage: { total_tokens: 71 } }); await tick();
      const late = h.capture('duplicate late usage stays on old request');
      assert.equal(late.query.processing.usageLastHour.totalTokens, 71); assert.equal(late.query.processing.round.totalTokens, 0);
      assert.deepEqual(late.query.job, before.query.job); assert.deepEqual(late.query.graph.relations, []);
      assert.equal(late.activeCount, 1, 'Old cleanup cannot release the new task');
      assert.deepEqual(late.snapshot, before.snapshot, 'Late usage must not append a successful old execution');
      const oldLedger = h.store.db.prepare('SELECT attempt,outcome,usage_json FROM relation_requests WHERE job_id=?').all(oldJob.id);
      assert.equal(oldLedger.length, 1); assert.equal(JSON.parse(oldLedger[0].usage_json).total_tokens, 71);
      assert.equal(oldLedger[0].outcome, 'late_response'); late.oldLedger = oldLedger; captures.push(late);
      entries[1].options.onUsage({ total_tokens: 21 });
      entries[1].response.resolve({ ...h.parseRelation(entries[1].input), usage: { total_tokens: 21 } });
      assert.equal((await deadline(() => fresh.task.promise, 3000, 'New relation completion')).outcome, 'empty');
      const complete = h.capture('new generation committed');
      assert.equal(complete.query.processing.usageLastHour.totalTokens, 92); assert.equal(complete.query.processing.round.totalTokens, 21);
      assert.equal(complete.query.job.state, 'complete'); assert.equal(complete.query.ledger.length, 1);
      assert.equal(complete.business.tasks.find(task => task.job === oldJob.id).state, 'cancelled');
      assert.equal(complete.business.tasks.find(task => task.job === newJob.id).state, 'succeeded');
      assert.equal(complete.adapterCalls.length, 2); assert.equal(complete.calls.length, 0); assert.equal(complete.activeCount, 0);
      captures.push(complete);
    } else if (name === 'knowledge-cancel-late') {
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
      assert.equal(recovered.query.detail.knowledge.length, 0); assert.equal(h.calls.length, 0); assert.equal(recovered.adapterCalls.length, 1);
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
