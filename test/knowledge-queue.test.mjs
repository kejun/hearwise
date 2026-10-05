import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createKnowledgeScheduler, knowledgeRetryDelay } from '../knowledge-queue.mjs';

const settings = { source: 'zh', targetLang: 'Chinese', audioSource: 'microphone' };
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-09-28T08:00:00Z') });
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-queue-'));
  const store = new ListeningStore(path.join(dir, 'test.sqlite'));
  const keys = new Map(), calls = [], changes = [], logs = [], idle = [];
  let busy = false, sequence = 0;
  const scheduler = createKnowledgeScheduler({ store, listeningIds: () => keys.keys(), keyFor: id => keys.get(id),
    translationBusy: () => busy,
    execute: (job, key) => new Promise((resolve, reject) => calls.push({ job, key, resolve, reject })),
    onChange: (id, flags) => changes.push({ id, flags, processing: store.processing(id) }), onLog: entry => logs.push(entry),
    onIdle: id => idle.push({ id, hasWork: scheduler.hasWork(id) }),
    ...options });
  t.after(() => { scheduler.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = (key = 'test-key', policyVersion = 1) => {
    const r = store.createRun(null, settings, '测试');
    store.db.prepare('UPDATE listenings SET knowledge_policy_version=? WHERE id=?').run(policyVersion, r.listeningId);
    keys.set(r.listeningId, key); return r;
  };
  const add = (r, count = 1, text = 'AlphaFold 是本次讨论的核心系统。') => {
    for (let i = 0; i < count; i++) store.addSegment(r.listeningId, r.runId, { id: String(++sequence), text });
  };
  return { store, scheduler, keys, calls, changes, logs, idle, run, add, setBusy: value => { busy = value; } };
}

test('孤立最终句 1.5 秒后整理，未组批期间已经显示为待处理', async t => {
  const h = harness(t), r = h.run();
  h.add(r); h.scheduler.schedule(r.listeningId);
  assert.equal(h.store.processing(r.listeningId).knowledge.bufferedSegments, 1);
  t.mock.timers.tick(1499); assert.equal(h.calls.length, 0);
  t.mock.timers.tick(1); assert.equal(h.calls.length, 1);
  assert.equal(h.store.processing(r.listeningId).knowledge.runningJobs, 1);
  h.calls[0].resolve(); await settle();
  assert.equal(h.store.detail(r.listeningId).jobs[0].state, 'complete');
  assert.equal(h.logs.at(-1).first_final_age_ms, 1500);
});

test('合批期限固定，不因后续输入被推后', t => {
  const h = harness(t, { batchQuietMs: 3000 }), r = h.run();
  h.add(r); h.scheduler.schedule(r.listeningId);
  t.mock.timers.tick(2500); h.add(r); h.scheduler.schedule(r.listeningId);
  t.mock.timers.tick(1499); assert.equal(h.calls.length, 0);
  t.mock.timers.tick(1); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].job.to_sequence, 2);
});

test('3 句或完整长句立即入队；停止时排空字符上限拆开的所有尾句', t => {
  const h = harness(t), a = h.run(), b = h.run(), c = h.run();
  h.add(a, 3); h.scheduler.schedule(a.listeningId);
  assert.equal(h.calls[0].job.to_sequence, 3);
  h.add(b, 1, '长'.repeat(1200)); h.scheduler.schedule(b.listeningId);
  assert.equal(h.calls.length, 2);
  h.add(c, 3, '长'.repeat(1600)); h.scheduler.schedule(c.listeningId, true);
  assert.equal(h.store.extractionRange(c.listeningId).length, 0);
  assert.deepEqual(h.store.detail(c.listeningId).jobs.map(j => [j.from_sequence, j.to_sequence]), [[1, 1], [2, 2], [3, 3]]);
});

