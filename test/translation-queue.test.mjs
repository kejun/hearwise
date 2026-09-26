import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationScheduler } from '../translation-queue.mjs';

const seg = id => ({ id, translation_state: 'pending' });
const task = (id, kind, listeningId = 'l1') => ({ segment: seg(id), listeningId, target: 'Chinese', kind });
function fakeClock() { let t = 0; return { now: () => t, advance: ms => { t += ms; } }; }

test('实时任务优先：最近 2 个待译最终句按源序启动，其余降级排队', () => {
  const s = createTranslationScheduler({ now: () => 0 });
  for (const id of ['s1', 's2', 's3', 's4']) assert.equal(s.enqueue(task(id, 'realtime')), true);
  assert.deepEqual([s.next(), s.next(), s.next(), s.next()].map(t => t.segment.id), ['s3', 's4', 's1', 's2']);
  assert.equal(s.next(), null);
});

test('窗口锁定期间新到的实时句不打断当前窗口', () => {
  const s = createTranslationScheduler({ now: () => 0 });
  s.enqueue(task('s1', 'realtime')); s.enqueue(task('s2', 'realtime')); s.enqueue(task('s3', 'realtime'));
  assert.equal(s.next().segment.id, 's2');
  s.enqueue(task('s4', 'realtime'));
  assert.equal(s.next().segment.id, 's3');
  assert.deepEqual([s.next(), s.next()].map(t => t.segment.id), ['s1', 's4']);
});

test('无实时任务时后台按 FIFO', () => {
  const s = createTranslationScheduler({ now: () => 0 });
  for (const id of ['b1', 'b2', 'b3']) s.enqueue(task(id, 'background'));
  assert.deepEqual([s.next(), s.next(), s.next()].map(t => t.segment.id), ['b1', 'b2', 'b3']);
});

test('防饥饿：连续 3 个实时任务后，等待超 10 秒的最老后台任务获得下一槽位', () => {
  const clock = fakeClock();
  const s = createTranslationScheduler({ now: clock.now });
  s.enqueue(task('b1', 'background'));
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) s.enqueue(task(id, 'realtime'));
  assert.deepEqual([s.next(), s.next(), s.next()].map(t => t.segment.id), ['r4', 'r5', 'r2']);
  // 后台只等了 0ms，不满足饥饿阈值，仍派发实时任务
  assert.equal(s.next().segment.id, 'r3');
  clock.advance(10000);
  // 已连续 4 个实时派发且 b1 等待 ≥10s，下一槽位给最老后台
  assert.equal(s.next().segment.id, 'b1');
  assert.equal(s.next().segment.id, 'r1');
  assert.equal(s.next(), null);
});

test('同一 segment 只保留一个队列身份，删除记录时按 listening 清空', () => {
  const s = createTranslationScheduler({ now: () => 0 });
  assert.equal(s.enqueue(task('s1', 'realtime')), true);
  assert.equal(s.enqueue(task('s1', 'realtime')), false);
  assert.equal(s.length, 1);
  s.enqueue(task('s2', 'background', 'l2'));
  assert.equal(s.hasListening('l2'), true);
  s.remove('l1');
  assert.equal(s.length, 1);
  assert.equal(s.has('s1'), false);
  assert.equal(s.hasListening('l1'), false);
  assert.equal(s.next().segment.id, 's2');
});

test('内存清单超上限时丢弃最老后台任务并标记 dropped（DB pending 可恢复）', () => {
  const s = createTranslationScheduler({ now: () => 0 });
  const tasks = [];
  for (let i = 0; i < 501; i++) {
    const t = task(`b${i}`, 'background');
    tasks.push(t);
    s.enqueue(t);
  }
  assert.equal(s.length, 500);
  assert.equal(tasks[0].dropped, true);
  assert.equal(s.has('b0'), false);
  assert.equal(s.has('b1'), true);
});
