import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processingView, createProcessingPoller } from '../public/processing-state.js';

const snapshot = (knowledge = {}, extra = {}) => ({ segments: [], jobs: [], processingAvailable: true,
  processing: { pendingTranslations: 0, failedTranslations: 0, knowledge }, ...extra });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('尚未组批也显示整理中；自动重试与需要手动继续的状态区分', () => {
  assert.deepEqual(processingView(snapshot({ bufferedSegments: 1 })), { text: '知识整理中', pending: 1, canRetry: false });
  assert.equal(processingView(snapshot({ retryingJobs: 1 })).text, '知识稍后自动重试');
  assert.equal(processingView(snapshot({ retryingJobs: 1 })).canRetry, false);
  assert.equal(processingView(snapshot({ pendingJobs: 1 }, { processingAvailable: false })).canRetry, true);
  assert.match(processingView(snapshot({ pendingJobs: 1 }, { processingAvailable: false })).text, /需 API Key/);
  assert.equal(processingView(snapshot({ failedJobs: 1 })).canRetry, true);
  assert.equal(processingView(snapshot()).text, '已处理');
});

test('部分未解决和全部拒绝均提供继续处理，但不当成自动待处理', () => {
  assert.deepEqual(processingView(snapshot({ partialJobs: 1, unresolvedItems: 2 })),
    { text: '部分知识未能整理', pending: 0, canRetry: true });
  assert.deepEqual(processingView(snapshot({ failedJobs: 1, unresolvedItems: 3 })),
    { text: '知识整理失败', pending: 0, canRetry: true });
  for (const [state, outcome, text] of [
    ['complete', 'partial', '部分知识未能整理'], ['failed', 'invalid', '知识整理失败']
  ]) {
    assert.deepEqual(processingView({ jobs: [{ state, outcome, summary: { visibleChangeCount: 0 } }] }),
      { text, pending: 0, canRetry: true });
  }
});

test('合法空结果和仅观察/排除的有效结果正常结束，不按卡片数报警', () => {
  for (const outcome of ['empty', 'ok', 'legacy']) {
    assert.deepEqual(processingView({ jobs: [{ state: 'complete', outcome, summary: { visibleChangeCount: 0 } }] }),
      { text: '已处理', pending: 0, canRetry: false });
  }
});

test('补全阶段只改变文案，不重复累加排队与执行数量', () => {
  const detail = snapshot({ pendingJobs: 1, retryingJobs: 1, runningJobs: 1,
    repairPendingJobs: 1, repairingJobs: 1, unresolvedItems: 3 });
  assert.deepEqual(processingView(detail), {
    text: '知识整理中，正在补全部分条目 · 知识稍后自动重试', pending: 3, canRetry: false
  });
  assert.deepEqual(processingView({ ...detail, processingAvailable: false }), {
    text: '内容待继续处理（需 API Key）', pending: 3, canRetry: true
  });
  assert.equal(processingView({ processingAvailable: true,
    jobs: [{ state: 'pending', retry_at: '2026-09-28T00:00:00Z' }, { state: 'pending', retry_at: null }] }).pending, 2);
});

test('历史恢复任务只提示，不单独显示无效的继续处理入口', () => {
  assert.deepEqual(processingView(snapshot({ legacyRecoveryJobs: 2 })),
    { text: '历史任务需重新核对', pending: 0, canRetry: false });
  assert.deepEqual(processingView({ jobs: [{ state: 'failed', outcome: 'legacy' }] }),
    { text: '历史任务需重新核对', pending: 0, canRetry: false });
});

test('混合翻译失败、知识失败及历史恢复提示时仍能继续真正可重试的工作', () => {
  assert.deepEqual(processingView({ processingAvailable: true,
    segments: [{ translation_state: 'failed' }, { translation_state: 'pending' }],
    jobs: [{ state: 'failed', outcome: 'invalid' }, { state: 'complete', outcome: 'partial' },
      { state: 'failed', outcome: 'legacy' }] }), {
    text: '1 项译文处理失败 · 知识整理失败 · 部分知识未能整理 · 历史任务需重新核对 · 译文处理中',
    pending: 1, canRetry: true
  });
});

