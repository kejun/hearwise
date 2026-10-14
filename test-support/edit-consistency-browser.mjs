import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createEditFixture, editTables } from './edit-protocol-fixture.mjs';
import { deadline } from './lifecycle.mjs';
import { writeJson } from '../scripts/lib/verification-evidence.mjs';

const directory = path.resolve(process.argv[2] || 'browser-evidence');
await mkdir(directory, { recursive: true });
const scenarios = ['conflict', 'unknown-502', 'unknown-lost', 'rollback', 'late-success'];
const report = { complete: false, ok: false, widths: [], negative: null };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
let browser;
const persist = () => writeJson(path.join(directory, 'browser.json'), report);
await persist();
async function client(fixture, width, { mutant = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 950 } });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const result = { context, page, writes: 0, explicitSaves: 0, receiptReads: 0, submissions: [], errors: [], excess: deferred() };
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('request', request => {
    if (request.url() === fixture.url + '/name-replacements' && request.method() === 'POST') {
      result.writes++; result.submissions.push(request.postDataJSON());
      if (result.writes > result.explicitSaves) result.excess.resolve({ writes: result.writes, explicitSaves: result.explicitSaves });
    }
    if (request.method() === 'GET' && request.url().startsWith(fixture.url + '/edits/')) result.receiptReads++;
  });
  if (mutant) {
    const source = await readFile(new URL('../public/knowledge-editor.js', import.meta.url), 'utf8');
    const anchor = 'current.revision = snapshot.revision;';
    assert.equal(source.split(anchor).length, 2, 'Mutate exactly the actual conflict refresh handler');
    await page.route('**/knowledge-editor.js', route => route.fulfill({ contentType: 'text/javascript',
      body: source.replace(anchor, anchor + "\n    setTimeout(() => { void save('POST'); }, 0); // Deliberately broken response-handler retry.") }));
  }
  await page.goto(fixture.base);
  await page.locator('#history-listening').click();
  await page.getByRole('button', { name: '查看“名称纠正测试”', exact: true }).click();
  await page.locator('#knowledge-view-list').click();
  result.card = page.locator(`.knowledge-item[data-id="${fixture.itemId}"]`);
  result.open = async () => {
    if (await result.card.getAttribute('open') === null) await result.card.locator('summary').click();
    await result.card.getByRole('button', { name: /^纠正 .* 的名称$/ }).click();
    await page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  };
  await result.open();
  return result;
}
async function submit(value, name) {
  await value.page.locator('#knowledge-edit-name').fill(name); value.explicitSaves++;
  await value.page.locator('#knowledge-edit-save').click();
}
async function layoutAndScreenshot(value, name) {
  const { page } = value;
  assert.equal(await page.evaluate(() => {
    const dialog = document.querySelector('#knowledge-editor'), box = dialog.getBoundingClientRect();
    return dialog.open && dialog.scrollWidth <= dialog.clientWidth && box.left >= 0 && box.right <= innerWidth;
  }), true, 'Visible editor must fit desktop/narrow viewport');
  await page.screenshot({ path: path.join(directory, name) });
}
const counts = value => ({ writes: value.writes, explicitSaves: value.explicitSaves, receiptReads: value.receiptReads, submissions: value.submissions });
async function change(fixture, name) {
  const snapshot = fixture.snapshot();
  const response = await fetch(fixture.url + '/name-replacements', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ name, revision: snapshot.revision }) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
}
async function runScenario(width, scenario) {
  const fixture = await createEditFixture(), opened = [], release = deferred();
  const open = async options => { const value = await client(fixture, width, options); opened.push(value); return value; };
  let details;
  try {
    if (scenario === 'conflict') {
      const a = await open(), b = await open(), initial = fixture.snapshot();
      await b.page.locator('#knowledge-edit-name').fill('Mira');
      await submit(a, 'Tibo'); await a.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
      const conflict = b.page.waitForResponse(response => response.url() === fixture.url + '/name-replacements' && response.status() === 409);
      b.explicitSaves++; await b.page.locator('#knowledge-edit-save').click();
      assert.equal((await (await conflict).json()).code, 'KNOWLEDGE_EDIT_STALE');
      await b.page.locator('#knowledge-edit-status').filter({ hasText: '已读取最新内容，输入已保留' }).waitFor();
      assert.equal(await b.page.locator('#knowledge-edit-name').inputValue(), 'Mira');
      assert.equal(await b.page.locator('#knowledge-edit-source').inputValue(), 'Tibo');
      assert.equal(b.writes, 1); assert.equal(a.submissions[0].revision, initial.revision); assert.equal(b.submissions[0].revision, initial.revision);
      await layoutAndScreenshot(b, `edits-${width}-${scenario}.png`);
      await b.page.locator('#knowledge-edit-close').focus(); await b.page.keyboard.press('Enter');
      await b.open(); assert.equal(await b.page.locator('#knowledge-edit-name').inputValue(), 'Tibo');
      await submit(b, 'Mira'); await b.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
      assert.equal(b.writes, 2); assert.equal(fixture.snapshot().item.canonical_name, 'Mira');
      details = { clients: [counts(a), counts(b)], originalRevision: initial.revision, saved: fixture.snapshot().revision };
    } else if (scenario.startsWith('unknown-')) {
      const a = await open(), before = fixture.snapshot(); let actualCommit;
      await a.page.route(fixture.url + '/edits/**', route => route.fulfill({ status: 502, contentType: 'text/html', body: 'Synthetic unavailable receipt' }), { times: 1 });
      await a.page.route(fixture.url + '/name-replacements', async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200); actualCommit = await response.json();
        assert.equal(fixture.snapshot().item.canonical_name, 'Tibo'); assert.equal(actualCommit.job.saved, true);
        if (scenario === 'unknown-lost') await route.abort('connectionreset');
        else await route.fulfill({ status: 502, contentType: 'text/html', body: 'Synthetic proxy response after actual commit' });
      }, { times: 1 });
      await submit(a, 'Tibo');
      await a.page.locator('#knowledge-edit-status').filter({ hasText: '保存结果尚未确认' }).waitFor();
      assert.equal(await a.page.locator('#knowledge-edit-name').inputValue(), 'Tibo');
      assert.match(await a.page.locator('#knowledge-edit-status').textContent(), /输入已保留.*关闭后重新打开核对/);
      for (const id of ['save', 'delete', 'suggest']) assert.equal(await a.page.locator(`#knowledge-edit-${id}`).isDisabled(), true);
      assert.equal(await a.page.locator('#knowledge-edit-close').isEnabled(), true);
      assert.equal(a.writes, 1); assert.equal(a.receiptReads, 1);
      assert.notEqual(fixture.snapshot().revision, before.revision);
      assert.equal(fixture.store.knowledgeEditJob(fixture.listeningId, fixture.itemId, actualCommit.job.id).saved, true);
      await layoutAndScreenshot(a, `edits-${width}-${scenario}.png`);
      const beforeClose = editTables(fixture.store);
      await a.page.locator('#knowledge-edit-close').focus(); await a.page.keyboard.press('Enter'); await a.open();
      assert.deepEqual(editTables(fixture.store), beforeClose, 'Closing/reopening an uncertain editor performs no business write');
      assert.equal(a.writes, 1);
      assert.equal(await a.page.locator('#knowledge-edit-name').inputValue(), 'Tibo');
      assert.equal(await a.page.locator('#knowledge-edit-save').isEnabled(), true);
      await submit(a, 'Mira'); await a.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
      assert.equal(a.writes, 2); assert.equal(fixture.snapshot().item.canonical_name, 'Mira');
      details = { ...counts(a), committedBeforeTransportFailure: true, receipt: actualCommit.job, reopened: 'Tibo', continued: 'Mira', closeReopenNoWrite: true };
    } else if (scenario === 'rollback') {
      const a = await open(), before = editTables(fixture.store);
      await a.page.route(fixture.url + '/name-replacements', async route => {
        await fixture.control(route.request().headers()['idempotency-key'], 'request', { rollback: true, pause: false }); await route.continue();
      }, { times: 1 });
      await submit(a, 'Tibo'); await a.page.locator('#knowledge-edit-status').filter({ hasText: '原内容未更改' }).waitFor();
      assert.equal(await a.page.locator('#knowledge-edit-name').inputValue(), 'Tibo');
      assert.equal(await a.page.locator('#knowledge-edit-save').isEnabled(), true);
      assert.deepEqual(editTables(fixture.store), before); assert.equal(a.receiptReads, 0); assert.equal(a.writes, 1);
      await layoutAndScreenshot(a, `edits-${width}-${scenario}.png`);
      await submit(a, 'Tibo'); await a.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
      assert.equal(a.writes, 2); assert.equal(fixture.snapshot().item.canonical_name, 'Tibo');
      details = { ...counts(a), allTablesRolledBack: true, explicitRetrySucceeded: true };
    } else if (scenario === 'late-success') {
      const a = await open(), committed = deferred();
      await a.page.route(fixture.url + '/name-replacements', async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200); committed.resolve();
        await release.promise; await route.fulfill({ response });
      }, { times: 1 });
      await submit(a, 'Tibo'); await deadline(() => committed.promise, 5000, 'First actual commit');
      assert.equal(await a.page.locator('#knowledge-edit-close').isDisabled(), true);
      await a.page.keyboard.press('Escape'); assert.equal(await a.page.locator('#knowledge-editor').isVisible(), true);
      const b = await open(); assert.equal(await b.page.locator('#knowledge-edit-name').inputValue(), 'Tibo');
      await submit(b, 'Mira'); await b.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
      assert.equal(fixture.snapshot().item.canonical_name, 'Mira'); release.resolve();
      await a.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
      await a.open(); assert.equal(await a.page.locator('#knowledge-edit-name').inputValue(), 'Mira');
      assert.equal(a.writes, 1); assert.equal(b.writes, 1);
      await layoutAndScreenshot(a, `edits-${width}-${scenario}.png`);
      details = { clients: [counts(a), counts(b)], lateResponseDoesNotRevert: true, loaded: 'Mira' };
    } else throw new Error('Unknown edit scenario');
    for (const value of opened) { assert.deepEqual(value.errors, []); assert.equal(value.writes, value.explicitSaves); }
    assert.equal(fixture.stats.providerRequests.length, 0);
    return { scenario, complete: true, ok: true, ...details, providerCalls: 0 };
  } finally { release.resolve(); for (const value of opened) await value.context.close(); await fixture.close(); }
}
async function negativeClient() {
  const fixture = await createEditFixture(); let a;
  try {
    a = await client(fixture, 390, { mutant: true });
    await change(fixture, 'Tibo');
    const overwritten = a.page.waitForResponse(response => response.url() === fixture.url + '/name-replacements' && response.status() === 200);
    await submit(a, 'Mira'); const excess = await deadline(() => a.excess.promise, 5000, 'Actual broken editor automatic resend');
    assert.equal((await (await overwritten).json()).job.saved, true);
    await a.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
    assert.deepEqual(excess, { writes: 2, explicitSaves: 1 }); assert.equal(fixture.snapshot().item.canonical_name, 'Mira');
    assert.equal(fixture.stats.providerRequests.length, 0); assert.deepEqual(a.errors, []);
    await a.page.screenshot({ path: path.join(directory, 'edits-390-auto-resend-negative.png') });
    return { complete: true, classification: 'implementation_mismatch', property: 'HW-06-06',
      mutation: 'Actual served public/knowledge-editor.js conflict handler sends a second POST after adopting the latest revision',
      counterexample: { ...counts(a), overwrittenName: 'Tibo', persistedName: 'Mira', firstExcessRequest: excess.writes } };
  } finally { await a?.context.close(); await fixture.close(); }
}
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  report.chromium = browser.version();
  for (const width of [1280, 390]) {
    const row = { width, results: [] }; report.widths.push(row);
    for (const scenario of scenarios) { row.results.push(await runScenario(width, scenario)); await persist(); }
  }
  report.negative = await negativeClient(); report.complete = true; report.ok = true;
} catch (error) { report.error = { name: error.name, message: error.message }; process.exitCode = 1; }
finally { await browser?.close(); await persist(); }
console.log(JSON.stringify(report));
