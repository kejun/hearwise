import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-checkpoint-'));
  const filename = path.join(dir, 'store.sqlite');
  let store = new ListeningStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = store.createRun(null, settings, 'Checkpoint');
  const segment = store.addSegment(run.listeningId, run.runId, { id: 's1', text: 'Anthropic partners with Akamai. Seth reports the deal.' }).segment;
  const job = store.createExtractionJob(run.listeningId, [segment]);
  const part = { part_no: 0, focus_refs: [{ segment_id: segment.id, start: 0, end: segment.original_text.length }] };
  const initialize = () => store.initializeKnowledgeParts(job.id, [part], 'v2.1');
  return { get store() { return store; }, run, segment, job, part, initialize,
    reopen() { store.close(); store = new ListeningStore(filename); return store; } };
}
const entry = (segment, patch = {}) => ({
  action: 'create', type: 'other', display_label: 'organization', canonical_name: 'Anthropic',
  role: '交易主体', reason: '本段讨论的公司', existing_item_id: null, observed_candidate_id: null,
  aliases: [], short_description: '与 Akamai 合作的公司', new_information: 'Anthropic 与 Akamai 合作。',
  certainty: 'clear', correction_reason: null, evidence: [{ segment_id: segment.id, quote: 'Anthropic partners with Akamai.' }], ...patch
});
const rejected = (sourceIndex = 1) => ({ sourceIndex, name: 'Akamai', item: { canonical_name: 'Akamai' },
  issues: [{ code: 'DESCRIPTION_REQUIRED', path: 'short_description', details: {} }] });

test('知识与检查点同事务提交，失败整体回滚，已提交 sourceIndex 不重复执行', t => {
  const h = fixture(t); h.initialize();
  const item = entry(h.segment);
  assert.throws(() => h.store.saveKnowledgeCheckpoint(h.job.id, { part: { part_no: 0, phase: 'repair_pending',
    unresolved: [rejected()], input_snapshot: { payload: 'x'.repeat(30001) } } }, [{ sourceIndex: 0, item }]), /载荷/);
  assert.equal(h.store.knowledge(h.run.listeningId).length, 0);
  assert.equal(h.store.knowledgeCheckpoint(h.job.id).parts[0].results.length, 0);
  const first = h.store.saveKnowledgeCheckpoint(h.job.id, { state: 'pending', part: { part_no: 0, phase: 'repair_pending',
    unresolved: [rejected()], stats: { initial_complete: true } } }, [{ sourceIndex: 0, item }]);
  assert.equal(first.changedItems.length, 1);
  assert.equal(first.results[0].status, 'created');
  assert.ok(h.store.knowledgeCheckpoint(h.job.id).progress.first_content_at);
  h.reopen();
  const again = h.store.saveKnowledgeCheckpoint(h.job.id, { part: { part_no: 0, unresolved: [rejected(0), rejected()] } },
    [{ sourceIndex: 0, item: { ...item, new_information: '重放时不能写入这个新事实。' } }]);
  assert.equal(again.changedItems.length, 0);
  assert.equal(again.part.results.length, 1);
  assert.deepEqual(again.part.unresolved.map(value => value.sourceIndex), [1]);
  assert.equal(h.store.knowledge(h.run.listeningId)[0].facts.length, 1);
  assert.equal(h.store.knowledge(h.run.listeningId)[0].content_version, 1);
  const dto = h.store.detail(h.run.listeningId).jobs[0];
  assert.equal('progress_json' in dto, false);
  assert.equal('parts' in dto, false);
  assert.equal(dto.resolved_count, 1);
  assert.equal(dto.unresolved_count, 1);
});

