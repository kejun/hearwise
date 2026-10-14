import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationScheduler } from '../translation-queue.mjs';

const task = (id, kind = 'realtime') => ({ segment: { id }, kind, listeningId: 'test', target: 'Chinese' });

test('actual 500 boundary retains every final; 501 realtime entries do not imply a hard capacity', () => {
  const queue = createTranslationScheduler();
  const tasks = Array.from({ length: 501 }, (_, i) => task(`r${i}`));
  for (const item of tasks.slice(0, 500)) assert.equal(queue.enqueue(item), true);
  assert.equal(queue.length, 500); assert.equal(tasks.some(item => item.dropped), false);
  assert.equal(queue.enqueue(tasks[500]), true);
  assert.equal(queue.length, 501);
  assert.equal(tasks.some(item => item.dropped), false);
  for (const item of tasks) assert.equal(queue.has(item.segment.id), true);
});

test('501 boundary evicts exactly the oldest explicit background, not an older realtime', () => {
  const queue = createTranslationScheduler();
  const tasks = Array.from({ length: 501 }, (_, i) => task(`t${i}`, [20, 400].includes(i) ? 'background' : 'realtime'));
  for (const item of tasks) queue.enqueue(item);
  assert.equal(queue.length, 500);
  assert.deepEqual(tasks.filter(item => item.dropped).map(item => item.segment.id), ['t20']);
  assert.equal(queue.has('t0'), true); assert.equal(queue.has('t400'), true); assert.equal(queue.has('t500'), true);
});

test('a new background may itself be evicted behind 500 realtime tasks', () => {
  const queue = createTranslationScheduler();
  for (let i = 0; i < 500; i++) queue.enqueue(task(`r${i}`));
  const background = task('new-background', 'background');
  assert.equal(queue.enqueue(background), true);
  assert.equal(background.dropped, true); assert.equal(queue.has(background.segment.id), false);
  assert.equal(queue.length, 500);
});

test('old realtime remains realtime and has no unconditional background fairness guarantee', () => {
  let time = 0;
  const queue = createTranslationScheduler({ now: () => time });
  queue.enqueue(task('old-realtime'));
  for (let batch = 0; batch < 8; batch++) {
    queue.enqueue(task(`new-${batch}-a`)); queue.enqueue(task(`new-${batch}-b`));
    time += 10000;
    assert.deepEqual([queue.next().segment.id, queue.next().segment.id], [`new-${batch}-a`, `new-${batch}-b`]);
    assert.equal(queue.has('old-realtime'), true);
  }
  assert.equal(queue.next().segment.id, 'old-realtime');
});

test('speech head alternation yields to the aged explicit background at the starvation boundary', () => {
  let time = 0;
  const queue = createTranslationScheduler({ now: () => time });
  queue.enqueue(task('background', 'background'));
  for (let i = 0; i < 6; i++) queue.enqueue(task(`r${i}`));
  queue.setSpeechHead('owner', 'r0'); assert.equal(queue.next().segment.id, 'r0');
  queue.setSpeechHead('owner', 'r1'); assert.equal(queue.next().segment.id, 'r4');
  assert.equal(queue.next().segment.id, 'r1');
  time = 9999; assert.equal(queue.next().segment.id, 'r5');
  queue.setSpeechHead('owner', 'r2'); time = 10000;
  assert.equal(queue.next().segment.id, 'background');
  assert.equal(queue.next().segment.id, 'r2');
});