test('慢模型期间相邻积压合为 6 句，同一收听严格串行', async t => {
  const h = harness(t), r = h.run();
  h.add(r, 3); h.scheduler.schedule(r.listeningId);
  h.add(r, 3); h.scheduler.schedule(r.listeningId);
  h.add(r, 3); h.scheduler.schedule(r.listeningId);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.store.detail(r.listeningId).jobs.map(j => [j.from_sequence, j.to_sequence]), [[1, 3], [4, 9]]);
  t.mock.timers.tick(5000);
  h.calls[0].resolve(); await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].job.from_sequence, 4);
});

test('不同收听使用两个槽位并轮流执行，单会话积压不抢占全部机会', async t => {
  const h = harness(t, { minStartIntervalMs: 0 }), a = h.run(), b = h.run(), c = h.run();
  for (const r of [a, b, c]) { h.add(r, 3); h.scheduler.schedule(r.listeningId); }
  h.add(a, 3); h.scheduler.schedule(a.listeningId);
  assert.deepEqual(h.calls.map(c => c.job.listening_id), [a.listeningId, b.listeningId]);
  h.calls[0].resolve(); await settle();
  assert.equal(h.calls[2].job.listening_id, c.listeningId);
  h.calls[1].resolve(); await settle();
  assert.equal(h.calls[3].job.listening_id, a.listeningId);
});

test('翻译持续繁忙仍在让路期限后运行知识任务，并将知识并发限制为 1', async t => {
  const h = harness(t), a = h.run(), b = h.run();
  h.setBusy(true);
  for (const r of [a, b]) { h.add(r, 3); h.scheduler.schedule(r.listeningId); }
  t.mock.timers.tick(1499); assert.equal(h.calls.length, 0);
  t.mock.timers.tick(1); assert.equal(h.calls.length, 1);
  t.mock.timers.tick(3000); assert.equal(h.calls.length, 1);
  h.setBusy(false); h.scheduler.pump();
  assert.equal(h.calls.length, 2);
});

test('翻译提前空闲即可启动，快模型仍遵守每会话 2 秒启动间隔', async t => {
  const h = harness(t), r = h.run(); h.setBusy(true);
  h.add(r, 3); h.scheduler.schedule(r.listeningId);
  t.mock.timers.tick(200); h.setBusy(false); h.scheduler.pump();
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(); await settle();
  h.add(r, 3); h.scheduler.schedule(r.listeningId);
  t.mock.timers.tick(1999); assert.equal(h.calls.length, 1);
  t.mock.timers.tick(1); assert.equal(h.calls.length, 2);
});

test('瞬时失败自动退避，不占槽、不合并新句、不让同会话后续批次越过重试', async t => {
  const h = harness(t), a = h.run('a-key'), b = h.run('b-key');
  h.add(a, 3); h.scheduler.schedule(a.listeningId);
  t.mock.timers.tick(500);
  h.calls[0].reject(Object.assign(new Error('temporary'), { status: 503 })); await settle();
  assert.equal(h.store.processing(a.listeningId).knowledge.retryingJobs, 1);
  h.add(a, 3); h.scheduler.schedule(a.listeningId);
  h.add(b, 3); h.scheduler.schedule(b.listeningId);
  assert.equal(h.calls[1].job.listening_id, b.listeningId);
  assert.deepEqual(h.store.detail(a.listeningId).jobs.map(j => [j.from_sequence, j.to_sequence]), [[1, 3], [4, 6]]);
  t.mock.timers.tick(2000);
  assert.equal(h.calls[2].job.id, h.calls[0].job.id);
  assert.equal(h.calls[2].job.attempts, 2);
  assert.equal(h.logs.find(entry => entry.state === 'running' && entry.attempt === 2).queue_ms, 2000);
  h.calls[2].reject(Object.assign(new Error('temporary'), { status: 503 })); await settle();
  t.mock.timers.tick(7999); assert.equal(h.calls.length, 3);
  t.mock.timers.tick(1); assert.equal(h.calls[3].job.attempts, 3);
  h.calls[3].resolve(); await settle();
  assert.equal(h.store.detail(a.listeningId).jobs[0].state, 'complete');
});

