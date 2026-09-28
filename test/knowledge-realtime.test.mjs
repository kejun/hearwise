import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { extractKnowledge } from '../knowledge.mjs';

const waitFor = async (predicate, timeout = 7000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('等待实时知识事件超时');
};
function reply(res, content) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
}
function knowledgeContent(input) {
  const segment = input.focus_segments[0];
  return JSON.stringify({ items: [{ action: 'create', type: 'other', display_label: 'product', canonical_name: 'AlphaFold',
    role: '核心系统', reason: '本次讨论的主体', existing_item_id: null, observed_candidate_id: null, correction_reason: null,
    aliases: [], short_description: '本次讨论的核心系统。', new_information: '本次讨论围绕 AlphaFold。', certainty: 'clear',
    evidence: [{ segment_id: segment.id, quote: segment.text }] }] });
}
async function startServer(t, onModel) {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-realtime-'));
  const requests = [], log = [], clients = [];
  const modelServer = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const request = { body, at: Date.now(), res };
    requests.push(request);
    onModel(request);
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const asr = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => asr.once('listening', resolve));
  asr.on('connection', ws => {
    let sentence = 0;
    ws.on('message', (raw, binary) => {
      if (binary) {
        ws.send(JSON.stringify({ header: { event: 'result-generated' }, payload: { output: { sentence: {
          sentence_id: String(++sentence), text: raw.toString(), sentence_end: true
        } } } }));
      } else {
        const message = JSON.parse(raw.toString());
        if (message.header.action === 'run-task') ws.send(JSON.stringify({ header: { event: 'task-started' } }));
        if (message.header.action === 'finish-task') ws.send(JSON.stringify({ header: { event: 'task-finished' } }));
      }
    });
  });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env: { ...process.env,
    PORT: '0', HOST: '127.0.0.1', LISTENING_DB: path.join(dir, 'test.sqlite'),
    EXTRACTION_WAIT_MS: '1500', EXTRACTION_CONCURRENCY: '2',
    ASR_ENDPOINT: `ws://127.0.0.1:${asr.address().port}`, MT_ENDPOINT: `http://127.0.0.1:${modelServer.address().port}`
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => log.push(String(data)));
  child.stderr.on('data', data => log.push(String(data)));
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    if (child.exitCode == null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    for (const ws of asr.clients) ws.terminate();
    await new Promise(resolve => asr.close(resolve));
    modelServer.closeAllConnections();
    await new Promise(resolve => modelServer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => /http:\/\/127\.0\.0\.1:\d+/.test(log.join('')));
  const base = log.join('').match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  async function start(source = 'zh') {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws'), events = [];
    clients.push(ws);
    ws.on('message', raw => events.push({ ...JSON.parse(raw.toString()), receivedAt: Date.now() }));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'start', key: 'test-knowledge-key', source, targetLang: 'Chinese', audioSource: 'microphone' }));
    await waitFor(() => events.some(e => e.type === 'listening-ready'));
    return { ws, events, id: events.find(e => e.type === 'listening-ready').listeningId };
  }
  return { base, requests, log, start };
}

test('收听中孤立句及时成批，429 后自动恢复并推送卡片，无需停止或手动刷新', async t => {
  let knowledgeCalls = 0;
  const s = await startServer(t, ({ body, res }) => {
    assert.equal(body.model, 'qwen3.8-flash');
    if (++knowledgeCalls === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      res.end(JSON.stringify({ error: { message: 'rate limit' } }));
    } else reply(res, knowledgeContent(JSON.parse(body.messages[1].content)));
  });
  const r = await s.start();
  r.ws.send(Buffer.from('AlphaFold 是本次讨论的核心系统。'));
  await waitFor(() => r.events.some(e => e.processing?.knowledge.bufferedSegments === 1));
  await waitFor(() => r.events.some(e => e.processing?.knowledge.retryingJobs === 1));
  await waitFor(() => r.events.some(e => e.type === 'knowledge-upserted'));
  const final = r.events.find(e => e.type === 'segment-final');
  assert.ok(s.requests[0].at - final.receivedAt >= 1200, '应有合批窗口');
  assert.ok(s.requests[0].at - final.receivedAt < 4000, '不能再固定等待 10 秒');
  assert.ok(s.requests[1].at - s.requests[0].at >= 1900, '遵守服务的重试等待时间');
  assert.equal(r.ws.readyState, WebSocket.OPEN);
  const detail = await (await fetch(`${s.base}/api/listenings/${r.id}`)).json();
  assert.equal(detail.knowledge.length, 1);
  assert.equal(detail.jobs[0].attempts, 2);
  assert.equal(detail.jobs[0].state, 'complete');
  assert.equal(detail.processing.knowledge.bufferedSegments, 0);
  assert.equal((await fetch(`${s.base}/processing-state.js`)).status, 200);
  assert.ok(s.log.some(line => line.includes('first_final_age_ms')));
  assert.ok(!s.log.join('').includes('test-knowledge-key'));
  t.diagnostic(`模拟模型：首次调用距最终句 ${s.requests[0].at - final.receivedAt}ms；重试间隔 ${s.requests[1].at - s.requests[0].at}ms`);
});

