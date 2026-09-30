import assert from 'node:assert/strict';
import { speechFixture } from './speech-fixture.mjs';

// Synthetic events, real page/AudioWorklet and stub providers. No live-provider timing claim.
export async function verifyIncrementalBrowser(browser) {
  const fixture = await speechFixture({ incremental: true, audioSamples: 24000,
    translationText: text => text === 'The company released a new AI model,' ? '这家公司发布了一个新的人工智能模型。' : '团队改进了面向企业客户的部署工具。' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = [], progress = [];
  const until = async check => {
    const deadline = Date.now() + 12000;
    while (!check()) { if (Date.now() > deadline) throw new Error('Incremental browser timed out'); await new Promise(resolve => setTimeout(resolve, 30)); }
  };
  try {
    await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'mock-incremental-key'));
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', ws => {
      if (ws.url().endsWith('/ws/tts')) ws.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string') return;
        const event = JSON.parse(payload); if (event.type === 'speech.progress') progress.push(event);
      });
    });
    await page.goto(fixture.base);
    await page.locator('#source-language').selectOption('en');
    await page.getByRole('button', { name: '开始聆听', exact: true }).click();
    await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
    await page.locator('#live-speech-tab').click();
    await page.getByRole('button', { name: '开启译文播报', exact: true }).click();
    // Readiness before injecting hypotheses avoids treating setup time as inference latency.
    await page.locator('#speech-status').filter({ hasText: /实验性|等待/ }).waitFor();
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
    assert.deepEqual(errors, []);
    return { earlyPlayed: true, canonicalSegmentsAtFirstAudio: archive.segmentCount, sourceCorrectionStops: true,
      actualAudioWorkletConsumedSamples: Math.max(...progress.map(event => event.consumedSamples)), uiErrors: errors };
  } finally { await page.close(); await fixture.close(); }
}
