import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCaptionController, entryFromSegment, DEFAULT_PARAMS } from '../public/caption-controller.js';

function harness(opts = {}) {
  const clock = { t: 0 };
  const timers = [];
  let nextId = 1;
  const schedule = (delay, fn) => {
    const entry = { id: nextId++, at: clock.t + delay, fn };
    timers.push(entry);
    return () => { const i = timers.indexOf(entry); if (i >= 0) timers.splice(i, 1); };
  };
  const events = { focus: [], bypass: [], changes: 0 };
  const controller = createCaptionController({
    now: () => clock.t, schedule,
    onChange: () => { events.changes++; },
    onFocus: e => events.focus.push(e),
    onBypass: items => events.bypass.push(items),
    ...opts
  });
  const advance = ms => {
    clock.t += ms;
    for (const x of timers.filter(t => t.at <= clock.t).sort((a, b) => a.at - b.at)) {
      const i = timers.indexOf(x);
      if (i >= 0) timers.splice(i, 1);
      x.fn();
    }
  };
  return { controller, events, advance, clock, timers };
}
const fin = (seq, over = {}) => ({ listeningId: 'l1', runId: 'r1', segmentId: `seg${seq}`, sequence: seq, source: `S${seq}`, ...over });
const tr = (seq, over = {}) => ({ listeningId: 'l1', runId: 'r1', segmentId: `seg${seq}`, sequence: seq, source: `S${seq}`,
  target: `T${seq}`, translationState: 'complete', ...over });
const start = (h, gen = 1, runId = 'r1') => h.controller.startRun({ listeningId: 'l1', runId, generation: gen });
const finalThenReady = (h, seq, over = {}) => { h.controller.onFinal(fin(seq, over), 1); h.controller.onTranslation(tr(seq, over), 1); };

test('首个完整译文立即聚焦，无固定等待，minFocus 不约束首条', () => {
  const h = harness();
  start(h);
  h.controller.onFinal(fin(1), 1);
  assert.equal(h.controller.getState().focus, null);
  h.controller.onTranslation(tr(1), 1);
  const focus = h.controller.getState().focus;
  assert.equal(focus.segmentId, 'seg1');
  assert.equal(h.events.focus[0].uiWaitMs, 0);
  assert.equal(h.clock.t, 0);
});

test('FOLLOW 不因迟到译文向后跳：旧句补齐不抢焦点', () => {
  const h = harness();
  start(h);
  finalThenReady(h, 1);
  h.advance(2000);
  h.controller.onFinal(fin(2), 1);           // A 慢
  h.controller.onFinal(fin(3), 1);
  h.controller.onTranslation(tr(3), 1);      // B 快 → grace 250ms 后聚焦 B
  h.advance(250);
  assert.equal(h.controller.getState().focus.segmentId, 'seg3');
  h.controller.onTranslation(tr(2), 1);      // A 迟到 → 原位补齐
  assert.equal(h.controller.getState().focus.segmentId, 'seg3');
  const st = h.controller.getState();
  assert.equal(st.recent.find(it => it.segmentId === 'seg2').target, 'T2');
});

test('缺口 grace 最多等 250ms，且计时不被新事件重置', () => {
  const h = harness({ params: { targetFocusMs: 800 } }); // 缩短 target 以隔离 grace 行为
  start(h);
  finalThenReady(h, 1);
  h.advance(1000);
  h.controller.onFinal(fin(2), 1);           // 前序 pending
  h.controller.onFinal(fin(3), 1);
  h.controller.onTranslation(tr(3), 1);      // 后序 ready → reorderStartedAt=1000
  h.advance(100);
  h.controller.onFinal(fin(4), 1);           // 新事件不得重置 grace 计时
  h.controller.onTranslation(tr(4), 1);
  assert.equal(h.controller.getState().focus.segmentId, 'seg1'); // t=1100，grace 未过
  h.advance(150); // t=1250 = 1000+250
  assert.equal(h.controller.getState().focus.segmentId, 'seg3'); // 候选为最早 ready，跨过 pending 的 seg2
});