test('翻译请求持续占用时，知识仍在短暂让路后通过 WebSocket 更新', async t => {
  let holdTranslations = true;
  const held = [];
  const s = await startServer(t, ({ body, res }) => {
    if (body.model === 'qwen-mt-flash') {
      if (holdTranslations) held.push(res);
      else reply(res, '已翻译');
    } else reply(res, knowledgeContent(JSON.parse(body.messages[1].content)));
  });
  const r = await s.start('en');
  for (let i = 0; i < 3; i++) r.ws.send(Buffer.from(`AlphaFold is the focus of this discussion ${i}.`));
  await waitFor(() => r.events.some(e => e.type === 'knowledge-upserted'));
  assert.equal(held.length, 2, '最终翻译继续占用自己的并发额度');
  assert.equal(r.events.filter(e => e.type === 'translation-updated').length, 0);
  const knowledge = s.requests.find(request => request.body.model === 'qwen3.8-flash');
  const lastFinal = r.events.filter(e => e.type === 'segment-final').at(-1);
  assert.ok(knowledge.at - lastFinal.receivedAt < 4000, '不能等翻译完成或 15 秒后才开始知识抽取');
  assert.equal(JSON.parse(knowledge.body.messages[1].content).focus_segments.length, 3);
  holdTranslations = false; held.forEach(res => reply(res, '已翻译'));
  await waitFor(() => r.events.filter(e => e.type === 'translation-updated').length === 3);
  t.diagnostic(`模拟模型：翻译持续繁忙时，知识调用距最后最终句 ${knowledge.at - lastFinal.receivedAt}ms`);
});

test('模型 HTTP 错误保留状态码并解析 Retry-After 日期', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-28T08:00:00Z') });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'limited' } }), {
    status: 429, headers: { 'Retry-After': 'Mon, 28 Sep 2026 08:00:10 GMT' }
  }));
  await assert.rejects(extractKnowledge('test-key', { policy_version: 2 }, 'http://test.invalid'), error => {
    assert.equal(error.status, 429); assert.equal(error.retryAfterMs, 10000); return true;
  });
});

test('模型返回响应头后读取超时仍按超时恢复，不误判为 JSON 协议错误', async t => {
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => { throw timeout; } }));
  await assert.rejects(extractKnowledge('test-key', { policy_version: 2 }, 'http://test.invalid'), error => error === timeout);
});

function newsItem(input, name, extra = {}) {
  return { action: 'create', display_label: 'organization', canonical_name: name,
    role: '主体', reason: '新闻的算力合作参与方', existing_item_id: null, observed_candidate_id: null,
    correction_reason: null, aliases: [], short_description: `${name}参与新闻中的算力合作。`,
    new_information: `原文提到${name}参与算力合作。`, certainty: 'clear',
    evidence: [{ segment_id: input.focus_segments[0].id, quote: name }], ...extra };
}

