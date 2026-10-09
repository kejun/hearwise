import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { speechFixture } from '../test-support/speech-fixture.mjs';
import { seedGraphListening } from '../test-support/graph-fixture.mjs';
import { preFixRevision } from '../test-support/knowledge-revision-fixture.mjs';

const fixture = await speechFixture({
  seed: store => {
    const first = seedGraphListening(store, { extraNodes: 0 }), item = first.nodes[0];
    const snapshot = store.knowledgeEditSnapshot(first.listeningId, item.id), id = randomUUID();
    store.createKnowledgeEditJob(first.listeningId, item.id, id,
      { name: 'Failed historical draft', source: item.canonical_name, revision: preFixRevision(snapshot, 11) });
    store.failKnowledgeEditJob(id, '模拟历史生成失败');
    store.db.prepare('UPDATE knowledge_items SET dialogue_summary=? WHERE id=?').run('最新卡片内容', item.id);
    return { first };
  }, modelResponse: () => ({ name: 'Tibo Suggested', reason: '仅作为建议。' })
});
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'local-test-only'));
  const { first } = fixture.seeded, item = first.nodes[0];
  const url = `${fixture.base}/api/listenings/${first.listeningId}/knowledge/${item.id}`;
  const read = async () => (await (await fetch(url)).json());
  const change = async name => {
    const snapshot = await read();
    const result = await fetch(`${url}/name-replacements`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ name, revision: snapshot.revision }) });
    assert.equal(result.status, 200, await result.clone().text());
  };
  let writes = 0, deletes = 0, suggestions = 0;
  page.on('request', request => {
    if (request.url() === `${url}/name-replacements` && request.method() === 'POST') writes++;
    if (request.url() === url && request.method() === 'DELETE') deletes++;
    if (request.url() === `${url}/name-suggestions` && request.method() === 'POST') suggestions++;
  });
  await page.goto(fixture.base); await page.locator('#history-listening').click();
  await page.getByRole('button', { name: '查看“柯达相机的故事”', exact: true }).click();
  await page.locator('#knowledge-view-list').click();
  const card = page.locator(`.knowledge-item[data-id="${item.id}"]`);
  await card.locator('summary').click();
  const open = async () => {
    await card.getByRole('button', { name: /^纠正 .* 的名称$/ }).click();
    await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  };
  await open();
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Eastman Kodak');
  assert.match(await page.locator('#knowledge-edit-status').textContent(), /上次保存未完成.*模拟历史生成失败.*已显示最新内容/);
  assert.equal(fixture.stats.providerRequests.length, 0);
  await page.locator('#knowledge-edit-name').fill('My preserved draft'); await change('Kodak Current');
  await page.locator('#knowledge-edit-save').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '已读取最新内容，输入已保留' }).waitFor();
  assert.equal(writes, 1); assert.equal(fixture.stats.providerRequests.length, 0);
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'My preserved draft');
  assert.equal(await page.locator('#knowledge-edit-source').inputValue(), 'Kodak Current');
  assert.match(await page.locator('#knowledge-edit-current-source').textContent(), /Kodak Current released.*译文/s);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => {
      const el = document.querySelector('#knowledge-editor'), box = el.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && box.left >= 0 && box.right <= innerWidth;
    }), true);
    if (process.env.KNOWLEDGE_REVISION_EVIDENCE_DIR) {
      await mkdir(process.env.KNOWLEDGE_REVISION_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.KNOWLEDGE_REVISION_EVIDENCE_DIR, `knowledge-revision-${width}.png`) });
    }
  }
  await page.locator('#knowledge-edit-save').click(); await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  assert.equal(writes, 2); assert.equal(fixture.stats.providerRequests.length, 0);
  assert.equal((await read()).item.canonical_name, 'My preserved draft');
  await open(); await page.locator('#knowledge-edit-name').fill('Preserve during suggestion');
  await page.route(`${url}/name-suggestions`, async route => { await change('Kodak Before Suggestion'); await route.continue(); }, { times: 1 });
  await page.locator('#knowledge-edit-suggest').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '已读取最新内容，输入已保留' }).waitFor();
  assert.equal(suggestions, 1); assert.equal(fixture.stats.providerRequests.length, 0);
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Preserve during suggestion');
  await page.locator('#knowledge-edit-suggest').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '尚未保存' }).waitFor();
  assert.equal(suggestions, 2); assert.equal(fixture.stats.providerRequests.length, 1);
  assert.equal((await read()).item.canonical_name, 'Kodak Before Suggestion');
  await page.locator('#knowledge-edit-delete').click(); await change('Kodak Latest');
  await page.locator('#knowledge-delete-submit').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '已读取最新内容，输入已保留' }).waitFor();
  assert.equal(deletes, 1); assert.equal(await page.locator('#knowledge-delete-confirm').isHidden(), true);
  assert.equal((await read()).item.canonical_name, 'Kodak Latest');
  await page.locator('#knowledge-edit-close').click();
  await page.route(url, async route => {
    const result = await route.fetch(), snapshot = await result.json();
    await route.fulfill({ response: result, json: { ...snapshot, revision: preFixRevision(snapshot, 11) } });
  }, { times: 1 });
  await open(); await page.locator('#knowledge-edit-delete').click(); await page.locator('#knowledge-delete-submit').click();
  await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  assert.equal(deletes, 2); assert.equal((await fetch(url)).status, 404);
  assert.equal(fixture.stats.providerRequests.length, 1); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['stale historical failure stays visible without replay',
    'real concurrent edit keeps draft', 'conflict only reads; no automatic save or model retry',
    'raw anchor refreshes with latest source/translation', 'desktop/390/320 layout', 'explicit confirmation uses zero models',
    'suggestion conflict preserves input', 'delete requires renewed confirmation', 'v11 token remains compatible', 'no page errors'] }));
} finally { await browser?.close(); await fixture.close(); }