test('停止后立即查询，网络短暂失败后自动恢复，到全部完成才停止', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const poller = createProcessingPoller({ isCurrent: () => true, read: async () => {
    calls++;
    if (calls === 1) throw new Error('network');
    return calls === 2 ? snapshot({ runningJobs: 1 }) : snapshot();
  } });
  t.after(() => poller.stop());
  poller.start('a'); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(3999); assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(2000); await settle(); assert.equal(calls, 3);
  t.mock.timers.tick(30000); assert.equal(calls, 3);
});

test('部分或全部未解决的终态停止轮询，人工继续后可以恢复', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const knowledge of [{ partialJobs: 1, unresolvedItems: 2 }, { failedJobs: 1, unresolvedItems: 3 }]) {
    let calls = 0, current = snapshot(knowledge);
    const poller = createProcessingPoller({ isCurrent: () => true,
      read: async () => { calls++; return current; } });
    t.after(() => poller.stop());
    poller.start('a'); await settle();
    t.mock.timers.tick(30000); assert.equal(calls, 1);
    current = snapshot({ pendingJobs: 1, repairPendingJobs: 1 });
    poller.start('a'); await settle(); assert.equal(calls, 2);
    t.mock.timers.tick(2000); await settle(); assert.equal(calls, 3);
    current = snapshot();
    t.mock.timers.tick(2000); await settle(); assert.equal(calls, 4);
    t.mock.timers.tick(30000); assert.equal(calls, 4);
    poller.stop();
  }
});

test('慢查询不叠加；切换记录后旧响应不能重启轮询', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let selected = 'a';
  const poller = createProcessingPoller({ isCurrent: id => id === selected,
    read: id => new Promise(resolve => calls.push({ id, resolve })) });
  t.after(() => poller.stop());
  poller.start('a'); t.mock.timers.tick(20000); assert.equal(calls.length, 1);
  selected = 'b'; poller.start('b'); assert.equal(calls.length, 2);
  calls[0].resolve(snapshot({ runningJobs: 1 })); await settle();
  calls[1].resolve(snapshot()); await settle();
  t.mock.timers.tick(20000); assert.equal(calls.length, 2);
});

test('后台缺少 Key 时停止空转轮询并保留继续处理入口', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const poller = createProcessingPoller({ isCurrent: () => true,
    read: async () => { calls++; return snapshot({ pendingJobs: 1 }, { processingAvailable: false }); } });
  t.after(() => poller.stop());
  poller.start('a'); await settle(); t.mock.timers.tick(20000);
  assert.equal(calls, 1);
});

test('记录已删除时停止轮询，不按网络故障无限重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const poller = createProcessingPoller({ isCurrent: () => true,
    read: async () => { calls++; throw Object.assign(new Error('missing'), { status: 404 }); } });
  t.after(() => poller.stop());
  poller.start('a'); await settle(); t.mock.timers.tick(30000);
  assert.equal(calls, 1);
});

test('关系待处理保持轮询，但未启用的历史关系不制造后台工作', () => {
  const related = relations => snapshot({}, { processing: { relations } });
  assert.deepEqual(processingView(related({ enabled: false, state: 'not_generated', pendingJobs: 8 })), { text: '已处理', pending: 0, canRetry: false });
  assert.deepEqual(processingView(related({ enabled: true, state: 'queued', pendingJobs: 2 })), { text: '关系稍后补齐', pending: 2, canRetry: false });
  assert.match(processingView(related({ enabled: true, runningJobs: 1 })).text, /关系整理中/);
  assert.match(processingView(related({ enabled: true, partialJobs: 1 })).text, /关系部分完成/);
  assert.match(processingView(related({ enabled: true, failedJobs: 1 })).text, /关系整理失败/);
  assert.match(processingView(related({ enabled: true, state: 'waiting_key', pendingJobs: 1 })).text, /需 API Key/);
});

