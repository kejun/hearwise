import { createCaptionFrontier } from '../public/caption-frontier.js';
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
function app(t, preferences = []) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const elements = new Map(), requests = [];
  const storage = new Map([['tongsheng:qianwen-key', 'old-test-key'], ['hearwise:speech-key', 'obsolete-tts-key'], ...preferences]);
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set(), events = new Map(), styles = new Map();
    const node = {
      value: '', _text: '', children: null,
      get textContent() { return this.children ? this.children.map(child => child.textContent).join('') : this._text; },
      set textContent(text) { this.children = null; this._text = text; },
      replaceChildren(...children) { this.children = children; }, hidden: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      style: { setProperty: (name, value) => styles.set(name, value), getPropertyValue: name => styles.get(name) }, setAttribute() {}, focus() {},
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
    ...translationParams, createCaptionFrontier, processingView, createProcessingPoller, createSpeechController, speechConfig, Date, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    WebSocket: Socket, Event, console, location: { protocol: 'http:', host: 'localhost' },
    document: { createElement: () => ({ textContent: '', className: '' }), getElementById: element, querySelector: element, documentElement: element('root'), addEventListener() {} },
    window: { addEventListener() {}, scrollY: 0, innerHeight: 800 }, MutationObserver: class { observe() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, body: options?.body ? JSON.parse(options.body) : null, resolve, reject })); }
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

for (const [stored, expected] of [
  [null, 44], ['', 44], ['  ', 44], ['bad', 44], ['NaN', 44], ['Infinity', 44], ['-Infinity', 44],
  ['0', 21], ['-30', 21], ['20', 21], ['21', 21], ['30', 30], ['44', 44],
  ['43.5', 44], ['63.6', 64], ['64', 64], ['70', 64], ['999', 64]
]) test(`译文字号初始化、样式和持久化迁移：${JSON.stringify(stored)} → ${expected}`, t => {
  const key = 'tongsheng:translation-size';
  const a = app(t, stored === null ? [] : [[key, stored]]);
  assert.equal(a.element('translation-size').value, String(expected));
  assert.equal(a.element('root').style.getPropertyValue('--translation-size'), String(expected));
  assert.equal(a.storage.get(key), stored === null ? undefined : String(expected));
});

test('译文字号端点实时保存，重复调整不越界且不受设置的取消或保存影响', t => {
  const a = app(t);
  for (const [value, expected] of [['21', '21'], ['64', '64'], ['20', '21'], ['70', '64'], ['44', '44'], ['21', '21']]) {
    a.element('translation-size').value = value;
    a.element('translation-size').emit('input');
    assert.equal(a.element('translation-size').value, expected);
    assert.equal(a.element('root').style.getPropertyValue('--translation-size'), expected);
    assert.equal(a.storage.get('tongsheng:translation-size'), expected);
  }
  for (const action of ['close-settings', 'settings-form']) {
    a.element('settings-trigger').emit('click');
    a.element(action).emit(action === 'settings-form' ? 'submit' : 'click');
    assert.equal(a.element('translation-size').value, '21');
    assert.equal(a.element('root').style.getPropertyValue('--translation-size'), '21');
    assert.equal(a.storage.get('tongsheng:translation-size'), '21');
  }
});

test('译文字号 HTML 端点与默认值一致，默认 CSS 保持 44', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="translation-size"[^>]+min="21"[^>]+max="64"[^>]+step="1"[^>]+value="44"/);
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const fallbacks = [...css.matchAll(/var\(--translation-size,([\d.]+)\)/g)];
  assert.ok(fallbacks.length > 0);
  assert.ok(fallbacks.every(match => match[1] === '44'));
});

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

test('播报只读取保存的连接 Key，清理旧独立 Key，更新连接后立即使用新值', t => {
  const a = app(t);
  assert.equal(a.storage.has('hearwise:speech-key'), false);
  assert.equal(a.run('readSpeechConfig().key'), 'old-test-key');
  a.element('api-key').value = 'new-shared-key';
  a.element('settings-form').emit('submit');
  assert.equal(a.run('readSpeechConfig().key'), 'new-shared-key');
  assert.equal(a.run('speech.enabled'), false);
});

