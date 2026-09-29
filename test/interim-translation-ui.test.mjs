import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as translationParams from '../public/translation-params.js';
import { processingView, createProcessingPoller } from '../public/processing-state.js';
import { createSpeechController } from '../public/speech-controller.js';
import { speechConfig } from '../public/speech-protocol.js';

// Execute the actual app and event handlers with a minimal DOM and controllable HTTP responses.
// Deliberately let aborted requests resolve to exercise the stale-response guards.
function app(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const elements = new Map(), requests = [];
  const storage = new Map([['tongsheng:qianwen-key', 'old-test-key']]);
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set(), events = new Map();
    const node = {
      value: '', textContent: '', hidden: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      style: { setProperty() {} }, setAttribute() {}, focus() {},
      getBoundingClientRect: () => ({ bottom: 100 }),
      setCustomValidity(message) { this.validationMessage = message; },
      reportValidity() { this.reported = true; },
      classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); } },
      addEventListener(name, callback) { events.set(name, [...(events.get(name) || []), callback]); },
      emit(name) { for (const callback of events.get(name) || []) callback({ preventDefault() {} }); }
    };
    elements.set(id, node); return node;
  }
  element('source-language').value = 'en'; element('target-language').value = 'Chinese';
  element('audio-input').value = 'microphone'; element('translation').classList.add('placeholder');
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const context = vm.createContext({
    ...translationParams, processingView, createProcessingPoller, createSpeechController, speechConfig, Date, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    WebSocket: Socket, Event, console, location: { protocol: 'http:', host: 'localhost' },
    document: { getElementById: element, querySelector: element, documentElement: element('root'), addEventListener() {} },
    window: { addEventListener() {}, scrollY: 0, innerHeight: 800 }, MutationObserver: class { observe() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, body: JSON.parse(options.body), resolve, reject })); }
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import[^\n]+\n/gm, ''), context);
  const run = (code, value) => { context.testValue = value; return vm.runInContext(code, context); };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const tick = async ms => { t.mock.timers.tick(ms); await flush(); };
  const reply = async (index, status, body) => {
    requests[index].resolve({ status, ok: status >= 200 && status < 300, json: async () => body });
    await flush();
  };
  const receive = (text, id = 's1') => run('receiveSentence(testValue)', { text, id });
  const final = (translation = '完整译文') => run('displayFinal(testValue)', {
    id: 'segment-1', asr_sentence_id: 's1', original_text: '完整原文', translation_text: translation,
    translation_state: translation ? 'complete' : 'pending'
  });
  t.after(() => run('clearTranslationWork()'));
  return { element, requests, storage, run, tick, flush, reply, receive, final };
}

test('更换音源先结束旧连接再启动新片段，取消选择保留旧流', async t => {
  const a = app(t);
  a.run(`
    phase = 'listening'; els.audioInput.value = 'tab';
    socket = new WebSocket(); audioContext = {}; processor = {};
    globalThis.switchEvents = [];
    globalThis.chosen = { getTracks: () => [{ stop: () => switchEvents.push('discard') }] };
    chooseTab = async () => chosen;
    stop = async () => { switchEvents.push('stop'); phase = 'idle'; socket.dispatchEvent(new Event('close')); };
    start = async selected => { switchEvents.push(selected === chosen ? 'start-selected' : 'wrong-stream'); };
  `);
  await a.run('switchTab()');
  assert.deepEqual(Array.from(a.run('switchEvents')), ['stop', 'start-selected']);
  a.run(`phase = 'listening'; switchEvents.length = 0; chooseTab = async () => { const error = new Error('cancel'); error.name = 'NotAllowedError'; throw error; };`);
  await a.run('switchTab()');
  assert.deepEqual(Array.from(a.run('switchEvents')), []); assert.equal(a.run('phase'), 'listening');
});

test('超长临时文本保留已有译文且不发送请求；修订为短句后恢复', async t => {
  const a = app(t);
  a.receive('Hello world'); await a.tick(0); await a.reply(0, 200, { text: '你好' });
  for (let i = 0; i < 3; i++) { a.receive('a'.repeat(3001 + i)); await a.tick(1200); }
  assert.equal(a.requests.length, 1);
  assert.equal(a.element('translation').textContent, '你好');
  assert.equal(a.element('caption-badge').textContent, '长句识别中，等待完整译文');
  assert.equal(a.element('hint').classList.contains('error'), false);
  a.receive('  Revised words  '); await a.tick(1200);
  assert.equal(a.requests[1].body.text, 'Revised words');
  await a.reply(1, 200, { text: '修订译文' });
  assert.equal(a.element('translation').textContent, '修订译文');
  a.final(); assert.equal(a.element('caption-badge').textContent, '已完成');
});

test('超限取消待发定时器及在途请求，迟到的成功不能覆盖等待状态', async t => {
  const a = app(t);
  a.receive('first words'); await a.tick(0);
  a.receive('queued words'); // Still inside the 1200ms throttle window.
  a.receive('a'.repeat(3001)); await a.tick(1200);
  assert.equal(a.requests.length, 1);
  assert.equal(a.requests[0].options.signal.aborted, true);
  await a.reply(0, 200, { text: '过期译文' });
  assert.notEqual(a.element('translation').textContent, '过期译文');
  assert.equal(a.element('caption-badge').textContent, '长句识别中，等待完整译文');
});

