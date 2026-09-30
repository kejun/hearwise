import assert from 'node:assert/strict';
import { speechFixture } from './speech-fixture.mjs';

// Synthetic events, real page/AudioWorklet and stub providers. No live-provider timing claim.
export async function verifyIncrementalBrowser(browser) {
  const fixture = await speechFixture({ audioSamples: 24000,
    translationText: text => text === 'The company released a new AI model,' ? '这家公司发布了一个新的人工智能模型。' : '团队改进了面向企业客户的部署工具。' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = [], progress = [], speechEvents = [], sent = [];
  let sockets = 0;
  const ttsSockets = [], closedSockets = new Set();
  const until = async check => {
    const deadline = Date.now() + 12000;
    while (!check()) { if (Date.now() > deadline) throw new Error('Incremental browser timed out'); await new Promise(resolve => setTimeout(resolve, 30)); }
  };
  try {
    await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'mock-incremental-key'));
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', ws => {
      if (ws.url().endsWith('/ws/tts')) {
        sockets++; ttsSockets.push(ws); ws.on('close', () => closedSockets.add(ws));
      }
      if (ws.url().endsWith('/ws/tts')) ws.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string') speechEvents.push(JSON.parse(payload));
      });
      if (ws.url().endsWith('/ws/tts')) ws.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string') return;
        const event = JSON.parse(payload); sent.push(event); if (event.type === 'speech.progress') progress.push(event);
      });
    });
    await page.goto(fixture.base);
    const setting = page.getByRole('checkbox', { name: '提前播报（实验）', exact: true });
    const openSettings = () => page.getByRole('button', { name: '播报设置', exact: true }).click();
    const saveSettings = () => page.getByRole('button', { name: '保存播报设置', exact: true }).click();
    const storedPreference = () => page.evaluate(() => JSON.parse(localStorage.getItem('hearwise:speech') || '{}').incremental);
    await page.locator('#live-speech-tab').click();
    await openSettings();
    assert.equal(await setting.isChecked(), false);
    await setting.check();
    await page.keyboard.press('Escape');
    assert.notEqual(await storedPreference(), true);
    await openSettings();
    assert.equal(await setting.isChecked(), false); // Cancel discards the draft.
    await setting.check();
    await saveSettings();
    assert.equal(await storedPreference(), true);
    assert.equal(sockets, 0); // Saving preferences never opens speech on its own.
    await page.reload();
    assert.equal(sockets, 0);
    await page.locator('#live-speech-tab').click();
    await openSettings();
    assert.equal(await setting.isChecked(), true);
    await page.locator('.modal').evaluate(el => { el.scrollTop = 0; });
    if (process.env.INCREMENTAL_SETTINGS_SCREENSHOT) await page.locator('.modal').screenshot({ path: process.env.INCREMENTAL_SETTINGS_SCREENSHOT });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.INCREMENTAL_SETTINGS_MOBILE_SCREENSHOT) await page.screenshot({ path: process.env.INCREMENTAL_SETTINGS_MOBILE_SCREENSHOT });
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#source-language').inputValue(), 'en'); // Language settings are intentionally hidden until opened.
    await page.getByRole('button', { name: '开始聆听', exact: true }).click();
    await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
    await page.locator('#live-speech-tab').click();
    await page.getByRole('button', { name: '开启译文播报', exact: true }).click();
    // Readiness before injecting hypotheses avoids treating setup time as inference latency.
    await until(() => speechEvents.some(event => event.type === 'speech.ready' && event.incremental));
    await page.locator('#speech-status').filter({ hasText: /实验性短句/ }).waitFor();
    assert.equal(sent.find(event => event.type === 'speech.start').incremental, true);
    // A canceled edit during live speech neither persists nor stops that consumer.
    const activeSockets = sockets;
    for (const dismiss of [() => page.keyboard.press('Escape'), () => page.locator('#close-settings').click(),
      () => page.locator('#settings-modal').click({ position: { x: 5, y: 5 } })]) {
      await openSettings();
      assert.equal(await setting.isChecked(), true);
      await setting.uncheck();
      await dismiss();
      assert.equal(await storedPreference(), true);
      assert.equal(await page.locator('#speech-toggle').getAttribute('aria-pressed'), 'true');
      assert.equal(sockets, activeSockets);
      assert.equal(sent.filter(event => event.type === 'speech.stop').length, 0);
    }
    const first = 'The company released a new AI model, and the team improved the deployment tools';
    fixture.final(first, false, 'news');
    await page.waitForTimeout(60);
    fixture.final(first + ' for enterprise customers', false, 'news');
    await until(() => progress.some(event => event.consumedSamples > 0));
    assert.equal(fixture.stats.commits[0], '这家公司发布了一个新的人工智能模型。');
    const archive = await page.evaluate(async () => {
      const list = await (await fetch('/api/listenings')).json();
      return (await fetch(`/api/listenings/${list.items[0].id}`)).json();
    });
    assert.equal(archive.segmentCount, 0); // Actual playback precedes persistence/final, not merely TTS enqueue.
    await page.locator('#live-caption-tab').click();
    await page.locator('#original .caption-committed').filter({ hasText: 'The company' }).waitFor();
    assert.ok(await page.locator('#original .caption-tail').textContent());
    if (process.env.INCREMENTAL_SCREENSHOT) await page.screenshot({ path: process.env.INCREMENTAL_SCREENSHOT, fullPage: true });
    fixture.final(first.replace('released', 'did not release') + ' for enterprise customers', false, 'news');
    await until(() => fixture.logs().includes('incremental_correction'));
    await page.locator('#live-speech-tab').click();
    await page.getByRole('button', { name: '开启译文播报', exact: true }).waitFor();
    assert.equal(fixture.stats.commits.length, 1);
    if (process.env.INCREMENTAL_CORRECTION_SCREENSHOT) await page.screenshot({ path: process.env.INCREMENTAL_CORRECTION_SCREENSHOT, fullPage: true });
    // Saving OFF during a fresh live epoch stops it; a manual restart uses final-only.
    await page.getByRole('button', { name: '开启译文播报', exact: true }).click();
    await until(() => speechEvents.filter(event => event.type === 'speech.ready').length === 2);
    const stoppingSocket = ttsSockets.at(-1);
    const stoppingEpoch = speechEvents.filter(event => event.type === 'speech.ready').at(-1).epoch;
    await openSettings();
    assert.equal(await setting.isChecked(), true);
    await setting.uncheck();
    await saveSettings();
    await until(() => sent.some(event => event.type === 'speech.stop' && event.epoch === stoppingEpoch));
    await until(() => closedSockets.has(stoppingSocket));
    assert.equal(await storedPreference(), false);
    assert.equal(await page.locator('#speech-toggle').getAttribute('aria-pressed'), 'false');
    const stoppedSockets = sockets;
    await page.waitForTimeout(100);
    assert.equal(sockets, stoppedSockets);
    // Let the earlier interrupted sentence finish while muted, before intentionally restarting.
    const corrected = first.replace('released', 'did not release') + ' for enterprise customers.';
    fixture.final(corrected, true, 'news');
    await page.waitForFunction(async () => {
      const list = await (await fetch('/api/listenings')).json();
      const record = await (await fetch(`/api/listenings/${list.items[0].id}`)).json();
      return record.segments.some(segment => segment.translation_state === 'complete');
    });
    assert.equal(fixture.stats.commits.length, 1);
    await page.getByRole('button', { name: '开启译文播报', exact: true }).click();
    await until(() => speechEvents.filter(event => event.type === 'speech.ready').length === 3);
    assert.equal(speechEvents.filter(event => event.type === 'speech.ready').at(-1).incremental, false);
    assert.equal(sent.filter(event => event.type === 'speech.start').at(-1).incremental, false);
    fixture.final(first, false, 'final-only');
    fixture.final(first + ' for enterprise customers', false, 'final-only');
    await page.waitForTimeout(150);
    assert.equal(fixture.stats.commits.length, 1);
    fixture.final(first + ' for enterprise customers.', true, 'final-only');
    await until(() => fixture.stats.commits.length === 2);
    await page.getByRole('button', { name: '关闭播报', exact: true }).click();
    await page.getByRole('button', { name: '停止聆听', exact: true }).click();
    await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
    await page.reload();
    assert.equal(await storedPreference(), false);
    assert.equal(await page.locator('#speech-toggle').getAttribute('aria-pressed'), 'false');
    await page.locator('#live-speech-tab').click();
    await openSettings();
    assert.equal(await setting.isChecked(), false);
    // Old/malformed preferences never accidentally opt into the experiment.
    for (const value of ['true', 1, null]) {
      await page.evaluate(value => localStorage.setItem('hearwise:speech', JSON.stringify({ incremental: value })), value);
      await page.reload();
      assert.equal(await page.locator('#speech-incremental').isChecked(), false);
      assert.equal(await page.locator('#speech-toggle').getAttribute('aria-pressed'), 'false');
    }
    assert.deepEqual(errors, []);
    return { defaultOff: true, persistedOptIn: true, canceledEditKeepsSession: true, savedOffRequiresRestart: true, malformedPreferenceOff: true, earlyPlayed: true, canonicalSegmentsAtFirstAudio: archive.segmentCount, sourceCorrectionStops: true,
      actualAudioWorkletConsumedSamples: Math.max(...progress.map(event => event.consumedSamples)), uiErrors: errors };
  } catch (error) {
    if (process.env.INCREMENTAL_SCREENSHOT) await page.screenshot({ path: process.env.INCREMENTAL_SCREENSHOT, fullPage: true }).catch(() => {});
    console.error('incremental_browser_failure', JSON.stringify({ message: error.message, status: await page.locator('#speech-status').textContent().catch(() => ''), speechEvents }));
    throw error;
  } finally { await page.close(); await fixture.close(); }
}
