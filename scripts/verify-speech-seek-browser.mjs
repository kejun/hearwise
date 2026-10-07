// Full UI -> WebSocket -> SQLite -> stub TTS -> AudioWorklet seek flow.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { speechFixture } from '../test-support/speech-fixture.mjs';
const fixture = await speechFixture({ audioSamples: 144000, seed(store) {
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, '全文进度验证');
  for (let i = 1; i <= 60; i++) {
    const row = store.addSegment(run.listeningId, run.runId, { id: String(i), text: `Source ${i}.` }).segment;
    store.setTranslation(row.id, `译文${i}。`, false);
  }
  const job = store.createExtractionJob(run.listeningId, store.detail(run.listeningId, 1, 100).segments);
  if (job) store.markJob(job.id, 'complete');
  store.finishRun(run.runId); return run;
} });
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = [], starts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (typeof payload === 'string') { const message = JSON.parse(payload); if (message.type === 'speech.transcript') starts.push(message); }
  }));
  await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'local-test-only'));
  await page.goto(fixture.base);
  await page.locator('#history-listening').click();
  await page.getByRole('button', { name: '查看“全文进度验证”', exact: true }).click();
  await page.locator('#transcript-speech-original').click();
  const seek = page.locator('#transcript-speech-seek'), pause = page.locator('#transcript-speech-pause');
  await page.locator('#transcript-speech-reading').filter({ hasText: 'Source 1.' }).waitFor();
  await pause.click();
  await page.waitForFunction(() => document.querySelector('#transcript-speech-pause').textContent === '继续播报');
  assert.equal(await seek.getAttribute('max'), '60');
  const requestsBeforeDrag = starts.length, generatedBeforeDrag = fixture.stats.commits.length;
  await seek.scrollIntoViewIfNeeded(); const box = await seek.boundingBox();
  await page.mouse.move(box.x + 8, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .9, box.y + box.height / 2, { steps: 8 });
  const target = Number(await seek.inputValue());
  assert.ok(target > 50, 'drag can reach content beyond the first page');
  assert.equal(starts.length, requestsBeforeDrag, 'drag preview must not send paid requests');
  await page.mouse.up();
  await page.waitForFunction(position => document.querySelector('#transcript-speech-position').textContent === `第 ${position} / 60 句`, target);
  await page.waitForTimeout(150);
  assert.equal(starts.length, requestsBeforeDrag + 1); assert.equal(starts.at(-1).startPosition, target);
  assert.equal(starts.at(-1).paused, true); assert.equal(fixture.stats.commits.length, generatedBeforeDrag);
  // Keyboard jumps retain focus and work repeatedly while a new player is unlocking.
  await seek.focus(); await page.keyboard.press('Home'); await page.keyboard.press('End');
  await page.waitForFunction(() => document.querySelector('#transcript-speech-seek').value === '60');
  await page.waitForTimeout(150);
  assert.equal(starts.at(-1).startPosition, 60); assert.equal(starts.at(-1).paused, true);
  assert.equal(await seek.evaluate(el => el === document.activeElement), true);
  assert.equal(fixture.stats.commits.length, generatedBeforeDrag);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SPEECH_SEEK_EVIDENCE_DIR) {
      await mkdir(process.env.SPEECH_SEEK_EVIDENCE_DIR, { recursive: true });
      await page.locator('#transcript-speech-controls').screenshot({ path: path.join(process.env.SPEECH_SEEK_EVIDENCE_DIR, `speech-seek-${width}.png`) });
    }
  }
  await pause.click();
  await page.locator('#transcript-speech-reading').filter({ hasText: 'Source 60.' }).waitFor();
  assert.equal(fixture.stats.commits.at(-1), 'Source 60.');
  await page.locator('#transcript-speech-status').filter({ hasText: '原文全文播报完成' }).waitFor();
  assert.equal(await page.locator('#transcript-speech-progress').isHidden(), true);
  await page.locator('#transcript-speech-translation').click();
  await page.locator('#transcript-speech-reading').filter({ hasText: '译文1。' }).waitFor();
  await seek.focus(); await page.keyboard.press('End');
  await page.locator('#transcript-speech-reading').filter({ hasText: '译文60。' }).waitFor();
  assert.equal(starts.at(-1).kind, 'translation'); assert.equal(starts.at(-1).paused, false);
  await seek.focus(); await page.keyboard.press('Home');
  await page.locator('#transcript-speech-reading').filter({ hasText: '译文1。' }).waitFor();
  await page.locator('#transcript-speech-stop').click();
  assert.equal(await page.locator('#transcript-speech-progress').isHidden(), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['real pointer drag', 'no requests during preview', 'beyond pagination', 'paused seek does not synthesize',
    'keyboard Home/End and rapid seek', 'focus retained', 'resume at last sentence', 'completion cleanup', 'translation forward/backward seek', 'stop cleanup', '1280/390/320 layout', 'no page errors'] }));
} finally { await browser?.close(); await fixture.close(); }
