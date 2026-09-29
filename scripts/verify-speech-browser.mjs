// Optional end-to-end browser check. Requires a local Playwright installation and Chromium.
// PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_EXECUTABLE=/path/to/chrome node scripts/verify-speech-browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { speechFixture } from '../test-support/speech-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = await speechFixture({ autoSentences: true, audioSamples: 24000 });
let browser;
const errors = [], progress = [];
const until = async check => {
  const deadline = Date.now() + 12000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Browser verification timed out'); await new Promise(r => setTimeout(r, 30)); }
};
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', ws => {
    if (!ws.url().endsWith('/ws/tts')) return;
    ws.on('framesent', ({ payload }) => { if (typeof payload === 'string') { const event = JSON.parse(payload); if (event.type === 'speech.progress') progress.push(event); } });
  });
  await page.goto(fixture.base);
  const captionTab = page.locator('#live-caption-tab'), speechTab = page.locator('#live-speech-tab');
  assert.equal(await captionTab.getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#live-speech-panel').isHidden(), true);
  await captionTab.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await speechTab.evaluate(el => el === document.activeElement), true);
  assert.equal(await speechTab.getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#live-caption-panel').isHidden(), true);
  assert.equal(await page.locator('#pinned-caption').isHidden(), true);
  await page.keyboard.press('Home');
  assert.equal(await captionTab.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('button', { name: '开启译文播报', exact: true }).isDisabled(), true);
  assert.equal(fixture.stats.connections, 0);
  assert.equal(await page.locator('#speech-key, #speech-remember').count(), 0);
  assert.ok((await page.locator('#speech-toggle').boundingBox()).height <= 34);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill('mock-shared-key');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page.getByRole('button', { name: '播报设置', exact: true }).click();
  await page.getByRole('button', { name: '保存播报设置', exact: true }).click();
  assert.equal(fixture.stats.connections, 0);
  await page.getByRole('button', { name: '开始聆听', exact: true }).click();
  await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
  await until(() => fixture.stats.asrClients.size === 1);
  // Even completed translations must not start speech before the click.
  fixture.final('Sentence 1.');
  await page.locator('#translation').filter({ hasText: '这是第' }).waitFor({ state: 'attached' });
  assert.equal(fixture.stats.connections, 0);
  await page.getByRole('button', { name: '开启译文播报', exact: true }).click();
  assert.match(await page.locator('#speech-status').textContent(), /下一句|说完一句|首次播放/);
  await until(() => progress.some(p => p.consumedSamples > 0));
  assert.equal(fixture.stats.sessions[0].sample_rate, 24000);
  const samplesBeforeSwitch = progress.at(-1).consumedSamples, connectionsBeforeSwitch = fixture.stats.connections;
  await captionTab.click();
  assert.equal(await page.locator('#speech-tab-indicator').isVisible(), true);
  await until(() => progress.some(p => p.consumedSamples > samplesBeforeSwitch));
  assert.equal(fixture.stats.connections, connectionsBeforeSwitch);
  await speechTab.click();
  assert.equal(await page.locator('#speech-toggle').getAttribute('aria-pressed'), 'true');
  if (process.env.SPEECH_SCREENSHOT) await page.screenshot({ path: process.env.SPEECH_SCREENSHOT });
  await page.getByRole('button', { name: '关闭播报', exact: true }).click();
  const commits = fixture.stats.commits.length;
  fixture.final('Sentence 99.');
  await page.locator('#translation').filter({ hasText: '99' }).waitFor({ state: 'attached' });
  assert.equal(fixture.stats.commits.length, commits);
  await page.getByRole('button', { name: '开启译文播报', exact: true }).click();
  await until(() => fixture.stats.commits.length > commits);
  await page.getByRole('button', { name: '停止聆听', exact: true }).click();
  await page.getByRole('button', { name: '开启译文播报', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '开启译文播报', exact: true }).isDisabled(), true);
  // Read the full stored transcript, not only the currently visible caption.
  await page.getByRole('button', { name: '播报全部原文', exact: true }).waitFor();
  const detail = await page.evaluate(async () => {
    const list = await (await fetch('/api/listenings')).json();
    return (await fetch(`/api/listenings/${list.items[0].id}`)).json();
  });
  const originalStart = fixture.stats.commits.length;
  await page.getByRole('button', { name: '播报全部原文', exact: true }).click();
  await page.locator('#transcript-speech-status').filter({ hasText: '原文全文播报完成' }).waitFor();
  assert.deepEqual(fixture.stats.commits.slice(originalStart), detail.segments.map(s => s.original_text));
  assert.equal(fixture.stats.sessions.at(-1).language_type, 'Auto');
  const translationStart = fixture.stats.commits.length;
  await page.getByRole('button', { name: '播报全部译文', exact: true }).click();
  await page.locator('#transcript-speech-status').filter({ hasText: '译文全文播报完成' }).waitFor();
  assert.deepEqual(fixture.stats.commits.slice(translationStart), detail.segments.map(s => s.translation_text));
  await page.getByRole('button', { name: '播报全部原文', exact: true }).click();
  await page.getByRole('button', { name: '停止全文播报', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '停止全文播报', exact: true }).isHidden(), true);
  await page.getByRole('button', { name: '继续收听', exact: true }).click();
  await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '开启译文播报', exact: true }).getAttribute('aria-pressed'), 'false');
  // Pin against the shared panel even while the caption tab is hidden.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.locator('#pinned-caption').waitFor();
  const expandedHeight = (await page.locator('#pinned-caption').boundingBox()).height;
  await page.getByRole('button', { name: '收起吸顶字幕', exact: true }).click();
  assert.equal(await page.locator('#pinned-toggle').getAttribute('aria-expanded'), 'false');
  assert.ok((await page.locator('#pinned-caption').boundingBox()).height < expandedHeight);
  fixture.final('Sentence 777.');
  await page.locator('#pinned-translation').filter({ hasText: '777' }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('#pinned-translation').isHidden(), true);
  await page.getByRole('button', { name: '展开吸顶字幕', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#pinned-translation').isVisible(), true);
  if (process.env.PINNED_SCREENSHOT) await page.locator('#pinned-caption').screenshot({ path: process.env.PINNED_SCREENSHOT });
  await page.getByRole('button', { name: '收起吸顶字幕', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#pinned-caption').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '停止聆听', exact: true }).click();
  await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '播报全部原文', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.SPEECH_TRANSCRIPT_SCREENSHOT) await page.locator('.transcript-panel').screenshot({ path: process.env.SPEECH_TRANSCRIPT_SCREENSHOT });
  await page.reload();
  assert.equal(await captionTab.getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#pinned-toggle').getAttribute('aria-expanded'), 'false');
  await page.evaluate(() => window.scrollTo(0, 0));
  if (process.env.CAPTION_PANEL_SCREENSHOT) await page.locator('#live-panel').screenshot({ path: process.env.CAPTION_PANEL_SCREENSHOT });
  await speechTab.click();
  if (process.env.SPEECH_PANEL_SCREENSHOT) await page.locator('#live-panel').screenshot({ path: process.env.SPEECH_PANEL_SCREENSHOT });
  assert.equal(await page.getByRole('button', { name: '开启译文播报', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: '播报设置', exact: true }).click();
  await page.getByRole('button', { name: '试听语音', exact: true }).click();
  await page.locator('#speech-result').filter({ hasText: '试听完成' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  assert.ok(fixture.stats.authorizations.every(value => value === 'Bearer mock-shared-key'));
  console.log(JSON.stringify({ ok: true, uiErrors: errors, ttsSessions: fixture.stats.connections,
    responses: fixture.stats.commits.length, consumedSamples: Math.max(...progress.map(p => p.consumedSamples)),
    checks: ['tabs and keyboard navigation', 'tab switch preserves playback', 'pin shared panel', 'collapse survives caption updates and reload', 'keyboard expand', 'shared key', 'small toggle', 'first playback hint', 'default off', 'save without speech', 'final translation to AudioWorklet consumption', 'stop', 're-enable', 'drain', 'full original', 'full translation', 'stop transcript', 'new run off', 'reload off', 'preview', 'mobile width'] }, null, 2));
} finally {
  await browser?.close(); await fixture.close();
}