test('实际处理结果区分更新、重复和身份暂缓，可见卡片按 ID 去重', t => {
  const h = fixture(t); h.initialize();
  const first = h.store.saveKnowledgeCheckpoint(h.job.id, { part: { part_no: 0 } }, [{ sourceIndex: 0, item: entry(h.segment) }]);
  const itemId = first.changedItems[0].id;
  const update = entry(h.segment, { action: 'update', existing_item_id: itemId });
  const saved = h.store.saveKnowledgeCheckpoint(h.job.id, { state: 'complete', outcome: 'partial', part: { part_no: 0,
    phase: 'done', unresolved: [rejected(8)] } }, [
    { sourceIndex: 1, item: update },
    { sourceIndex: 2, item: { ...update, new_information: '公司正在扩充算力。' } },
    { sourceIndex: 3, item: { ...update, new_information: '公司需要更多数据中心。' } },
    { sourceIndex: 4, item: entry(h.segment, { new_information: '另一个同名公司的事实。' }) },
    { sourceIndex: 5, item: entry(h.segment, { action: 'observe', canonical_name: 'Akamai' }) },
    { sourceIndex: 6, item: entry(h.segment, { action: 'exclude', canonical_name: 'Seth' }) },
    { sourceIndex: 7, item: entry(h.segment, { action: 'update', existing_item_id: 'unknown' }) }
  ]);
  assert.deepEqual(saved.results.map(result => result.status), ['repeated', 'updated', 'updated', 'deferred_identity', 'observed', 'excluded', 'deferred_identity']);
  assert.equal(saved.changedItems.length, 1);
  const card = h.store.knowledge(h.run.listeningId)[0];
  assert.equal(card.content_version, 3);
  assert.equal(card.facts.length, 3);
  const dto = h.store.detail(h.run.listeningId).jobs[0];
  assert.equal(dto.visible_change_count, 1);
  assert.equal(dto.resolved_count, 8);
  assert.equal(h.store.processing(h.run.listeningId).knowledge.visibleChangeCount, 1);
});

test('重启保留抽取预算，已预约纠正不自动重发并记录中断', t => {
  const h = fixture(t);
  h.store.initializeKnowledgeParts(h.job.id, [h.part, { ...h.part, part_no: 1 }]);
  h.store.saveKnowledgeCheckpoint(h.job.id, { state: 'running', progress: { extra_requests: 2, protocol_retries: 1, last_request_at: 1000 },
    part: { part_no: 0, phase: 'extract_inflight', initial_requests: 3 } });
  h.store.saveKnowledgeCheckpoint(h.job.id, { part: { part_no: 1, phase: 'repair_inflight', repair_reserved: true,
    unresolved: [rejected()], stats: { initial_complete: true } } });
  h.reopen();
  const checkpoint = h.store.knowledgeCheckpoint(h.job.id);
  assert.equal(checkpoint.job.state, 'pending');
  assert.equal(checkpoint.parts[0].phase, 'extract_pending');
  assert.equal(checkpoint.parts[0].initial_requests, 3);
  assert.equal(checkpoint.progress.extra_requests, 2);
  assert.equal(checkpoint.progress.protocol_retries, 1);
  assert.equal(checkpoint.parts[1].phase, 'done');
  assert.equal(checkpoint.parts[1].repair_reserved, 1);
  assert.equal(checkpoint.parts[1].unresolved[0].issues.at(-1).code, 'REPAIR_INTERRUPTED');
  assert.equal(h.store.nextJob(h.run.listeningId).ready_at, 3000);
});

