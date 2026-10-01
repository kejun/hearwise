import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { ListeningStore } from '../storage.mjs';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
const missingId = '00000000-0000-0000-0000-000000000000';
const root = fileURLToPath(new URL('..', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hearwise-metadata-'));
  const filename = path.join(dir, 'history.sqlite');
  const context = { dir, filename, store: new ListeningStore(filename) };
  context.reopen = () => { context.store.close(); context.store = new ListeningStore(filename); };
  t.after(() => { context.store.close(); rmSync(dir, { recursive: true, force: true }); });
  return context;
}
function seed(store, title = '原始标题', { original = 'First sentence.', translated = '第一句。' } = {}) {
  const run = store.createRun(null, settings, title);
  let segment;
  if (original != null) {
    segment = store.addSegment(run.listeningId, run.runId, { id: 's1', text: original }).segment;
    if (translated != null) store.setTranslation(segment.id, translated, false);
  }
  store.finishRun(run.runId);
  return { ...run, segment };
}
function snapshotContent(store, id) {
  const { runs, segments, knowledge, jobs, processing } = store.detail(id);
  return { runs, segments, knowledge, jobs, processing };
}

test('v4 升级为 v8：历史记录默认空备注，转写与知识任务保留，重复打开不重建', t => {
  const h = fixture(t);
  const run = seed(h.store);
  h.store.createExtractionJob(run.listeningId, [run.segment]);
  const previous = snapshotContent(h.store, run.listeningId);
  h.store.db.exec('ALTER TABLE listenings DROP COLUMN notes; PRAGMA user_version = 4;');
  h.reopen();
  assert.equal(h.store.db.prepare('PRAGMA user_version').get().user_version, 9);
  const column = h.store.db.prepare("SELECT * FROM pragma_table_info('listenings') WHERE name='notes'").get();
  assert.equal(column.type, 'TEXT');
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, "''");
  assert.equal(h.store.detail(run.listeningId).listening.notes, '');
  assert.deepEqual(snapshotContent(h.store, run.listeningId), previous);
  assert.equal(h.store.list().items[0].notes, '');
  assert.equal(h.store.exportText(run.listeningId, 'original').text, 'First sentence.');
  h.store.updateMetadata(run.listeningId, { title: '迁移后标题', notes: '迁移后备注' });
  h.reopen();
  assert.equal(h.store.detail(run.listeningId).listening.notes, '迁移后备注');
  assert.equal(h.store.detail(run.listeningId).listening.title, '迁移后标题');
  assert.equal(h.store.detail(seed(h.store).listeningId).listening.notes, '');
});

test('标题和多行纯文本备注持久化，局部修改/清空备注不影响正文、时间及历史排序', t => {
  const h = fixture(t);
  const first = seed(h.store);
  const second = seed(h.store, '最近收听');
  h.store.createExtractionJob(first.listeningId, [first.segment]);
  h.store.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', first.listeningId);
  h.store.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run('2026-02-01T00:00:00.000Z', second.listeningId);
  const before = h.store.detail(first.listeningId).listening;
  const content = snapshotContent(h.store, first.listeningId);
  const order = h.store.list().items.map(item => item.id);
  const notes = '  第一行\n\n<script>alert("plain text")</script> & 备注\r\n最后一行  ';
  const updated = h.store.updateMetadata(first.listeningId, { title: '  新标题 🎧  ', notes });
  assert.equal(updated.title, '新标题 🎧');
  assert.equal(updated.notes, notes);
  assert.equal(updated.created_at, before.created_at);
  assert.equal(updated.updated_at, before.updated_at);
  assert.deepEqual(snapshotContent(h.store, first.listeningId), content);
  assert.deepEqual(h.store.list().items.map(item => item.id), order);
  h.reopen();
  assert.equal(h.store.detail(first.listeningId).listening.notes, notes);
  assert.equal(h.store.list().items.find(item => item.id === first.listeningId).title, '新标题 🎧');
  assert.equal(h.store.updateMetadata(first.listeningId, { title: '仅改标题' }).notes, notes);
  assert.equal(h.store.updateMetadata(first.listeningId, { notes: '' }).title, '仅改标题');
  assert.equal(h.store.detail(first.listeningId).listening.notes, '');
  // Continuing listening must retain both user-authored fields.
  h.store.updateMetadata(first.listeningId, { notes: '继续前的备注' });
  const resumed = h.store.createRun(first.listeningId, settings, '不应覆盖标题');
  assert.equal(h.store.detail(first.listeningId).listening.title, '仅改标题');
  assert.equal(h.store.detail(first.listeningId).listening.notes, '继续前的备注');
  h.store.finishRun(resumed.runId);
});

