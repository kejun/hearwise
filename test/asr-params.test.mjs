import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { deadline, stopChild, closeServer } from '../test-support/lifecycle.mjs';
import { startServer } from '../test-support/server-fixture.mjs';
import WebSocket, { WebSocketServer } from 'ws';

async function waitFor(predicate, label, diagnostics, timeout = 5000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeout) throw new Error(`${label} timed out after ${timeout}ms\n${diagnostics()}`);
    await delay(15);
  }
}
const listen = async server => {
  server.listen(0, '127.0.0.1');
  await deadline(() => once(server, 'listening'), 5000, 'Model HTTP startup');
  return server.address().port;
};

test('ASR 断句参数按 run 下发、被拒时显式回退、事件携带 runId', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-params-'));
  const clients = new Set();
  let app, asrServer, modelServer;
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    const results = await Promise.allSettled([
      app && stopChild(app.child), asrServer && closeServer(asrServer, 'ASR'), modelServer && closeServer(modelServer, 'model HTTP')
    ]);
    rmSync(dir, { recursive: true, force: true });
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, `ASR fixture cleanup failed\n${app?.logs() || ''}`);
  });
  modelServer = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '已翻译：' + body.messages[0].content } }] }));
  });
  const modelPort = await listen(modelServer);
  asrServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await deadline(() => once(asrServer, 'listening'), 5000, 'ASR stub startup');
  let sentenceNo = 0;
  let rejectSegmentation = false;
  const runTaskPayloads = [];
  asrServer.on('connection', ws => {
    let taskId;
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        sentenceNo++;
        ws.send(JSON.stringify({ header: { event: 'result-generated' }, payload: { output: { sentence:
          { sentence_id: `p${sentenceNo}`, text: `Param test ${sentenceNo}.`, sentence_end: true } } } }));
        return;
      }
      const message = JSON.parse(raw.toString());
      if (message.header?.action === 'run-task') {
        runTaskPayloads.push(message.payload.parameters);
        taskId = message.header.task_id;
        if (rejectSegmentation && message.payload.parameters.max_sentence_silence != null) {
          ws.send(JSON.stringify({ header: { event: 'task-failed', task_id: taskId, error_message: 'InvalidParameter: max_sentence_silence' } }));
          return;
        }
        ws.send(JSON.stringify({ header: { event: 'task-started', task_id: taskId } }));
      }
      if (message.header?.action === 'finish-task') ws.send(JSON.stringify({ header: { event: 'task-finished', task_id: taskId } }));
    });
  });
  app = await startServer({ env: {
    LISTENING_DB: path.join(dir, 'history.sqlite'), ASR_ENDPOINT: `ws://127.0.0.1:${asrServer.address().port}`,
    MT_ENDPOINT: `http://127.0.0.1:${modelPort}/chat/completions`
  } });
  const wait = (predicate, label, events = []) => waitFor(predicate, label,
    () => `Events: ${JSON.stringify(events)}\n${app.logs()}`);
  const closed = (ws, label) => ws.readyState === WebSocket.CLOSED ? Promise.resolve() :
    deadline(() => once(ws, 'close'), 5000, label);

  async function startRun(extra = {}, waitReady = true) {
    const ws = new WebSocket(`${app.base.replace('http:', 'ws:')}/ws`);
    clients.add(ws);
    ws.once('close', () => clients.delete(ws));
    const events = [];
    ws.on('error', error => events.push({ type: 'socket-error', message: error.message }));
    ws.on('message', raw => events.push(JSON.parse(raw.toString())));
    await deadline(() => once(ws, 'open'), 5000, 'Client WebSocket open');
    ws.send(JSON.stringify({ type: 'start', key: 'test-key', source: 'en', targetLang: 'Chinese', audioSource: 'microphone', ...extra }));
    if (waitReady) await wait(() => events.some(e => e.type === 'listening-ready' || e.type === 'error'), 'Listening ready', events);
    return { ws, events };
  }
  const stopRun = ws => { const stopped = closed(ws, 'Run stop'); ws.send(JSON.stringify({ type: 'stop' })); return stopped; };

  // 默认实时优先：下发低延迟断句参数，事件带 runId
  const realtime = await startRun();
  const ready = realtime.events.find(e => e.type === 'listening-ready');
  assert.equal(ready.captionMode, 'realtime');
  assert.match(ready.runId, /^[0-9a-f-]{36}$/);
  const params = runTaskPayloads.at(-1);
  assert.equal(params.semantic_punctuation_enabled, false);
  assert.equal(params.max_sentence_silence, 2500);
  assert.equal(params.multi_threshold_mode_enabled, true);
  realtime.ws.send(Buffer.from([0, 0]));
  await wait(() => realtime.events.some(e => e.type === 'segment-final'), 'Final ASR segment', realtime.events);
  const final = realtime.events.find(e => e.type === 'segment-final');
  assert.equal(final.runId, ready.runId);
  assert.equal(final.segment.run_id, ready.runId);
  await stopRun(realtime.ws);

  // classic 模式：不带断句参数
  const classic = await startRun({ captionMode: 'classic' });
  assert.equal(classic.events.find(e => e.type === 'listening-ready').captionMode, 'classic');
  const classicParams = runTaskPayloads.at(-1);
  assert.equal('semantic_punctuation_enabled' in classicParams, false);
  assert.equal('max_sentence_silence' in classicParams, false);
  assert.equal('multi_threshold_mode_enabled' in classicParams, false);
  await stopRun(classic.ws);

  // 服务拒绝断句参数：显式回退旧参数重连一次，任务仍能启动
  rejectSegmentation = true;
  const before = runTaskPayloads.length;
  const fallback = await startRun();
  assert.ok(fallback.events.some(e => e.type === 'listening-ready'), '回退后应成功启动');
  assert.equal(fallback.events.filter(e => e.type === 'listening-ready').length, 1);
  assert.equal(runTaskPayloads.length, before + 2);
  assert.equal('max_sentence_silence' in runTaskPayloads.at(-1), false);
  await wait(() => app.logs().includes('asr_param_fallback'), 'ASR fallback diagnostic', fallback.events);
  await stopRun(fallback.ws);

  // 非法 captionMode 拒绝启动
  rejectSegmentation = false;
  const invalid = await startRun({ captionMode: 'turbo' }, false);
  const invalidClosed = closed(invalid.ws, 'Invalid settings close');
  await Promise.all([
    wait(() => invalid.events.some(e => e.type === 'error'), 'Invalid settings error', invalid.events), invalidClosed
  ]);
  assert.match(invalid.events.find(e => e.type === 'error').message, /收听设置/);
});