test('人工继续仅重开未解决工作，重复点击不重置在途预算', t => {
  const h = fixture(t);
  h.store.initializeKnowledgeParts(h.job.id, [h.part, { ...h.part, part_no: 1 }, { ...h.part, part_no: 2 }]);
  h.store.saveKnowledgeCheckpoint(h.job.id, { part: { part_no: 0, phase: 'done', initial_requests: 1,
    stats: { initial_complete: true } } }, [{ sourceIndex: 0, item: entry(h.segment) }]);
  h.store.saveKnowledgeCheckpoint(h.job.id, { part: { part_no: 1, phase: 'done', initial_requests: 1, repair_reserved: true,
    unresolved: [rejected()], stats: { initial_complete: true, repair_error: 'REPAIR_INTERRUPTED' } } });
  h.store.saveKnowledgeCheckpoint(h.job.id, { state: 'complete', outcome: 'partial', progress: { extra_requests: 2, protocol_retries: 1 },
    part: { part_no: 2, phase: 'done', initial_requests: 3, stats: { initial_complete: false, failure_code: 'NETWORK_ERROR' } } });
  assert.equal(h.store.retry(h.run.listeningId), 1);
  let checkpoint = h.store.knowledgeCheckpoint(h.job.id);
  assert.equal(checkpoint.progress.cycle, 2);
  assert.equal(checkpoint.progress.extra_requests, 0);
  assert.equal(checkpoint.progress.protocol_retries, 0);
  assert.equal(checkpoint.parts[0].phase, 'done');
  assert.equal(checkpoint.parts[0].results.length, 1);
  assert.equal(checkpoint.parts[1].phase, 'repair_pending');
  assert.equal(checkpoint.parts[1].initial_requests, 1);
  assert.equal(checkpoint.parts[1].repair_reserved, 0);
  assert.equal(checkpoint.parts[2].phase, 'extract_pending');
  assert.equal(checkpoint.parts[2].initial_requests, 0);
  h.store.saveKnowledgeCheckpoint(h.job.id, { state: 'running', progress: { extra_requests: 1 }, part: { part_no: 1, repair_reserved: true } });
  assert.equal(h.store.retry(h.run.listeningId), 0);
  checkpoint = h.store.knowledgeCheckpoint(h.job.id);
  assert.equal(checkpoint.progress.cycle, 2);
  assert.equal(checkpoint.progress.extra_requests, 1);
  assert.equal(checkpoint.parts[1].repair_reserved, 1);
  assert.equal(h.store.knowledge(h.run.listeningId).length, 1);
});

test('v3 遗留 v2 包括 attempts=0 的任务隔离，已完成 legacy 不重跑，v1 可重试', t => {
  const h = fixture(t);
  const time = new Date().toISOString();
  for (const [id, policy, state, sequence] of [['old-complete', 2, 'complete', 2], ['old-failed', 2, 'failed', 3], ['old-v1', 1, 'failed', 4]]) {
    h.store.db.prepare(`INSERT INTO extraction_jobs (id,listening_id,from_sequence,to_sequence,prompt_version,state,attempts,created_at,updated_at)
      VALUES (?,?,?,?,?,?,0,?,?)`).run(id, h.run.listeningId, sequence, sequence, policy, state, time, time);
  }
  h.store.applyKnowledgeV2(h.run.listeningId, [entry(h.segment)]); // 旧任务已有部分写入，再被人工重置为 pending/0。
  h.store.db.exec('DROP TABLE extraction_parts; ALTER TABLE extraction_jobs DROP COLUMN outcome; ALTER TABLE extraction_jobs DROP COLUMN progress_json; ALTER TABLE listenings DROP COLUMN notes; PRAGMA user_version=3;');
  h.reopen();
  assert.equal(h.store.db.prepare('PRAGMA user_version').get().user_version, 6);
  let jobs = h.store.detail(h.run.listeningId).jobs;
  for (const id of [h.job.id, 'old-failed']) {
    const job = jobs.find(value => value.id === id);
    assert.equal(job.state, 'failed'); assert.equal(job.outcome, 'legacy'); assert.equal(job.last_error, 'LEGACY_RECOVERY_REQUIRED');
  }
  assert.equal(jobs.find(value => value.id === 'old-complete').state, 'complete');
  assert.equal(jobs.find(value => value.id === 'old-complete').outcome, 'legacy');
  assert.equal(h.store.processing(h.run.listeningId).knowledge.legacyRecoveryJobs, 2);
  assert.equal(h.store.processing(h.run.listeningId).knowledge.failedJobs, 1);
  h.store.retry(h.run.listeningId);
  jobs = h.store.detail(h.run.listeningId).jobs;
  assert.equal(jobs.find(value => value.id === 'old-v1').state, 'pending');
  assert.equal(jobs.find(value => value.id === h.job.id).state, 'failed');
  assert.equal(h.store.knowledge(h.run.listeningId).length, 1);
});

