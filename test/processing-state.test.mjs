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