test('Fish 使用独立 Key 和设置，切换后不借用千问 Key，保存不自动播报', t => {
  const a = app(t);
  assert.equal(a.element('speech-provider').value, 'qwen');
  assert.equal(a.element('speech-qwen-model').value, 'Qwen3-TTS-Flash-Realtime');
  a.element('speech-prompt').value = '千问专用指令';
  a.element('speech-form').emit('submit');
  a.element('speech-provider').value = 'fish'; a.element('speech-provider').emit('change');
  assert.equal(a.element('speech-qwen-fields').hidden, true);
  assert.equal(a.element('speech-qwen-fields').disabled, true);
  assert.equal(a.element('speech-fish-fields').disabled, false);
  assert.throws(() => a.run('readSpeechConfig()'), /Fish Audio API Key/);
  a.element('speech-fish-key').value = ' fish-only-key ';
  a.element('speech-fish-voice').value = 'voice-123';
  a.element('speech-fish-model').value = 's2.1-pro';
  a.element('speech-fish-style').value = '[calm]';
  const config = a.run('readSpeechConfig()');
  assert.equal(config.key, 'fish-only-key'); assert.equal(config.prompt, undefined);
  a.element('speech-form').emit('submit');
  assert.equal(a.storage.get('hearwise:fish-key'), 'fish-only-key');
  assert.equal(a.storage.get('tongsheng:qianwen-key'), 'old-test-key');
  const preferences = JSON.parse(a.storage.get('hearwise:speech'));
  assert.equal(preferences.provider, 'fish'); assert.equal(preferences.fish.model, 's2.1-pro');
  assert.equal(preferences.fish.style, 'calm'); assert.equal(preferences.prompt, '千问专用指令');
  assert.ok(!a.storage.get('hearwise:speech').includes('fish-only-key'));
  assert.equal(a.run('speech.enabled'), false);
  a.element('speech-provider').value = 'qwen'; a.element('speech-provider').emit('change');
  assert.equal(a.run('readSpeechConfig().key'), 'old-test-key');
  assert.equal(a.run('readSpeechConfig().prompt'), '千问专用指令');
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

function metadataApp(t) {
  const a = app(t);
  a.run(`els.historyView.hidden = true; listeningId = 'record-1'; detail = { listening: { id: 'record-1', title: '原始标题', notes: '' }, runs: [] }; renderRecordMetadata();`);
  return a;
}
test('历史标题备注编辑可取消、重复打开、清空备注，空标题不提交', async t => {
  const a = metadataApp(t);
  a.element('edit-record').emit('click');
  assert.equal(a.element('record-title-input').value, '原始标题');
  a.element('record-title-input').value = '取消的标题';
  a.element('record-notes-input').value = '未保存';
  a.element('cancel-record').emit('click');
  assert.equal(a.element('record-editor').hidden, true);
  assert.equal(a.run('detail.listening.title'), '原始标题');
  a.element('edit-record').emit('click');
  assert.equal(a.element('record-title-input').value, '原始标题');
  assert.equal(a.element('record-notes-input').value, '');
  a.element('record-title-input').value = '   ';
  a.element('record-editor').emit('submit');
  assert.equal(a.requests.length, 0);
  assert.equal(a.element('record-title-input').validationMessage, '请输入标题');
  a.element('record-title-input').value = ' 新标题 ';
  a.element('record-title-input').emit('input');
  a.element('record-notes-input').value = '<script>保持纯文本</script>\n第二行';
  a.element('record-editor').emit('submit');
  a.element('record-editor').emit('submit');
  assert.equal(a.requests.length, 1);
  assert.equal(a.requests[0].options.method, 'PATCH');
  assert.equal(a.requests[0].body.title, '新标题');
  assert.equal(a.element('save-record').disabled, true);
  await a.reply(0, 200, { listening: { id: 'record-1', title: '新标题', notes: '<script>保持纯文本</script>\n第二行' } });
  assert.equal(a.element('record-title').textContent, '新标题');
  assert.equal(a.element('record-notes').textContent, '<script>保持纯文本</script>\n第二行');
  assert.equal(a.element('record-editor').hidden, true);
  assert.equal(a.element('record-edit-status').textContent, '标题与备注已保存');
  a.element('edit-record').emit('click');
  a.element('record-notes-input').value = '';
  a.element('record-editor').emit('submit');
  await a.reply(1, 200, { listening: { id: 'record-1', title: '新标题', notes: '' } });
  assert.equal(a.element('record-notes-panel').hidden, true);
});
test('保存失败保留草稿，可重试；离开记录后的迟到响应不覆盖另一记录', async t => {
  const a = metadataApp(t);
  a.element('edit-record').emit('click');
  a.element('record-title-input').value = '待保存';
  a.element('record-editor').emit('submit');
  await a.reply(0, 500, { error: '磁盘不可写' });
  assert.equal(a.element('record-editor').hidden, false);
  assert.equal(a.element('record-title-input').value, '待保存');
  assert.equal(a.element('record-edit-error').textContent, '磁盘不可写');
  assert.equal(a.element('save-record').disabled, false);
  a.element('record-editor').emit('submit');
  a.run(`closeRecordEditor(); listeningId = 'record-2'; detail = { listening: { id: 'record-2', title: '另一记录' }, runs: [] };`);
  await a.reply(1, 200, { listening: { id: 'record-1', title: '待保存', notes: '' } });
  assert.equal(a.run('detail.listening.title'), '另一记录');
  assert.equal(a.element('record-edit-status').textContent, '');
});
test('活动收听不可编辑，保存超时后表单恢复并保留输入', async t => {
  const a = metadataApp(t);
  a.run(`detail.runs = [{ state: 'active' }]; renderRecordMetadata(); openRecordEditor();`);
  assert.equal(a.run('editingRecordId'), null);
  assert.equal(a.element('edit-record').disabled, true);
  a.run(`detail.runs = []; openRecordEditor();`);
  a.element('record-editor').emit('submit');
  const req = a.requests[0];
  req.options.signal.addEventListener('abort', () => req.reject(new Error('aborted')));
  await a.tick(10000);
  assert.match(a.element('record-edit-error').textContent, /保存超时/);
  assert.equal(a.element('save-record').disabled, false);
  assert.equal(a.element('record-title-input').value, '原始标题');
});


test('保存时进入历史页，成功后刷新历史列表', async t => {
  const a = metadataApp(t);
  a.run(`globalThis.historyReloads = 0; reloadHistory = async () => { historyReloads++; };`);
  a.element('edit-record').emit('click');
  a.element('record-title-input').value = '历史新标题';
  a.element('record-editor').emit('submit');
  a.run(`closeRecordEditor(); els.historyView.hidden = false;`);
  await a.reply(0, 200, { listening: { id: 'record-1', title: '历史新标题', notes: '' } });
  assert.equal(a.run('historyReloads'), 1);
  assert.equal(a.run('detail.listening.title'), '历史新标题');
});
test('保存前发起的详情刷新晚返回，不得覆盖刚保存的标题备注', async t => {
  const a = metadataApp(t);
  a.run(`detail.segments = []; renderDetail = renderRecordMetadata; fetchDetail();`);
  a.element('edit-record').emit('click');
  a.element('record-title-input').value = '刚保存';
  a.element('record-notes-input').value = '保留备注';
  a.element('record-editor').emit('submit');
  await a.reply(1, 200, { listening: { id: 'record-1', title: '刚保存', notes: '保留备注' } });
  await a.reply(0, 200, { listening: { id: 'record-1', title: '旧标题', notes: '' }, runs: [], segments: [], knowledge: [], segmentCount: 0 });
  assert.equal(a.run('detail.listening.title'), '刚保存');
  assert.equal(a.run('detail.listening.notes'), '保留备注');
});


test('slow MT completes instead of being aborted on every preview cadence; latest source coalesces', async t => {
  const a = app(t);
  a.receive('The weather is warm'); await a.tick(1);
  assert.equal(a.requests.length, 1);
  a.receive('The weather is warm today'); await a.tick(1300);
  a.receive('The weather is warm today and sunny'); await a.tick(1300);
  assert.equal(a.requests.length, 1);
  assert.equal(a.requests[0].options.signal.aborted, false);
  await a.reply(0, 200, { text: '天气温暖' });
  assert.equal(a.element('translation').textContent, '天气温暖');
  await a.tick(1);
  assert.equal(a.requests.length, 2);
  assert.equal(a.requests[1].body.text, 'The weather is warm today and sunny');
});
