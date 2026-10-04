import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { graphFixture } from '../test-support/graph-fixture.mjs';

const fixture = await graphFixture({ modelResponse: async body => {
  const input = JSON.parse(body.messages.at(-1).content);
  if (!input.name) return { items: [] };
  await new Promise(resolve => setTimeout(resolve, 250));
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
  await card.getByRole('button', { name: '修改或删除 Eastman Kodak', exact: true }).click();
  await page.locator('#knowledge-edit-name').waitFor();
  await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  await page.locator('#knowledge-edit-name').fill('Discarded draft');
  await page.locator('#knowledge-edit-cancel').click();
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
  await page.waitForFunction(() => document.querySelector('#knowledge-edit-save').disabled);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#knowledge-editor').isVisible(), true);
  await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  await card.locator('summary').filter({ hasText: 'Kodak' }).waitFor();
  await page.reload(); await open();
  await card.locator('summary').filter({ hasText: 'Kodak' }).waitFor();
  await page.locator('#knowledge-view-graph').click();
  await page.locator(`.graph-node[data-node-id="${fixture.seeded.first.nodes[0].id}"]`).click();
  await page.locator('#graph-edit-node').click();
  await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Kodak');
  await page.locator('#knowledge-edit-delete').click();
  await page.locator('#knowledge-delete-cancel').click();
  assert.equal(await page.locator('#knowledge-delete-confirm').isHidden(), true);
  await page.locator('#knowledge-edit-delete').click();
  await page.locator('#knowledge-delete-submit').click();
  await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  await page.waitForFunction(id => !document.querySelector(`.graph-node[data-node-id="${id}"]`), fixture.seeded.first.nodes[0].id);
  await page.reload(); await open();
  assert.equal(await card.count(), 0);
  const graph = await page.request.get(`${fixture.base}/api/listenings/${fixture.seeded.first.listeningId}/graph`);
  assert.equal((await graph.json()).nodes.length, fixture.seeded.first.nodes.length - 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['cancel preserves content', 'failed regeneration retains draft', 'atomic save',
    'busy Escape protection', 'desktop/390/320 layout', 'reload persistence', 'graph edit entry', 'delete confirmation', 'no resurrection', 'no page errors'] }));
} finally { await browser?.close(); await fixture.close(); }
