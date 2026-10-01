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
  const assertGroups = async () => {
    const ready = await page.waitForFunction(() => {
      const connected = [...document.querySelectorAll('[data-node-group="connected"]:not([hidden])')].map(el => el.getBoundingClientRect().bottom);
      const independent = [...document.querySelectorAll('[data-node-group="independent"]:not([hidden])')].map(el => el.getBoundingClientRect().top);
      if (connected.length && independent.length && Math.max(...connected) >= Math.min(...independent)) return false;
      return { connected: connected.length, independent: independent.length, separated: true };
    });
    return ready.jsonValue();
  };
  const assertFullscreenFit = async () => {
    await page.waitForFunction(() => {
      const viewport = document.querySelector('#graph-viewport'), rect = viewport.getBoundingClientRect();
      const nodes = [...document.querySelectorAll('.graph-node:not([hidden])')].map(el => el.getBoundingClientRect());
      if (!nodes.length) return false;
      const left = Math.min(...nodes.map(r => r.left)), right = Math.max(...nodes.map(r => r.right));
      const top = Math.min(...nodes.map(r => r.top)), bottom = Math.max(...nodes.map(r => r.bottom));
      return Math.abs((left + right - rect.left - rect.right) / 2) < 2 && Math.abs((top + bottom - rect.top - rect.bottom) / 2) < 2 &&
        left >= rect.left && right <= rect.right && top >= rect.top && bottom <= rect.bottom &&
        Math.max((right - left) / rect.width, (bottom - top) / rect.height) > .7 &&
        viewport.scrollWidth <= viewport.clientWidth + 1 && viewport.scrollHeight <= viewport.clientHeight + 1;
    });
    await assertGroups();
  };
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
  assert.equal(await page.locator('.graph-zoom-value').count(), 0);
  const before = await page.locator('.graph-world').evaluate(el => el.style.transform);
  await page.locator('#graph-zoom-in').click();
  assert.notEqual(await page.locator('.graph-world').evaluate(el => el.style.transform), before);
  await page.locator('#graph-fit').click();
  await page.locator('#graph-viewport').focus(); await page.keyboard.press('+'); await page.keyboard.press('0');
  const originalView = await page.locator('#graph-viewport').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop, scale: el.querySelector('.graph-world').style.transform }));
  await page.locator('#graph-fullscreen').click();
  assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.open && el.matches(':modal')), true);
  assert.equal(await page.locator('#graph-fullscreen').getAttribute('aria-pressed'), 'true');
  assert.ok((await page.locator('#graph-viewport').boundingBox()).height > 600);
  await assertFullscreenFit();
  assert.ok(await page.locator('.graph-world').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a > 1), 'fullscreen can enlarge a small map beyond the old 100% cap');
  assert.equal(await page.locator('.graph-job-panel').evaluate(el => el.closest('dialog') === null), true);
  await source.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#graph-details').isHidden(), true);
  assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.open), true, 'first Escape closes details');
  await screenshot('graph-desktop-fullscreen.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.open), false);
  assert.equal(await page.locator('#graph-fullscreen').evaluate(el => el === document.activeElement), true);
  assert.deepEqual(await page.locator('#graph-viewport').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop, scale: el.querySelector('.graph-world').style.transform })), originalView);
  assert.equal(await page.evaluate(() => document.body.style.overflow), '');
  checks.push('Fullscreen fills the viewport, traps focus, closes details before Escape exit, and restores zoom/scroll/focus');
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill('mock-graph-key');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page.locator('#graph-generate').click();
  await page.locator('[data-relation-id]').first().waitFor({ timeout: 20000 });
  const edge = page.locator('[data-relation-id]').first();
  const generatedGroups = await assertGroups();
  assert.equal(generatedGroups.connected, 2); assert.equal(generatedGroups.independent, 9);
  assert.match(await page.locator('[data-graph-group="independent"]').textContent(), /独立条目 · 9/);
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
  await page.locator('#graph-fullscreen').click();
  const mobileFull = await page.locator('#graph-fullscreen-dialog').boundingBox();
  assert.equal(mobileFull.width, 390); assert.equal(mobileFull.height, 844);
  assert.ok((await page.locator('#graph-viewport').boundingBox()).height > 450);
  assert.ok(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
  await assertFullscreenFit();
  await screenshot('graph-mobile-fullscreen.png');
  await page.setViewportSize({ width: 844, height: 390 });
  await assertFullscreenFit();
  assert.ok((await page.locator('#graph-viewport').boundingBox()).height > 180);
  await screenshot('graph-mobile-landscape-fullscreen.png');
  const beforeManualZoom = await page.locator('.graph-world').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
  await page.locator('#graph-zoom-in').click();
  await page.waitForFunction(previous => new DOMMatrix(getComputedStyle(document.querySelector('.graph-world')).transform).a > previous, beforeManualZoom);
  const manualScale = await page.locator('.graph-world').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.graph-world').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a), manualScale, 'resizing must preserve manual zoom');
  await page.locator('#graph-fit').click(); await assertFullscreenFit();
  await page.locator('#graph-fullscreen').click();

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
  let releaseSnapshot;
  const delayedSnapshot = new Promise(resolve => { releaseSnapshot = resolve; });
  await page.route(`**/api/listenings/${fixture.seeded.second.listeningId}/graph`, async route => {
    await delayedSnapshot;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ listeningId: fixture.seeded.second.listeningId,
      graphRevision: 999999, nodes: stressNodes, relations: stressRelations, status: { enabled: true, state: 'complete' } }) });
  });
  await page.locator('#graph-refresh').click();
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.locator('#graph-fullscreen').click();
  releaseSnapshot();
  await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length >= 36);
  await assertFullscreenFit();
  await page.locator('#graph-fullscreen').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#graph-search').fill('特别长');
  assert.match(await page.locator('#graph-count').textContent(), /1 \/ /);
  const longName = page.locator('[data-node-id="stress-0"]');
  assert.match(await longName.getAttribute('title'), /完整换行与图谱名称省略显示/);
  assert.equal(await longName.locator('strong').evaluate(el => el.scrollWidth > el.clientWidth), true);
  const compactSize = await longName.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight }));
  assert.deepEqual(compactSize, { width: 156, height: 40 });
  await page.locator('[data-node-id="stress-0"]').click();
  assert.match(await page.locator('#graph-detail-title').textContent(), /完整换行/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot('graph-mobile-long-name.png');
  await page.locator('#graph-close').click(); await page.locator('#graph-search').fill('');
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.locator('#graph-fit').click(); await page.locator('#graph-viewport').scrollIntoViewIfNeeded();
  await page.locator('#graph-relayout').click();
  const nodeCrossings = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.graph-node:not([hidden])')].map(el => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
    let crossings = 0;
    for (const line of document.querySelectorAll('.graph-edges > path')) {
      const total = line.getTotalLength();
      for (let length = 2; length < total - 2; length += 2) {
        const p = line.getPointAtLength(length);
        if (nodes.some(n => p.x > n.x + 1 && p.x < n.x + n.w - 1 && p.y > n.y + 1 && p.y < n.y + n.h - 1)) crossings++;
      }
    }
    return crossings;
  });
  assert.equal(nodeCrossings, 0, 'no edge crosses a node in the dense fixture');
  await screenshot('graph-desktop-dense-fixture.png');
  await page.locator('#graph-fullscreen').click();
  await assertFullscreenFit();
  await screenshot('graph-desktop-dense-fullscreen.png');
  await page.setViewportSize({ width: 2560, height: 1100 });
  await assertFullscreenFit();
  await screenshot('graph-wide-fullscreen.png');
  await page.locator('#graph-fullscreen').click();

  checks.push('Connected and independent groups update automatically; fullscreen content is centered and fits desktop, wide, portrait and landscape viewports, including late snapshots and manual zoom');
  checks.push('Synthetic dense map and long names stay searchable, keyboard accessible and within viewport; qualifiers remain visible');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks, screenshots: directory || null,
    provider: 'local stub only; no live-model quality or latency benchmark' }, null, 2));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    if (directory) await page.screenshot({ path: path.join(directory, 'graph-failure.png') });
    console.error(JSON.stringify(await page.evaluate(() => ({
      viewport: document.querySelector('#graph-viewport')?.getBoundingClientRect().toJSON(),
      world: document.querySelector('.graph-world')?.style.cssText,
      canvas: document.querySelector('.graph-canvas')?.style.cssText,
      nodes: [...document.querySelectorAll('.graph-node:not([hidden])')].map(el => el.getBoundingClientRect().toJSON())
    })), null, 2));
  }
  throw error;
} finally { await browser?.close(); await fixture.close(); }