test('积压 ≥3 条 ready 时一次追赶最新，越过的条目记 bypass 且不删除', () => {
  const h = harness();
  start(h);
  finalThenReady(h, 1);
  h.advance(100);
  // 批量到达落在 minFocus 窗口内：800ms 唤醒时已积压 3 条 ready → 一次追赶最新
  for (const s of [2, 3, 4]) h.controller.onFinal(fin(s), 1);
  for (const s of [2, 3, 4]) h.controller.onTranslation(tr(s), 1);
  assert.equal(h.controller.getState().focus.segmentId, 'seg1'); // minFocus 未到，先不切
  h.advance(700); // t=800
  assert.equal(h.controller.getState().focus.segmentId, 'seg4');
  const bypassed = h.events.bypass.flat().map(it => it.segmentId);
  assert.deepEqual(bypassed, ['seg2', 'seg3']);
  const st = h.controller.getState();
  assert.equal(st.counts.bypassed, 2);
  assert.equal(st.counts.total, 4); // 条目保持有序记录，未删除
});

test('UI 等待预算：ready 到显示不超过 maxReadyUiWaitMs', () => {
  const h = harness();
  start(h);
  finalThenReady(h, 1);            // focusStartedAt=0
  h.advance(50);
  finalThenReady(h, 2);            // readyReceivedAt=50；minFocus 挡到 800，target 1600，预算 1550
  assert.equal(h.controller.getState().focus.segmentId, 'seg1');
  h.advance(750);                  // t=800：仍在 target 门内
  assert.equal(h.controller.getState().focus.segmentId, 'seg1');
  h.advance(750);                  // t=1550 = 50+1500：预算到期，聚焦
  const e = h.events.focus.at(-1);
  assert.equal(e.item.segmentId, 'seg2');
  assert.equal(e.focusedAt, 1550);
  assert.equal(e.uiWaitMs, 1500);
});

test('minFocusMs 保护已显示条目：800ms 内不换', () => {
  const h = harness({ params: { targetFocusMs: 800 } });
  start(h);
  finalThenReady(h, 1);
  h.advance(300);
  finalThenReady(h, 2);
  h.advance(499); // t=799
  assert.equal(h.controller.getState().focus.segmentId, 'seg1');
  h.advance(1);   // t=800 = min 门限（target 同为 800）
  assert.equal(h.controller.getState().focus.segmentId, 'seg2');
});

test('REVIEW 冻结焦点、原位补齐、backToLatest 返回最新并报告更新数', () => {
  const h = harness();
  start(h);
  finalThenReady(h, 1);
  h.advance(1000);
  h.controller.enterReview();
  h.controller.onFinal(fin(2), 1);
  h.controller.onTranslation(tr(2), 1);
  h.advance(5000);
  assert.equal(h.controller.getState().focus.segmentId, 'seg1');
  assert.equal(h.controller.getState().counts.newer, 1);
  const { updatedCount } = h.controller.backToLatest();
  assert.equal(updatedCount, 1);
  assert.equal(h.controller.getState().focus.segmentId, 'seg2');
  assert.equal(h.controller.getState().mode, 'FOLLOW');
});

test('backToLatest 无完整译文时定位最新 final 原文并标记等待译文', () => {
  const h = harness();
  start(h);
  h.controller.onFinal(fin(1), 1);
  h.controller.onFinal(fin(2), 1);
  const { updatedCount } = h.controller.backToLatest();
  assert.equal(updatedCount, 2);
  const e = h.events.focus.at(-1);
  assert.equal(e.item.segmentId, 'seg2');
  assert.equal(e.waitingTranslation, true);
  h.advance(DEFAULT_PARAMS.pendingHintMs);
  assert.equal(h.controller.getState().hint, 'translating');
  h.advance(DEFAULT_PARAMS.slowTranslationMs);
  assert.equal(h.controller.getState().hint, 'slow-translation');
});