test('临时翻译失败标明来源，成功或最终句到达后清除对应错误', async t => {
  const a = app(t);
  a.receive('first words'); await a.tick(0);
  await a.reply(0, 502, { error: '模型暂不可用' });
  assert.equal(a.element('hint').textContent, '临时译文暂不可用：模型暂不可用');
  assert.equal(a.element('caption-badge').textContent, '等待完整译文');
  a.receive('updated words'); await a.tick(1200); await a.reply(1, 200, { text: '已恢复' });
  assert.equal(a.element('hint').classList.contains('error'), false);
  a.receive('more words'); await a.tick(1200);
  a.requests[2].reject(new Error('网络中断')); await a.flush();
  assert.equal(a.element('hint').classList.contains('error'), true);
  a.final(''); // The final translation is pending; the failed provisional work has ended.
  assert.equal(a.element('hint').classList.contains('error'), false);
  assert.equal(a.element('translation').textContent, '已恢复');
  a.final(); assert.equal(a.element('translation').textContent, '完整译文');
});

test('临时译文失败、恢复和最终句都不覆盖或清除无关错误', async t => {
  const a = app(t);
  a.run("showError('音频采集已停止')");
  a.receive('first words'); await a.tick(0); await a.reply(0, 502, { error: '模型失败' });
  assert.equal(a.element('hint').textContent, '音频采集已停止');
  a.receive('next words'); await a.tick(1200); await a.reply(1, 200, { text: '成功' });
  a.final();
  assert.equal(a.element('hint').textContent, '音频采集已停止');
  assert.equal(a.element('hint').classList.contains('error'), true);
});

for (const status of [200, 400, 429, 502]) {
  test(`换句后忽略旧请求的 ${status} 响应（新句不足翻译长度也不能回写）`, async t => {
    const a = app(t);
    a.receive('first words'); await a.tick(0);
    a.receive('Hi', 's2');
    assert.equal(a.requests[0].options.signal.aborted, true);
    await a.reply(0, status, { text: '旧句译文', error: '旧句错误' });
    assert.equal(a.element('caption-badge').textContent, '正在识别');
    assert.equal(a.element('original').textContent, 'Hi');
    assert.equal(a.element('hint').classList.contains('error'), false);
    assert.notEqual(a.element('translation').textContent, '旧句译文');
  });
}

test('最终句后迟到的 429 不覆盖已完成；当前 429 为可恢复的中性提示', async t => {
  const a = app(t);
  a.receive('first words'); await a.tick(0); await a.reply(0, 502, { error: '临时失败' });
  a.receive('more words'); await a.tick(1200); await a.reply(1, 429, { code: 'FINAL_TRANSLATION_BUSY' });
  assert.equal(a.element('hint').classList.contains('error'), false);
  assert.equal(a.element('caption-badge').textContent, '最终译文优先处理中');
  a.receive('latest words'); await a.tick(1200); a.final();
  await a.reply(2, 429, { code: 'FINAL_TRANSLATION_BUSY' });
  assert.equal(a.element('caption-badge').textContent, '已完成');
});

test('服务端返回超长错误码时中性降级，空成功响应不能伪装为译文', async t => {
  const a = app(t);
  a.receive('valid text'); await a.tick(0); await a.reply(0, 400, { code: 'INTERIM_TEXT_TOO_LONG' });
  assert.equal(a.element('caption-badge').textContent, '长句识别中，等待完整译文');
  assert.equal(a.element('hint').classList.contains('error'), false);
  a.receive('valid text again'); await a.tick(1200); await a.reply(1, 200, { text: '  ' });
  assert.match(a.element('hint').textContent, /翻译服务未返回文字/);
  assert.equal(a.element('translation').classList.contains('provisional'), false);
});

test('空白 Key 保存不破坏旧值，纠正输入后保存并取消旧请求', async t => {
  const a = app(t);
  a.receive('first words'); await a.tick(0);
  a.element('api-key').value = '   '; a.element('settings-form').emit('submit');
  assert.equal(a.run('saved.key'), 'old-test-key');
  assert.equal(a.storage.get('tongsheng:qianwen-key'), 'old-test-key');
  assert.equal(a.element('api-key').reported, true);
  assert.equal(a.element('api-key').validationMessage, '请输入有效的 API Key');
  a.element('api-key').value = '  new-test-key  '; a.element('api-key').emit('input');
  assert.equal(a.element('api-key').validationMessage, '');
  a.element('settings-form').emit('submit');
  assert.equal(a.run('saved.key'), 'new-test-key');
  assert.equal(a.storage.get('tongsheng:qianwen-key'), 'new-test-key');
  assert.equal(a.requests[0].options.signal.aborted, true);
  await a.reply(0, 502, { error: '旧 Key 失败' });
  assert.equal(a.element('hint').classList.contains('error'), false);
});

test('实际请求前复核参数，等待节流期间失效的 Key 不发往服务器', async t => {
  const a = app(t);
  a.receive('first words'); await a.tick(0); await a.reply(0, 200, { text: '成功' });
  a.receive('queued words'); a.run("saved.key = ''"); await a.tick(1200);
  assert.equal(a.requests.length, 1);
  assert.match(a.element('hint').textContent, /请先填写有效的 API Key/);
});

test('连接关闭取消临时工作，迟到的响应不能盖掉断线提示', async t => {
  const a = app(t);
  a.run('prepareAudio = async () => {}'); await a.run('start()');
  a.run("phase = 'listening'");
  a.receive('first words'); await a.tick(0);
  a.run('socket.close()'); await a.flush();
  assert.equal(a.requests[0].options.signal.aborted, true);
  await a.reply(0, 429, { code: 'FINAL_TRANSLATION_BUSY' });
  assert.equal(a.element('hint').textContent, '连接已断开，请重试');
  assert.equal(a.element('caption-badge').textContent, '等待开始');
});
