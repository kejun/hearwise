// Real browser/media pipeline, local ASR/MT protocol fixtures; no quality or device claim.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { speechFixture } from './speech-fixture.mjs';
import { seedNameReplacement } from './name-replacement-fixture.mjs';

const directory = process.argv[2];
const observations = { widths: [], sourceVersion: null, complete: false };
const until = async predicate => {
  const end = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error('Session browser observation timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
const finalFrame = (text, id = text) => ({ header: { event: 'result-generated' }, payload: { output: {
  sentence: { sentence_id: id, text, sentence_end: true, begin_time: 0, end_time: 1500 } } } });
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  observations.chromium = browser.version();
  for (const width of [1280, 390]) {
    const fixture = await speechFixture({ translationText: text => `译文：${text}`, onAsrFinish(ws) {
      // Valid stop tail remains eligible until the terminal frame, then even queued frames are stale.
      for (const event of [finalFrame('Stop tail 😀.', 'tail'), { header: { event: 'task-finished' } }, finalFrame('INVALID LATE FINAL')])
        ws.send(JSON.stringify(event));
    } });
    const page = await browser.newPage({ viewport: { width, height: 950 } });
    page.setDefaultTimeout(10000);
    const errors = [], incoming = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => {
      if (socket.url().endsWith('/ws')) socket.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string') incoming.push(JSON.parse(payload));
      });
    });
    try {
      await page.addInitScript(() => {
        localStorage.setItem('tongsheng:qianwen-key', 'fixture-only');
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        let denied = false;
        window.fixtureTracks = []; window.fixtureSockets = [];
        navigator.mediaDevices.getUserMedia = async options => {
          if (!denied) { denied = true; throw new DOMException('Fixture denied microphone', 'NotAllowedError'); }
          const stream = await getUserMedia(options);
          window.fixtureTracks.push(...stream.getTracks());
          return stream;
        };
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(...args) { super(...args); if (String(args[0]).endsWith('/ws')) window.fixtureSockets.push(this); }
        };
      });
      await page.goto(fixture.base);
      await page.getByRole('button', { name: '开始聆听', exact: true }).click();
      await page.getByText('请允许浏览器使用麦克风，然后重试', { exact: true }).waitFor();
      assert.equal((await (await fetch(`${fixture.base}/api/listenings`)).json()).total, 0);
      assert.equal(await page.getByRole('button', { name: '开始聆听', exact: true }).isEnabled(), true);
      await page.screenshot({ path: path.join(directory, `session-${width}-permission.png`) });
      await page.getByRole('button', { name: '开始聆听', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
      await until(() => fixture.stats.asrClients.size === 1);
      fixture.final('The weather 😀 is warm today and sunny outside.', false, 'same');
      await page.locator('#original').filter({ hasText: 'sunny outside.' }).waitFor();
      for (let i = 0; i < 4; i++) fixture.final('The weather 😀 is warm today and sunny outside.', false, 'same');
      fixture.final('The weather 😀 is warm today and sunny outside now.', false, 'same');
      fixture.final('The forecast is completely different 😀 with rain.', false, 'same');
      fixture.final('Rain 😀.', true, 'same');
      await until(async () => await page.locator('#original').textContent() === 'Rain 😀.' &&
        await page.locator('#translation').textContent() === '译文：Rain 😀.');
      fixture.final('Rain 😀.', true, 'same'); fixture.final('Conflicting final.', true, 'same');
      await page.getByText('识别服务返回冲突定稿，已停止播报；文字记录保留首次定稿，请核对原文', { exact: true }).waitFor();
      const first = incoming.find(e => e.type === 'listening-ready');
      const read = async id => (await (await fetch(`${fixture.base}/api/listenings/${id}`)).json());
      assert.deepEqual((await read(first.listeningId)).segments.map(s => s.original_text), ['Rain 😀.']);
      await page.getByRole('button', { name: '停止聆听', exact: true }).click();
      await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
      await until(async () => await page.locator('#translation').textContent() === '译文：Stop tail 😀.');
      assert.deepEqual((await read(first.listeningId)).segments.map(s => s.original_text), ['Rain 😀.', 'Stop tail 😀.']);
      assert.equal(await page.evaluate(() => window.fixtureTracks.every(track => track.readyState === 'ended')), true);
      await page.getByRole('button', { name: '继续收听', exact: true }).click();
      await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
      await until(() => fixture.stats.asrClients.size === 1 && incoming.filter(e => e.type === 'listening-ready').length === 2);
      fixture.final('Reconnected run.', true, 'same');
      await until(async () => await page.locator('#translation').textContent() === '译文：Reconnected run.');
      const beforeDrop = await read(first.listeningId);
      assert.equal(beforeDrop.runs.length, 2);
      assert.equal(beforeDrop.segments.length, 3);
      assert.notEqual(beforeDrop.segments[0].run_id, beforeDrop.segments[2].run_id);
      for (const upstream of fixture.stats.asrClients) upstream.terminate();
      await page.getByText(/识别连接已断开，请重试|连接已断开，请重试/).first().waitFor();
      await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
      assert.equal((await read(first.listeningId)).runs.at(-1).state, 'interrupted');
      assert.equal(await page.evaluate(() => window.fixtureTracks.every(track => track.readyState === 'ended')), true);
      await page.screenshot({ path: path.join(directory, `session-${width}-disconnect.png`) });
      await page.getByRole('button', { name: '新建收听', exact: true }).click();
      await page.getByRole('button', { name: '开始聆听', exact: true }).click();
      await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
      await until(() => incoming.filter(e => e.type === 'listening-ready').length === 3);
      fixture.final('New listening.', true, 'same');
      await until(async () => await page.locator('#translation').textContent() === '译文：New listening.');
      const third = incoming.filter(e => e.type === 'listening-ready')[2];
      assert.notEqual(third.listeningId, first.listeningId);
      // The browser event queue can deliver an old socket callback after switching records.
      // Dispatch on the old transport, never call app internals or replace business functions.
      await page.evaluate(event => {
        for (const data of [event, { type: 'error', message: 'STALE CONNECTION ERROR' }])
          window.fixtureSockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
      }, incoming.find(e => e.type === 'segment-final'));
      assert.equal(await page.locator('#original').textContent(), 'New listening.');
      assert.equal(await page.locator('#translation').textContent(), '译文：New listening.');
      assert.equal(await page.getByText('STALE CONNECTION ERROR', { exact: true }).count(), 0);
      assert.equal((await read(third.listeningId)).segments.length, 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const stop = page.getByRole('button', { name: '停止聆听', exact: true });
      assert.equal(await stop.isEnabled(), true); assert.ok((await stop.boundingBox()).height >= 44);
      await page.screenshot({ path: path.join(directory, `session-${width}-recovered.png`) });
      await stop.click(); await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
      assert.deepEqual(errors, []);
      observations.widths.push({ width, permissionRejected: true, keyboardRecovery: true, stopTail: true,
        duplicateFinalIdentity: true, conflictingFinalPreserved: true, reconnectRuns: beforeDrop.runs.length,
        oldSocketIgnored: true, microphoneReleased: true, first: await read(first.listeningId), next: await read(third.listeningId) });
    } finally { await page.close(); await fixture.close(); }
  }

  // The source edit uses the public business API; the browser checks the user's archived text.
  const pending = [];
  const fixture = await speechFixture({ seed(store) {
    const h = seedNameReplacement(store);
    store.db.prepare("UPDATE segments SET translation_text=NULL, translation_state='failed' WHERE id=?").run(h.segment.id);
    return h;
  }, modelResponse(body) {
    return body.model === 'qwen-mt-flash' ? new Promise(resolve => pending.push({ source: body.messages[0].content, resolve })) : { items: [] };
  } });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } }); page.setDefaultTimeout(10000);
  try {
    await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'fixture-only'));
    const h = fixture.seeded, url = `${fixture.base}/api/listenings/${h.listeningId}`;
    const json = async (endpoint, options) => {
      const response = await fetch(endpoint, options), body = await response.json();
      assert.ok(response.ok, JSON.stringify(body)); return body;
    };
    const post = (endpoint, body, headers = {}) => json(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const row = async () => (await json(url)).segments.find(s => s.id === h.segment.id);
    const open = async () => {
      await page.goto(fixture.base); await page.getByRole('button', { name: '历史收听', exact: true }).click();
      await page.getByRole('button', { name: '查看“名称纠正测试”', exact: true }).click();
      await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
    };
    await open();
    await post(`${url}/retry`, { key: 'fixture-only' }); await until(() => pending.length === 1);
    await post(`${url}/retry`, { key: 'fixture-only' }); await until(() => pending.length === 2);
    pending[1].resolve('');
    await until(() => fixture.logs().includes('model_error translation:other'));
    const snapshot = await json(`${url}/knowledge/${h.item.id}`);
    await post(`${url}/knowledge/${h.item.id}/name-replacements`, { name: 'Tibo', revision: snapshot.revision }, { 'Idempotency-Key': randomUUID() });
    const corrected = await row(), revision = (await json(`${url}/knowledge/${h.item.id}`)).revision;
    assert.notEqual(snapshot.revision, revision);
    pending[0].resolve('OLD SOURCE RESPONSE');
    await until(() => fixture.logs().includes('"stage":"model","kind":"background"'));
    assert.deepEqual(await row(), corrected);
    await post(`${url}/retry`, { key: 'fixture-only' }); await until(() => pending.length === 3);
    assert.equal(pending[2].source, corrected.original_text);
    pending[2].resolve('新版本有效译文 😀');
    await until(async () => (await row()).translation_state === 'complete');
    await open();
    await page.locator('#transcript-panel').getByText(corrected.original_text, { exact: true }).waitFor();
    await page.locator('#transcript-panel').getByText('新版本有效译文 😀', { exact: true }).waitFor();
    assert.equal(await page.getByText('OLD SOURCE RESPONSE', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(directory, 'session-source-version.png') });
    observations.sourceVersion = { before: snapshot.revision, after: revision, oldRequest: pending[0].source,
      newRequest: pending[2].source, persisted: await row(), visibleText: true };
  } finally { for (const request of pending) request.resolve('cleanup'); await page.close(); await fixture.close(); }
  observations.complete = true;
  console.log(JSON.stringify({ ok: true, chromium: observations.chromium, widths: observations.widths.map(row => row.width), sourceVersion: true }));
} finally {
  await browser?.close();
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify(observations, null, 2));
}
