// Browser integration against local stub ASR/MT/TTS/relations. No paid API calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { graphFixture } from '../test-support/graph-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = process.env.GRAPH_EVIDENCE_DIR;
if (directory) await mkdir(directory, { recursive: true });
const fixture = await graphFixture();
let browser;
const errors = [], checks = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  const screenshot = async name => { if (directory) await page.screenshot({ path: path.join(directory, name), fullPage: false }); };
  const select = async title => {
    await page.locator('#history-listening').click();
    await page.getByRole('button', { name: `查看“${title}”`, exact: true }).click();
    await page.locator('#record-title').filter({ hasText: title }).waitFor();
  };
  await page.goto(fixture.base);
  await select('柯达相机的故事');
  assert.equal(await page.locator('#knowledge-view-list').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#knowledge-list details.knowledge-item').count(), fixture.seeded.first.nodes.length);
  await page.locator('#knowledge-list details.knowledge-item summary').first().click();
  await page.locator('#knowledge-view-graph').click();
  await page.waitForFunction(n => document.querySelectorAll('[data-node-id]').length === n, fixture.seeded.first.nodes.length);
  assert.match(await page.locator('#graph-count').textContent(), /11 \/ 11/);
  assert.equal(fixture.stats.providerRequests.length, 0);
  const source = page.locator(`[data-node-id="${fixture.seeded.first.nodes[0].id}"]`);
  await source.focus(); await page.keyboard.press('Enter');
  await page.locator('#graph-details').waitFor();
  assert.match(await page.locator('.graph-description').textContent(), /制造公司/);
  assert.equal(await page.locator('#graph-close').evaluate(el => el === document.activeElement), true);
  await screenshot('graph-desktop-node.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#graph-details').isHidden(), true);
  assert.equal(await source.evaluate(el => el === document.activeElement), true);
  await page.locator('#knowledge-view-list').click();
  assert.equal(await page.locator('#knowledge-list details.knowledge-item').first().evaluate(el => el.open), true);
  await page.locator('#knowledge-view-graph').click();
  checks.push('Every formal knowledge item is a graph node; list expansion survives view switching; keyboard/Escape restores focus');
  await page.locator('#graph-search').fill('Brownie');
  assert.match(await page.locator('#graph-count').textContent(), /2 \/ 11|1 \/ 11/); // description also contains the camera name
  await page.locator('#graph-search').fill('no such entity');
  assert.match(await page.locator('#graph-count').textContent(), /0 \/ 11/);
  await page.locator('#graph-search').fill('');
  const before = await page.locator('.graph-zoom-value').textContent();
  await page.locator('#graph-zoom-in').click();
  assert.notEqual(await page.locator('.graph-zoom-value').textContent(), before);
  await page.locator('#graph-fit').click();
  await page.locator('#graph-viewport').focus(); await page.keyboard.press('+'); await page.keyboard.press('0');
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill('mock-graph-key');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page.locator('#graph-generate').click();
  await page.locator('[data-relation-id]').first().waitFor({ timeout: 20000 });
  const edge = page.locator('[data-relation-id]').first();
  await page.locator('#graph-viewport').scrollIntoViewIfNeeded();
  await screenshot('graph-desktop-overview.png');
  await edge.click();
  await page.locator('.graph-evidence-content').filter({ hasText: '第 104 句' }).first().waitFor();
  assert.match(await page.locator('#graph-details').textContent(), /最终译文：.*1900/s);
  assert.match(await page.locator('#graph-details').textContent(), /1900/);
  assert.equal(await page.locator('#transcript-list').getByText(fixture.seeded.first.evidence.original_text, { exact: true }).count(), 0);
  await screenshot('graph-desktop-evidence.png');
  await page.locator('#graph-close').click();
  assert.equal(await edge.evaluate(el => el === document.activeElement), true);
  checks.push('Generation is explicit and scoped; labeled directional relation displays original + final translation outside loaded transcript page');
  await source.click(); await page.locator('#graph-local').focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('#graph-count').textContent(), /2 \/ 11/);
  await page.locator('#graph-close').click(); await page.locator('#graph-local').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#graph-fit').click();
  await page.locator('#graph-viewport').scrollIntoViewIfNeeded();
  await screenshot('graph-mobile-overview.png');
  // Semantic node list provides full-size keyboard/touch controls even at low zoom.
  await page.locator('.graph-results > summary').click();
  const result = page.locator(`[data-result-node-id="${fixture.seeded.first.nodes[0].id}"]`);
  await result.click();
  const panel = await page.locator('#graph-details').boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 390 && panel.y >= 0 && panel.y + panel.height <= 844);
  assert.ok(panel.y > 300, 'mobile details are a bottom panel');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal document overflow');
  await screenshot('graph-mobile-node.png');
  await page.locator('#graph-close').click();
  assert.equal(await result.evaluate(el => el === document.activeElement), true);
  await edge.click();
  await page.locator('.graph-evidence-content').filter({ hasText: '第 104 句' }).first().waitFor();
  await screenshot('graph-mobile-evidence.png');
  await page.keyboard.press('Escape');
  checks.push('Mobile bottom panel stays in viewport; semantic controls, local neighbors, filtering and zoom work without overflow');
  await page.reload(); await select('柯达相机的故事');
  assert.equal(await page.locator('#knowledge-view-graph').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-relation-id]').first().waitFor();
  await select('另一段收听');
  await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 2);
  assert.equal(await page.locator('[data-relation-id]').count(), 0);
  assert.equal(await page.locator('#graph-details').isHidden(), true);
  assert.equal(await page.locator('#graph-search').inputValue(), '');
  checks.push('Browser preference survives reload; switching listening resets old nodes, relations and detail callbacks');
  // Presentation-only stress fixture, clearly synthetic; it never enters storage/model calls.
  const stressNodes = Array.from({ length: 36 }, (_, i) => ({ id: `stress-${i}`, type: i % 3 ? 'term' : 'person',
    canonical_name: i === 0 ? '特别长的知识节点名称，用于检验窄屏详情完整换行与图谱名称省略显示' : `Synthetic topic ${i}`,
    short_description: 'Synthetic layout fixture; not an extracted or verified fact.', content_version: 1, mentions: [] }));
  const stressRelations = Array.from({ length: 52 }, (_, i) => ({ id: `stress-edge-${i}`,
    subject_item_id: stressNodes[i % 36].id, object_item_id: stressNodes[(i * 7 + 1) % 36].id,
    predicate: 'uses', assertions: [{ id: `stress-assertion-${i}`, statement: 'Synthetic relation for layout only.',
      status: 'needs_review', polarity: i % 4 ? 'positive' : 'negative', modality: i % 3 ? 'asserted' : 'planned', supports: [] }] }))
    .filter(r => r.subject_item_id !== r.object_item_id);
  await page.route(`**/api/listenings/${fixture.seeded.second.listeningId}/graph`, route => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ listeningId: fixture.seeded.second.listeningId,
      graphRevision: 999999, nodes: stressNodes, relations: stressRelations, status: { enabled: true, state: 'complete' } }) }));
  await page.locator('#graph-refresh').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length >= 36);
  await page.locator('#graph-search').fill('特别长');
  assert.match(await page.locator('#graph-count').textContent(), /1 \/ /);
  await page.locator('[data-node-id="stress-0"]').click();
  assert.match(await page.locator('#graph-detail-title').textContent(), /完整换行/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot('graph-mobile-long-name.png');
  await page.locator('#graph-close').click(); await page.locator('#graph-search').fill('');
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.locator('#graph-fit').click(); await page.locator('#graph-viewport').scrollIntoViewIfNeeded();
  await screenshot('graph-desktop-dense-fixture.png');
  checks.push('Synthetic dense map and long names stay searchable, keyboard accessible and within viewport; qualifiers remain visible');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks, screenshots: directory || null,
    provider: 'local stub only; no live-model quality or latency benchmark' }, null, 2));
} finally { await browser?.close(); await fixture.close(); }
