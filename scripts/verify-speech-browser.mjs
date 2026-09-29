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
  assert.equal(await page.getByRole('button', { name: '开启译文播报', exact: true }).isDisabled(), true);
  assert.equal(fixture.stats.connections, 0);
  await page.getByRole('button', { name: '播报设置', exact: true }).click();
  await page.getByLabel('阿里云百炼语音 API Key', { exact: true }).fill('mock-tts-key');
  await page.getByRole('button', { name: '保存播报设置', exact: true }).click();
  assert.equal(fixture.stats.connections, 0);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill('mock-asr-key');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page.getByRole('button', { name: '开始聆听', exact: true }).click();
  await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
  await until(() => fixture.stats.asrClients.size === 1);
  // Even completed translations must not start speech before the click.
  fixture.final('Sentence 1.');
  await page.locator('#translation').filter({ hasText: '这是第' }).waitFor();
  assert.equal(fixture.stats.connections, 0);
  await page.getByRole('button', { name: '开启译文播报', exact: true }).click();
  await until(() => progress.some(p => p.consumedSamples > 0));
  assert.equal(fixture.stats.sessions[0].sample_rate, 24000);
  if (process.env.SPEECH_SCREENSHOT) await page.screenshot({ path: process.env.SPEECH_SCREENSHOT });
  await page.getByRole('button', { name: '关闭播报', exact: true }).click();
  const commits = fixture.stats.commits.length;
  fixture.final('Sentence 99.');
  await page.locator('#translation').filter({ hasText: '99' }).waitFor();
  assert.equal(fixture.stats.commits.length, commits);
  await page.getByRole('button', { name: '开启译文播报', exact: true }).click();
  await until(() => fixture.stats.commits.length > commits);
  await page.getByRole('button', { name: '停止聆听', exact: true }).click();
  await page.getByRole('button', { name: '开启译文播报', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '开启译文播报', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '继续收听', exact: true }).click();
  await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '开启译文播报', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: '停止聆听', exact: true }).click();
  await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
  await page.reload();
  assert.equal(await page.getByRole('button', { name: '开启译文播报', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: '播报设置', exact: true }).click();
  await page.getByRole('button', { name: '试听语音', exact: true }).click();
  await page.locator('#speech-result').filter({ hasText: '试听完成' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, uiErrors: errors, ttsSessions: fixture.stats.connections,
    responses: fixture.stats.commits.length, consumedSamples: Math.max(...progress.map(p => p.consumedSamples)),
    checks: ['default off', 'save without speech', 'final translation to AudioWorklet consumption', 'stop', 're-enable', 'drain', 'new run off', 'reload off', 'preview', 'mobile width'] }, null, 2));
} finally {
  await browser?.close(); await fixture.close();
}
