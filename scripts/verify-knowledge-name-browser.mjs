import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { graphFixture } from '../test-support/graph-fixture.mjs';

let release, invalid = false, calls = 0;
const barrier = new Promise(resolve => { release = resolve; });
const fixture = await graphFixture({ modelResponse: async body => {
  const input = JSON.parse(body.messages.at(-1).content);
  assert.equal(input.operation, 'name_suggestion'); calls++;
  if (calls === 1) await barrier;
  return invalid ? 'invalid JSON' : { name: 'Tibo', reason: '建议名称，需要人工确认。' };
} });
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'fixture-key'));
  const first = fixture.seeded.first, item = first.nodes[0], second = first.nodes[1];
  const url = `${fixture.base}/api/listenings/${first.listeningId}/knowledge/${item.id}`;
  const read = () => page.request.get(url).then(response => response.json());
  const before = await read();
  await page.goto(fixture.base);
  await page.locator('#history-listening').click();
  await page.getByRole('button', { name: '查看“柯达相机的故事”', exact: true }).click();
  await page.locator('#knowledge-view-list').click();
  const card = page.locator(`.knowledge-item[data-id="${item.id}"]`);
  await card.locator('summary').click();
  await card.getByRole('button', { name: '纠正 Eastman Kodak 的名称', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  await page.locator('#knowledge-edit-suggest').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '正在获取校对建议' }).waitFor();
  assert.equal(await page.locator('#knowledge-edit-save').isDisabled(), true);
  assert.deepEqual(await read(), before);
  release();
  await page.locator('#knowledge-edit-status').filter({ hasText: '尚未保存' }).waitFor();
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Tibo');
  assert.equal(calls, 1); assert.deepEqual(await read(), before);
  await page.locator('#knowledge-edit-name').fill('Tibo Confirmed');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.evaluate(() => {
      const el = document.querySelector('#knowledge-editor'), box = el.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && box.left >= 0 && box.right <= innerWidth;
    }), true);
    if (process.env.KNOWLEDGE_NAME_EVIDENCE_DIR) await page.screenshot({
      path: path.join(process.env.KNOWLEDGE_NAME_EVIDENCE_DIR, `knowledge-name-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.locator('#knowledge-edit-save').click(); await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  assert.equal((await read()).item.canonical_name, 'Tibo Confirmed'); assert.equal(calls, 1);
  await page.locator('#knowledge-view-graph').click(); await page.locator('#graph-search').fill('Tibo Confirmed');
  await page.locator('.graph-results > summary').click();
  await page.locator(`[data-result-node-id="${item.id}"]`).filter({ hasText: 'Tibo Confirmed' }).waitFor();
  await page.locator('#knowledge-view-list').click();
  const secondCard = page.locator(`.knowledge-item[data-id="${second.id}"]`);
  await secondCard.locator('summary').click();
  await secondCard.getByRole('button', { name: '纠正 Brownie camera 的名称', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  await page.locator('#knowledge-edit-name').fill('Camera manual'); invalid = true;
  await page.locator('#knowledge-edit-suggest').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '获取建议失败' }).waitFor();
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Camera manual');
  assert.equal(await page.locator('#knowledge-edit-save').isEnabled(), true); assert.equal(calls, 2);
  await page.locator('#knowledge-edit-save').click(); await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  assert.equal(calls, 2); assert.equal(fixture.stats.providerRequests.length, 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, calls, checks: ['suggestion uses same editor', 'one request per explicit suggestion',
    'suggestion does not save', 'ungrounded spelling accepted after human confirmation', 'manual override/save adds zero calls',
    'malformed suggestion retains draft and permits manual save', 'graph search', 'desktop/390/320', 'no page errors'] }));
} finally { release(); await browser?.close(); await fixture.close(); }
