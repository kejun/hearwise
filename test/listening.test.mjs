import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { ListeningStore } from '../storage.mjs';
import { parseKnowledge } from '../knowledge.mjs';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
const waitFor = (predicate, timeout = 3000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(async () => {
    try { if (await predicate()) { clearInterval(timer); resolve(); return; } } catch {}
    if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('等待超时')); }
  }, 15);
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('最终句幂等、继续收听顺序与重启恢复', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-store-'));
  const filename = path.join(dir, 'data.sqlite');
  try {
    let store = new ListeningStore(filename);
    const first = store.createRun(null, settings, '测试收听');
    assert.throws(() => store.createRun(first.listeningId, settings, 'ignored'), /正在另一个页面/);
    const a = store.addSegment(first.listeningId, first.runId, { id: 's1', text: 'Maya plans a launch.' });
    assert.equal(store.addSegment(first.listeningId, first.runId, { id: 's1', text: 'changed' }).inserted, false);
    store.setTranslation(a.segment.id, 'Maya 计划发布。', false);
    store.close();
    store = new ListeningStore(filename);
    assert.equal(store.detail(first.listeningId).runs[0].state, 'interrupted');
    const second = store.createRun(first.listeningId, { ...settings, targetLang: 'Japanese' }, 'ignored');
    const b = store.addSegment(first.listeningId, second.runId, { id: 's1', text: 'The launch is done.' });
    assert.equal(b.segment.sequence_no, 2);
    assert.equal(store.detail(first.listeningId).segments[0].translation_text, 'Maya 计划发布。');
    assert.equal(store.detail(first.listeningId).runs[1].target_lang, 'Japanese');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('知识只接受当前句子的原文证据并保留背景来源', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-knowledge-'));
  const store = new ListeningStore(path.join(dir, 'data.sqlite'));
  try {
    const run = store.createRun(null, settings, '知识测试');
    const segment = store.addSegment(run.listeningId, run.runId, { id: 's1', text: 'I mean Kubernetes.' }).segment;
    const input = { focus_segments: [{ id: segment.id, text: segment.original_text }], existing_candidates: [] };
    const item = { type: 'term', canonical_name: 'Kubernetes', aliases: [], dialogue_summary: '对话提到 Kubernetes。',
      background_note: '容器编排平台。', certainty: 'clear', decision: 'create', existing_item_id: null,
      correction_reason: null, evidence: [{ segment_id: segment.id, quote: 'Kubernetes' }] };
    assert.throws(() => parseKnowledge(JSON.stringify({ items: [{ ...item, evidence: [{ segment_id: 'wrong', quote: 'Kubernetes' }] }] }), input), /原文证据/);
    const parsed = parseKnowledge('```json\n' + JSON.stringify({ items: [item] }) + '\n```', input);
    const [created] = store.applyKnowledge(run.listeningId, parsed);
    assert.equal(created.background_note, '容器编排平台。');
    assert.equal(created.mentions[0].segment_id, segment.id);
    assert.equal(store.detail(run.listeningId).segments[0].original_text, 'I mean Kubernetes.');
    const another = store.addSegment(run.listeningId, run.runId, { id: 's2', text: 'Another Kubernetes project is unrelated.' }).segment;
    const separate = parseKnowledge(JSON.stringify({ items: [{ ...item,
      evidence: [{ segment_id: another.id, quote: 'Kubernetes' }], dialogue_summary: '对话提到另一个同名项目。', certainty: 'needs_review' }] }),
      { focus_segments: [{ id: another.id, text: another.original_text }], context_segments: [], existing_candidates: [] });
    store.applyKnowledge(run.listeningId, separate);
    assert.equal(store.knowledge(run.listeningId).length, 2);
    const correctionSegment = store.addSegment(run.listeningId, run.runId, { id: 's3', text: 'I mean Kubernetes Platform.' }).segment;
    const correction = parseKnowledge(JSON.stringify({ items: [{ ...item, canonical_name: 'Kubernetes Platform',
      decision: 'correct', existing_item_id: created.id, correction_reason: '对话明确说 I mean',
      evidence: [{ segment_id: correctionSegment.id, quote: 'Kubernetes Platform' }] }] }),
      { focus_segments: [{ id: correctionSegment.id, text: correctionSegment.original_text }], context_segments: [],
        existing_candidates: [{ id: created.id, type: 'term', aliases: [] }] });
    store.applyKnowledge(run.listeningId, correction);
    const corrected = store.knowledge(run.listeningId).find(k => k.id === created.id);
    assert.equal(corrected.canonical_name, 'Kubernetes Platform');
    assert.equal(corrected.revisions[0].old_value, 'Kubernetes');
    assert.equal(store.detail(run.listeningId).segments[0].original_text, 'I mean Kubernetes.');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('删除已结束的收听记录并级联清除关联数据', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-delete-'));
  const store = new ListeningStore(path.join(dir, 'data.sqlite'));
  try {
    const run = store.createRun(null, settings, '待删除记录');
    const other = store.createRun(null, settings, '保留记录');
    const segment = store.addSegment(run.listeningId, run.runId, { id: 's1', text: 'Maya speaks.' }).segment;
    store.createExtractionJob(run.listeningId, [segment]);
    store.applyKnowledge(run.listeningId, [{ type: 'person', canonical_name: 'Maya', aliases: ['May'],
      dialogue_summary: '提到了 Maya。', background_note: null, certainty: 'clear', decision: 'create',
      existing_item_id: null, correction_reason: null, evidence: [{ segment_id: segment.id, quote: 'Maya' }] }]);
    assert.equal(store.removeListening(run.listeningId), 'active');
    assert.ok(store.detail(run.listeningId));
    store.finishRun(run.runId);
    assert.equal(store.removeListening(run.listeningId), 'deleted');
    assert.equal(store.removeListening(run.listeningId), 'missing');
    assert.equal(store.detail(run.listeningId), null);
    for (const table of ['listening_runs', 'segments', 'knowledge_items', 'knowledge_aliases', 'knowledge_mentions', 'extraction_jobs']) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, table === 'listening_runs' ? 1 : 0, table);
    }
    assert.ok(store.detail(other.listeningId));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('积压的相邻知识批次合并且不遗漏原文', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-batch-'));
  const store = new ListeningStore(path.join(dir, 'data.sqlite'));
  try {
    const run = store.createRun(null, settings, '批次测试');
    for (let i = 1; i <= 6; i++) store.addSegment(run.listeningId, run.runId, { id: `s${i}`, text: `Maya says ${i}.` });
    const first = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
    const merged = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
    assert.equal(first.id, merged.id);
    assert.equal(merged.from_sequence, 1);
    assert.equal(merged.to_sequence, 6);
    assert.equal(store.jobInput(merged).focus_segments.length, 6);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('WebSocket 最终句持久化、翻译抽取、停止后重试和继续收听', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-server-'));
  let failTranslationCount = 0;
  let failKnowledgeCount = 0;
  const modelServer = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.model === 'qwen-mt-flash' && failTranslationCount-- > 0 || body.model === 'qwen-doc-turbo' && failKnowledgeCount-- > 0) {
      res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'temporary failure' } })); return;
    }
    let content;
    if (body.model === 'qwen-mt-flash') content = '已翻译：' + body.messages[0].content;
    else {
      const input = JSON.parse(body.messages[1].content);
      const focus = input.focus_segments[0];
      const candidate = input.existing_candidates.find(c => c.canonical_name === 'Maya');
      content = JSON.stringify({ items: focus ? [{ type: 'person', canonical_name: 'Maya', aliases: [],
        dialogue_summary: '对话提到 Maya。', background_note: null, certainty: 'clear', decision: candidate ? 'link' : 'create',
        existing_item_id: candidate?.id || null, correction_reason: null, evidence: [{ segment_id: focus.id, quote: 'Maya' }] }] : [] });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
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
        const sentence = { sentence_id: 'same-id', text: sentenceNo === 1 ? 'Maya speaks.' : 'Maya returns.', sentence_end: true };
        const event = JSON.stringify({ header: { event: 'result-generated' }, payload: { output: { sentence } } });
        ws.send(event); ws.send(event);
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
  const port = 36000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, PORT: String(port),
    LISTENING_DB: path.join(dir, 'history.sqlite'), ASR_ENDPOINT: `ws://127.0.0.1:${asrServer.address().port}`,
    MT_ENDPOINT: `http://127.0.0.1:${modelPort}/chat/completions` }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[server] '+d));
  child.stdout.on('data', d => process.stderr.write('[server] '+d));
  t.after(async () => {
    child.kill(); await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => asrServer.close(resolve));
    await new Promise(resolve => modelServer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base)).ok; } catch { return false; } });
  async function startRun(listeningId = null) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', raw => events.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'start', key: 'test-key', source: 'en', targetLang: 'Chinese', audioSource: 'microphone', listeningId }));
    await waitFor(() => events.some(e => e.type === 'listening-ready'));
    ws.send(Buffer.from([0, 0]));
    await waitFor(() => events.some(e => e.type === 'segment-final'));
    return { ws, events, ready: events.find(e => e.type === 'listening-ready') };
  }
  const first = await startRun();
  await waitFor(() => first.events.some(e => e.type === 'translation-updated'));
  const activeDelete = await fetch(`${base}/api/listenings/${first.ready.listeningId}`, { method: 'DELETE' });
  assert.equal(activeDelete.status, 409);
  first.ws.send(JSON.stringify({ type: 'stop' }));
  await new Promise(resolve => first.ws.once('close', resolve));
  const read = async () => (await fetch(`${base}/api/listenings/${first.ready.listeningId}`)).json();
  let detail = await read();
  assert.equal(detail.segments.length, 1);
  assert.equal(detail.segments[0].translation_text, '已翻译：Maya speaks.');
  assert.equal(detail.runs[0].state, 'complete');
  await waitFor(async () => (await read()).knowledge.length === 1);
  failTranslationCount = 1; failKnowledgeCount = 2;
  const second = await startRun(first.ready.listeningId);
  second.ws.send(JSON.stringify({ type: 'stop' }));
  await new Promise(resolve => second.ws.once('close', resolve));
  await waitFor(async () => { const current = await read(); return current.segments[1]?.translation_state === 'failed' && current.jobs.at(-1)?.state === 'failed'; });
  detail = await read();
  assert.equal(detail.runs.length, 2);
  assert.deepEqual(detail.segments.map(s => s.sequence_no), [1, 2]);
  assert.equal(detail.segments[0].original_text, 'Maya speaks.');
  assert.equal((await (await fetch(`${base}/api/listenings`)).json()).items[0].segment_count, 2);
  const blocked = await fetch(`${base}/api/listenings/${first.ready.listeningId}/retry`, { method: 'POST',
    headers: { Origin: 'http://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'test-key' }) });
  assert.equal(blocked.status, 403);
  const retry = await fetch(`${base}/api/listenings/${first.ready.listeningId}/retry`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'test-key' }) });
  assert.equal(retry.status, 202);
  await waitFor(async () => { const current = await read(); return current.segments[1].translation_state === 'complete' && current.jobs.at(-1).state === 'complete'; });
  detail = await read();
  assert.equal(detail.knowledge.length, 1);
  assert.equal(detail.knowledge[0].mentions.length, 2);
  const blockedDelete = await fetch(`${base}/api/listenings/${first.ready.listeningId}`, { method: 'DELETE',
    headers: { Origin: 'http://example.com' } });
  assert.equal(blockedDelete.status, 403);
  const deleted = await fetch(`${base}/api/listenings/${first.ready.listeningId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal((await fetch(`${base}/api/listenings/${first.ready.listeningId}`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/listenings`)).json()).total, 0);
  assert.equal((await fetch(`${base}/api/listenings/${first.ready.listeningId}`, { method: 'DELETE' })).status, 404);
});