test('429 遵守 Retry-After，同 Key 冷却但其他 Key 不被阻塞', async t => {
  const h = harness(t, { concurrency: 1 }), a = h.run(), b = h.run(), c = h.run('another-key');
  h.add(a, 3); h.scheduler.schedule(a.listeningId);
  h.calls[0].reject(Object.assign(new Error('rate limit'), { status: 429, retryAfterMs: 10000 })); await settle();
  for (const r of [b, c]) { h.add(r, 3); h.scheduler.schedule(r.listeningId); }
  assert.equal(h.calls[1].job.listening_id, c.listeningId);
  h.calls[1].resolve(); await settle();
  t.mock.timers.tick(9999); assert.equal(h.calls.length, 2);
  t.mock.timers.tick(1); assert.equal(h.calls[2].job.listening_id, a.listeningId);
});

test('永久失败保留错误并继续后续批次；手动重试不重置运行中的任务', async t => {
  const h = harness(t, { minStartIntervalMs: 0 }), r = h.run();
  h.add(r, 3); h.scheduler.schedule(r.listeningId);
  h.store.retry(r.listeningId);
  assert.equal(h.store.detail(r.listeningId).jobs[0].state, 'running');
  h.add(r, 3); h.scheduler.schedule(r.listeningId);
  h.calls[0].reject(Object.assign(new Error('Unauthorized'), { status: 401 })); await settle();
  assert.equal(h.store.detail(r.listeningId).jobs[0].state, 'failed');
  assert.equal(h.calls[1].job.from_sequence, 4);
  h.store.retry(r.listeningId);
  assert.deepEqual(h.store.detail(r.listeningId).jobs.map(j => [j.state, j.attempts]), [['pending', 0], ['running', 1]]);
});

test('手动重试重置次数后仍固定原批次范围，不并入新原文', async t => {
  const h = harness(t), r = h.run();
  h.add(r); h.scheduler.schedule(r.listeningId, true);
  h.calls[0].reject(Object.assign(new Error('Unauthorized'), { status: 401 })); await settle();
  h.store.retry(r.listeningId);
  h.add(r, 2); h.scheduler.schedule(r.listeningId, true);
  assert.deepEqual(h.store.detail(r.listeningId).jobs.map(j => [j.from_sequence, j.to_sequence]), [[1, 1], [2, 3]]);
});

test('瞬时错误耗尽 3 次尝试后终止自动重试', async t => {
  const h = harness(t), r = h.run();
  h.add(r, 3); h.scheduler.schedule(r.listeningId);
  for (let attempt = 0; attempt < 3; attempt++) {
    h.calls[attempt].reject(Object.assign(new Error('unavailable'), { status: 503 })); await settle();
    if (attempt < 2) t.mock.timers.tick(attempt === 0 ? 2000 : 8000);
  }
  t.mock.timers.tick(100000);
  assert.equal(h.calls.length, 3);
  assert.equal(h.store.detail(r.listeningId).jobs[0].state, 'failed');
  assert.equal(h.scheduler.hasWork(r.listeningId), false);
});

test('删除收听取消合批；在途完成不会恢复已删除记录', async t => {
  const h = harness(t), a = h.run(), b = h.run();
  h.add(a); h.scheduler.schedule(a.listeningId);
  h.store.finishRun(a.runId); h.store.removeListening(a.listeningId); h.keys.delete(a.listeningId); h.scheduler.remove(a.listeningId);
  t.mock.timers.tick(5000); assert.equal(h.calls.length, 0);
  h.add(b, 3); h.scheduler.schedule(b.listeningId);
  h.store.finishRun(b.runId); h.store.removeListening(b.listeningId); h.keys.delete(b.listeningId); h.scheduler.remove(b.listeningId);
  h.calls[0].resolve(); await settle();
  assert.equal(h.store.hasListening(b.listeningId), false);
});