test('停止收听后仍会等待关系完成，而不是只等条目', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const poller = createProcessingPoller({ isCurrent: () => true, read: async () => {
    calls++; return snapshot({}, { processing: { relations: calls < 3 ? { enabled: true, pendingJobs: 1 } : { enabled: true, state: 'complete' } } });
  } });
  t.after(() => poller.stop());
  poller.start('a'); await settle(); t.mock.timers.tick(2000); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(2000); await settle(); assert.equal(calls, 3);
  t.mock.timers.tick(20000); assert.equal(calls, 3);
});

test('关系鉴权受阻时即使服务器仍持有旧 Key，也停止无效轮询', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const poller = createProcessingPoller({ isCurrent: () => true, read: async () => {
    calls++; return snapshot({}, { processingAvailable: true, processing: { relations: { enabled: true, state: 'waiting_key', pendingJobs: 2 } } });
  } });
  t.after(() => poller.stop());
  poller.start('a'); await settle(); t.mock.timers.tick(10000); await settle();
  assert.equal(calls, 1);
});

test('关系终态压过遗留任务计数，明确显示暂停或取消', () => {
  for (const [state, text] of [['paused', '历史关系任务已暂停'], ['cancelled', '关系整理已取消']]) {
    const result = processingView(snapshot({}, { processing: { relations: { enabled: true, state, pendingJobs: 9, runningJobs: 1 } } }));
    assert.equal(result.pending, 0);
    assert.match(result.text, new RegExp(text));
    assert.doesNotMatch(result.text, /整理中|稍后补齐/);
  }
  assert.equal(processingView(snapshot({}, { processing: { relations: { state: 'queued' } } })).pending, 1);
});

test('历史关系暂停和取消停止轮询；手动继续重新开始，完成后再次停止', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const state of ['paused', 'cancelled']) {
    let calls = 0, relations = { state, enabled: true, pendingJobs: 7, runningJobs: 1 };
    const poller = createProcessingPoller({ isCurrent: () => true, read: async () => {
      calls++; return snapshot({}, { processing: { relations } });
    } });
    t.after(() => poller.stop());
    poller.start('a'); await settle(); t.mock.timers.tick(20000); assert.equal(calls, 1);
    relations = { enabled: true, state: 'queued' }; poller.start('a'); await settle(); assert.equal(calls, 2);
    t.mock.timers.tick(2000); await settle(); assert.equal(calls, 3);
    relations = { enabled: true, state: 'complete', pendingJobs: 7 };
    t.mock.timers.tick(2000); await settle(); assert.equal(calls, 4);
    t.mock.timers.tick(20000); assert.equal(calls, 4); poller.stop();
  }
});

test('关系暂停不会中断仍在处理的译文；等待原因不误报正在调用', () => {
  const result = processingView(snapshot({}, { processing: { pendingTranslations: 1, relations: { enabled: true, state: 'paused', pendingJobs: 9 } } }));
  assert.equal(result.pending, 1); assert.match(result.text, /译文处理中.*历史关系任务已暂停/);
  for (const [waitReason, label] of [['foreground', '等待前台任务'], ['provider_cooldown', '限流冷却'], ['retrying', '等待重试'], ['network_retry', '等待重试'], ['quiet_period', '等待原文与条目稳定'], ['admission_interval', '等待请求间隔'], ['translations', '等待译文完成']]) {
    assert.match(processingView(snapshot({}, { processing: { relations: { enabled: true, state: 'running', runningJobs: 1, waitReason } } })).text, new RegExp(label));
  }
});


test('失败提供手动重试，部分结果明确保留，不因遗留计数继续轮询', () => {
  for (const state of ['failed', 'partial']) {
    const result = processingView(snapshot({}, { processing: { relations: { enabled: true, state, pendingJobs: 9, runningJobs: 2 } } }));
    assert.equal(result.pending, 0); assert.match(result.text, state === 'failed' ? /手动重试/ : /部分完成.*已有结果保留/);
    assert.doesNotMatch(result.text, /已处理|整理中|稍后补齐/);
  }
});
