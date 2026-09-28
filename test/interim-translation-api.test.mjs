import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';

const valid = { key: 'test-key', text: 'Hello world.', source: 'en', target: 'Chinese' };
async function waitFor(predicate) {
  const deadline = Date.now() + 7000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待临时翻译回归场景超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function startServer(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'interim-translation-'));
  const calls = [], held = [], clients = [], events = [];
  let paused = false, upstream;
  const modelServer = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
    const respond = () => {
      const content = body.model === 'qwen-mt-flash' ? '模拟完整译文' : '{"items":[]}';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    };
    if (paused && body.model === 'qwen-mt-flash') held.push(respond);
    else respond();
  });
  modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
  const asr = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(asr, 'listening');
  asr.on('connection', ws => {
    upstream = ws;
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.header.action === 'run-task') ws.send(JSON.stringify({ header: { event: 'task-started' } }));
      if (message.header.action === 'finish-task') ws.send(JSON.stringify({ header: { event: 'task-finished' } }));
    });
  });
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve('.'), env: { ...process.env, PORT: '0', HOST: '127.0.0.1', LISTENING_DB: path.join(dir, 'test.sqlite'),
      ASR_ENDPOINT: `ws://127.0.0.1:${asr.address().port}`, MT_ENDPOINT: `http://127.0.0.1:${modelServer.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', () => {});
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    if (child.exitCode == null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    for (const ws of asr.clients) ws.terminate();
    await new Promise(resolve => asr.close(resolve));
    modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => /http:\/\/127\.0\.0\.1:\d+/.test(log));
  const base = log.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  async function post(input, raw = false) {
    const response = await fetch(`${base}/api/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: raw ? input : JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  }
  async function start() {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws'); clients.push(ws);
    ws.on('message', raw => events.push(JSON.parse(raw.toString()))); await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'start', key: valid.key, source: valid.source, targetLang: valid.target, audioSource: 'microphone' }));
    await waitFor(() => events.some(e => e.type === 'listening-ready'));
    return events.find(e => e.type === 'listening-ready');
  }
  function sentence(text, final, id = 'long-sentence') {
    upstream.send(JSON.stringify({ header: { event: 'result-generated' }, payload: { output: {
      sentence: { sentence_id: id, text, sentence_end: final }
    } } }));
  }
  return { base, post, calls, start, events, sentence, held,
    pause: () => { paused = true; }, release: () => { paused = false; for (const respond of held.splice(0)) respond(); } };
}

test('临时接口返回具体字段/错误码，无效请求不会调用模型', async t => {
  const s = await startServer(t);
  const cases = [
    [{ ...valid, key: '   ' }, 'API_KEY_REQUIRED', 'key'],
    [{ ...valid, key: 123 }, 'API_KEY_REQUIRED', 'key'],
    [{ ...valid, text: '   ' }, 'TRANSLATION_TEXT_REQUIRED', 'text'],
    [{ ...valid, text: null }, 'TRANSLATION_TEXT_REQUIRED', 'text'],
    [{ ...valid, text: 'a'.repeat(3001) }, 'INTERIM_TEXT_TOO_LONG', 'text'],
    [{ ...valid, text: '😀'.repeat(1501) }, 'INTERIM_TEXT_TOO_LONG', 'text'],
    [{ ...valid, source: 'invalid' }, 'UNSUPPORTED_SOURCE_LANGUAGE', 'source'],
    [{ ...valid, target: 'invalid' }, 'UNSUPPORTED_TARGET_LANGUAGE', 'target'],
    [null, 'INVALID_TRANSLATION_REQUEST'], [[], 'INVALID_TRANSLATION_REQUEST'], [42, 'INVALID_TRANSLATION_REQUEST']
  ];
  for (const [input, code, field] of cases) {
    const result = await s.post(input);
    assert.equal(result.status, 400); assert.equal(result.body.code, code); assert.equal(result.body.field, field);
    assert.equal(typeof result.body.error, 'string');
    assert.equal(JSON.stringify(result.body).includes(valid.key), false);
    if (code === 'INTERIM_TEXT_TOO_LONG') assert.equal(result.body.maxLength, 3000);
  }
  const malformed = await s.post('{', true);
  assert.equal(malformed.status, 400); assert.equal(malformed.body.code, 'INVALID_TRANSLATION_REQUEST');
  assert.equal(s.calls.length, 0);
});

test('3000 字符、trim 后边界及默认语言正常；共享模块可由浏览器加载', async t => {
  const s = await startServer(t);
  for (const text of ['a'.repeat(3000), `  ${'中'.repeat(3000)}  `, '😀'.repeat(1500)]) {
    assert.equal((await s.post({ key: valid.key, text })).status, 200);
    assert.equal(s.calls.at(-1).messages[0].content, text.trim());
    assert.equal(s.calls.at(-1).translation_options.target_lang, 'Chinese');
  }
  const before = s.calls.length;
  const passthrough = await s.post({ ...valid, source: 'zh', text: ' 同语言原文 ' });
  assert.equal(passthrough.body.text, '同语言原文'); assert.equal(s.calls.length, before);
  const module = await fetch(`${s.base}/translation-params.js`);
  assert.equal(module.status, 200); assert.match(module.headers.get('content-type'), /javascript/);
  assert.match(await module.text(), /export const INTERIM_TRANSLATION_MAX_LENGTH = 3000/);
});

test('超长临时输入被明确拒绝，最终原文仍完整入库翻译，繁忙后自动恢复', async t => {
  const s = await startServer(t);
  const ready = await s.start(), text = 'a'.repeat(3001);
  s.sentence(text, false);
  await waitFor(() => s.events.some(e => e.type === 'sentence'));
  assert.equal(s.events.find(e => e.type === 'sentence').text, text);
  assert.equal((await s.post({ ...valid, text })).body.code, 'INTERIM_TEXT_TOO_LONG');
  s.pause(); s.sentence(text, true); s.sentence('Second final sentence.', true, 'second-sentence');
  await waitFor(() => s.held.length === 2);
  const busy = await s.post(valid);
  assert.equal(busy.status, 429); assert.equal(busy.body.code, 'FINAL_TRANSLATION_BUSY');
  s.release(); await waitFor(() => s.events.filter(e => e.type === 'translation-updated').length === 2);
  const final = s.events.find(e => e.type === 'translation-updated' && e.segment.asr_sentence_id === 'long-sentence').segment;
  assert.equal(final.original_text, text); assert.equal(final.translation_state, 'complete');
  assert.equal(s.calls.some(call => call.model === 'qwen-mt-flash' && call.messages[0].content === text), true);
  const stored = await (await fetch(`${s.base}/api/listenings/${ready.listeningId}/segments?ids=${final.id}`)).json();
  assert.equal(stored.items[0].original_text, text); assert.equal(stored.items[0].translation_text, '模拟完整译文');
  assert.equal((await s.post(valid)).status, 200);
});