test('重试时间跨重启保留，无 Key 时等待授权，恢复后不提前重试', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-09-28T08:00:00Z') });
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-restart-'));
  const filename = path.join(dir, 'test.sqlite');
  let store = new ListeningStore(filename);
  const r = store.createRun(null, settings, '重启');
  store.addSegment(r.listeningId, r.runId, { id: '1', text: 'AlphaFold' });
  const job = store.createExtractionJob(r.listeningId, store.extractionRange(r.listeningId));
  store.markJob(job.id, 'running');
  store.markJob(job.id, 'pending', 'temporary', new Date(Date.now() + 8000).toISOString());
  store.close(); store = new ListeningStore(filename);
  let hasKey = false, calls = 0;
  const scheduler = createKnowledgeScheduler({ store, listeningIds: () => [r.listeningId], keyFor: () => hasKey ? 'test-key' : null,
    translationBusy: () => false, execute: async () => { calls++; } });
  t.after(() => { scheduler.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  scheduler.pump(); t.mock.timers.tick(2000); assert.equal(calls, 0);
  hasKey = true; scheduler.pump(); t.mock.timers.tick(5999); assert.equal(calls, 0);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 1);
  assert.equal(store.detail(r.listeningId).jobs[0].attempts, 2);
});

test('重试分类限制次数，参数错误不重试，过长 Retry-After 交给用户继续', () => {
  const transient = Object.assign(new Error('temporary'), { status: 503 });
  assert.deepEqual([1, 2, 3].map(n => knowledgeRetryDelay(transient, n)), [2000, 8000, null]);
  assert.equal(knowledgeRetryDelay({ status: 400 }, 1), null);
  assert.equal(knowledgeRetryDelay({ status: 429, retryAfterMs: 400000 }, 1), null);
  assert.equal(knowledgeRetryDelay({ code: 'KNOWLEDGE_INVALID_RESPONSE' }, 1), 2000);
  assert.equal(knowledgeRetryDelay({ code: 'KNOWLEDGE_INVALID_RESPONSE' }, 2), null);
  assert.equal(knowledgeRetryDelay({ name: 'TimeoutError' }, 1), 2000);
});

test('v2 continuation 释放全局槽但不完成任务，同收听后批不能越过等待的首批', async t => {
  const h = harness(t, { concurrency: 1 }), a = h.run('a-key', 2), b = h.run('b-key', 2);
  const readiness = new Map(), nextJob = h.store.nextJob.bind(h.store);
  t.mock.method(h.store, 'nextJob', id => {
    const job = nextJob(id);
    return job ? { ...job, ready_at: readiness.get(job.id) ?? job.ready_at } : job;
  });
  h.add(a, 3); h.scheduler.schedule(a.listeningId);
  h.add(a, 3); h.scheduler.schedule(a.listeningId);
  h.add(b, 3); h.scheduler.schedule(b.listeningId);
  const first = h.calls[0].job;
  const readyAt = Date.now() + 8000;
  readiness.set(first.id, readyAt);
  // 模拟执行器在原子提交有效项后，持久化 pending 与分片 ready_at。
  h.store.markJob(first.id, 'pending');
  h.calls[0].resolve({ kind: 'continue', readyAt, reason: 'interval', summary: { created_count: 1 } });
  await settle();
  assert.equal(h.store.detail(a.listeningId).jobs[0].state, 'pending');
  assert.equal(h.store.detail(a.listeningId).jobs[0].retry_at, null);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].job.listening_id, b.listeningId);
  assert.ok(h.idle.some(entry => entry.id === a.listeningId && entry.hasWork));
  assert.equal(h.logs.find(entry => entry.state === 'continuing').created_count, 1);
  h.store.markJob(h.calls[1].job.id, 'complete');
  h.calls[1].resolve({ kind: 'terminal', outcome: 'empty' }); await settle();
  t.mock.timers.tick(7999); assert.equal(h.calls.length, 2);
  t.mock.timers.tick(1);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].job.id, first.id);
  assert.equal(h.calls[2].job.attempts, 2);
  h.store.markJob(first.id, 'complete');
  h.calls[2].resolve({ kind: 'terminal', outcome: 'partial', summary: { unresolved_count: 1 } }); await settle();
  t.mock.timers.tick(2000);
  assert.equal(h.calls[3].job.from_sequence, 4);
  assert.equal(h.logs.find(entry => entry.outcome === 'partial').unresolved_count, 1);
});