test('真实HTTP/WebSocket：有效公司先展示，定向纠正只补另一公司并及时发布补全状态', async t => {
  let held, extractionCalls = 0, repairCalls = 0;
  const s = await startServer(t, ({ body, res }) => {
    if (body.model === 'qwen-mt-flash') { reply(res, '两家公司开展算力合作。'); return; }
    const input = JSON.parse(body.messages[1].content);
    if (input.rejected) { repairCalls++; held = { input, res }; }
    else {
      extractionCalls++;
      reply(res, JSON.stringify({ items: [newsItem(input, 'Anthropic'), newsItem(input, 'Akamai', { role: null })] }));
    }
  });
  const r = await s.start('en');
  r.ws.send(Buffer.from('Anthropic signed a compute deal with Akamai.'));
  await waitFor(() => held);
  assert.equal(held.input.rejected.length, 1);
  assert.equal(held.input.rejected[0].item.canonical_name, 'Akamai');
  assert.ok(held.input.rejected[0].issues.some(issue => issue.code === 'ROLE_REQUIRED'));
  await waitFor(() => r.events.some(event => event.processing?.knowledge.repairingJobs === 1));
  const before = await (await fetch(`${s.base}/api/listenings/${r.id}`)).json();
  assert.equal(before.knowledge.length, 1);
  assert.equal(before.knowledge[0].canonical_name, 'Anthropic');
  assert.ok(r.events.some(event => event.type === 'knowledge-upserted' && event.item.canonical_name === 'Anthropic'));
  assert.equal(before.jobs[0].state, 'running');
  assert.equal('progress_json' in before.jobs[0], false, 'private checkpoint is not a polling payload');
  reply(held.res, JSON.stringify({ corrections: [{ rejection_id: held.input.rejected[0].rejection_id,
    item: { ...held.input.rejected[0].item, role: '主体' } }] }));
  await waitFor(() => r.events.some(event => event.type === 'knowledge-upserted' && event.item.canonical_name === 'Akamai'));
  await waitFor(async () => (await (await fetch(`${s.base}/api/listenings/${r.id}`)).json()).jobs[0].outcome === 'ok');
  const after = await (await fetch(`${s.base}/api/listenings/${r.id}`)).json();
  assert.deepEqual(after.knowledge.map(item => item.canonical_name).sort(), ['Akamai', 'Anthropic']);
  assert.equal(after.knowledge.find(item => item.canonical_name === 'Anthropic').id, before.knowledge[0].id);
  assert.deepEqual([extractionCalls, repairCalls], [1, 1]);
  assert.match(s.log.join(''), /ROLE_REQUIRED/);
  assert.ok(!s.log.join('').includes('test-knowledge-key'));
  t.diagnostic('使用构造模型响应验证完整传输与入库链路；不代表真实模型主体召回率。');
});

test('真实HTTP/API：全拒绝后空纠正保持失败，人工继续只重试未解决条目', async t => {
  let extractionCalls = 0, repairCalls = 0;
  const s = await startServer(t, ({ body, res }) => {
    if (body.model === 'qwen-mt-flash') { reply(res, '算力合作。'); return; }
    const input = JSON.parse(body.messages[1].content);
    if (!input.rejected) {
      extractionCalls++;
      reply(res, JSON.stringify({ items: [newsItem(input, 'Akamai', { role: null })] }));
    } else {
      repairCalls++;
      reply(res, JSON.stringify({ corrections: repairCalls === 1 ? [] : input.rejected.map(target => ({
        rejection_id: target.rejection_id, item: { ...target.item, role: '主体' }
      })) }));
    }
  });
  const r = await s.start('en');
  r.ws.send(Buffer.from('Anthropic signed a compute deal with Akamai.'));
  const read = async () => (await fetch(`${s.base}/api/listenings/${r.id}`)).json();
  await waitFor(async () => (await read()).jobs[0]?.outcome === 'invalid');
  const failed = await read();
  assert.equal(failed.knowledge.length, 0);
  assert.equal(failed.processing.knowledge.failedJobs, 1);
  assert.equal(failed.processing.knowledge.unresolvedItems, 1);
  assert.equal(failed.processing.knowledge.pendingJobs + failed.processing.knowledge.runningJobs, 0);
  const retry = await fetch(`${s.base}/api/listenings/${r.id}/retry`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'test-knowledge-key' }) });
  assert.equal(retry.status, 202);
  await waitFor(async () => (await read()).jobs[0]?.outcome === 'ok');
  assert.deepEqual([extractionCalls, repairCalls], [1, 2]);
  assert.equal((await read()).knowledge.length, 1);
});
