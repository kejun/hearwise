import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { graphFixture } from '../test-support/graph-fixture.mjs';

const fixture = await graphFixture({ modelResponse: async body => {
  const input = JSON.parse(body.messages.at(-1).content);
  if (!input.name) return { items: [] };
  await new Promise(resolve => setTimeout(resolve, input.name === 'Kodak' ? Number(process.env.KNOWLEDGE_EDIT_SLOW_MODEL_MS || 1500) : 250));
  return { short_description: '对话介绍的相机制造公司', dialogue_summary: `${input.name} 推出了相机。`,
    facts: [{ content: `${input.name} 推出了相机。`, segment_id: input.segments[0].id,
      quote: input.name === 'Fail' ? 'unverified quote' : input.segments[0].text }] };
} });
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'local-test-only'));
  await page.goto(fixture.base);
  const open = async () => {
    await page.locator('#history-listening').click();
    await page.getByRole('button', { name: '查看“柯达相机的故事”', exact: true }).click();
    await page.locator('#knowledge-view-list').click();
  };
  await open();
  const card = page.locator(`.knowledge-item[data-id="${fixture.seeded.first.nodes[0].id}"]`);
  await card.locator('summary').click();
  const editUrl = `${fixture.base}/api/listenings/${fixture.seeded.first.listeningId}/knowledge/${fixture.seeded.first.nodes[0].id}`;
  // A real proxy/mismatched deployment can return HTML rather than the JSON API contract.
  await page.route(editUrl, route => route.fulfill({ status: 404, contentType: 'text/html', body: '<html>private diagnostic</html>' }), { times: 1 });
  await card.getByRole('button', { name: '修改或删除 Eastman Kodak', exact: true }).click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '读取知识条目失败（HTTP 404）' }).waitFor();
  assert.equal(await page.locator('#knowledge-edit-save').isDisabled(), true);
  assert.doesNotMatch(await page.locator('#knowledge-edit-status').textContent(), /private|pattern/);
  await page.locator('#knowledge-edit-close').click();
  await card.getByRole('button', { name: '修改或删除 Eastman Kodak', exact: true }).click();
  await page.locator('#knowledge-edit-name').waitFor();
  await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  await page.locator('#knowledge-edit-name').fill('Proxy failed draft');
  const callsBeforeProxy = fixture.stats.providerRequests.length;
  await page.route(editUrl, route => route.fulfill({ status: 504, contentType: 'text/html', body: '<html>Gateway Timeout</html>' }), { times: 1 });
  await page.locator('#knowledge-edit-save').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '保存知识修改失败（HTTP 504）' }).waitFor();
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Proxy failed draft');
  assert.equal(await page.locator('#knowledge-edit-save').isDisabled(), true);
  assert.equal(fixture.stats.providerRequests.length, callsBeforeProxy);
  await page.locator('#knowledge-edit-close').click();
  await card.getByRole('button', { name: '修改或删除 Eastman Kodak', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  await page.locator('#knowledge-edit-name').fill('Discarded draft');
  await page.locator('#knowledge-edit-close').click();
  assert.match(await card.textContent(), /Eastman Kodak/);
  await card.getByRole('button', { name: '修改或删除 Eastman Kodak', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Eastman Kodak');
  await page.locator('#knowledge-edit-name').fill('Fail');
  await page.locator('#knowledge-edit-save').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '原内容未更改' }).waitFor();
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Fail');
  assert.match(await card.textContent(), /Eastman Kodak/);
  await page.locator('#knowledge-edit-name').fill('Kodak');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.evaluate(() => {
      const el = document.querySelector('#knowledge-editor');
      return el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth;
    }), true);
    if (process.env.KNOWLEDGE_EDIT_EVIDENCE_DIR) {
      await mkdir(process.env.KNOWLEDGE_EDIT_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.KNOWLEDGE_EDIT_EVIDENCE_DIR, `knowledge-edit-${width}.png`) });
    }
  }
  await page.locator('#knowledge-edit-save').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '正在后台重新生成' }).waitFor();
  // Refresh while the model is still running, then resume the same persisted job.
  const callsDuringSave = fixture.stats.providerRequests.length;
  await page.reload(); await open();
  await card.locator('summary').click();
  await card.getByRole('button', { name: '修改或删除 Eastman Kodak', exact: true }).click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '正在后台重新生成' }).waitFor();
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Kodak');
  assert.equal(await page.locator('#knowledge-edit-close').isEnabled(), true);
  await page.locator('#knowledge-editor').waitFor({ state: 'hidden', timeout: 45000 });
  assert.equal(fixture.stats.providerRequests.length, callsDuringSave);
  await card.locator('summary').filter({ hasText: 'Kodak' }).waitFor();
  await page.reload(); await open();
  await card.locator('summary').filter({ hasText: 'Kodak' }).waitFor();
  await card.locator('summary').click();
  await card.getByRole('button', { name: '修改或删除 Kodak', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  await page.locator('#knowledge-edit-name').fill('Eastman Kodak');
  const callsBeforeLostResponse = fixture.stats.providerRequests.length;
  // The server accepts, then the gateway loses the response. Recover by reading the job.
  await page.route(editUrl, async route => {
    const result = await route.fetch(); assert.equal(result.status(), 202);
    await route.fulfill({ status: 502, contentType: 'text/html', body: '<html>upstream connection lost</html>' });
  }, { times: 1 });
  await page.locator('#knowledge-edit-save').click();
  await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  assert.equal(fixture.stats.providerRequests.length, callsBeforeLostResponse + 1);
  await page.reload(); await open();
  await card.locator('summary').filter({ hasText: 'Eastman Kodak' }).waitFor();
  await page.locator('#knowledge-view-graph').click();
  await page.locator('.graph-results > summary').click();
  await page.locator(`[data-result-node-id="${fixture.seeded.first.nodes[0].id}"]`).click();
  await page.locator('#graph-edit-node').click();
  await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Eastman Kodak');
  await page.locator('#knowledge-edit-delete').click();
  await page.locator('#knowledge-delete-cancel').click();
  assert.equal(await page.locator('#knowledge-delete-confirm').isHidden(), true);
  await page.locator('#knowledge-edit-delete').click();
  await page.locator('#knowledge-delete-submit').click();
  await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  await page.waitForFunction(id => !document.querySelector(`[data-result-node-id="${id}"]`), fixture.seeded.first.nodes[0].id);
  await page.reload(); await open();
  assert.equal(await card.count(), 0);
  const graph = await page.request.get(`${fixture.base}/api/listenings/${fixture.seeded.first.listeningId}/graph`);
  assert.equal((await graph.json()).nodes.length, fixture.seeded.first.nodes.length - 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['cancel preserves content', 'failed regeneration retains draft', 'atomic save',
    'HTML read failure', 'HTML write failure retains draft', 'lost committed response does not repeat paid request',
    'refresh resumes running job', 'model delay ' + (process.env.KNOWLEDGE_EDIT_SLOW_MODEL_MS || 1500) + 'ms',
    'desktop/390/320 layout', 'reload persistence', 'graph edit entry', 'delete confirmation', 'no resurrection', 'no page errors'] }));
} finally { await browser?.close(); await fixture.close(); }