test('候选保留最新说明和完整事实，上限为每项600/整体3600，不截断事实', t => {
  const h = fixture(t);
  const created = h.store.applyKnowledgeV2(h.run.listeningId, [entry(h.segment, { short_description: 'd'.repeat(180), new_information: 'old fact' })])[0];
  for (const content of ['recent complete fact', 'n'.repeat(500)]) {
    h.store.applyKnowledgeV2(h.run.listeningId, [entry(h.segment, { action: 'update', existing_item_id: created.id,
      short_description: 'new '.repeat(45), new_information: content })]);
  }
  let input = h.store.jobInput(h.job);
  assert.equal(input.existing_candidates[0].short_description, 'new '.repeat(45));
  assert.deepEqual(input.existing_candidates[0].recent_facts, ['recent complete fact']);
  for (let index = 0; index < 11; index++) h.store.applyKnowledgeV2(h.run.listeningId, [entry(h.segment, {
    canonical_name: `Other ${index}`, short_description: 'd'.repeat(180), new_information: 'f'.repeat(400)
  })]);
  input = h.store.jobInput(h.job);
  assert.equal(input.existing_candidates.length, 12);
  const lengths = input.existing_candidates.map(candidate => candidate.short_description.length + candidate.recent_facts.reduce((n, fact) => n + fact.length, 0));
  assert.ok(lengths.every(length => length <= 600));
  assert.ok(lengths.reduce((sum, length) => sum + length, 0) <= 3600);
});

test('检查点不存凭据，删除级联且迟到提交不能复活收听', t => {
  const h = fixture(t); h.initialize();
  assert.throws(() => h.store.saveKnowledgeCheckpoint(h.job.id, { progress: { apiKey: 'do-not-store' } }), /凭据/);
  h.store.finishRun(h.run.runId);
  assert.equal(h.store.removeListening(h.run.listeningId), 'deleted');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM extraction_parts').get().n, 0);
  assert.throws(() => h.store.saveKnowledgeCheckpoint(h.job.id, { part: { part_no: 0 } }, [{ sourceIndex: 0, item: entry(h.segment) }]));
  assert.equal(h.store.knowledge(h.run.listeningId).length, 0);
});

test('v4 新建任务重启保持可初始化，未知契约拒绝重新解释检查点', t => {
  const h = fixture(t); h.reopen();
  assert.equal(h.store.knowledgeCheckpoint(h.job.id).job.outcome, null);
  h.initialize();
  assert.equal(h.store.knowledgeCheckpoint(h.job.id).parts.length, 1);
  const before = h.store.knowledgeCheckpoint(h.job.id).parts[0].focus_refs;
  h.store.initializeKnowledgeParts(h.job.id, [{ ...h.part, focus_refs: [] }]);
  assert.deepEqual(h.store.knowledgeCheckpoint(h.job.id).parts[0].focus_refs, before);
  h.store.saveKnowledgeCheckpoint(h.job.id, { progress: { contract_revision: 'v99' }, state: 'failed', outcome: 'invalid' });
  assert.equal(h.store.retry(h.run.listeningId), 0);
});

test('429 冷却持久化，完成任务的 Retry-After 跨重启约束同收听后续任务', t => {
  const h = fixture(t); h.initialize();
  h.store.saveKnowledgeCheckpoint(h.job.id, { state: 'complete', outcome: 'partial',
    progress: { last_request_at: 1000, rate_limit_until: 61000 },
    part: { part_no: 0, phase: 'done', unresolved: [rejected()], stats: { initial_complete: true } } });
  const segment = h.store.addSegment(h.run.listeningId, h.run.runId, { id: 's2', text: 'Akamai expands computing capacity.' }).segment;
  const next = h.store.createExtractionJob(h.run.listeningId, [segment]);
  const another = h.store.createRun(null, settings, 'Another listening');
  const otherSegment = h.store.addSegment(another.listeningId, another.runId, { id: 's1', text: 'Unrelated recording.' }).segment;
  h.store.createExtractionJob(another.listeningId, [otherSegment]);
  h.reopen();
  assert.equal(h.store.nextJob(h.run.listeningId).id, next.id);
  assert.equal(h.store.nextJob(h.run.listeningId).ready_at, 61000);
  assert.equal(h.store.nextJob(another.listeningId).ready_at, 0);
  assert.equal(h.store.knowledgeCheckpoint(next.id).progress.rate_limit_until, undefined);
});

