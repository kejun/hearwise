import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { parseKnowledgeV2, parseKnowledgeRepair } from '../knowledge.mjs';
import { createKnowledgeWorkflow } from '../knowledge-workflow.mjs';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
const makeItem = (name, input, extra = {}) => ({
  action: 'create', display_label: 'organization', canonical_name: name,
  role: '主体', reason: '讨论的核心公司', existing_item_id: null, observed_candidate_id: null,
  aliases: [], correction_reason: null, short_description: `${name}是本段讨论的公司。`,
  new_information: `原文正在讨论${name}。`, certainty: 'clear',
  evidence: [{ segment_id: input.focus_segments[0].id, quote: name }], ...extra
});
const parsed = (input, items) => parseKnowledgeV2(JSON.stringify({ items }), input);
const corrected = (input, targets, transform = item => ({ ...item, role: '主体' })) => parseKnowledgeRepair(
  JSON.stringify({ corrections: targets.filter(target => target.anchor).map(target => ({
    rejection_id: target.rejection_id, item: transform(target.rawItem)
  })) }), input, targets);

function fixture(t, text = 'Anthropic and Akamai signed a compute deal.') {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-workflow-'));
  const filename = path.join(dir, 'test.sqlite');
  let store = new ListeningStore(filename);
  const run = store.createRun(null, settings, 'news');
  store.addSegment(run.listeningId, run.runId, { id: 'sentence', text });
  const job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
  let time = Date.now();
  const seen = [];
  const h = {
    get store() { return store; }, run, job, seen,
    now: () => time,
    reopen() { store.close(); store = new ListeningStore(filename); },
    workflow(options) { return createKnowledgeWorkflow({ store, endpoint: 'http://mock.invalid',
      now: () => time, onItems: (id, items) => seen.push(...items.map(item => item.id)), ...options }); },
    async step(workflow) {
      const pending = store.nextJob(run.listeningId);
      assert.ok(pending, 'should still have pending work');
      time = Math.max(time, pending.ready_at || 0, pending.retry_at ? Date.parse(pending.retry_at) : 0);
      store.markJob(job.id, 'running');
      return workflow.execute({ ...pending, state: 'running' }, 'fake-test-key');
    },
    detail() { return store.detail(run.listeningId); }
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return h;
}

test('partial initial output is visible before one targeted correction; both then resolve', async t => {
  const h = fixture(t);
  let normalCalls = 0, repairCalls = 0;
  const workflow = h.workflow({
    extract: async (key, input) => { normalCalls++; return parsed(input, [makeItem('Anthropic', input), makeItem('Akamai', input, { role: null })]); },
    repair: async (key, input, endpoint, targets) => {
      repairCalls++;
      assert.equal(h.detail().knowledge.length, 1);
      assert.equal(h.seen.length, 1);
      assert.equal(targets.length, 1);
      assert.equal(targets[0].rawItem.canonical_name, 'Akamai');
      return corrected(input, targets);
    }
  });
  assert.equal((await h.step(workflow)).kind, 'continue');
  assert.equal(h.detail().knowledge[0].canonical_name, 'Anthropic');
  const result = await h.step(workflow);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.summary.accepted_initial_count, 1);
  assert.equal(result.summary.resolved_count, 2);
  assert.equal(result.summary.repaired_count, 1);
  assert.equal(result.summary.visible_change_count, 2);
  assert.deepEqual([normalCalls, repairCalls], [1, 1]);
  assert.equal(h.detail().knowledge.length, 2);
});