test('元数据验证：空标题、错误类型、过长及未知字段不写入；支持上限及缺失/活动状态', t => {
  const h = fixture(t);
  const run = seed(h.store);
  const before = h.store.detail(run.listeningId).listening;
  const invalid = [null, [], 'text', 0, {}, { unexpected: true }, { title: 'valid', notes: 'valid', updated_at: 'fake' },
    { title: '' }, { title: ' \t\n ' }, { title: 123 }, { title: null }, { title: [] }, { title: {} },
    { title: '中'.repeat(201) }, { notes: null }, { notes: [] }, { notes: {} }, { notes: false },
    { notes: '中'.repeat(10001) }, { title: 'valid', notes: 'x'.repeat(10001) }];
  for (const input of invalid) {
    assert.throws(() => h.store.updateMetadata(run.listeningId, input), TypeError, JSON.stringify(input)?.slice(0, 100));
    assert.deepEqual(h.store.detail(run.listeningId).listening, before);
  }
  const maximum = h.store.updateMetadata(run.listeningId, { title: '中'.repeat(200), notes: '备'.repeat(10000) });
  assert.equal(maximum.title.length, 200);
  assert.equal(maximum.notes.length, 10000);
  assert.equal(h.store.updateMetadata(missingId, { title: 'missing' }), 'missing');
  const active = h.store.createRun(run.listeningId, settings, 'ignored');
  assert.equal(h.store.updateMetadata(run.listeningId, { title: 'active', notes: 'blocked' }), 'active');
  assert.equal(h.store.detail(run.listeningId).listening.title, maximum.title);
  h.store.finishRun(active.runId);
  assert.equal(h.store.updateMetadata(run.listeningId, { notes: 'stopped' }).notes, 'stopped');
});

test('两种 TXT 在正文前加备注，空白备注保持旧内容，备注不能替代缺失的原文/译文', t => {
  const h = fixture(t);
  const run = seed(h.store);
  const second = h.store.createRun(run.listeningId, settings, 'ignored');
  h.store.addSegment(run.listeningId, second.runId, { id: 's2', text: 'Second sentence.' });
  h.store.finishRun(second.runId);
  const original = 'First sentence.\nSecond sentence.';
  const translation = '第一句。';
  for (const notes of ['', ' \t\n ']) {
    h.store.updateMetadata(run.listeningId, { notes });
    assert.equal(h.store.exportText(run.listeningId, 'original').text, original);
    assert.equal(h.store.exportText(run.listeningId, 'translation').text, translation);
  }
  const notes = '<b>纯文本备注</b>\n第二行\n保留换行';
  h.store.updateMetadata(run.listeningId, { title: '编辑后的导出标题', notes });
  for (const [kind, body] of [['original', original], ['translation', translation]]) {
    assert.deepEqual(h.store.exportText(run.listeningId, kind), {
      title: '编辑后的导出标题', hasBody: true, text: `${notes}\n\n${body}`
    });
  }
  const empty = seed(h.store, '仅备注', { original: null });
  const untranslated = seed(h.store, '未翻译', { translated: null });
  const whitespace = seed(h.store, '空白正文', { original: ' \n ', translated: '\t ' });
  for (const id of [empty.listeningId, untranslated.listeningId, whitespace.listeningId]) {
    h.store.updateMetadata(id, { notes: '不能单独导出' });
    assert.equal(h.store.exportText(id, 'translation').hasBody, false);
    assert.ok(!h.store.exportText(id, 'translation').text.includes('不能单独导出'));
  }
  assert.equal(h.store.exportText(empty.listeningId, 'original').hasBody, false);
  assert.equal(h.store.exportText(whitespace.listeningId, 'original').hasBody, false);
  assert.equal(h.store.exportText(missingId, 'original'), null);
});

