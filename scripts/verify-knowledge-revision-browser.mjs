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
    const name = store.acceptNameCorrection(first.listeningId, item.id, randomUUID(), { revision: snapshot.revision }, { hasKey: true });
    store.failKnowledgeEditJob(name.job.id, '模拟历史名称失败');
    store.db.prepare('UPDATE knowledge_items SET dialogue_summary=? WHERE id=?').run('最新卡片内容', item.id);
    return { first };
  },
  modelResponse: body => {
    const input = JSON.parse(body.messages.at(-1).content);
    if (input.operation === 'name_correction') return { outcome: 'unchanged', name: input.name, reason: '模拟检查', evidence: [] };
    if (!input.name) return { items: [] };
    return { short_description: '相机公司', dialogue_summary: '推出了相机。',
      facts: [{ content: '推出了相机。', segment_id: input.segments[0].id, quote: input.segments[0].text }] };
  }
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
    const result = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, source: snapshot.item.canonical_name, revision: snapshot.revision, key: 'stub-only' }) });
    assert.equal(result.status, 200, await result.clone().text());
  };
  let patches = 0, deletes = 0, posts = 0;
  page.on('request', request => {
    if (request.url() === url && request.method() === 'PATCH') patches++;
    if (request.url() === url && request.method() === 'DELETE') deletes++;
    if (request.url() === `${url}/name-corrections` && request.method() === 'POST') posts++;
  });
  await page.goto(fixture.base);
  await page.locator('#history-listening').click();
  await page.getByRole('button', { name: '查看“柯达相机的故事”', exact: true }).click();
  await page.locator('#knowledge-view-list').click();
  const card = page.locator(`.knowledge-item[data-id="${item.id}"]`);
  await card.locator('summary').click();
  const open = async () => {
    await card.getByRole('button', { name: /^修改或删除 / }).click();
    await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  };
  await open();
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Eastman Kodak');
  assert.match(await page.locator('#knowledge-edit-status').textContent(), /上次保存未完成.*模拟历史生成失败.*已显示最新内容/);
  assert.equal(fixture.stats.providerRequests.length, 0);
  await page.locator('#knowledge-edit-close').click();
  await card.getByRole('button', { name: '校正 Eastman Kodak 的名称', exact: true }).click();
  await page.locator('#knowledge-name-status').filter({ hasText: '此后条目或原文已改变' }).waitFor();
  assert.equal(posts, 0); assert.equal(fixture.stats.providerRequests.length, 0);
  await page.locator('#knowledge-name-close').click();
  await open();
  await page.locator('#knowledge-edit-name').fill('My preserved draft');
  await change('Kodak Current');
  const calls = fixture.stats.providerRequests.length;
  await page.locator('#knowledge-edit-save').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '已读取最新内容，输入已保留' }).waitFor();
  assert.equal(patches, 1); assert.equal(fixture.stats.providerRequests.length, calls);
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'My preserved draft');
  assert.equal(await page.locator('#knowledge-edit-source').inputValue(), 'Eastman Kodak');
  assert.match(await page.locator('#knowledge-edit-current-source').textContent(), /Kodak Current released/);
  assert.match(await page.locator('#knowledge-edit-current-source').textContent(), /译文/);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => {
      const el = document.querySelector('#knowledge-editor');
      return el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth;
    }), true);
    if (process.env.KNOWLEDGE_REVISION_EVIDENCE_DIR) {
      await mkdir(process.env.KNOWLEDGE_REVISION_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.KNOWLEDGE_REVISION_EVIDENCE_DIR, `knowledge-revision-${width}.png`) });
    }
  }
  await page.locator('#knowledge-edit-source').fill('Kodak Current');
  await page.locator('#knowledge-edit-save').click();
  await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  assert.equal(patches, 2); assert.equal(fixture.stats.providerRequests.length, calls + 1);
  assert.equal((await read()).item.canonical_name, 'My preserved draft');
  // A real change between the name GET and POST must also stop automatic work.
  await card.getByRole('button', { name: /^校正 .* 的名称$/ }).click();
  await page.locator('#knowledge-name-status').filter({ hasText: '此后条目或原文已改变' }).waitFor();
  let nameConflictCalls;
  await page.route(`${url}/name-corrections`, async route => {
    await change('Kodak Before Name'); nameConflictCalls = fixture.stats.providerRequests.length;
    await route.continue();
  }, { times: 1 });
  await page.locator('#knowledge-name-retry').click();
  await page.locator('#knowledge-name-status').filter({ hasText: '已读取最新名称“Kodak Before Name”' }).waitFor();
  assert.equal(posts, 1); assert.equal(fixture.stats.providerRequests.length, nameConflictCalls);
  await page.locator('#knowledge-name-retry').click();
  await page.locator('#knowledge-name-status').filter({ hasText: '保留“Kodak Before Name”' }).waitFor();
  assert.equal(posts, 2); assert.equal(fixture.stats.providerRequests.length, nameConflictCalls,
    'the explicit retry reuses the manual correction rule without a model request');
  await page.locator('#knowledge-name-close').click();
  await open(); await page.locator('#knowledge-edit-delete').click();
  await change('Kodak Latest');
  const beforeDelete = fixture.stats.providerRequests.length;
  await page.locator('#knowledge-delete-submit').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '已读取最新内容，输入已保留' }).waitFor();
  assert.equal(deletes, 1); assert.equal(fixture.stats.providerRequests.length, beforeDelete);
  assert.equal(await page.locator('#knowledge-delete-confirm').isHidden(), true);
  assert.equal((await read()).item.canonical_name, 'Kodak Latest');
  await page.locator('#knowledge-edit-close').click();
  await page.route(url, async route => {
    const result = await route.fetch(), snapshot = await result.json();
    await route.fulfill({ response: result, json: { ...snapshot, revision: preFixRevision(snapshot, 11) } });
  }, { times: 1 });
  await open(); await page.locator('#knowledge-edit-delete').click();
  await page.locator('#knowledge-delete-submit').click();
  await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  assert.equal(deletes, 2); assert.equal((await fetch(url)).status, 404);
  assert.equal(fixture.stats.providerRequests.length, beforeDelete);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['stale failures remain visible', 'stale failure never replaces current name',
    'name failure reopening sends zero POST', 'real concurrent edit keeps draft', 'conflict only reads; no paid retry',
    'latest linked source and translation shown', 'desktop/390/320 layout', 'explicit save after review',
    'name conflict only reads then waits for explicit retry', 'delete requires renewed confirmation',
    'v11 browser token accepted after upgrade', 'no page errors'] }));
} finally { await browser?.close(); await fixture.close(); }