test('v2 普通分片继续仍遵守两秒间隔，多次派发不受旧失败尝试上限限制', async t => {
  const h = harness(t), r = h.run('test-key', 2);
  h.add(r, 3); h.scheduler.schedule(r.listeningId);
  for (let index = 0; index < 4; index++) {
    const call = h.calls[index];
    h.store.markJob(call.job.id, 'pending');
    call.resolve({ kind: 'continue', readyAt: Date.now(), reason: 'phase' }); await settle();
    t.mock.timers.tick(1999); assert.equal(h.calls.length, index + 1);
    t.mock.timers.tick(1); assert.equal(h.calls.length, index + 2);
  }
  assert.equal(h.calls[4].job.attempts, 5);
  assert.equal(h.logs.filter(entry => entry.state === 'retrying').length, 0);
  assert.equal(h.store.processing(r.listeningId).knowledge.failedJobs, 0);
});

test('v2 已内部处理的纠正 429 仍冷却共享 Key，其他 Key 可继续', async t => {
  const h = harness(t, { concurrency: 1 }), a = h.run('shared-key', 2), b = h.run('shared-key', 2), c = h.run('other-key', 2);
  h.add(a, 3); h.scheduler.schedule(a.listeningId);
  for (const r of [b, c]) { h.add(r, 3); h.scheduler.schedule(r.listeningId); }
  h.store.markJob(h.calls[0].job.id, 'failed', '纠正被限流');
  h.calls[0].resolve({ kind: 'terminal', outcome: 'invalid', rateLimitMs: 10000, summary: { unresolved_count: 2 } });
  await settle();
  assert.equal(h.store.detail(a.listeningId).jobs[0].state, 'failed');
  assert.equal(h.calls[1].job.listening_id, c.listeningId);
  assert.equal(h.logs.find(entry => entry.outcome === 'invalid').state, 'failed');
  h.store.markJob(h.calls[1].job.id, 'complete');
  h.calls[1].resolve({ kind: 'terminal', outcome: 'ok' }); await settle();
  t.mock.timers.tick(9999); assert.equal(h.calls.length, 2);
  t.mock.timers.tick(1); assert.equal(h.calls[2].job.listening_id, b.listeningId);
});

test('v2 未捕获系统错误直接保留失败，不按 TypeError 自动重放已提交内容', async t => {
  const errors = [], h = harness(t, { onError: error => errors.push(error) }), r = h.run('test-key', 2);
  h.add(r, 3); h.scheduler.schedule(r.listeningId);
  h.calls[0].reject(new TypeError('checkpoint write failed')); await settle();
  t.mock.timers.tick(100000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.detail(r.listeningId).jobs[0].state, 'failed');
  assert.equal(h.scheduler.hasWork(r.listeningId), false);
  assert.equal(errors.length, 1);
});

test('v2 数据库升级为 v8，旧运行中 v2 任务隔离等待历史恢复', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-migration-'));
  const filename = path.join(dir, 'test.sqlite');
  let store = new ListeningStore(filename);
  const r = store.createRun(null, settings, '迁移');
  store.addSegment(r.listeningId, r.runId, { id: '1', text: 'AlphaFold' });
  const job = store.createExtractionJob(r.listeningId, store.extractionRange(r.listeningId));
  store.markJob(job.id, 'running');
  store.db.exec(`DROP TABLE extraction_parts;
    ALTER TABLE extraction_jobs DROP COLUMN outcome;
    ALTER TABLE extraction_jobs DROP COLUMN progress_json;
    ALTER TABLE extraction_jobs DROP COLUMN retry_at;
    ALTER TABLE listenings DROP COLUMN notes;
    PRAGMA user_version=2;`);
  store.close(); store = new ListeningStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.equal(store.nextJob(r.listeningId), undefined);
  const migrated = store.detail(r.listeningId).jobs[0];
  assert.equal(migrated.id, job.id);
  assert.equal(migrated.outcome, 'legacy');
  assert.match(migrated.last_error, /LEGACY_RECOVERY_REQUIRED/);
  assert.equal(store.detail(r.listeningId).listening.knowledge_policy_version, 2);
});
