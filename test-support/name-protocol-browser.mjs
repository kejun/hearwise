// Real editor/list/detail/graph paths; only transport outcomes and local providers are controlled.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createNameProtocolFixture } from './name-protocol-fixture.mjs';
import { installNameWriteFault, removeNameWriteFault } from './name-transaction-fixture.mjs';
import { deadline } from './lifecycle.mjs';
import { digest, writeJson, sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { nameBrowserFailure } from './name-browser-failure.mjs';
import { inspectNameBusinessTables } from '../scripts/lib/name-protocol-durable.mjs';
const directory = path.resolve(process.argv[2]); await mkdir(directory, { recursive: true });
const scenarios = ['held-double-submit', 'receipt-recovery', 'unknown-502', 'unknown-lost', 'rollback-retry', 'cancel-noop'];
const report = { source: sourceVersion(), complete: false, widths: [], negative: null };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const wait = (gate, label) => deadline(() => gate.promise, 7000, label);
const persist = () => writeJson(path.join(directory, 'browser.json'), report);
let browser;
function identities(f) { const s = f.seeded; return { listeningId: f.listeningId, itemId: f.itemId, segmentId: s.segment.id,
  unlinkedId: s.other.id, unrelatedId: s.unrelated.listeningId, staleId: s.staleId, cameraId: s.camera.id, factId: s.factId }; }
async function client(f, width, mutant, created) {
  const context = await browser.newContext({ viewport: { width, height: 950 } }), page = await context.newPage(); page.setDefaultTimeout(7000);
  const value = { context, page, requests: [], responses: [], sources: [], pending: [], errors: [], requestFailures: [], explicitSaves: 0 };
  created(value);
  page.on('pageerror', error => value.errors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith(f.url)) value.requests.push({ method: request.method(), url: request.url(), headers: { 'idempotency-key': request.headers()['idempotency-key'] ?? null }, body: request.postDataJSON() });
  });
  page.on('requestfailed', request => { if (request.url().startsWith(f.url)) value.requestFailures.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText ?? null }); });
  page.on('response', response => {
    const url = response.url();
    if (url.startsWith(f.url)) {
      const entry = { url, status: response.status() }; value.responses.push(entry);
      value.pending.push((async () => { try { entry.text = await response.text(); } catch (error) { entry.bodyError = error.message; } })());
    }
    if (['/app.js', '/knowledge-editor.js', '/knowledge-graph.js'].includes(new URL(url).pathname)) value.pending.push((async () => {
      const bytes = await response.body(); value.sources.push({ url, status: response.status(), sha256: digest(bytes), bytes: bytes.length });
    })());
  });
  if (mutant) {
    const source = await readFile('public/knowledge-editor.js', 'utf8'), anchor = 'async function save(method) {\n    if (busy || !selected || outcomeUnknown) return;';
    assert.equal(source.split(anchor).length, 2);
    const changed = source.replace(anchor, 'async function save(method) {\n    if (!selected || outcomeUnknown) return;');
    value.mutation = { file: 'public/knowledge-editor.js', originalSha256: digest(source), mutantSha256: digest(changed), anchor };
    await page.route('**/knowledge-editor.js', route => route.fulfill({ contentType: 'text/javascript', body: changed }));
  }
  await page.goto(f.base); await page.locator('#history-listening').click();
  await page.getByRole('button', { name: '查看“名称纠正测试”', exact: true }).click();
  value.open = async () => {
    await page.locator('#knowledge-view-list').click();
    const card = page.locator(`.knowledge-item[data-id="${f.itemId}"]`);
    if (!await card.evaluate(node => node.open)) await card.locator('summary').click();
    await card.getByRole('button', { name: /^纠正 .* 的名称$/ }).click();
    await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  };
  await value.open(); return value;
}
async function editor(value) {
  return value.page.evaluate(() => {
    const d = document.querySelector('#knowledge-editor'), box = d.getBoundingClientRect();
    return { open: d.open, draft: document.querySelector('#knowledge-edit-name').value, source: document.querySelector('#knowledge-edit-source').value,
      status: document.querySelector('#knowledge-edit-status').textContent, busy: d.getAttribute('aria-busy'), saveDisabled: document.querySelector('#knowledge-edit-save').disabled,
      closeDisabled: document.querySelector('#knowledge-edit-close').disabled, fits: box.left >= 0 && box.right <= innerWidth && d.scrollWidth <= d.clientWidth };
  });
}
async function save(value, name, { doubled = false } = {}) {
  await value.page.locator('#knowledge-edit-name').fill(name); value.explicitSaves++;
  if (doubled) await value.page.locator('#knowledge-editor form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  else await value.page.locator('#knowledge-edit-save').click();
}
async function views(value, fixture, expected) {
  const page = value.page; await page.locator('#knowledge-view-list').click();
  const card = page.locator(`.knowledge-item[data-id="${fixture.itemId}"]`);
  await card.locator('.knowledge-title-line strong').filter({ hasText: expected }).waitFor();
  if (!await card.evaluate(node => node.open)) await card.locator('summary').click();
  const list = { id: await card.getAttribute('data-id'), name: await card.locator('.knowledge-title-line strong').textContent(),
    summary: await card.locator('.knowledge-brief').textContent(), fact: await card.locator('.knowledge-dialogue').textContent(), transcript: await page.locator('#transcript-list').textContent() };
  assert.equal(list.name, expected);
  await page.locator('#knowledge-view-graph').click(); await page.locator('#graph-count').filter({ hasText: '2 / 2' }).waitFor();
  await page.locator('#graph-viewport canvas').first().waitFor({ state: 'visible' });
  if (!await page.locator('.graph-results').evaluate(node => node.open)) await page.locator('.graph-results > summary').click();
  const entries = await page.locator('[data-result-node-id]').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.resultNodeId, text: node.textContent })));
  await page.locator(`[data-result-node-id="${fixture.itemId}"]`).click();
  await page.locator('#graph-detail-title').filter({ hasText: expected }).waitFor();
  const graph = { entries, name: await page.locator('#graph-detail-title').textContent(), details: await page.locator('#graph-details').textContent() };
  assert.ok(graph.details.includes(expected)); await page.keyboard.press('Escape');
  await value.open(); const reopened = await editor(value); assert.equal(reopened.draft, expected);
  return { list, graph, reopened };
}
async function run(width, scenario, mutant = false) {
  const f = await createNameProtocolFixture(), baseline = f.tables(), ids = identities(f), release = deferred(), committed = deferred();
  const row = { scenario, identities: ids, baseline, checkpoints: [], upstream: [], width, complete: false }; let a, failed = false;
  if (mutant) report.negative = row; else report.widths.find(value => value.width === width).results.push(row);
  const capture = async label => {
    const tables = f.tables(), inspection = inspectNameBusinessTables({ baseline, tables, identities: ids });
    assert.equal(inspection.ok, true, JSON.stringify(inspection));
    row.checkpoints.push({ label, tables, snapshot: f.snapshot(), editor: await editor(a) });
  };
  try {
    a = await client(f, width, mutant, value => { a = value; }); await capture('opened');
    if (scenario === 'held-double-submit') {
      await a.page.route(f.url + '/name-replacements', async route => {
        const response = await route.fetch(), text = await response.text(); row.upstream.push({ request: route.request().postDataJSON(), id: route.request().headers()['idempotency-key'], status: response.status(), text });
        if (response.status() === 200) { committed.resolve(); await release.promise; }
        await route.fulfill({ response });
      });
      const conflict = mutant ? a.page.waitForResponse(r => r.url() === f.url + '/name-replacements' && r.status() === 409) : null;
      await save(a, 'Tibo', { doubled: true }); await wait(committed, 'Real name commit held before browser response');
      if (mutant) {
        await conflict;
        await a.page.waitForFunction(() => document.querySelector('#knowledge-edit-source').value === 'Tibo');
        assert.equal(a.requests.filter(r => r.method === 'POST').length, 2);
      } else assert.equal(a.requests.filter(r => r.method === 'POST').length, 1);
      await capture('committed-held'); if (!mutant) assert.equal(row.checkpoints.at(-1).editor.closeDisabled, true);
      release.resolve(); await a.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
      row.views = await views(a, f, 'Tibo');
    } else if (['receipt-recovery', 'unknown-502', 'unknown-lost'].includes(scenario)) {
      if (scenario !== 'receipt-recovery') await a.page.route(f.url + '/edits/**', route => route.fulfill({ status: 502, contentType: 'text/html', body: 'Synthetic unavailable receipt' }), { times: 1 });
      await a.page.route(f.url + '/name-replacements', async route => {
        const response = await route.fetch(), text = await response.text(); assert.equal(response.status(), 200);
        row.upstream.push({ request: route.request().postDataJSON(), id: route.request().headers()['idempotency-key'], status: response.status(), text });
        assert.equal(f.snapshot().item.canonical_name, 'Tibo');
        if (scenario === 'unknown-lost') await route.abort('connectionreset');
        else await route.fulfill({ status: 502, contentType: 'text/html', body: 'Synthetic proxy response after actual commit' });
      }, { times: 1 });
      await save(a, 'Tibo');
      if (scenario === 'receipt-recovery') await a.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
      else {
        await a.page.locator('#knowledge-edit-status').filter({ hasText: '保存结果尚未确认' }).waitFor(); await capture('unknown');
        assert.equal(row.checkpoints.at(-1).editor.draft, 'Tibo'); assert.equal(row.checkpoints.at(-1).editor.saveDisabled, true);
        const before = f.tables(); await a.page.locator('#knowledge-edit-close').focus(); await a.page.keyboard.press('Enter'); await a.open();
        assert.deepEqual(f.tables(), before); await capture('reopened-unknown');
        await a.page.locator('#knowledge-edit-close').click();
      }
      row.views = await views(a, f, 'Tibo');
    } else if (scenario === 'rollback-retry') {
      installNameWriteFault(f.store, 'receipt-success'); const before = f.tables(); await save(a, 'Ｔｉｂｏ  Longer');
      await a.page.locator('#knowledge-edit-status').filter({ hasText: '原内容未更改' }).waitFor();
      assert.deepEqual(f.tables(), before); await capture('rolled-back'); removeNameWriteFault(f.store, 'receipt-success');
      await save(a, 'Ｔｉｂｏ  Longer'); await a.page.locator('#knowledge-editor').waitFor({ state: 'hidden' }); row.views = await views(a, f, 'Ｔｉｂｏ  Longer');
    } else {
      await a.page.locator('#knowledge-edit-name').fill('Unused draft'); await a.page.locator('#knowledge-edit-close').click(); await a.open();
      assert.deepEqual(f.tables(), baseline); await capture('cancelled-reopened');
      const revision = f.snapshot().revision; await save(a, 'Deebo'); await a.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
      assert.equal(f.snapshot().revision, revision); row.views = await views(a, f, 'Deebo');
    }
    await capture('final'); assert.equal(row.checkpoints.at(-1).editor.fits, true);
    row.screenshot = `name-${width}-${mutant ? 'double-submit-negative' : scenario}.png`;
    await a.page.screenshot({ path: path.join(directory, row.screenshot) });
    await Promise.all(a.pending); assert.deepEqual(a.errors, []); assert.equal(f.stats.providerRequests.length, 0);
    Object.assign(row, { requests: a.requests, responses: a.responses, sources: a.sources, errors: a.errors,
      explicitSaves: a.explicitSaves, providerCalls: f.stats.providerRequests, mutation: a.mutation ?? null, complete: true });
    assert.equal(row.requests.filter(request => request.method === 'POST').length, row.explicitSaves + (mutant ? 1 : 0));
    return row;
  } catch (error) {
    failed = true; row.failure = { name: error.name, message: error.message }; await persist();
    try { await nameBrowserFailure({ row, client: a, fixture: f, error, inspectEditor: editor }); }
    catch (cause) { row.diagnosticError = cause.message; }
    await persist(); console.error('NAME_BROWSER_FAILURE ' + JSON.stringify(row)); throw error;
  } finally {
    release.resolve();
    const cleanup = await Promise.allSettled([deadline(() => a?.context.close(), 3000, 'Name browser context close'), f.close()]);
    const failures = cleanup.filter(value => value.status === 'rejected').map(value => value.reason?.message ?? String(value.reason));
    if (failures.length) { row.cleanupErrors = failures; await persist(); if (!failed) throw new Error(failures.join('; ')); }
  }
}
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  report.chromium = browser.version();
  for (const width of [1280, 390]) { const row = { width, results: [] }; report.widths.push(row); for (const scenario of scenarios) { await run(width, scenario); await persist(); } }
  await run(390, 'held-double-submit', true); report.complete = true;
} catch (error) { report.error = { name: error.name, message: error.message }; process.exitCode = 1; }
finally { await browser?.close(); await persist(); }
