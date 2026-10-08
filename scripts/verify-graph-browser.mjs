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
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce', hasTouch: true });
  page.on('pageerror', error => errors.push(error.message));
  const screenshot = async name => { if (directory) await page.screenshot({ path: path.join(directory, name), fullPage: false }); };
  const graph = () => page.locator('#graph-viewport');
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const waitNodes = count => page.waitForFunction(expected => {
    const cy = document.querySelector('#graph-viewport')?._cyreg?.cy;
    return cy && cy.nodes(':visible').length === expected;
  }, count);
  const view = () => graph().evaluate(el => {
    const cy = el._cyreg.cy;
    return { zoom: cy.zoom(), pan: cy.pan(), positions: cy.nodes().map(node => ({ id: node.id(), ...node.position() })).sort((a, b) => a.id.localeCompare(b.id)) };
  });
  // Canvas controls and the accessible controls must exercise the same graph.
  // Open the semantic list with real input rather than making hidden buttons clickable.
  const openList = async selector => {
    const list = page.locator(selector);
    if (!await list.evaluate(el => el.open)) await list.locator(':scope > summary').click();
  };
  const closeLists = async () => {
    for (const selector of ['.graph-results', '.graph-relations']) {
      const list = page.locator(selector);
      if (await list.count() && await list.evaluate(el => el.open)) await list.locator(':scope > summary').click();
    }
  };
  const nodePoint = async id => {
    await graph().scrollIntoViewIfNeeded();
    return graph().evaluate((el, nodeId) => {
      const point = el._cyreg.cy.getElementById(nodeId).renderedPosition(), rect = el.getBoundingClientRect();
      return { x: rect.x + el.clientLeft + point.x, y: rect.y + el.clientTop + point.y };
    }, id);
  };
  const backgroundPoint = async () => {
    await graph().scrollIntoViewIfNeeded();
    return graph().evaluate(el => {
      const cy = el._cyreg.cy, rect = el.getBoundingClientRect();
      const boxes = cy.nodes(':visible').map(node => node.renderedBoundingBox({ includeLabels: true, includeOverlays: false }));
      const candidates = [{ x: 8, y: 8 }, { x: rect.width - 8, y: 8 }, { x: 8, y: rect.height - 8 }, { x: rect.width - 8, y: rect.height - 8 }];
      const point = candidates.find(p => boxes.every(b => p.x < b.x1 - 4 || p.x > b.x2 + 4 || p.y < b.y1 - 4 || p.y > b.y2 + 4));
      if (!point) throw new Error('No background input target outside rendered node bounds');
      return { x: rect.x + point.x, y: rect.y + point.y, dx: point.x > rect.width / 2 ? -64 : 64, dy: point.y > rect.height / 2 ? -42 : 42 };
    });
  };
  const assertGroups = async () => {
    const ready = await page.waitForFunction(() => {
      const cy = document.querySelector('#graph-viewport')?._cyreg?.cy;
      if (!cy) return false;
      const connected = cy.nodes(':visible').filter(node => node.data('group') === 'connected');
      const independent = cy.nodes(':visible').filter(node => node.data('group') === 'independent');
      const bounds = { includeLabels: true, includeOverlays: false };
      if (connected.length && independent.length && connected.boundingBox(bounds).y2 >= independent.boundingBox(bounds).y1) return false;
      return { connected: connected.length, independent: independent.length, separated: true };
    });
    return ready.jsonValue();
  };
  const assertFullscreenFit = async () => {
    await page.waitForFunction(() => {
      const viewport = document.querySelector('#graph-viewport'), cy = viewport?._cyreg?.cy;
      if (!cy || !cy.nodes(':visible').length) return false;
      const bounds = cy.elements(':visible').renderedBoundingBox({ includeLabels: true, includeOverlays: false });
      const width = cy.width(), height = cy.height();
      return Math.abs((bounds.x1 + bounds.x2 - width) / 2) < 2 && Math.abs((bounds.y1 + bounds.y2 - height) / 2) < 2 &&
        bounds.x1 >= -1 && bounds.x2 <= width + 1 && bounds.y1 >= -1 && bounds.y2 <= height + 1 &&
        Math.max(bounds.w / width, bounds.h / height) > .7 &&
        viewport.scrollWidth <= viewport.clientWidth + 1 && viewport.scrollHeight <= viewport.clientHeight + 1;
    });
    await assertGroups();
  };
  const assertNeighborFocus = async id => {
    const focus = await graph().evaluate((el, nodeId) => {
      const cy = el._cyreg.cy, node = cy.getElementById(nodeId);
      const neighbors = node.neighborhood('node').filter(':visible');
      const related = node.closedNeighborhood().filter(':visible');
      return { selected: node.hasClass('selected'), neighborCount: neighbors.length,
        allNeighborsEmphasized: neighbors.every(n => n.hasClass('neighbor') && !n.hasClass('faded')),
        unrelatedFaded: cy.elements(':visible').difference(related).every(item => item.hasClass('faded')),
        relatedVisible: related.every(item => !item.hasClass('faded')) };
    }, id);
    assert.equal(focus.selected, true);
    assert.equal(focus.neighborCount, 1);
    assert.equal(focus.allNeighborsEmphasized, true);
    assert.equal(focus.unrelatedFaded, true);
    assert.equal(focus.relatedVisible, true);
  };
  const assertCompactLabel = async (item, expectedType) => {
    await settle();
    const compact = await graph().evaluate((el, id) => {
      const node = el._cyreg.cy.getElementById(id), options = { includeOverlays: false };
      return { label: node.data('label'), displayLabel: node.data('displayLabel'), type: node.data('typeLabel'),
        width: node.width(), height: node.height(), position: node.position(),
        body: node.boundingBox({ ...options, includeLabels: false }),
        combined: node.boundingBox({ ...options, includeLabels: true }),
        labelBounds: node.boundingBox({ ...options, includeNodes: false, includeEdges: false, includeLabels: true }) };
    }, item.id);
    assert.equal(compact.label, item.canonical_name, `${item.id} retains its full canonical name`);
    assert.equal(compact.type, expectedType);
    assert.deepEqual({ width: compact.width, height: compact.height }, { width: 164, height: 56 });
    assert.equal(compact.displayLabel.split('\n')[1], expectedType);
    assert.ok(compact.displayLabel.split('\n')[0].endsWith('…'));
    assert.ok([...compact.displayLabel.split('\n')[0]].length <= 20, 'long canvas labels stay compact');
    const label = compact.labelBounds, body = compact.body, combined = compact.combined;
    assert.ok(label.w > 0 && label.h > 0, `${item.id} has nonempty rendered label bounds`);
    assert.ok(label.x1 >= compact.position.x - 82 - 2 && label.x2 <= compact.position.x + 82 + 2 &&
      label.y1 >= compact.position.y - 28 - 2 && label.y2 <= compact.position.y + 28 + 2,
    `${item.id} rendered label must stay within its 164×56 model-space node: ${JSON.stringify(label)}`);
    assert.ok(combined.x1 >= body.x1 - 2 && combined.x2 <= body.x2 + 2 && combined.y1 >= body.y1 - 2 && combined.y2 <= body.y2 + 2,
      `${item.id} label cannot extend outside its rendered node body`);
  };
  const select = async title => {
    await page.locator('#history-listening').click();
    await page.getByRole('button', { name: `查看“${title}”`, exact: true }).click();
    await page.locator('#record-title').filter({ hasText: title }).waitFor();
  };
  await page.goto(fixture.base);
  // Hold the real detail request: navigation must paint before any response arrives.
  const detailUrl = new RegExp(`/api/listenings/${fixture.seeded.first.listeningId}\\?page=1$`);
  let releaseDetail, detailReads = 0, graphReads = 0;
  const heldDetail = new Promise(resolve => { releaseDetail = resolve; });
  const countGraph = request => { if (new URL(request.url()).pathname.endsWith('/graph')) graphReads++; };
  page.on('request', countGraph);
  await page.route(detailUrl, async route => { detailReads++; await heldDetail; await route.continue(); });
  await page.locator('#history-listening').click();
  await page.getByRole('button', { name: '查看“柯达相机的故事”', exact: true }).click();
  await page.locator('#record-loading').waitFor({ state: 'visible', timeout: 1500 });
  assert.equal(await page.locator('#history-view').isHidden(), true);
  assert.equal(await page.locator('#record-loading-title').textContent(), '柯达相机的故事');
  assert.equal(await page.locator('#live-panel').isHidden(), true);
  assert.equal(await page.locator('#record-panel').isHidden(), true);
  assert.equal(await page.locator('#pinned-caption').isHidden(), true);
  await screenshot('history-loading-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot('history-loading-mobile.png');
  assert.equal(graphReads, 0, 'Graph must not compete with the initial detail download');
  releaseDetail();
  await page.locator('#record-title').filter({ hasText: '柯达相机的故事' }).waitFor();
  await page.locator('#record-loading').waitFor({ state: 'hidden' });
  await page.waitForTimeout(250);
  assert.equal(detailReads, 1, 'Completed history must not immediately download the same detail again');
  await page.unroute(detailUrl);
  page.off('request', countGraph);
  await page.setViewportSize({ width: 1360, height: 1000 });

  const retryUrl = new RegExp(`/api/listenings/${fixture.seeded.second.listeningId}\\?page=1$`);
  let attempts = 0;
  await page.route(retryUrl, route => ++attempts === 1
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法读取，请重试' }) })
    : route.continue());
  await page.locator('#history-listening').click();
  await page.getByRole('button', { name: '查看“另一段收听”', exact: true }).click();
  await page.locator('#record-loading-retry').waitFor({ state: 'visible' });
  assert.match(await page.locator('#record-loading-status').textContent(), /暂时无法读取/);
  assert.equal(await page.locator('#record-panel').isHidden(), true);
  await page.locator('#record-loading-retry').click();
  await page.locator('#record-title').filter({ hasText: '另一段收听' }).waitFor();
  assert.equal(attempts, 2);
  await page.unroute(retryUrl);
  checks.push('History opens before a held network response, defers graph reads, avoids duplicate completed-detail fetches, and retries visibly on failure; desktop/mobile loading fits');
  await select('柯达相机的故事');
  assert.equal(await page.locator('#knowledge-view-list').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#knowledge-list details.knowledge-item').count(), fixture.seeded.first.nodes.length);
  await page.locator('#knowledge-list details.knowledge-item summary').first().click();
  await page.locator('#knowledge-view-graph').click();
  await waitNodes(fixture.seeded.first.nodes.length);
  assert.ok(await graph().locator('canvas').count() > 0, 'Cytoscape paints the graph on canvas');
  assert.match(await page.locator('#graph-count').textContent(), /11 \/ 11/);
  assert.equal(fixture.stats.providerRequests.length, 0);
  const source = page.locator(`[data-result-node-id="${fixture.seeded.first.nodes[0].id}"]`);
  await openList('.graph-results');
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
  await waitNodes(0);
  assert.equal(await page.locator('.graph-empty').isVisible(), true);
  assert.match(await page.locator('.graph-empty').textContent(), /没有符合筛选/);
  await page.locator('#graph-search').fill('');
  await page.locator('#graph-type').selectOption({ label: '人物' });
  await waitNodes(fixture.seeded.first.nodes.filter(node => node.type === 'person').length);
  assert.equal(await graph().evaluate(el => el._cyreg.cy.nodes(':visible').every(node => node.data('typeLabel') === '人物')), true);
  await page.locator('#graph-type').selectOption('');
  await waitNodes(fixture.seeded.first.nodes.length);
  await closeLists();
  assert.equal(await page.locator('.graph-zoom-value').count(), 0);
  const before = (await view()).zoom;
  await page.locator('#graph-zoom-in').click();
  assert.ok((await view()).zoom > before);
  await page.locator('#graph-fit').click();
  await page.locator('#graph-viewport').focus(); await page.keyboard.press('+'); await page.keyboard.press('0');
  const originalView = await view();
  await page.locator('#graph-fullscreen').click();
  assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.open && el.matches(':modal')), true);
  assert.equal(await page.locator('#graph-fullscreen').getAttribute('aria-pressed'), 'true');
  assert.ok((await page.locator('#graph-viewport').boundingBox()).height > 600);
  await assertFullscreenFit();
  assert.ok((await view()).zoom > 1, 'fullscreen can enlarge a small map beyond the old 100% cap');
  assert.equal(await page.locator('.graph-job-panel').evaluate(el => el.closest('dialog') === null), true);
  await page.locator('#graph-fullscreen').focus();
  for (let tab = 0; tab < 14; tab++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.contains(document.activeElement)), true, 'fullscreen keeps keyboard focus inside its dialog');
  }
  await openList('.graph-results');
  await source.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await closeLists();
  assert.equal(await page.locator('#graph-details').isHidden(), true);
  assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.open), true, 'first Escape closes details');
  await assertFullscreenFit();
  await screenshot('graph-desktop-fullscreen.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.open), false);
  assert.equal(await page.locator('#graph-fullscreen').evaluate(el => el === document.activeElement), true);
  await settle();
  assert.deepEqual(await view(), originalView);
  assert.equal(await page.evaluate(() => document.body.style.overflow), '');
  checks.push('Fullscreen fills the viewport, traps focus, closes details before Escape exit, and restores positions/zoom/pan/focus');
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('tab', { name: '连接设置', exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill('mock-graph-key');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await page.locator('#graph-generate').click();
  await page.locator('[data-relation-id]').first().waitFor({ state: 'attached', timeout: 20000 });
  const edge = page.locator('[data-relation-id]').first();
  const generatedGroups = await assertGroups();
  assert.equal(generatedGroups.connected, 2); assert.equal(generatedGroups.independent, 9);
  assert.match(await page.locator('[data-graph-group="independent"]').textContent(), /独立条目 · 9/);
  await page.locator('#graph-viewport').scrollIntoViewIfNeeded();
  await screenshot('graph-desktop-overview.png');
  await openList('.graph-relations');
  await edge.click();
  await page.locator('.graph-evidence-content').filter({ hasText: '第 104 句' }).first().waitFor();
  assert.match(await page.locator('#graph-details').textContent(), /最终译文：.*1900/s);
  assert.match(await page.locator('#graph-details').textContent(), /1900/);
  assert.equal(await page.locator('#transcript-list').getByText(fixture.seeded.first.evidence.original_text, { exact: true }).count(), 0);
  await screenshot('graph-desktop-evidence.png');
  await page.locator('#graph-close').click();
  assert.equal(await edge.evaluate(el => el === document.activeElement), true);
  checks.push('Generation is explicit and scoped; labeled directional relation displays original + final translation outside loaded transcript page');
  await openList('.graph-results');
  await source.click();
  await assertNeighborFocus(fixture.seeded.first.nodes[0].id);
  await page.locator('#graph-local').focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('#graph-count').textContent(), /2 \/ 11/);
  await page.locator('#graph-close').click(); await page.locator('#graph-local').click();
  await closeLists();
  await page.locator('#graph-fit').click();

  const canvasRelation = await graph().evaluate(el => {
    const cy = el._cyreg.cy, edge = cy.edges(':visible').first(), p = edge.renderedMidpoint(), rect = el.getBoundingClientRect();
    return { x: rect.x + el.clientLeft + p.x, y: rect.y + el.clientTop + p.y, id: edge.id(),
      relationId: edge.data('relationId'), label: edge.data('label'), arrow: edge.style('target-arrow-shape') };
  });
  assert.equal(canvasRelation.id, `relation:${canvasRelation.relationId}`);
  assert.equal(canvasRelation.arrow, 'triangle');
  assert.match(canvasRelation.label, /时间限定.*推出/);
  await graph().scrollIntoViewIfNeeded();
  // scrollIntoView can change screen coordinates, so read them again before input.
  const relationPoint = await graph().evaluate((el, id) => {
    const p = el._cyreg.cy.getElementById(id).renderedMidpoint(), rect = el.getBoundingClientRect();
    return { x: rect.x + el.clientLeft + p.x, y: rect.y + el.clientTop + p.y };
  }, canvasRelation.id);
  await page.mouse.click(relationPoint.x, relationPoint.y);
  await page.locator('.graph-evidence-content').filter({ hasText: '第 104 句' }).first().waitFor();
  assert.equal(await graph().evaluate((el, id) => el._cyreg.cy.getElementById(id).hasClass('selected'), canvasRelation.id), true);
  await page.locator('#graph-close').click();

  // Drive the actual canvas with pointer input, never cy.emit()/position()/pan().
  const firstId = fixture.seeded.first.nodes[0].id;
  let point = await nodePoint(firstId);
  await page.mouse.click(point.x, point.y);
  await page.locator('#graph-details').waitFor();
  assert.equal(await page.locator('#graph-detail-title').textContent(), fixture.seeded.first.nodes[0].canonical_name);
  await assertNeighborFocus(firstId);
  await page.locator('#graph-close').click();
  assert.equal(await graph().evaluate(el => el._cyreg.cy.elements('.faded').length), 0, 'closing details clears focus dimming');
  const beforeDrag = await view();
  point = await nodePoint(firstId);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 56, point.y + 10, { steps: 12 }); await page.mouse.up();
  await settle();
  const afterDrag = await view(), originalNode = beforeDrag.positions.find(node => node.id === firstId), movedNode = afterDrag.positions.find(node => node.id === firstId);
  assert.ok(Math.abs((movedNode.x - originalNode.x) * beforeDrag.zoom - 56) < 4, 'drag changes the grabbed node position in model coordinates');
  assert.ok(Math.abs((movedNode.y - originalNode.y) * beforeDrag.zoom - 10) < 4);
  assert.deepEqual(afterDrag.pan, beforeDrag.pan, 'node drag does not pan the graph');
  assert.deepEqual(afterDrag.positions.filter(node => node.id !== firstId), beforeDrag.positions.filter(node => node.id !== firstId), 'node drag leaves other positions alone');
  assert.equal(await page.locator('#graph-details').isHidden(), true, 'dragging does not accidentally open node details');
  const background = await backgroundPoint(), beforePan = await view();
  await page.mouse.move(background.x, background.y); await page.mouse.down();
  await page.mouse.move(background.x + background.dx, background.y + background.dy, { steps: 12 }); await page.mouse.up();
  await settle();
  const afterPan = await view();
  assert.ok(Math.abs(afterPan.pan.x - beforePan.pan.x - background.dx) < 4, 'background drag pans horizontally');
  assert.ok(Math.abs(afterPan.pan.y - beforePan.pan.y - background.dy) < 4, 'background drag pans vertically');
  assert.deepEqual(afterPan.positions, beforePan.positions, 'background pan leaves model positions unchanged');
  const viewportBox = await graph().boundingBox(), beforeWheel = (await view()).zoom;
  await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + viewportBox.height / 2);
  await page.mouse.wheel(0, -180);
  await page.waitForFunction(previous => document.querySelector('#graph-viewport')._cyreg.cy.zoom() > previous * 1.05, beforeWheel);
  // Cytoscape intentionally coalesces wheel events for a short interval.
  await page.waitForTimeout(200);
  assert.deepEqual((await view()).positions, beforePan.positions, 'wheel zoom leaves model positions unchanged');

  const graphUrl = `${fixture.base}/api/listenings/${fixture.seeded.first.listeningId}/graph`;
  const savedSnapshotResponse = await page.request.get(graphUrl);
  assert.equal(savedSnapshotResponse.ok(), true);
  const metadataSnapshot = await savedSnapshotResponse.json();
  metadataSnapshot.graphRevision++;
  metadataSnapshot.status.usageLastHour = { requests: 3, measuredRequests: 3, totalTokens: 234, inputTokens: 123, outputTokens: 111 };
  await page.route(graphUrl, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(metadataSnapshot) }), { times: 1 });
  const beforeMetadata = await view();
  await page.locator('#graph-refresh').click();
  await page.waitForFunction(() => document.querySelector('#graph-usage').textContent.includes('234 tokens'));
  await settle();
  assert.deepEqual(await view(), beforeMetadata, 'metadata-only snapshots preserve dragged positions and the manual viewport exactly');
  checks.push('Canvas node click focuses direct neighbors; real node drag, background pan and wheel zoom work; metadata-only refresh preserves positions and viewport');

  // Repeated open/close must not lose handlers, focus, or the saved viewport.
  await page.locator('#graph-fit').click();
  for (let cycle = 0; cycle < 2; cycle++) {
    const saved = await view();
    await page.locator('#graph-fullscreen').click();
    await assertFullscreenFit();
    point = await nodePoint(firstId);
    await page.mouse.click(point.x, point.y);
    await page.locator('#graph-details').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#graph-details').isHidden(), true);
    assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.open), true);
    if (cycle === 0) {
      const tappedView = await view();
      await page.setViewportSize({ width: 1180, height: 880 });
      await assertFullscreenFit();
      const resizedView = await view();
      assert.notDeepEqual({ zoom: resizedView.zoom, pan: resizedView.pan }, { zoom: tappedView.zoom, pan: tappedView.pan }, 'a node tap leaves auto-fit active for a subsequent fullscreen resize');
      await page.setViewportSize({ width: 1360, height: 1000 });
      await assertFullscreenFit();
    } else {
      const beforeFullscreenDrag = await view();
      point = await nodePoint(firstId);
      await page.mouse.move(point.x, point.y); await page.mouse.down();
      await page.mouse.move(point.x + 48, point.y + 12, { steps: 12 }); await page.mouse.up();
      await settle();
      const manualView = await view();
      assert.notDeepEqual(manualView.positions, beforeFullscreenDrag.positions, 'the fullscreen node really moved');
      await page.setViewportSize({ width: 1180, height: 880 }); await settle();
      assert.deepEqual(await view(), manualView, 'actual node dragging preserves the manual viewport and positions across resize');
      await page.setViewportSize({ width: 1360, height: 1000 }); await settle();
      assert.deepEqual(await view(), manualView);
    }
    await page.keyboard.press('Escape');
    await settle();
    assert.deepEqual(await view(), saved);
    assert.equal(await page.locator('#graph-fullscreen').evaluate(el => el === document.activeElement), true);
  }
  checks.push('Repeated fullscreen and canvas-detail open/close preserve handlers, saved viewport and keyboard focus');
  checks.push('Node tapping retains fullscreen resize auto-fit; actual dragging opts into a stable manual viewport');
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
  // CDP dispatches genuine multi-touch input to Chromium and Cytoscape's gesture handlers.
  const touch = await page.context().newCDPSession(page);
  const touchPoint = (x, y, id) => ({ x, y, id, radiusX: 2, radiusY: 2, force: 1 });
  const touchViewport = await graph().boundingBox(), center = { x: touchViewport.x + touchViewport.width / 2, y: touchViewport.y + touchViewport.height / 2 };
  const beforePinch = await view();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(center.x - 32, center.y, 1), touchPoint(center.x + 32, center.y, 2)] });
  for (let step = 1; step <= 8; step++) {
    const spread = 32 + step * 5;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(center.x - spread, center.y, 1), touchPoint(center.x + spread, center.y, 2)] });
    await page.waitForTimeout(16);
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settle();
  const afterPinch = await view();
  assert.ok(afterPinch.zoom > beforePinch.zoom * 1.25, 'two-finger pinch zooms the graph');
  assert.deepEqual(afterPinch.positions, beforePinch.positions, 'pinch does not move individual nodes');
  assert.equal(await page.evaluate(() => window.visualViewport.scale), 1, 'pinch is handled by the graph, not page magnification');
  const touchBackground = await backgroundPoint(), beforeTouchPan = await view();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(touchBackground.x, touchBackground.y, 1)] });
  for (let step = 1; step <= 8; step++) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(touchBackground.x + touchBackground.dx * step / 8, touchBackground.y + touchBackground.dy * step / 8, 1)] });
    await page.waitForTimeout(16);
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settle();
  const afterTouchPan = await view();
  assert.ok((afterTouchPan.pan.x - beforeTouchPan.pan.x) * Math.sign(touchBackground.dx) > 30, 'one-finger background drag pans horizontally');
  assert.ok((afterTouchPan.pan.y - beforeTouchPan.pan.y) * Math.sign(touchBackground.dy) > 20, 'one-finger background drag pans vertically');
  assert.equal(afterTouchPan.zoom, beforeTouchPan.zoom);
  assert.deepEqual(afterTouchPan.positions, beforeTouchPan.positions);
  await touch.detach();
  await page.locator('#graph-fit').click(); await assertFullscreenFit();
  checks.push('Mobile Chromium multi-touch pinch and single-finger background pan change the canvas viewport without changing nodes or magnifying the page');
  await page.setViewportSize({ width: 844, height: 390 });
  await assertFullscreenFit();
  assert.ok((await page.locator('#graph-viewport').boundingBox()).height > 180);
  await screenshot('graph-mobile-landscape-fullscreen.png');
  const beforeManualZoom = (await view()).zoom;
  await page.locator('#graph-zoom-in').click();
  await page.waitForFunction(previous => document.querySelector('#graph-viewport')._cyreg.cy.zoom() > previous, beforeManualZoom);
  const manualScale = (await view()).zoom;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await view()).zoom, manualScale, 'resizing must preserve manual zoom');
  await page.locator('#graph-fit').click(); await assertFullscreenFit();
  await page.locator('#graph-fullscreen').click();

  // Semantic node list provides full-size keyboard/touch controls even at low zoom.
  await openList('.graph-results');
  const result = page.locator(`[data-result-node-id="${fixture.seeded.first.nodes[0].id}"]`);
  await result.click();
  const panel = await page.locator('#graph-details').boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 390 && panel.y >= 0 && panel.y + panel.height <= 844);
  assert.ok(panel.y > 300, 'mobile details are a bottom panel');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal document overflow');
  await screenshot('graph-mobile-node.png');
  await page.locator('#graph-close').click();
  assert.equal(await result.evaluate(el => el === document.activeElement), true);
  await openList('.graph-relations');
  await edge.click();
  await page.locator('.graph-evidence-content').filter({ hasText: '第 104 句' }).first().waitFor();
  await screenshot('graph-mobile-evidence.png');
  await page.keyboard.press('Escape');
  checks.push('Mobile bottom panel stays in viewport; semantic controls, local neighbors, filtering and zoom work without overflow');
  await page.reload(); await select('柯达相机的故事');
  assert.equal(await page.locator('#knowledge-view-graph').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-relation-id]').first().waitFor({ state: 'attached' });
  await select('另一段收听');
  await waitNodes(2);
  assert.equal(await page.locator('[data-relation-id]').count(), 0);
  assert.equal(await page.locator('#graph-details').isHidden(), true);
  assert.equal(await page.locator('#graph-search').inputValue(), '');
  checks.push('Browser preference survives reload; switching listening resets old nodes, relations and detail callbacks');

  // Keep the original IDs and insert a lexically earlier node while fullscreen.
  // Restoring only the old coordinates would place this new node on an old one.
  const liveAddedNode = { id: '000-live-arrival', type: 'term', canonical_name: 'Synthetic newly arrived knowledge',
    short_description: 'Synthetic live-arrival fixture; not an extracted or verified fact.', content_version: 1, mentions: [] };
  const liveNodes = [...fixture.seeded.second.nodes, liveAddedNode];
  const liveSnapshot = { listeningId: fixture.seeded.second.listeningId, graphRevision: 500000,
    nodes: liveNodes, relations: [], status: { enabled: true, state: 'complete' } };
  let releaseLiveSnapshot;
  const heldLiveSnapshot = new Promise(resolve => { releaseLiveSnapshot = resolve; });
  const secondGraphPattern = `**/api/listenings/${fixture.seeded.second.listeningId}/graph`;
  const liveSnapshotRoute = async route => {
    await heldLiveSnapshot;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(liveSnapshot) });
  };
  await page.route(secondGraphPattern, liveSnapshotRoute);
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.locator('#graph-fit').click(); await settle();
  assert.deepEqual((await view()).positions.map(node => node.id).sort(), fixture.seeded.second.nodes.map(node => node.id).sort());
  await page.locator('#graph-refresh').click();
  await page.locator('#graph-fullscreen').click();
  assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.open), true);
  releaseLiveSnapshot();
  await waitNodes(liveNodes.length);
  await page.locator('#graph-fullscreen').click();
  await settle();
  const arrived = await graph().evaluate(el => {
    const cy = el._cyreg.cy, nodes = cy.nodes(':visible');
    const boxes = nodes.map(node => node.renderedBoundingBox({ includeLabels: true, includeOverlays: false }));
    const bounds = nodes.renderedBoundingBox({ includeLabels: true, includeOverlays: false });
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (Math.min(a.x2, b.x2) > Math.max(a.x1, b.x1) && Math.min(a.y2, b.y2) > Math.max(a.y1, b.y1)) overlaps++;
    }
    return { ids: nodes.map(node => node.id()).sort(), overlaps,
      fits: boxes.every(b => b.x1 >= -1 && b.x2 <= cy.width() + 1 && b.y1 >= -1 && b.y2 <= cy.height() + 1),
      centered: Math.abs((bounds.x1 + bounds.x2 - cy.width()) / 2) < 2 && Math.abs((bounds.y1 + bounds.y2 - cy.height()) / 2) < 2 };
  });
  assert.deepEqual(arrived.ids, liveNodes.map(node => node.id).sort(), 'fullscreen live arrival retains every original node and the new node');
  assert.equal(arrived.overlaps, 0, 'fullscreen exit must not partially restore old coordinates on top of a newly arrived node');
  assert.equal(arrived.fits, true, 'all live-arrival nodes fit in the restored inline viewport');
  assert.equal(arrived.centered, true);
  await graph().scrollIntoViewIfNeeded(); await screenshot('graph-live-arrival-inline.png');
  checks.push('A new node arriving during fullscreen preserves old IDs and exits into a fitted, non-overlapping inline layout');

  // Presentation-only stress fixture, clearly synthetic; it never enters storage/model calls.
  const stressNodes = Array.from({ length: 36 }, (_, i) => ({ id: `stress-${i}`, type: i % 3 ? 'term' : 'person',
    canonical_name: i === 0 ? '特别长的知识节点名称，用于检验窄屏详情完整换行与图谱名称省略显示' :
      i === 1 ? 'WWWWWWWWWWWWWWWWWWWWWithoutSpacesKnowledgeIdentifier' : `Synthetic topic ${i}`,
    short_description: 'Synthetic layout fixture; not an extracted or verified fact.', content_version: 1, mentions: [] }));
  const stressRelations = Array.from({ length: 52 }, (_, i) => ({ id: `stress-edge-${i}`,
    subject_item_id: stressNodes[i % 36].id, object_item_id: stressNodes[(i * 7 + 1) % 36].id,
    predicate: 'uses', assertions: [{ id: `stress-assertion-${i}`, statement: 'Synthetic relation for layout only.',
      status: 'needs_review', polarity: i % 4 ? 'positive' : 'negative', modality: i % 3 ? 'asserted' : 'planned', supports: [] }] }))
    .filter(r => r.subject_item_id !== r.object_item_id);
  let stressSnapshot = { listeningId: fixture.seeded.second.listeningId, graphRevision: 999999,
    nodes: stressNodes, relations: stressRelations, deletedItemIds: liveNodes.map(node => node.id), status: { enabled: true, state: 'complete' } };
  let releaseSnapshot;
  const delayedSnapshot = new Promise(resolve => { releaseSnapshot = resolve; });
  await page.route(secondGraphPattern, async route => {
    await delayedSnapshot;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stressSnapshot) });
  });
  await page.unroute(secondGraphPattern, liveSnapshotRoute);
  await page.locator('#graph-refresh').click();
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.locator('#graph-fullscreen').click();
  releaseSnapshot();
  await waitNodes(36);
  await assertFullscreenFit();
  await page.locator('#graph-fullscreen').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#graph-search').fill('特别长');
  assert.match(await page.locator('#graph-count').textContent(), /1 \/ /);
  const longName = page.locator('[data-result-node-id="stress-0"]');
  await openList('.graph-results');
  assert.match(await longName.textContent(), /完整换行与图谱名称省略显示/);
  await assertCompactLabel(stressNodes[0], '人物');
  await longName.click();
  assert.match(await page.locator('#graph-detail-title').textContent(), /完整换行/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot('graph-mobile-long-name.png');
  await page.locator('#graph-close').click();
  await page.locator('#graph-search').fill('WithoutSpacesKnowledgeIdentifier');
  await waitNodes(1);
  await assertCompactLabel(stressNodes[1], '术语');
  const latinName = page.locator('[data-result-node-id="stress-1"]');
  assert.equal(await latinName.isVisible(), true);
  await latinName.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#graph-detail-title').textContent(), stressNodes[1].canonical_name);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot('graph-mobile-unbroken-latin-name.png');
  await page.keyboard.press('Escape'); await page.locator('#graph-search').fill('');
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.locator('#graph-fit').click(); await page.locator('#graph-viewport').scrollIntoViewIfNeeded();
  await page.locator('#graph-relayout').click();
  await closeLists();
  await settle();
  const dense = await graph().evaluate(el => {
    const cy = el._cyreg.cy, nodes = cy.nodes(':visible');
    const boxes = nodes.map(node => ({ id: node.id(), ...node.boundingBox({ includeLabels: false, includeOverlays: false }) }));
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (Math.min(a.x2, b.x2) > Math.max(a.x1, b.x1) && Math.min(a.y2, b.y2) > Math.max(a.y1, b.y1)) overlaps++;
    }
    return { nodeCount: nodes.length, edgeCount: cy.edges(':visible').length, overlaps,
      finiteNodes: nodes.every(node => Number.isFinite(node.position('x')) && Number.isFinite(node.position('y'))),
      finiteRoutes: cy.edges(':visible').every(edge => {
        const source = edge.sourceEndpoint(), target = edge.targetEndpoint(), midpoint = edge.midpoint();
        return [source, target, midpoint].every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y)) && Math.hypot(source.x - target.x, source.y - target.y) > 1;
      }), labels: cy.edges(':visible').map(edge => edge.data('label')) };
  });
  assert.equal(dense.nodeCount, stressNodes.length);
  assert.equal(dense.edgeCount, stressRelations.length);
  assert.equal(dense.overlaps, 0, 'dense canvas nodes cannot overlap');
  assert.equal(dense.finiteNodes, true);
  assert.equal(dense.finiteRoutes, true, 'every dense relation has a finite non-degenerate canvas route');
  for (const qualifier of ['否定', '计划', '待核对']) assert.ok(dense.labels.some(label => label.includes(qualifier)), `${qualifier} remains on rendered relation labels`);
  await screenshot('graph-desktop-dense-fixture.png');
  await openList('.graph-relations');
  await page.locator('[data-relation-id="stress-edge-0"]').click();
  const focusedRelation = await graph().evaluate(el => {
    const edge = el._cyreg.cy.getElementById('relation:stress-edge-0');
    return { selected: edge.hasClass('selected'), label: edge.data('label'), textOpacity: edge.style('text-opacity') };
  });
  assert.equal(focusedRelation.selected, true);
  assert.equal(Number(focusedRelation.textOpacity), 1, 'focused dense-map relation labels remain visible');
  for (const qualifier of ['否定', '计划', '待核对']) assert.ok(focusedRelation.label.includes(qualifier));
  assert.match(await page.locator('#graph-details').textContent(), /否定.*计划.*待核对/s);
  await screenshot('graph-desktop-dense-relation.png');
  await page.locator('#graph-close').click(); await closeLists();
  await page.locator('#graph-fullscreen').click();
  await assertFullscreenFit();
  await screenshot('graph-desktop-dense-fullscreen.png');
  await page.setViewportSize({ width: 2560, height: 1100 });
  await assertFullscreenFit();
  await screenshot('graph-wide-fullscreen.png');
  await page.locator('#graph-fullscreen').click();

  const providerCallsBeforeEmpty = fixture.stats.providerRequests.length;
  stressSnapshot = { ...stressSnapshot, graphRevision: 1000000, nodes: [], relations: [],
    deletedItemIds: [...liveNodes, ...stressNodes].map(node => node.id), status: { enabled: true, state: 'empty' } };
  await page.locator('#graph-refresh').click();
  await waitNodes(0);
  assert.match(await page.locator('#graph-count').textContent(), /0 \/ 0/);
  assert.equal(await page.locator('.graph-empty').isVisible(), true);
  assert.match(await page.locator('.graph-empty').textContent(), /尚无知识条目/);
  assert.equal(await page.locator('[data-result-node-id]').count(), 0);
  assert.equal(await page.locator('[data-relation-id]').count(), 0);
  assert.equal(await graph().evaluate(el => el._cyreg.cy.elements().length), 0);
  await page.locator('#graph-fit').click();
  await page.locator('#graph-fullscreen').click();
  assert.equal(await page.locator('.graph-empty').isVisible(), true);
  assert.equal(await graph().evaluate(el => Number.isFinite(el._cyreg.cy.zoom()) && Object.values(el._cyreg.cy.pan()).every(Number.isFinite)), true);
  await screenshot('graph-empty-fullscreen.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#graph-fullscreen-dialog').evaluate(el => el.open), false);
  assert.equal(fixture.stats.providerRequests.length, providerCallsBeforeEmpty, 'empty-state refresh and viewport controls make no model calls');

  checks.push('Connected and independent groups update automatically; fullscreen content is centered and fits desktop, wide, portrait and landscape viewports, including late snapshots and manual zoom');
  checks.push('Synthetic dense map and long names stay searchable, keyboard accessible and within viewport; qualifiers remain visible');
  checks.push('Search/type filters retain semantic and canvas parity; filtered-empty and no-data states remain usable, including fullscreen');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks, screenshots: directory || null,
    provider: 'local stub only; no live-model quality or latency benchmark' }, null, 2));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    if (directory) await page.screenshot({ path: path.join(directory, 'graph-failure.png') });
    console.error(JSON.stringify(await page.evaluate(() => {
      const viewport = document.querySelector('#graph-viewport'), cy = viewport?._cyreg?.cy;
      return { viewport: viewport?.getBoundingClientRect().toJSON(), fullscreen: document.querySelector('#graph-fullscreen-dialog')?.open,
        zoom: cy?.zoom(), pan: cy?.pan(), bounds: cy?.elements(':visible').renderedBoundingBox({ includeLabels: true, includeOverlays: false }),
        nodes: cy?.nodes().map(node => ({ id: node.id(), group: node.data('group'), visible: node.visible(), position: node.position(), classes: node.classes() })) };
    }), null, 2));
  }
  throw error;
} finally { await browser?.close(); await fixture.close(); }
