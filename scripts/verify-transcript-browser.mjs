// Archived reading against real HTTP/storage with local providers only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { graphFixture } from '../test-support/graph-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = await graphFixture();
const directory = process.env.TRANSCRIPT_EVIDENCE_DIR;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const open = async title => {
    await page.locator('#history-listening').click();
    await page.getByRole('button', { name: `查看“${title}”`, exact: true }).click();
    await page.locator('.transcript-item').first().waitFor({ state: 'attached' });
  };
  const original = page.locator('.transcript-original');
  const translation = page.locator('.transcript-translation');
  await page.goto(fixture.base);
  await open('柯达相机的故事');
  assert.equal(await original.first().isVisible(), true);
  assert.equal(await translation.first().isVisible(), true);
  await page.locator('#hide-transcript-original').focus();
  await page.keyboard.press('Space');
  assert.equal(await original.first().isHidden(), true);
  assert.equal(await translation.first().isVisible(), true);
  const count = await original.count();
  await page.locator('#load-more').click();
  await page.waitForFunction(count => document.querySelectorAll('.transcript-item').length > count, count);
  assert.equal(await original.last().isHidden(), true);
  assert.equal(await translation.last().isVisible(), true);
  await page.locator('#hide-transcript-translation').check();
  assert.equal(await page.locator('#transcript-hidden-note').isVisible(), true);
  assert.equal(await page.locator('#transcript-list').isHidden(), true);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-select').selectOption('original');
  const download = await downloadPromise;
  assert.match(await readFile(await download.path(), 'utf8'), /Eastman Kodak released/);
  assert.equal(await page.locator('#transcript-panel').getAttribute('open'), '');
  await page.reload();
  await open('另一段收听');
  assert.equal(await page.locator('#hide-transcript-original').isChecked(), true);
  assert.equal(await page.locator('#hide-transcript-translation').isChecked(), true);
  await page.locator('#show-transcript-all').click();
  assert.equal(await original.first().isVisible(), true);
  assert.equal(await translation.first().isVisible(), true);
  await page.locator('#hide-transcript-translation').check();
  assert.equal(await original.first().isVisible(), true);
  assert.equal(await translation.first().isHidden(), true);
  // Background polling must not reset the preference.
  await page.waitForTimeout(2200);
  assert.equal(await translation.first().isHidden(), true);
  await page.locator('#hide-transcript-translation').uncheck();
  if (directory) await mkdir(directory, { recursive: true });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    await page.locator('#transcript-panel').evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 180));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const selector of ['.transcript-visibility label', '#download-select', '#transcript-speech-original', '#transcript-speech-translation']) {
      for (const control of await page.locator(selector).all()) assert.ok((await control.boundingBox()).height >= 44);
    }
    if (directory) await page.screenshot({ path: path.join(directory, `transcript-${width}.png`) });
  }
  await page.evaluate(() => localStorage.setItem('hearwise:transcript-visibility', '{broken'));
  await page.reload();
  await open('柯达相机的故事');
  assert.equal(await original.first().isVisible(), true);
  assert.equal(await translation.first().isVisible(), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['independent visibility', 'keyboard', 'pagination', 'both hidden recovery',
    'full export while hidden', 'reload and record switch', 'polling', 'desktop and mobile layout', 'invalid preference fallback'] }));
} finally {
  await browser?.close();
  await fixture.close();
}
