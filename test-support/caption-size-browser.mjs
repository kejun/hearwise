import assert from 'node:assert/strict';
import { speechFixture } from './speech-fixture.mjs';

const SIZE_KEY = 'tongsheng:translation-size';
const samples = [
  ['Welcome to our weekly meeting.', '欢迎参加每周例会。'],
  ['Today we will review the project.', '今天我们回顾项目进展。'],
  ['The team has finished the first draft.', '团队已经完成了初稿。'],
  ['Please share your feedback tomorrow.', '请在明天分享你的反馈。'],
  ['We will make the next steps clear.', '我们会明确下一步计划。'],
  ['Clear information makes communication easier.', '让信息更清晰，让沟通更简单。']
];

// Real range input, layout and persisted preferences in a fresh browser context.
// Captions come through the ASR/translation fixture, rather than edited page text.
export async function verifyCaptionSizeBrowser(browser) {
  const fixture = await speechFixture({ translationText: text => new Map(samples).get(text) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [], measurements = [], migrations = [];
  page.on('pageerror', error => errors.push(error.message));
  const slider = page.getByRole('slider', { name: '译文字号', exact: true });
  const assertSize = async (size, { stored = String(size), mobile = false } = {}) => {
    await page.waitForFunction(({ size, stored, key }) =>
      document.querySelector('#translation-size').value === String(size) &&
      document.documentElement.style.getPropertyValue('--translation-size') === String(size) &&
      localStorage.getItem(key) === stored, { size, stored, key: SIZE_KEY });
    const actual = await page.evaluate(() => {
      const fontSize = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
      return { translation: fontSize('#translation'), pinned: fontSize('#pinned-translation'), original: fontSize('#original') };
    });
    const expected = { translation: size * (mobile ? .72 : 1), pinned: size * (mobile ? .5 : .6), original: mobile ? 17 : 22 };
    for (const key of Object.keys(expected)) {
      assert.ok(Math.abs(actual[key] - expected[key]) < .001,
        `${mobile ? 'mobile' : 'desktop'} ${key} at ${size}: expected ${expected[key]}px, got ${actual[key]}px`);
    }
    return actual;
  };
  const pressSize = async (key, size, options) => {
    await slider.focus();
    await page.keyboard.press(key);
    return assertSize(size, options);
  };
  const screenshot = async (locator, variable) => {
    if (process.env[variable]) await locator.screenshot({ path: process.env[variable], animations: 'disabled' });
  };
  try {
    await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'mock-caption-size-key'));
    await page.goto(fixture.base);
    assert.equal(await slider.getAttribute('min'), '21');
    assert.equal(await slider.getAttribute('max'), '64');
    assert.equal(await slider.getAttribute('step'), '1');
    assert.equal(await slider.getAttribute('value'), '44');
    await assertSize(44, { stored: null });

    // Native keyboard controls exercise input events and both clamped endpoints.
    for (const [key, size] of [['Home', 21], ['ArrowLeft', 21], ['ArrowRight', 22],
      ['End', 64], ['ArrowRight', 64], ['ArrowLeft', 63]]) await pressSize(key, size);
    await page.reload();
    await assertSize(63);
    for (let repeat = 0; repeat < 3; repeat++) {
      await pressSize('Home', 21);
      await pressSize('End', 64);
    }
    await page.reload();
    await assertSize(64);
    await pressSize('Home', 21);
    await page.reload();
    await assertSize(21);

    // Size is saved immediately; dismissing or saving unrelated settings must not reset it.
    for (const dismiss of [() => page.keyboard.press('Escape'), () => page.locator('#close-settings').click(),
      () => page.locator('#settings-modal').click({ position: { x: 5, y: 5 } })]) {
      await page.getByRole('button', { name: '打开设置', exact: true }).click();
      await dismiss();
      await page.locator('#settings-modal').waitFor({ state: 'hidden' });
      await assertSize(21);
    }
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    await page.getByRole('tab', { name: '连接设置', exact: true }).click();
    await page.getByRole('button', { name: '保存并继续', exact: true }).click();
    await assertSize(21);
    await page.locator('#live-speech-tab').click();
    await page.getByRole('button', { name: '播报设置', exact: true }).click();
    await page.getByRole('button', { name: '保存播报设置', exact: true }).click();
    await assertSize(21);
    assert.equal(fixture.stats.connections, 0);
    assert.equal(fixture.stats.asrClients.size, 0);

    // Old upper limits and damaged storage are repaired, including a second reload.
    for (const [saved, expected] of [['70', 64], ['18', 21], ['0', 21], ['-10', 21], ['22', 22], ['44', 44],
      ['63', 63], ['43.6', 44], ['', 44], ['   ', 44], ['broken', 44], ['44px', 44], ['NaN', 44], ['Infinity', 44], ['-Infinity', 44]]) {
      await page.evaluate(({ key, saved }) => localStorage.setItem(key, saved), { key: SIZE_KEY, saved });
      await page.reload();
      await assertSize(expected);
      await page.reload();
      await assertSize(expected);
      migrations.push({ saved, restored: expected });
    }

    await page.getByRole('button', { name: '开始聆听', exact: true }).click();
    await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
    // Listening-ready means the fixture ASR connection is ready for deterministic input.
    assert.equal(fixture.stats.asrClients.size, 1);
    for (const [index, [original, translation]] of samples.entries()) {
      fixture.final(original, true, `caption-size-${index}`);
      await page.waitForFunction(({ original, translation }) =>
        document.querySelector('#original').textContent === original &&
        document.querySelector('#translation').textContent === translation &&
        !document.querySelector('#translation').classList.contains('placeholder'), { original, translation });
    }
    await page.waitForFunction(count => document.querySelectorAll('#transcript-list .transcript-item').length === count, samples.length);
    const [original, translation] = samples.at(-1);

    for (const [device, viewport] of [['desktop', { width: 1280, height: 950 }], ['mobile', { width: 390, height: 844 }]]) {
      const mobile = device === 'mobile';
      await page.setViewportSize(viewport);
      for (const [boundary, key, size] of [['min', 'Home', 21], ['max', 'End', 64]]) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const actual = await pressSize(key, size, { mobile });
        assert.equal(await page.locator('#original').textContent(), original);
        assert.equal(await page.locator('#translation').textContent(), translation);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${device} has no horizontal overflow`);
        await screenshot(page.locator('#live-panel'), `CAPTION_SIZE_${device.toUpperCase()}_${boundary.toUpperCase()}_SCREENSHOT`);

        // Real transcript content provides scroll height for the shared panel's pin boundary.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.locator('#pinned-caption').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#pinned-translation').isVisible(), true);
        assert.equal(await page.locator('#pinned-translation').textContent(), translation);
        await assertSize(size, { mobile });
        await screenshot(page.locator('#pinned-caption'), `CAPTION_SIZE_PINNED_${device.toUpperCase()}_${boundary.toUpperCase()}_SCREENSHOT`);
        await page.getByRole('button', { name: '收起吸顶字幕', exact: true }).click();
        assert.equal(await page.locator('#pinned-translation').isHidden(), true);
        await page.getByRole('button', { name: '展开吸顶字幕', exact: true }).click();
        assert.equal(await page.locator('#pinned-translation').isVisible(), true);
        await assertSize(size, { mobile });
        measurements.push({ device, size, ...actual });
      }
      // The mobile range remains keyboard-adjustable in single-unit steps too.
      await page.evaluate(() => window.scrollTo(0, 0));
      await pressSize('ArrowLeft', 63, { mobile });
      await pressSize('End', 64, { mobile });
      await pressSize('ArrowRight', 64, { mobile });
      await pressSize('Home', 21, { mobile });
      await pressSize('ArrowLeft', 21, { mobile });
      await pressSize('ArrowRight', 22, { mobile });
    }
    await page.getByRole('button', { name: '停止聆听', exact: true }).click();
    await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
    await page.reload();
    await assertSize(22, { mobile: true });
    assert.deepEqual(errors, []);
    return { default: 44, range: [21, 64], step: 1, keyboardBoundaries: true, repeatedChanges: true,
      reloadPersistence: true, unrelatedSettingsIndependent: true, migrations, measurements, uiErrors: errors };
  } catch (error) {
    console.error('caption_size_browser_failure', JSON.stringify({ message: error.message,
      value: await slider.inputValue().catch(() => ''), hint: await page.locator('#hint').textContent().catch(() => '') }));
    throw error;
  } finally {
    await context.close();
    await fixture.close();
  }
}
