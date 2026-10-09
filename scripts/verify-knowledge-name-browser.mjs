import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import path from 'node:path';
import { graphFixture } from '../test-support/graph-fixture.mjs';

let release, invalid = true, calls = 0;
const barrier = new Promise(resolve => { release = resolve; });
const fixture = await graphFixture({ modelResponse: async body => {
  const input = JSON.parse(body.messages.at(-1).content);
  if (input.operation !== 'name_correction') return { items: [] };
  calls++;
  if (input.name === 'Eastman Kodak') {
    await barrier;
    const segment = input.segments.find(row => row.linked);
    return { outcome: 'corrected', name: '伊士曼柯达公司', reason: '已有译文明确给出对应名称。',
      evidence: [{ segment_id: segment.id, source_kind: 'translation', quote: segment.translation }] };
  }
  await new Promise(resolve => setTimeout(resolve, 1500));
  if (input.name === 'Brownie camera' && invalid) return 'invalid response';
  return { outcome: input.name === 'Brownie camera' ? 'unchanged' : 'insufficient_evidence',
    name: input.name, reason: '保留当前名称。', evidence: [] };
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
  const snapshot = await page.request.get(url).then(r => r.json()), acceptedId = randomUUID();
  // Another tab has accepted the same input. Lose the merged acknowledgement:
  // submitted UUID lookup misses; input-revision lookup must find the original ID.
  const accepted = await page.request.post(`${url}/name-corrections`, {
    headers: { 'Idempotency-Key': acceptedId }, data: { revision: snapshot.revision, key: 'fixture-key' } });
  assert.equal(accepted.status(), 202);
  const openListening = async () => {
    await page.locator('#history-listening').click();
    await page.getByRole('button', { name: '查看“柯达相机的故事”', exact: true }).click();
    await page.locator('#knowledge-view-list').click();
  };
  await page.goto(fixture.base); await openListening();
  const card = page.locator(`.knowledge-item[data-id="${item.id}"]`);
  await card.locator('summary').click();
  await page.route(url, async route => {
    const response = await route.fetch(), body = await response.json(); delete body.nameCorrectionJob;
    await route.fulfill({ response, json: body });
  }, { times: 1 });
  await page.route(`${url}/name-corrections`, async route => {
    const response = await route.fetch(); assert.equal(response.status(), 202);
    assert.equal((await response.json()).job.id, acceptedId); release();
    await route.fulfill({ status: 502, contentType: 'text/html', body: '<html>private gateway error</html>' });
  }, { times: 1 });
  await card.getByRole('button', { name: '校正 Eastman Kodak 的名称', exact: true }).click();
  const status = page.locator('#knowledge-name-status');
  await status.filter({ hasText: '名称已校正：Eastman Kodak → 伊士曼柯达公司' }).waitFor();
  assert.equal(calls, 1); assert.doesNotMatch(await status.textContent(), /private|gateway/);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.evaluate(() => {
      const el = document.querySelector('#knowledge-name-correction'), box = el.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && box.left >= 0 && box.right <= innerWidth;
    }), true);
    if (process.env.KNOWLEDGE_NAME_EVIDENCE_DIR) await page.screenshot({
      path: path.join(process.env.KNOWLEDGE_NAME_EVIDENCE_DIR, `knowledge-name-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.locator('#knowledge-name-close').click();
  await card.locator('summary').filter({ hasText: '伊士曼柯达公司' }).waitFor();
  if (!(await card.evaluate(el => el.open))) await card.locator('summary').click();
  await card.getByRole('button', { name: '校正 伊士曼柯达公司 的名称', exact: true }).click();
  await status.filter({ hasText: '名称已校正' }).waitFor(); assert.equal(calls, 1);
  await page.locator('#knowledge-name-close').click();
  await card.getByRole('button', { name: '修改或删除 伊士曼柯达公司', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), '伊士曼柯达公司');
  assert.equal(await page.locator('#knowledge-edit-source').inputValue(), 'Eastman Kodak');
  await page.locator('#knowledge-edit-close').click();
  await page.locator('#knowledge-view-graph').click();
  await page.locator('#graph-search').fill('伊士曼柯达');
  await page.locator('.graph-results > summary').click();
  const node = page.locator(`[data-result-node-id="${item.id}"]`);
  await node.filter({ hasText: '伊士曼柯达公司' }).waitFor(); await node.click();
  await page.locator('#graph-correct-name').click();
  await status.filter({ hasText: '名称已校正' }).waitFor(); assert.equal(calls, 1);
  await page.locator('#knowledge-name-close').click();
  await page.locator('#knowledge-view-list').click();
  const secondCard = page.locator(`.knowledge-item[data-id="${second.id}"]`);
  await secondCard.locator('summary').click();
  await secondCard.getByRole('button', { name: '校正 Brownie camera 的名称', exact: true }).click();
  await status.filter({ hasText: '正在校正名称' }).waitFor();
  await page.reload(); await openListening(); await secondCard.locator('summary').click();
  await secondCard.getByRole('button', { name: '校正 Brownie camera 的名称', exact: true }).click();
  await status.filter({ hasText: '原名称未更改' }).waitFor(); assert.equal(calls, 2);
  assert.equal(await page.locator('#knowledge-name-retry').isVisible(), true);
  invalid = false; await page.locator('#knowledge-name-retry').click();
  await status.filter({ hasText: '保留“Brownie camera”' }).waitFor(); assert.equal(calls, 3);
  await page.locator('#knowledge-name-close').click();
  const third = first.nodes[2], thirdCard = page.locator(`.knowledge-item[data-id="${third.id}"]`);
  await thirdCard.locator('summary').click();
  await thirdCard.getByRole('button', { name: `校正 ${third.canonical_name} 的名称`, exact: true }).click();
  await status.filter({ hasText: '依据不足，保留' }).waitFor(); assert.equal(calls, 4);
  await page.locator('#knowledge-name-close').click();
  await thirdCard.getByRole('button', { name: `校正 ${third.canonical_name} 的名称`, exact: true }).click();
  await status.filter({ hasText: '依据不足，保留' }).waitFor(); assert.equal(calls, 4);
  assert.equal(fixture.stats.providerRequests.length, 4);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, calls, checks: ['merged UUID/lost acknowledgement read recovery',
    'list and graph display/search', 'manual editor display default/raw anchor', 'zero-call repeat',
    'reload running job', 'terminal failure and explicit retry', 'insufficient evidence/cache', 'desktop/390/320', 'no page errors'] }));
} finally { release(); await browser?.close(); await fixture.close(); }