async function startApp(t, filename, modelPort) {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: '0', HOST: '127.0.0.1',
    LISTENING_DB: filename, MT_ENDPOINT: `http://127.0.0.1:${modelPort}/models`, ASR_ENDPOINT: `ws://127.0.0.1:${modelPort}/asr` },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) return `http://127.0.0.1:${match[1]}`;
    if (child.exitCode != null) throw new Error(`Server exited: ${output}`);
    await delay(20);
  }
  throw new Error(`Server startup timed out: ${output}`);
}

test('PATCH/GET/TXT API：保存立即生效、校验和同源保护、活动冲突、无正文阻止导出且不调用模型', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hearwise-metadata-api-'));
  const filename = path.join(dir, 'history.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const initial = new ListeningStore(filename);
  const run = seed(initial);
  const empty = seed(initial, '无正文', { original: null });
  const untranslated = seed(initial, '只有原文', { translated: null });
  initial.createExtractionJob(untranslated.listeningId, [untranslated.segment]);
  const before = snapshotContent(initial, run.listeningId);
  const originalMetadata = initial.detail(run.listeningId).listening;
  initial.close();
  let modelCalls = 0;
  const modelServer = http.createServer((_req, res) => { modelCalls++; res.writeHead(500); res.end('Unexpected model call'); });
  modelServer.on('upgrade', (_req, socket) => { modelCalls++; socket.destroy(); });
  const modelPort = await listen(modelServer);
  t.after(() => new Promise(resolve => modelServer.close(resolve)));
  const base = await startApp(t, filename, modelPort);
  const endpoint = `${base}/api/listenings/${run.listeningId}`;
  const patch = (input, url = endpoint, headers = {}) => fetch(url, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
  const read = async () => (await fetch(endpoint)).json();
  const notes = '第一行备注\n第二行 <script>plain text</script>';
  let response = await patch({ title: '  改名后的收听 🎧  ', notes });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.listening.title, '改名后的收听 🎧');
  assert.equal(result.listening.notes, notes);
  assert.equal(result.listening.updated_at, originalMetadata.updated_at);
  assert.equal((await read()).listening.title, result.listening.title);
  assert.equal((await (await fetch(`${base}/api/listenings`)).json()).items.find(item => item.id === run.listeningId).notes, notes);
  for (const [kind, body, label] of [['original', 'First sentence.', '原文'], ['translation', '第一句。', '译文']]) {
    response = await fetch(`${endpoint}/export?kind=${kind}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `${notes}\n\n${body}`);
    assert.ok(response.headers.get('content-type').startsWith('text/plain'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('content-disposition').includes(`filename="transcript-${kind}.txt"`));
    const filename = decodeURIComponent(response.headers.get('content-disposition').split("filename*=UTF-8''")[1]);
    assert.equal(filename, `改名后的收听-🎧-${label}.txt`);
  }
  response = await patch({ notes: '' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).listening.title, result.listening.title);
  assert.equal(await (await fetch(`${endpoint}/export?kind=original`)).text(), 'First sentence.');
  assert.equal((await patch({ title: '标题不改变备注' })).status, 200);
  assert.equal((await read()).listening.notes, '');
  for (const input of [null, [], 'x', {}, { extra: 'x' }, { title: '' }, { title: ' \n ' }, { title: 1 }, { title: null },
    { title: 'x'.repeat(201) }, { notes: null }, { notes: 1 }, { notes: {} }, { notes: 'x'.repeat(10001) }]) {
    response = await patch(input);
    assert.equal(response.status, 400, JSON.stringify(input)?.slice(0, 60));
    assert.equal(typeof (await response.json()).error, 'string');
  }
  response = await fetch(endpoint, { method: 'PATCH', body: '{bad json' });
  assert.equal(response.status, 400);
  assert.equal((await patch({ notes: 'x'.repeat(33000) })).status, 400);
  assert.equal((await patch({ title: '跨域不得修改' }, endpoint, { Origin: 'http://example.com' })).status, 403);
  assert.equal((await patch({ title: '不存在' }, `${base}/api/listenings/${missingId}`)).status, 404);
  assert.equal((await fetch(`${base}/api/listenings/${missingId}/export?kind=original`)).status, 404);
  assert.equal((await fetch(`${endpoint}/export?kind=both`)).status, 400);

  // An active run in another tab is checked in the database, not only in the UI.
  const db = new DatabaseSync(filename);
  try {
    db.prepare("UPDATE listening_runs SET state='active', ended_at=NULL WHERE id=?").run(run.runId);
    response = await patch({ title: '活动中不可修改' });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /先停止/);
    db.prepare("UPDATE listening_runs SET state='complete', ended_at=? WHERE id=?").run(before.runs[0].ended_at, run.runId);
  } finally { db.close(); }
  assert.equal((await patch({ title: '停止后可修改' })).status, 200);
  for (const id of [empty.listeningId, untranslated.listeningId]) {
    assert.equal((await patch({ notes: '只有备注不能生成正文' }, `${base}/api/listenings/${id}`)).status, 200);
    assert.equal((await fetch(`${base}/api/listenings/${id}/export?kind=translation`)).status, 409);
  }
  assert.equal((await fetch(`${base}/api/listenings/${empty.listeningId}/export?kind=original`)).status, 409);

  const filenames = [
    ['../../危险/标题\\path:*?"<>|\u0000\u0001\u007f\u0085\r\n🎧', '危险-标题-path-🎧-原文.txt'],
    ['a'.repeat(79) + '🎧Z', 'a'.repeat(79) + '🎧-原文.txt'],
    ["A'(*).🎧", "A'(-).🎧-原文.txt"],
    ['\ud800孤立代理项', '�孤立代理项-原文.txt'],
    ['../\\:*?"<>|', '收听记录-原文.txt']
  ];
  for (const [title, expected] of filenames) {
    assert.equal((await patch({ title })).status, 200);
    response = await fetch(`${endpoint}/export?kind=original`);
    assert.equal(response.status, 200);
    const disposition = response.headers.get('content-disposition');
    const encoded = disposition.split("filename*=UTF-8''")[1];
    assert.doesNotMatch(encoded, /['()*\u0000-\u001f\u007f-\u009f]/);
    assert.equal(decodeURIComponent(encoded), expected);
  }
  // HTTP may split a multi-byte character between chunks. Decode only after buffering.
  const splitNotes = '分块中文 🎧\n第二行';
  const payload = Buffer.from(JSON.stringify({ notes: splitNotes }));
  const splitAt = payload.indexOf(Buffer.from('中')) + 1;
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.write(payload.subarray(0, splitAt));
    setTimeout(() => req.end(payload.subarray(splitAt)), 20);
  });
  assert.equal(chunked.status, 200);
  assert.equal(chunked.body.listening.notes, splitNotes);
  assert.equal((await read()).listening.notes, splitNotes);
  // The advertised maximum remains writable even with three-byte Chinese text.
  response = await patch({ title: '中'.repeat(200), notes: '备'.repeat(10000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).listening.notes.length, 10000);
  const after = await read();
  assert.deepEqual({ runs: after.runs, segments: after.segments, knowledge: after.knowledge, jobs: after.jobs, processing: after.processing },
    JSON.parse(JSON.stringify(before)));
  assert.equal(modelCalls, 0);
});