test('all rejected plus empty corrections stays invalid; manual retry touches only rejected slots', async t => {
  const h = fixture(t);
  let extractCalls = 0, repairCalls = 0;
  const workflow = h.workflow({
    extract: async (key, input) => { extractCalls++; return parsed(input, [makeItem('Akamai', input, { role: null })]); },
    repair: async (key, input, endpoint, targets) => ++repairCalls === 1
      ? parseKnowledgeRepair('{"corrections":[]}', input, targets) : corrected(input, targets)
  });
  await h.step(workflow);
  assert.equal((await h.step(workflow)).outcome, 'invalid');
  assert.equal(h.detail().jobs[0].state, 'failed');
  assert.equal(h.store.nextJob(h.run.listeningId), undefined);
  assert.equal(h.store.retry(h.run.listeningId), 1);
  assert.equal(h.store.retry(h.run.listeningId), 0);
  const result = await h.step(workflow);
  assert.equal(result.outcome, 'ok');
  assert.deepEqual([extractCalls, repairCalls], [1, 2]);
  assert.equal(h.detail().knowledge.length, 1);
});

test('valid initial empty or policy decisions never trigger correction', async t => {
  for (const decision of ['empty', 'observe', 'exclude']) {
    await t.test(decision, async t => {
      const h = fixture(t);
      const workflow = h.workflow({
        extract: async (key, input) => parsed(input, decision === 'empty' ? [] : [makeItem('Anthropic', input, {
          action: decision, short_description: null, new_information: null
        })]),
        repair: async () => assert.fail('no correction expected')
      });
      const result = await h.step(workflow);
      assert.equal(result.outcome, decision === 'empty' ? 'empty' : 'ok');
      assert.equal(h.detail().knowledge.length, 0);
      assert.equal(result.summary.request_count, 1);
    });
  }
});

test('safe organization type normalization needs no extra model call', async t => {
  const h = fixture(t);
  const workflow = h.workflow({
    extract: async (key, input) => parsed(input, [makeItem('Anthropic', input, { type: 'organization' })]),
    repair: async () => assert.fail('normalization should resolve this locally')
  });
  const result = await h.step(workflow);
  assert.equal(result.outcome, 'ok');
  assert.equal(h.detail().knowledge[0].type, 'other');
  assert.ok(result.summary.normalized_count > 0);
});

test('multi-part retries share two extra requests and never reapply the successful first part', async t => {
  const h = fixture(t, 'Anthropic is central. ' + 'x'.repeat(2600) + ' Akamai is central.');
  let calls = 0;
  const workflow = h.workflow({ extract: async (key, input) => {
    calls++;
    if (calls === 2 || calls === 3) throw new TypeError('simulated network outage');
    const name = input.focus_segments[0].text.includes('Anthropic') ? 'Anthropic' : 'Akamai';
    return parsed(input, [makeItem(name, input)]);
  } });
  await h.step(workflow);
  const first = h.detail().knowledge[0];
  assert.equal((await h.step(workflow)).reason, 'network_retry');
  assert.equal((await h.step(workflow)).reason, 'network_retry');
  const result = await h.step(workflow);
  assert.equal(result.outcome, 'ok');
  assert.equal(calls, 4, 'm=2, normal requests <= m+2');
  const retained = h.detail().knowledge.find(item => item.id === first.id);
  assert.equal(retained.facts.length, 1);
  assert.equal(retained.content_version, first.content_version);
  assert.equal(h.store.knowledgeCheckpoint(h.job.id).progress.extra_requests, 2);
});

test('protocol retry and network retry consume the same shared budget', async t => {
  const h = fixture(t);
  let calls = 0;
  const workflow = h.workflow({ extract: async () => {
    calls++;
    if (calls === 1) throw new TypeError('simulated network outage');
    throw Object.assign(new Error('invalid structured response'), { code: 'KNOWLEDGE_INVALID_RESPONSE' });
  } });
  await h.step(workflow); await h.step(workflow);
  assert.equal((await h.step(workflow)).outcome, 'invalid');
  assert.equal(calls, 3);
  const cp = h.store.knowledgeCheckpoint(h.job.id);
  assert.equal(cp.progress.extra_requests, 2);
  assert.equal(cp.progress.protocol_retries, 1);
});