test('纠正候选存活集合排除已晋升/排除的观察对象，保留未进入 topN 的真实目标', t => {
  const h = fixture(t);
  h.store.applyKnowledgeV2(h.run.listeningId, [entry(h.segment, { action: 'observe' })]);
  const observedId = h.store.jobInput(h.job).observed_candidates[0].id;
  assert.ok(h.store.knowledgeCandidateIds(h.run.listeningId).observed.has(observedId));
  const promoted = h.store.applyKnowledgeV2(h.run.listeningId, [entry(h.segment, { observed_candidate_id: observedId })])[0];
  assert.equal(h.store.knowledgeCandidateIds(h.run.listeningId).observed.has(observedId), false);
  assert.ok(h.store.knowledgeCandidateIds(h.run.listeningId).existing.has(promoted.id));
  h.store.applyKnowledgeV2(h.run.listeningId, [entry(h.segment, { action: 'observe', canonical_name: 'Seth' })]);
  const laterObserved = h.store.jobInput(h.job).observed_candidates[0].id;
  h.store.applyKnowledgeV2(h.run.listeningId, [entry(h.segment, { action: 'exclude', canonical_name: 'Seth', observed_candidate_id: laterObserved })]);
  assert.equal(h.store.knowledgeCandidateIds(h.run.listeningId).observed.has(laterObserved), false);
  for (let index = 0; index < 14; index++) h.store.applyKnowledgeV2(h.run.listeningId, [entry(h.segment, { canonical_name: `Other ${index}` })]);
  const newest = h.store.jobInput(h.job, [{ id: h.segment.id, text: 'Unrelated pronoun.' }]);
  assert.equal(newest.existing_candidates.some(candidate => candidate.id === promoted.id), false);
  assert.ok(h.store.knowledgeCandidateIds(h.run.listeningId).existing.has(promoted.id));
  const another = h.store.createRun(null, settings, 'Other recording');
  assert.equal(h.store.knowledgeCandidateIds(another.listeningId).existing.has(promoted.id), false);
});

test('人工新周期只统计本周期可见变化，累计已处理 sourceIndex 保持不变', t => {
  const h = fixture(t); h.initialize();
  h.store.saveKnowledgeCheckpoint(h.job.id, { state: 'complete', outcome: 'partial',
    part: { part_no: 0, phase: 'done', unresolved: [rejected(1), rejected(2)], stats: { initial_complete: true } } },
  [{ sourceIndex: 0, item: entry(h.segment) }]);
  assert.equal(h.store.detail(h.run.listeningId).jobs[0].visible_change_count, 1);
  h.store.retry(h.run.listeningId);
  assert.equal(h.store.detail(h.run.listeningId).jobs[0].visible_change_count, 0);
  h.store.saveKnowledgeCheckpoint(h.job.id, { state: 'complete', outcome: 'partial',
    part: { part_no: 0, phase: 'done' } }, [{ sourceIndex: 1, item: entry(h.segment, { canonical_name: 'Akamai', new_information: 'Akamai 参与合作。' }) }]);
  const checkpoint = h.store.knowledgeCheckpoint(h.job.id);
  assert.deepEqual(checkpoint.parts[0].results.map(result => result.cycle), [1, 2]);
  const job = h.store.detail(h.run.listeningId).jobs[0];
  assert.equal(job.resolved_count, 2);
  assert.equal(job.visible_change_count, 1);
  assert.equal(h.store.processing(h.run.listeningId).knowledge.visibleChangeCount, 1);
  assert.equal(h.store.knowledge(h.run.listeningId).length, 2);
});
