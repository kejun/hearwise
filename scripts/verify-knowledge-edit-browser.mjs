import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { deadline } from '../test-support/lifecycle.mjs';
import path from 'node:path';
import { speechFixture } from '../test-support/speech-fixture.mjs';
import { seedNameReplacement } from '../test-support/name-replacement-fixture.mjs';

const fixture = await speechFixture({ seed: store => seedNameReplacement(store, { graph: true }),
  modelResponse: () => { throw new Error('Manual name replacement must not request a model'); } });
let browser, page;
const network = [];
const record = entry => { if (network.length < 200) network.push({ at: new Date().toISOString(), ...entry }); };
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith(`${fixture.base}/api/`)) record({ event: 'request', method: request.method(), url: request.url(),
    editId: request.headers()['idempotency-key'] || null }); });
  page.on('response', response => { if (response.url().startsWith(`${fixture.base}/api/`)) record({ event: 'response', method: response.request().method(), url: response.url(), status: response.status() }); });
  page.on('requestfailed', request => { if (request.url().startsWith(`${fixture.base}/api/`)) record({ event: 'requestfailed', method: request.method(), url: request.url(), error: request.failure()?.errorText || null }); });
  // Deliberately no API Key, including for a graph that already has a relation.
  await page.goto(fixture.base);
  const open = async () => {
    await page.locator('#history-listening').click();
    await page.getByRole('button', { name: '查看“名称纠正测试”', exact: true }).click();
    await page.locator('#knowledge-view-list').click();
  };
  await open();
  const item = fixture.seeded.item, card = page.locator(`.knowledge-item[data-id="${item.id}"]`);
  await card.locator('summary').click();
  assert.equal(await card.locator('.knowledge-item-actions button').count(), 1);
  const url = `${fixture.base}/api/listenings/${fixture.seeded.listeningId}/knowledge/${item.id}`;
  const edit = async name => {
    await card.getByRole('button', { name: `纠正 ${name} 的名称`, exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  };
  await page.route(url, route => route.fulfill({ status: 404, contentType: 'text/html', body: '<html>private diagnostic</html>' }), { times: 1 });
  await card.getByRole('button', { name: '纠正 Deebo 的名称', exact: true }).click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '读取知识条目失败（HTTP 404）' }).waitFor();
  assert.equal(await page.locator('#knowledge-edit-save').isDisabled(), true);
  assert.doesNotMatch(await page.locator('#knowledge-edit-status').textContent(), /private|pattern/);
  await page.locator('#knowledge-edit-close').click(); await edit('Deebo');
  await page.locator('#knowledge-edit-name').fill('Proxy failed draft');
  await page.route(`${url}/name-replacements`, route => route.fulfill({ status: 504, contentType: 'text/html', body: '<html>Gateway Timeout</html>' }), { times: 1 });
  await page.locator('#knowledge-edit-save').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '保存名称纠正失败（HTTP 504）' }).waitFor();
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Proxy failed draft');
  assert.equal(await page.locator('#knowledge-edit-save').isDisabled(), true);
  await page.locator('#knowledge-edit-close').click(); await edit('Deebo');
  await page.locator('#knowledge-edit-name').fill('Discarded draft'); await page.locator('#knowledge-edit-close').click();
  await edit('Deebo'); assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Deebo');
  assert.equal(await page.locator('#knowledge-edit-source').getAttribute('readonly'), '');
  await page.locator('#knowledge-edit-suggest').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '可直接填写正确名称并保存' }).waitFor();
  assert.equal(fixture.stats.providerRequests.length, 0);
  await page.locator('#knowledge-edit-name').fill('Camera'); await page.locator('#knowledge-edit-save').click();
  await page.locator('#knowledge-edit-status').filter({ hasText: '已存在同名条目' }).waitFor();
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Camera');
  assert.match(await card.textContent(), /Deebo/);
  await page.locator('#knowledge-edit-name').fill('Tibo');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.evaluate(() => {
      const el = document.querySelector('#knowledge-editor'), box = el.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && box.left >= 0 && box.right <= innerWidth;
    }), true);
    if (process.env.KNOWLEDGE_EDIT_EVIDENCE_DIR) {
      await mkdir(process.env.KNOWLEDGE_EDIT_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.KNOWLEDGE_EDIT_EVIDENCE_DIR, `knowledge-edit-${width}.png`) });
    }
  }
  await page.locator('#knowledge-edit-save').click(); await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  assert.equal(fixture.stats.providerRequests.length, 0);
  await page.reload(); await open(); await card.locator('summary').filter({ hasText: 'Tibo' }).waitFor();
  const saved = await page.request.get(url).then(response => response.json());
  assert.equal(saved.item.canonical_name, 'Tibo'); assert.equal(saved.item.facts[0].id, fixture.seeded.factId);
  assert.match(saved.segments[0].original_text, /^Tibo released/);
  assert.match(saved.segments[0].original_text, /Deeboverse/);
  assert.equal(saved.item.mentions[0].surface_text, saved.segments[0].original_text);
  const graphUrl = `${fixture.base}/api/listenings/${fixture.seeded.listeningId}/graph`;
  let graph = await page.request.get(graphUrl).then(response => response.json());
  assert.equal(graph.relations.length, 1); assert.equal(graph.assertions[0].status, 'active');
  await card.locator('summary').click(); await edit('Tibo'); await page.locator('#knowledge-edit-name').fill('Tibo Corrected');
  let writes = 0;
  page.on('request', request => { if (request.url() === `${url}/name-replacements` && request.method() === 'POST') writes++; });
  await page.route(`${url}/name-replacements`, async route => {
    let result;
    try { result = await route.fetch(); }
    catch (error) { record({ event: 'lost_response_upstream_error', error: error.message }); throw error; }
    record({ event: 'lost_response_upstream', status: result.status(), body: await result.text() });
    assert.equal(result.status(), 200);
    await route.fulfill({ status: 502, contentType: 'text/html', body: '<html>response lost</html>' });
  }, { times: 1 });
  await page.locator('#knowledge-edit-save').click(); await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  assert.equal(writes, 1); assert.equal(fixture.stats.providerRequests.length, 0);
  await page.reload(); await open(); await card.locator('summary').filter({ hasText: 'Tibo Corrected' }).waitFor();
  await page.locator('#knowledge-view-graph').click(); await page.locator('.graph-results > summary').click();
  await page.locator(`[data-result-node-id="${item.id}"]`).click();
  assert.equal(await page.locator('#graph-correct-name').count(), 0);
  assert.equal(await page.locator('#graph-edit-node').textContent(), '纠正名称');
  await page.locator('#graph-edit-node').click(); await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  assert.equal(await page.locator('#knowledge-edit-name').inputValue(), 'Tibo Corrected');
  await page.locator('#knowledge-edit-delete').click(); await page.locator('#knowledge-delete-cancel').click();
  assert.equal(await page.locator('#knowledge-delete-confirm').isHidden(), true);
  await page.locator('#knowledge-edit-delete').click(); await page.locator('#knowledge-delete-submit').click();
  await page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
  await page.reload(); await open(); assert.equal(await card.count(), 0);
  graph = await page.request.get(graphUrl).then(response => response.json());
  assert.ok(graph.deletedItemIds.includes(item.id)); assert.equal(fixture.stats.providerRequests.length, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['one entry in list and graph', 'Deebo→Tibo without Key or model',
    'collision/cancel/proxy failure preserve input', 'literal linked-source/fact/quote replacement', 'existing graph stays active',
    'lost response recovers receipt without another write', 'desktop/390/320 layout', 'reload persistence', 'delete confirmation', 'no page errors'] }));
} catch (failure) {
  // Failure-only observation: never retries a write or changes the success path.
  const diagnostics = { failure: { name: failure.name, message: failure.message }, network, editor: null, receipts: [], serverLog: fixture.logs(), providerRequests: fixture.stats.providerRequests };
  try {
    diagnostics.editor = await deadline(() => page.evaluate(() => ({ url: location.href,
      open: document.querySelector('#knowledge-editor')?.open, busy: document.querySelector('#knowledge-editor')?.getAttribute('aria-busy'),
      status: document.querySelector('#knowledge-edit-status')?.textContent, name: document.querySelector('#knowledge-edit-name')?.value })), 3000, 'editor failure snapshot');
    const requests = network.filter(row => row.event === 'request' && row.method === 'POST' && row.url.endsWith('/name-replacements') && row.editId).slice(-4);
    for (const request of requests) {
      const url = request.url.replace(/\/name-replacements$/, `/edits/${request.editId}`);
      try {
        const response = await page.request.get(url, { timeout: 3000 });
        diagnostics.receipts.push({ url, status: response.status(), body: await response.text() });
      } catch (error) { diagnostics.receipts.push({ url, error: error.message }); }
    }
    if (process.env.KNOWLEDGE_EDIT_EVIDENCE_DIR) {
      await mkdir(process.env.KNOWLEDGE_EDIT_EVIDENCE_DIR, { recursive: true });
      await writeFile(path.join(process.env.KNOWLEDGE_EDIT_EVIDENCE_DIR, 'knowledge-edit-failure.json'), JSON.stringify(diagnostics, null, 2));
      await page.screenshot({ path: path.join(process.env.KNOWLEDGE_EDIT_EVIDENCE_DIR, 'knowledge-edit-failure.png'), timeout: 3000 });
    }
  } catch (error) { diagnostics.observationError = error.message; }
  console.error('KNOWLEDGE_EDIT_FAILURE ' + JSON.stringify(diagnostics));
  throw failure;
} finally { await browser?.close(); await fixture.close(); }
