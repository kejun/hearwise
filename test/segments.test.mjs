import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { ListeningStore } from '../storage.mjs';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
const waitFor = (predicate, timeout = 5000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(async () => {
    try { if (await predicate()) { clearInterval(timer); resolve(); return; } } catch {}
    if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('等待超时')); }
  }, 15);
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('segmentsQuery 支持 latest、afterSequence、beforeSequence、ids 与 runId 归属校验', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-segments-'));
  const store = new ListeningStore(path.join(dir, 'data.sqlite'));
  try {
    const runA = store.createRun(null, settings, '范围查询');
    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push(store.addSegment(runA.listeningId, runA.runId, { id: `a${i}`, text: `Sentence ${i}.` }).segment.id);
    store.setTranslation(ids[0], '第一句。', false);
    store.setTranslation(ids[2], '第三句。', false);
    store.finishRun(runA.runId);
    const runB = store.createRun(runA.listeningId, settings, 'ignored');
    const idB = store.addSegment(runA.listeningId, runB.runId, { id: 'b1', text: 'Another run.' }).segment.id;

    const other = store.createRun(null, settings, '另一条记录');
    assert.equal(store.segmentsQuery('missing-listening-id'), null);
    assert.equal(store.segmentsQuery(runA.listeningId, { runId: other.runId }), 'missing-run');

    const latest = store.segmentsQuery(runA.listeningId, { latest: 3 });
    assert.deepEqual(latest.items.map(s => s.sequence_no), [4, 5, 6]);
    assert.equal(latest.total, 6);
    assert.equal(latest.pending, 4);

    const scoped = store.segmentsQuery(runA.listeningId, { runId: runA.runId, latest: 50 });
    assert.deepEqual(scoped.items.map(s => s.sequence_no), [1, 2, 3, 4, 5]);
    assert.equal(scoped.total, 5);
    assert.equal(scoped.pending, 3);

    const after = store.segmentsQuery(runA.listeningId, { afterSequence: 3, limit: 2 });
    assert.deepEqual(after.items.map(s => s.sequence_no), [4, 5]);

    const before = store.segmentsQuery(runA.listeningId, { beforeSequence: 4, limit: 2 });
    assert.deepEqual(before.items.map(s => s.sequence_no), [2, 3]);

    const byIds = store.segmentsQuery(runA.listeningId, { ids: [idB, ids[4], ids[0]] });
    assert.deepEqual(byIds.items.map(s => s.id), [ids[0], ids[4], idB]);

    const crossScope = store.segmentsQuery(runA.listeningId, { runId: runA.runId, ids: [idB] });
    assert.equal(crossScope.items.length, 0);
    assert.equal(store.segmentsQuery(runA.listeningId, { runId: 'not-a-run' }), 'missing-run');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/listenings/:id/segments 参数校验与实时补齐查询', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-segments-http-'));
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
  asrServer.on('connection', ws => {
    let taskId;
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        sentenceNo++;
        const sentence = { sentence_id: `s${sentenceNo}`, text: `Sentence number ${sentenceNo}.`, sentence_end: true };
        ws.send(JSON.stringify({ header: { event: 'result-generated' }, payload: { output: { sentence } } }));
        return;
      }
      const message = JSON.parse(raw.toString());
      if (message.header?.action === 'run-task') {
        taskId = message.header.task_id;
        ws.send(JSON.stringify({ header: { event: 'task-started' } }));
      }
      if (message.header?.action === 'finish-task') {
        ws.send(JSON.stringify({ header: { event: 'task-finished', task_id: taskId } }));
      }
    });
  });
  const port = 37000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, PORT: String(port),
    LISTENING_DB: path.join(dir, 'history.sqlite'), ASR_ENDPOINT: `ws://127.0.0.1:${asrServer.address().port}`,
    MT_ENDPOINT: `http://127.0.0.1:${modelPort}/chat/completions` }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  child.stdout.on('data', d => process.stderr.write('[server] ' + d));
  t.after(async () => {
    child.kill(); await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => asrServer.close(resolve));
    await new Promise(resolve => modelServer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base)).ok; } catch { return false; } });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events = [];
  ws.on('message', raw => events.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'start', key: 'test-key', source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }));
  await waitFor(() => events.some(e => e.type === 'listening-ready'));
  const ready = events.find(e => e.type === 'listening-ready');
  for (let i = 0; i < 4; i++) {
    ws.send(Buffer.from([0, i]));
    await waitFor(() => events.filter(e => e.type === 'segment-final').length >= i + 1);
  }
  ws.send(JSON.stringify({ type: 'stop' }));
  await new Promise(resolve => ws.once('close', resolve));

  const get = async query => {
    const response = await fetch(`${base}/api/listenings/${ready.listeningId}/segments${query}`);
    return { status: response.status, body: await response.json() };
  };
  let result = await get('?latest=3');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items.map(s => s.sequence_no), [2, 3, 4]);
  assert.equal(result.body.total, 4);
  result = await get(`?runId=${ready.runId}&afterSequence=2&limit=10`);
  assert.deepEqual(result.body.items.map(s => s.sequence_no), [3, 4]);
  result = await get('?beforeSequence=3&limit=10');
  assert.deepEqual(result.body.items.map(s => s.sequence_no), [1, 2]);
  const firstId = (await get('?latest=1&afterSequence=0')).body.items[0].id;
  result = await get(`?ids=${firstId}`);
  assert.equal(result.body.items.length, 1);
  assert.equal(result.body.items[0].id, firstId);

  assert.equal((await get('?runId=nope')).status, 400);
  assert.equal((await get(`?runId=${'0'.repeat(36)}`)).status, 404);
  assert.equal((await get('?ids=abc')).status, 400);
  assert.equal((await get(`?ids=${Array.from({ length: 51 }, () => firstId).join(',')}`)).status, 400);
  assert.equal((await get('?latest=0')).status, 400);
  assert.equal((await get('?latest=201')).status, 400);
  assert.equal((await get('?limit=0')).status, 400);
  assert.equal((await get('?afterSequence=-1')).status, 400);
  assert.equal((await get('?beforeSequence=0')).status, 400);
  assert.equal((await fetch(`${base}/api/listenings/${'0'.repeat(8)}-0000-0000-0000-000000000000/segments`)).status, 404);
});

test('契约：真实 DB 行经 entryFromSegment 后译文非空（防止列名漂移）', async () => {
  const { entryFromSegment } = await import('../public/caption-controller.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-contract-'));
  const store = new ListeningStore(path.join(dir, 'data.sqlite'));
  try {
    const run = store.createRun(null, settings, '契约');
    const { segment } = store.addSegment(run.listeningId, run.runId, { id: 'c1', text: 'Hello world.', endMs: 900 });
    store.setTranslation(segment.id, '你好，世界。', false);
    const row = store.segmentsQuery(run.listeningId, { runId: run.runId, latest: 10 }).items[0];
    const entry = entryFromSegment(row);
    assert.equal(entry.target, '你好，世界。');
    assert.equal(entry.translationState, 'complete');
    assert.equal(entry.source, 'Hello world.');
    assert.equal(entry.asrSentenceId, 'c1');
  } finally { store.close?.(); rmSync(dir, { recursive: true, force: true }); }
});
