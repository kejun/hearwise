import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';

const waitFor = (predicate, timeout = 5000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(async () => {
    try { if (await predicate()) { clearInterval(timer); resolve(); return; } } catch {}
    if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('等待超时')); }
  }, 15);
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('ASR 断句参数按 run 下发、被拒时显式回退、事件携带 runId', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-params-'));
  const modelServer = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '已翻译：' + body.messages[0].content } }] }));
  });
  const modelPort = await listen(modelServer);
  const asrServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => asrServer.on('listening', resolve));
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
  const port = 38000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, PORT: String(port),
    LISTENING_DB: path.join(dir, 'history.sqlite'), ASR_ENDPOINT: `ws://127.0.0.1:${asrServer.address().port}`,
    MT_ENDPOINT: `http://127.0.0.1:${modelPort}/chat/completions` }, stdio: ['ignore', 'pipe', 'pipe'] });
  const serverLog = [];
  child.stderr.on('data', d => serverLog.push(String(d)));
  child.stdout.on('data', d => serverLog.push(String(d)));
  t.after(async () => {
    child.kill(); await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => asrServer.close(resolve));
    await new Promise(resolve => modelServer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}`)).ok; } catch { return false; } });

  async function startRun(extra = {}, waitReady = true) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', raw => events.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'start', key: 'test-key', source: 'en', targetLang: 'Chinese', audioSource: 'microphone', ...extra }));
    if (waitReady) await waitFor(() => events.some(e => e.type === 'listening-ready' || e.type === 'error'));
    return { ws, events };
  }
  const stopRun = ws => { ws.send(JSON.stringify({ type: 'stop' })); return new Promise(resolve => ws.once('close', resolve)); };

  // 默认实时优先：下发低延迟断句参数，事件带 runId
  const realtime = await startRun();
  const ready = realtime.events.find(e => e.type === 'listening-ready');
  assert.equal(ready.captionMode, 'realtime');
  assert.match(ready.runId, /^[0-9a-f-]{36}$/);
  const params = runTaskPayloads.at(-1);
  assert.equal(params.semantic_punctuation_enabled, false);
  assert.equal(params.max_sentence_silence, 900);
  assert.equal(params.multi_threshold_mode_enabled, true);
  realtime.ws.send(Buffer.from([0, 0]));
  await waitFor(() => realtime.events.some(e => e.type === 'segment-final'));
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
  await waitFor(() => serverLog.some(line => line.includes('asr_param_fallback')));
  await stopRun(fallback.ws);

  // 非法 captionMode 拒绝启动
  rejectSegmentation = false;
  const invalid = await startRun({ captionMode: 'turbo' }, false);
  const invalidClosed = new Promise(resolve => invalid.ws.once('close', resolve));
  await waitFor(() => invalid.events.some(e => e.type === 'error'));
  assert.match(invalid.events.find(e => e.type === 'error').message, /收听设置/);
  await invalidClosed;
});