test('correction timeout preserves partial output without triggering another full extraction', async t => {
  const h = fixture(t);
  let normalCalls = 0, repairCalls = 0;
  const workflow = h.workflow({
    extract: async (key, input) => { normalCalls++; return parsed(input, [makeItem('Anthropic', input), makeItem('Akamai', input, { role: null })]); },
    repair: async () => { repairCalls++; throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }
  });
  await h.step(workflow);
  const result = await h.step(workflow);
  assert.equal(result.outcome, 'partial');
  assert.equal(h.detail().knowledge.length, 1);
  assert.equal(h.store.nextJob(h.run.listeningId), undefined);
  assert.deepEqual([normalCalls, repairCalls], [1, 1]);
});

test('correction 429 returns shared cooldown even though it will not automatically resend', async t => {
  const h = fixture(t);
  const workflow = h.workflow({
    extract: async (key, input) => parsed(input, [makeItem('Akamai', input, { role: null })]),
    repair: async () => { throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 7000 }); }
  });
  await h.step(workflow);
  const result = await h.step(workflow);
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.rateLimitMs, 7000);
});

test('correction Retry-After persists across restart before the next part', async t => {
  const h = fixture(t, 'Anthropic is central. ' + 'x'.repeat(2600) + ' Akamai is central.');
  const workflow = h.workflow({
    extract: async (key, input) => parsed(input, [makeItem('Anthropic', input, { role: null })]),
    repair: async () => { throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 10000 }); }
  });
  await h.step(workflow);
  const result = await h.step(workflow);
  assert.equal(result.kind, 'continue');
  const deadline = h.now() + 10000;
  assert.ok(h.store.nextJob(h.run.listeningId).ready_at >= deadline);
  h.reopen();
  assert.ok(h.store.nextJob(h.run.listeningId).ready_at >= deadline);
});

test('early continuation restores pending even when the scheduler already marked running', async t => {
  const h = fixture(t);
  const workflow = h.workflow({
    extract: async (key, input) => parsed(input, [makeItem('Akamai', input, { role: null })]),
    repair: async () => assert.fail('too early to send repair')
  });
  await h.step(workflow);
  h.store.markJob(h.job.id, 'running');
  const result = await workflow.execute(h.job, 'fake-test-key');
  assert.equal(result.kind, 'continue');
  assert.ok(h.store.nextJob(h.run.listeningId));
  assert.equal(h.detail().jobs[0].state, 'pending');
});

test('restart after committed initial output resumes correction without repeating accepted items', async t => {
  const h = fixture(t);
  const first = h.workflow({ extract: async (key, input) => parsed(input, [makeItem('Anthropic', input), makeItem('Akamai', input, { role: null })]) });
  await h.step(first);
  const id = h.detail().knowledge[0].id;
  h.reopen();
  const resumed = h.workflow({
    extract: async () => assert.fail('committed initial output must not be generated again'),
    repair: async (key, input, endpoint, targets) => corrected(input, targets)
  });
  assert.equal((await h.step(resumed)).outcome, 'ok');
  const item = h.detail().knowledge.find(item => item.id === id);
  assert.equal(item.facts.length, 1);
  assert.equal(item.content_version, 1);
});

test('reserved correction with no committed response is not resent after restart', async t => {
  const h = fixture(t);
  await h.step(h.workflow({ extract: async (key, input) => parsed(input, [makeItem('Akamai', input, { role: null })]) }));
  const cp = h.store.knowledgeCheckpoint(h.job.id);
  h.store.saveKnowledgeCheckpoint(h.job.id, { part: { part_no: 0, phase: 'repair_inflight', repair_reserved: 1 }, state: 'running' });
  h.reopen();
  const resumed = h.workflow({
    extract: async () => assert.fail('do not re-extract'), repair: async () => assert.fail('do not resend reserved correction')
  });
  assert.equal((await h.step(resumed)).outcome, 'invalid');
  assert.equal(h.store.knowledgeCheckpoint(h.job.id).parts[0].repair_reserved, 1);
  assert.equal(h.detail().jobs[0].unresolved_count, cp.parts[0].unresolved.length);
});