test('旧 run / 旧 generation 事件只补自己的记录，不动当前焦点', () => {
  const h = harness();
  start(h, 1, 'r1');
  h.controller.onFinal(fin(1), 1);
  start(h, 2, 'r2'); // 新 run：焦点状态重置
  h.controller.onFinal({ ...fin(1, { runId: 'r2' }), segmentId: 'seg10' }, 2);
  h.controller.onTranslation({ ...tr(1, { runId: 'r2' }), segmentId: 'seg10' }, 2);
  assert.equal(h.controller.getState().focus.segmentId, 'seg10');
  // 旧 run 迟到译文：只补 r1 的行
  const late = h.controller.onTranslation(tr(1), 1);
  assert.equal(late.item.target, 'T1');
  assert.equal(h.controller.getState().focus.segmentId, 'seg10');
  // 当前 run 的过期 generation：不触发调度
  h.controller.onFinal({ ...fin(2, { runId: 'r2' }), segmentId: 'seg11' }, 1);
  h.controller.onTranslation({ ...tr(2, { runId: 'r2' }), segmentId: 'seg11' }, 1);
  assert.equal(h.controller.getState().focus.segmentId, 'seg10'); // 未追赶
  h.controller.onTranslation({ ...tr(2, { runId: 'r2' }), segmentId: 'seg11' }, 1); // complete 不回退
  // 未跟踪 run 的事件被忽略
  assert.equal(h.controller.onFinal({ ...fin(9), runId: 'rX' }, 1).ignored, true);
});

test('complete 不回退；重复 final 幂等；冲突 final 记录不覆盖', () => {
  const h = harness();
  start(h);
  h.controller.onFinal(fin(1), 1);
  h.controller.onTranslation(tr(1), 1);
  assert.equal(h.controller.onTranslation({ ...tr(1), translationState: 'pending', target: null }, 1).unchanged, true);
  assert.equal(h.controller.onTranslation({ ...tr(1), translationState: 'failed', target: null }, 1).unchanged, true);
  assert.equal(h.controller.getState().focus.target, 'T1');
  assert.equal(h.controller.onFinal(fin(1), 1).duplicate, true);
  const conflict = h.controller.onFinal({ ...fin(1), source: '不同文本' }, 1);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.item.source, 'S1');
  assert.equal(h.controller.conflicts.length, 1);
});

test('loadSnapshot 恢复后 backToLatest 直接定位最新完整译文，不从头闪播', () => {
  const h = harness();
  const entries = [1, 2, 3, 4, 5].map(s => ({ ...fin(s), target: s <= 3 ? `T${s}` : null,
    translationState: s <= 3 ? 'complete' : 'pending', readyReceivedAt: s <= 3 ? 0 : null }));
  h.controller.loadSnapshot({ listeningId: 'l1', runId: 'r1', generation: 7 }, entries);
  const { updatedCount } = h.controller.backToLatest();
  assert.equal(updatedCount, 5);
  assert.equal(h.controller.getState().focus.segmentId, 'seg3');
  assert.equal(h.events.focus.length, 1); // 只聚焦一次，无逐条闪播
});

test('后台隐藏期间不推进焦点，恢复可见一次追赶最新', () => {
  const h = harness();
  start(h);
  finalThenReady(h, 1);
  h.controller.setHidden(true);
  h.advance(1000);
  for (const s of [2, 3, 4]) { h.controller.onFinal(fin(s), 1); h.controller.onTranslation(tr(s), 1); }
  h.advance(5000);
  assert.equal(h.controller.getState().focus.segmentId, 'seg1');
  h.controller.setHidden(false);
  assert.equal(h.controller.getState().focus.segmentId, 'seg4'); // ≥3 积压 → 直接最新
});

test('草稿区独立：partial 只进 draft，对应 final 到达后清空', () => {
  const h = harness();
  start(h);
  h.controller.onDraft({ sentenceId: 'seg1', text: 'hello wor' });
  assert.equal(h.controller.getState().draft.text, 'hello wor');
  assert.equal(h.controller.getState().focus, null); // 草稿不影响焦点
  h.controller.onFinal(fin(1), 1);
  assert.equal(h.controller.getState().draft, null);
  assert.equal(h.controller.getState().hint, 'waiting-next');
});

test('entryFromSegment 归一化数据库行', () => {
  const entry = entryFromSegment({ listening_id: 'l', run_id: 'r', id: 's', sequence_no: 3,
    original_text: 'hi', translated_text: '你好', translation_state: 'complete', end_ms: 1200, asr_sentence_id: 7 });
  assert.deepEqual(entry, { listeningId: 'l', runId: 'r', segmentId: 's', sequence: 3,
    source: 'hi', target: '你好', translationState: 'complete', sourceEndMs: 1200, asrSentenceId: '7' });
});
