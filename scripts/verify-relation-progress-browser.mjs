// Deterministic UI contract/race checks against a local HTTP fixture. No model calls.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { graphStatusText } from '../public/knowledge-graph.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const directory = process.env.GRAPH_EVIDENCE_DIR;
if (directory) await mkdir(directory, { recursive: true });
const limits = { maxWindowRequests: 3, requestTimeoutMs: 30000, maxConcurrent: 2 };
const nodes = [{ id: 'kodak', canonical_name: 'Eastman Kodak', display_label: 'organization', content_version: 1, short_description: '对话中提到的相机公司' },
  { id: 'brownie', canonical_name: 'Brownie camera', display_label: 'product', content_version: 1 }];
const relation = { id: 'edge', subject_item_id: 'kodak', object_item_id: 'brownie', predicate: 'released', assertions: [{ id: 'claim', status: 'active', modality: 'asserted', polarity: 'positive', statement: 'Kodak released the Brownie camera.' }] };
const statuses = { a: { enabled: false, state: 'not_generated', limits }, b: { enabled: false, state: 'not_generated', limits } };
const counters = { GET: 0, POST: 0, DELETE: 0 };
let revision = 1, roundNumber = 0, holdGet, holdPost, holdDelete, dropPost = false, dropDelete = false, failGets = 0, startedEvents = 0, browser;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async check => {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture check timed out'); await new Promise(r => setTimeout(r, 20)); }
};
function activeStatus() {
  const startedAt = Date.now() - 185000;
  return { enabled: true, state: 'running', limits, pendingJobs: 5, runningJobs: 1, waitReason: null,
    progress: { totalWindows: 10, completedWindows: 4, remainingWindows: 6 },
    round: { id: `round-${++roundNumber}`, epoch: roundNumber, state: 'active', startedAt, finishedAt: null,
      requestCount: 14, totalTokens: 4200, measuredRequests: 4 },
    usageLastHour: { requests: 63, measuredRequests: 4, totalTokens: 4200, inputTokens: 4000, outputTokens: 200 } };
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><title>关系整理进度验证</title><body style="padding:20px;background:#f6f7f1"><main style="max-width:960px;margin:auto"><h1 style="font-size:20px;color:#315f4d">本次收听 · 知识图谱</h1><p>浏览器测试示例，使用本地模拟状态</p><div id="graph" class="knowledge-graph"></div></main><script type="module">import { createKnowledgeGraph } from '/knowledge-graph.js'; window.key=''; window.started=[]; window.required=0; window.graph=createKnowledgeGraph({root:document.querySelector('#graph'), getKey:()=>window.key,onRequireKey:()=>window.required++,onStarted:id=>window.started.push(id),loadSegment:async()=>({}),locateSegment:()=>{}}); graph.select('a'); graph.setActive(true);</script></body></html>`);
  }
  if (['/style.css', '/knowledge-graph.js'].includes(req.url)) {
    res.writeHead(200, { 'content-type': req.url.endsWith('css') ? 'text/css' : 'text/javascript' });
    return res.end(await readFile(new URL(`../public${req.url}`, import.meta.url)));
  }
  const id = req.url.match(/^\/api\/listenings\/([ab])\/graph$/)?.[1];
  if (!id) { res.writeHead(404); return res.end(); }
  counters[req.method]++;
  if (req.method === 'GET') {
    if (failGets > 0) { failGets--; res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: '临时读取失败' })); }
    const data = structuredClone({ listeningId: id, graphRevision: revision, nodes: id === 'a' ? nodes : [{ id: 'other', canonical_name: '另一段收听', type: 'term' }], relations: id === 'a' && statuses.a.enabled ? [relation] : [], status: statuses[id] });
    const gate = holdGet; holdGet = null; if (gate) await gate.promise;
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(data));
  }
  if (req.method === 'POST') { statuses[id] = activeStatus(); revision++; }
  if (req.method === 'DELETE') { statuses[id] = { ...statuses[id], state: 'cancelled', round: { ...statuses[id].round, state: 'cancelled', stopReason: 'USER_CANCELLED', finishedAt: Date.now() } }; revision++; }
  if (req.method === 'POST' && dropPost) { dropPost = false; return res.destroy(); }
  if (req.method === 'DELETE' && dropDelete) { dropDelete = false; return res.destroy(); }
  const data = structuredClone({ status: statuses[id], graphRevision: revision });
  const gate = req.method === 'POST' ? holdPost : holdDelete;
  if (gate) await gate.promise;
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const errors = [], checks = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  const screenshot = async name => { if (directory) await page.screenshot({ path: path.join(directory, name), fullPage: false }); };
  async function settledContinuation() {
    // Wait for the action's final render and its paint, not just completed status text.
    await page.waitForFunction(() => {
      const button = document.querySelector('#graph-generate'), cancel = document.querySelector('#graph-cancel');
      return !button.disabled && button.textContent === '继续关系整理' && cancel.hidden && getComputedStyle(button).opacity === '1';
    });
    await page.mouse.move(0, 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#graph-generate').isEnabled(), true);
  }
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#graph-status').filter({ hasText: '尚未生成' }).waitFor();
  await page.locator('#graph-cost').filter({ hasText: '不设整轮 token、请求数或处理时长上限' }).waitFor();
  assert.match(await page.locator('#graph-cost').textContent(), /窗口最多尝试 3 次.*30 秒.*2 个并行/);
  assert.match(await page.locator('#graph-usage').textContent(), /不代表免费/);
  await page.locator('#graph-generate').click();
  assert.equal(await page.evaluate(() => window.required), 1); assert.equal(counters.POST, 0);
  await page.evaluate(() => { window.key = 'local-fixture-key'; });
  holdPost = deferred();
  await page.locator('#graph-generate').evaluate(el => { el.dispatchEvent(new Event('click')); el.dispatchEvent(new Event('click')); });
  await until(() => counters.POST === 1);
  assert.equal(await page.locator('#graph-generate').isDisabled(), true);
  holdPost.resolve(); holdPost = null;
  await page.locator('#graph-round').filter({ hasText: '本轮请求 14 次' }).waitFor();
  assert.match(await page.locator('#graph-progress').textContent(), /4 \/ 10.*剩余 6/);
  assert.match(await page.locator('#graph-usage').textContent(), /63 次关系请求.*59 次请求用量未知/);
  await page.locator('[data-relation-id]').first().waitFor();
  assert.equal(await page.locator('[data-relation-id]').count(), 1);
  await page.evaluate(() => window.graph.setProcessing({ state: 'not_generated', enabled: false, round: null }));
  assert.match(await page.locator('#graph-status').textContent(), /正在整理关系/);
  const elapsed = await page.locator('#graph-round').textContent();
  await page.waitForFunction(text => document.querySelector('#graph-round').textContent !== text, elapsed);
  assert.equal(counters.POST, 1);
  checks.push('Missing key does not start; repeated clicks start exactly once; completed/total, live elapsed beyond two minutes, uncapped request counts and separate hourly unknown usage are visible');
  async function updateStatus(changes) {
    statuses.a = { ...statuses.a, ...changes }; revision++;
    await page.evaluate(() => window.graph.refresh());
    await page.waitForFunction(text => document.querySelector('#graph-status').textContent === text, graphStatusText(statuses.a, true));
  }
  for (const [waitReason, label] of [['foreground', '前台任务'], ['provider_cooldown', '限流冷却'], ['network_retry', '等待重试'], ['quiet_period', '等待原文与知识条目稳定'], ['admission_interval', '等待请求间隔'], ['translations', '等待相关译文']]) {
    await updateStatus({ waitReason }); assert.match(await page.locator('#graph-status').textContent(), new RegExp(label));
  }
  await updateStatus({ waitReason: 'foreground' });
  await screenshot('relation-progress-desktop-waiting.png');
  // Freeze an old read before cancelling. Its late result must not revive the cancelled round.
  const oldRead = holdGet = deferred(); const readsBefore = counters.GET;
  await page.evaluate(() => { void window.graph.refresh(); }); await until(() => counters.GET > readsBefore);
  holdDelete = deferred();
  await page.locator('#graph-cancel').evaluate(el => { el.dispatchEvent(new Event('click')); el.dispatchEvent(new Event('click')); });
  await until(() => counters.DELETE === 1);
  assert.equal(await page.locator('#graph-cancel').isDisabled(), true);
  assert.equal(await page.locator('#graph-generate').isDisabled(), true);
  holdDelete.resolve(); holdDelete = null; oldRead.resolve();
  await page.locator('#graph-status').filter({ hasText: '关系整理已取消' }).waitFor();
  await settledContinuation();
  assert.equal(await page.locator('#graph-generate').isEnabled(), true);
  assert.equal(await page.locator('#graph-cancel').isHidden(), true);
  await page.locator('[data-relation-id]').first().waitFor();
  assert.equal(await page.locator('[data-relation-id]').count(), 1);
  await screenshot('relation-progress-desktop-cancelled.png');
  const terminalRound = await page.locator('#graph-round').textContent();
  await page.evaluate(status => window.graph.setProcessing(status), { ...statuses.a, state: 'running', round: { ...statuses.a.round, finishedAt: null } });
  assert.match(await page.locator('#graph-status').textContent(), /关系整理已取消/);
  assert.equal(await page.locator('#graph-round').textContent(), terminalRound);
  checks.push('Waiting reasons stay honest; cancel is single-flight, retains partial map, ignores stale in-flight GET/detail events and unlocks manual continuation');
  await updateStatus({ state: 'paused', round: { ...statuses.a.round, state: 'paused', requestCount: 12, stopReason: 'ROUND_REQUEST_LIMIT' } });
  assert.match(await page.locator('#graph-status').textContent(), /历史关系任务已暂停/);
  assert.match(await page.locator('#graph-round').textContent(), /本轮请求 12 次/);
  await screenshot('relation-progress-desktop-paused.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('relation-progress-mobile-paused.png');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile page must not overflow');
  assert.ok((await page.locator('#graph-generate').boundingBox()).height >= 44);
  const previousRound = structuredClone(statuses.a);
  const callsBeforeContinue = counters.POST;
  await page.locator('#graph-generate').click();
  await page.locator('#graph-cancel').waitFor();
  assert.equal(counters.POST, callsBeforeContinue + 1);
  await screenshot('relation-progress-mobile-running.png');
  await page.evaluate(value => window.graph.setProcessing(value), previousRound);
  assert.match(await page.locator('#graph-status').textContent(), /正在整理关系/);
  await updateStatus({ state: 'waiting_key', waitReason: 'waiting_key' });
  assert.equal(await page.locator('#graph-generate').isEnabled(), true);
  assert.equal(await page.locator('#graph-cancel').isVisible(), true);
  await page.locator('#graph-cancel').click();
  await page.locator('#graph-status').filter({ hasText: '关系整理已取消' }).waitFor();
  await screenshot('relation-progress-mobile-cancelled.png');
  checks.push('Legacy paused jobs stay manually resumable without advertising removed quotas; continuation and waiting-key cancellation work; mobile controls meet 44px and no overflow');
  // A late POST for a previous selection must neither overwrite B nor invoke A callbacks.
  startedEvents = await page.evaluate(() => window.started.length);
  holdPost = deferred(); const beforeLate = counters.POST;
  await page.locator('#graph-generate').click(); await until(() => counters.POST > beforeLate);
  await page.evaluate(() => window.graph.select('b'));
  await page.locator('[data-node-id="other"]').waitFor();
  const finishedStart = page.waitForEvent('requestfinished', request => request.method() === 'POST');
  holdPost.resolve(); holdPost = null;
  await finishedStart; await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.locator('#graph-status').filter({ hasText: '尚未生成' }).waitFor();
  assert.equal(await page.evaluate(() => window.started.length), startedEvents);
  assert.equal(await page.locator('[data-node-id="kodak"]').count(), 0);
  assert.equal(await page.locator('#graph-cancel').isHidden(), true);
  await page.evaluate(() => window.graph.select('a'));
  await page.locator('#graph-cancel').waitFor();
  await updateStatus({ state: 'complete', pendingJobs: 0, runningJobs: 0, waitReason: null,
    progress: { totalWindows: 10, completedWindows: 10, remainingWindows: 0 },
    round: { ...statuses.a.round, finishedAt: Date.now() } });
  assert.equal(await page.locator('#graph-generate').isEnabled(), true);
  assert.equal(await page.locator('#graph-cancel').isHidden(), true);
  await settledContinuation();
  await screenshot('relation-progress-mobile-complete.png');
  await page.setViewportSize({ width: 1360, height: 1000 });
  await settledContinuation();
  await screenshot('relation-progress-desktop-complete.png');
  // New content can resume work in the same round without a new start request.
  const sameRound = { ...statuses.a, state: 'queued', pendingJobs: 1, waitReason: 'translations', round: { ...statuses.a.round, finishedAt: null } };
  await page.evaluate(value => window.graph.setProcessing(value), sameRound);
  assert.match(await page.locator('#graph-status').textContent(), /等待相关译文/);
  assert.equal(await page.locator('#graph-generate').isDisabled(), true);
  await page.evaluate(value => window.graph.setProcessing(value), statuses.a);
  // The server accepts a start, but its response and the first recovery GET are lost.
  // Recovery must only read, then poll to completion without an SSE event or another click.
  const beforeLostPost = counters.POST;
  dropPost = true; failGets = 1;
  await page.locator('#graph-generate').click();
  await page.locator('#graph-status').filter({ hasText: '服务器操作状态尚未确认' }).waitFor();
  assert.equal(await page.locator('#graph-generate').isDisabled(), true);
  await page.locator('#graph-generate').evaluate(el => { el.dispatchEvent(new Event('click')); });
  assert.equal(counters.POST, beforeLostPost + 1);
  await page.locator('#graph-status').filter({ hasText: '正在整理关系' }).waitFor();
  assert.equal(counters.POST, beforeLostPost + 1);
  statuses.a = { ...statuses.a, state: 'partial', pendingJobs: 0, runningJobs: 0,
    progress: { totalWindows: 10, completedWindows: 8, partialWindows: 2, remainingWindows: 2 }, round: { ...statuses.a.round, finishedAt: Date.now() } }; revision++;
  await page.locator('#graph-status').filter({ hasText: '关系部分完成' }).waitFor();
  assert.match(await page.locator('#graph-status').textContent(), /已有结果保留/);
  assert.match(await page.locator('#graph-progress').textContent(), /其中 2 个部分完成/);
  assert.equal(await page.locator('#graph-generate').textContent(), '检查新增或变化的内容');
  assert.equal(await page.locator('#graph-generate').isEnabled(), true);
  const partialReads = counters.GET;
  await page.waitForTimeout(2300); assert.equal(counters.GET, partialReads);
  assert.equal(counters.POST, beforeLostPost + 1);
  checks.push('Lost POST response plus failed recovery GET recovers through reads only; active polling reaches honest partial completion without SSE; no duplicate generation');
  await screenshot('relation-progress-desktop-partial.png');
  // A final invalidation can be the only signal; its failed GET must retry itself.
  statuses.a = { ...statuses.a, state: 'failed' }; revision++; failGets = 1;
  await page.evaluate(revision => window.graph.invalidate('a', revision), revision);
  await page.locator('#graph-status').filter({ hasText: '临时读取失败' }).waitFor();
  await page.locator('#graph-status').filter({ hasText: '关系整理失败' }).waitFor();
  assert.equal(await page.locator('#graph-generate').textContent(), '重试未完成的关系');
  assert.equal(counters.POST, beforeLostPost + 1);
  // Online/visibility reconciliation also only reads the existing server state.
  statuses.a = { ...statuses.a, state: 'complete', progress: { totalWindows: 10, completedWindows: 10, remainingWindows: 0 } }; revision++;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.locator('#graph-status').filter({ hasText: '关系整理完成' }).waitFor();
  assert.equal(counters.POST, beforeLostPost + 1);
  await page.locator('#graph-generate').click();
  await page.locator('#graph-cancel').waitFor();
  await page.waitForFunction(() => !document.querySelector('#graph-cancel').disabled);
  const beforeLostDelete = counters.DELETE; dropDelete = true;
  await page.locator('#graph-cancel').click();
  await page.locator('#graph-status').filter({ hasText: '关系整理已取消' }).waitFor();
  assert.equal(counters.DELETE, beforeLostDelete + 1);
  await settledContinuation();
  const cancelledReads = counters.GET;
  await page.waitForTimeout(2300); assert.equal(counters.GET, cancelledReads);
  checks.push('Final invalidation read failures retry; online refresh reconciles without POST; lost DELETE response recovers cancellation and stops polling');
  await page.locator('#graph-generate').click();
  await page.locator('#graph-cancel').waitFor();
  await page.evaluate(() => window.graph.destroy());
  assert.equal(await page.locator('#graph').textContent(), '');
  checks.push('Late start response cannot overwrite a newer listening; completed state can restart; destroy clears controls/timers');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks, counters, screenshots: directory || null, provider: 'Local fixture only; zero external/model calls' }, null, 2));
} finally {
  holdGet?.resolve(); holdPost?.resolve(); holdDelete?.resolve();
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