test('storage errors after a successful response propagate instead of causing a model retry', async t => {
  const h = fixture(t);
  const originalSave = h.store.saveKnowledgeCheckpoint.bind(h.store);
  h.store.saveKnowledgeCheckpoint = (id, patch, accepted = []) => {
    if (accepted.length) throw new TypeError('simulated transaction failure');
    return originalSave(id, patch, accepted);
  };
  const workflow = h.workflow({ extract: async (key, input) => parsed(input, [makeItem('Akamai', input)]) });
  await assert.rejects(h.step(workflow), /simulated transaction failure/);
  assert.equal(h.store.knowledgeCheckpoint(h.job.id).progress.extra_requests, 0);
  assert.equal(h.detail().knowledge.length, 0);
});

test('a lost broadcast cannot turn committed success into a non-retryable partial result', async t => {
  const h = fixture(t);
  const workflow = h.workflow({
    extract: async (key, input) => parsed(input, [makeItem('Akamai', input)]),
    onItems: () => { throw new Error('socket closed after commit'); },
    onError: () => { throw new Error('diagnostics unavailable'); }
  });
  assert.equal((await h.step(workflow)).outcome, 'ok');
  assert.equal(h.detail().knowledge.length, 1, 'detail refresh can recover the lost event');
});

test('repair never revives an observed candidate promoted by accepted initial output', async t => {
  const h = fixture(t);
  const originalInput = h.store.jobInput(h.job);
  h.store.applyKnowledgeV2(h.run.listeningId, parsed(originalInput, [makeItem('Akamai', originalInput, {
    action: 'observe', short_description: null, new_information: null
  })]).items);
  let observedId;
  const workflow = h.workflow({
    extract: async (key, input) => {
      observedId = input.observed_candidates[0].id;
      return parsed(input, [makeItem('Akamai', input, { observed_candidate_id: observedId }),
        makeItem('Akamai', input, { role: null, observed_candidate_id: observedId })]);
    },
    repair: async (key, input, endpoint, targets) => {
      assert.equal(h.store.knowledgeCandidateIds(h.run.listeningId).observed.has(observedId), false);
      assert.equal(input.observed_candidates.some(candidate => candidate.id === observedId), false);
      return parseKnowledgeRepair('{"corrections":[]}', input, targets);
    }
  });
  await h.step(workflow);
  assert.equal((await h.step(workflow)).outcome, 'partial');
  assert.equal(h.detail().knowledge.length, 1);
});

test('unknown correction IDs are discarded and diagnosed without undoing resolved slots', async t => {
  const h = fixture(t);
  const diagnostics = [];
  const workflow = h.workflow({
    extract: async (key, input) => parsed(input, [makeItem('Akamai', input, { role: null })]),
    repair: async (key, input, endpoint, targets) => parseKnowledgeRepair(JSON.stringify({ corrections: [
      { rejection_id: targets[0].rejection_id, item: { ...targets[0].rawItem, role: '主体' } },
      { rejection_id: 'unknown-slot', item: makeItem('Anthropic', input) }
    ] }), input, targets),
    onDiagnostic: (job, part, issues) => diagnostics.push(...issues)
  });
  await h.step(workflow);
  const result = await h.step(workflow);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.summary.protocol_issue_count, 1);
  assert.ok(diagnostics.some(problem => problem.code === 'REPAIR_ID_UNKNOWN'));
  assert.deepEqual(h.detail().knowledge.map(item => item.canonical_name), ['Akamai']);
});

test('deletion while the model responds cannot recreate the record', async t => {
  const h = fixture(t);
  const workflow = h.workflow({ extract: async (key, input) => {
    const output = parsed(input, [makeItem('Akamai', input)]);
    h.store.db.prepare("UPDATE listening_runs SET state='complete' WHERE id=?").run(h.run.runId);
    h.store.removeListening(h.run.listeningId);
    return output;
  } });
  await h.step(workflow);
  assert.equal(h.store.hasListening(h.run.listeningId), false);
  assert.equal(h.seen.length, 0);
});
