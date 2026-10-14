import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { importProtocolFixture, importedWorkObservation } from '../test-support/import-protocol-fixture.mjs';
import { deadline } from '../test-support/lifecycle.mjs';
import { observeImportFetch } from '../test-support/import-protocol-browser-observer.mjs';
import { importBrowserSourceStamp, importBrowserCases, summarizeImportBrowserEvidence } from '../test-support/import-protocol-browser-evidence.mjs';

const timeout = 10000;
const digest = value => createHash('sha256').update(value).digest('hex');
const root = path.resolve(process.env.IMPORT_PROTOCOL_BROWSER_EVIDENCE_DIR || 'browser-evidence');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'import-protocol-'));
const observations = { schemaVersion: 1, profile: 'import-protocol-browser', startedAt: new Date().toISOString(),
  finishedAt: null, complete: false, ok: false, sourceStart: null, sourceEnd: null,
  properties: [{ id: 'HW-09-04', version: 1 }, { id: 'HW-09-05', version: 1 }],
  tools: { node: process.version, sqlite: process.versions.sqlite, chromium: null },
  scenarios: [], screenshots: [], errors: [], cleanup: [],
  scope: 'Real browser UI, production HTTP handlers and SQLite, synthetic data and stub providers only.' };
// Keep the known stale-refresh/expiry UI regression last: its failure must not
// hide observations from the four primary append/replace acceptance scenarios.
const cases = importBrowserCases;
console.log(`Import protocol browser evidence: ${directory}`);

async function writeJson(name, value) {
  const filename = path.join(directory, name);
  await writeFile(`${filename}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await rename(`${filename}.tmp`, filename);
}
function failure(error) {
  return { name: error.name, message: String(error.message).replaceAll('local-test-only', '[synthetic key omitted]') };
}
function snapshotSummary(snapshot) {
  return { sha256: digest(JSON.stringify(snapshot)),
    rowCounts: Object.fromEntries(Object.entries(snapshot.rows).map(([table, rows]) => [table, rows.length])),
    listeningIds: snapshot.rows.listenings.map(row => row.id).sort(),
    integrity: snapshot.integrity, foreignKeyErrors: snapshot.foreignKeyErrors };
}
async function save() {
  await writeJson('observations.json', observations);
  const scenarios = observations.scenarios.map(({ snapshots, ...scenario }) => ({ ...scenario,
    requestCounts: { total: scenario.http.length, validate: count(scenario, 'validate'),
      preview: count(scenario, 'preview'), commit: count(scenario, 'commit') },
    commitStatuses: scenario.http.filter(row => row.path === '/api/data/import/commit').map(row => row.status),
    snapshots: snapshots.map(({ label, database }) => ({ label, ...snapshotSummary(database) })) }));
  await writeJson('report.json', { ...observations, scenarios,
    results: summarizeImportBrowserEvidence(observations).results,
    artifacts: [{ path: 'observations.json', sha256: digest(await readFile(path.join(directory, 'observations.json'))) },
      ...observations.screenshots.map(({ path: filename, sha256 }) => ({ path: filename, sha256 }))] });
}
function recordSnapshot(scenario, fixture, label) {
  const database = fixture.snapshot();
  scenario.snapshots.push({ label, database });
  assert.equal(database.integrity, 'ok');
  assert.deepEqual(database.foreignKeyErrors, []);
  return database;
}
function safeProtocolBody(body) {
  // Never persist upload/preview capabilities or request headers/API keys.
  const { token, previewToken, ...safe } = body;
  return { ...safe, ...(token ? { tokenSha256: digest(token) } : {}),
    ...(previewToken ? { previewTokenSha256: digest(previewToken) } : {}) };
}
async function observeRequests(page, scenario) {
  const requests = new Map(), tasks = new Set(), indices = new Map(), bodies = new Map();
  // File-backed uploads can evict Chromium's inspector response cache. Read a
  // clone in-page without waiting on it or changing the app's original Response.
  await page.addInitScript(observeImportFetch);
  const bodyFor = response => {
    const request = response.request();
    if (!bodies.has(request)) bodies.set(request, (async () => {
      const row = requests.get(request); assert.ok(row && Number.isInteger(row.responseIndex));
      const selection = { url: response.url(), index: row.responseIndex };
      await page.waitForFunction(({ url, index }) => window.__importProtocolResponses?.filter(row => row.url === url)[index]?.done,
        selection, { timeout });
      const observed = await page.evaluate(({ url, index }) => window.__importProtocolResponses.filter(row => row.url === url)[index], selection);
      assert.equal(observed.status, response.status()); assert.equal(observed.error, undefined);
      assert.equal(observed.url, request.url()); assert.equal(observed.method, request.method());
      row.fetch = { index: observed.index, url: observed.url, method: observed.method, requestBody: observed.requestBody };
      return observed.body;
    })());
    return bodies.get(request);
  };
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    const row = { index: scenario.http.length, method: request.method(), url: request.url(), path: url.pathname,
      status: null, response: null };
    if (url.pathname.startsWith('/api/data/import/')) {
      row.responseIndex = indices.get(request.url()) || 0; indices.set(request.url(), row.responseIndex + 1);
      if (url.pathname.endsWith('/validate')) row.request = { mode: url.searchParams.get('mode'),
        uploadBytes: request.postDataBuffer()?.length ?? null };
      else row.request = safeProtocolBody(request.postDataJSON());
    }
    scenario.http.push(row); requests.set(request, row);
  });
  page.on('response', response => {
    const row = requests.get(response.request());
    if (!row) return;
    row.status = response.status();
    if (!row.path.startsWith('/api/data/import/')) return;
    const task = bodyFor(response).then(body => { row.response = safeProtocolBody(body); })
      .catch(error => { row.bodyError = failure(error); });
    tasks.add(task); void task.finally(() => tasks.delete(task));
  });
  page.on('requestfailed', request => {
    const row = requests.get(request);
    if (row) row.failure = request.failure()?.errorText;
  });
  return { bodyFor, drain: () => deadline(() => Promise.all([...tasks]), timeout, 'HTTP evidence body completion') };
}
const count = (scenario, endpoint) => scenario.http.filter(row => row.path === `/api/data/import/${endpoint}`).length;
const responseFor = (page, endpoint) => page.waitForResponse(response =>
  new URL(response.url()).pathname === `/api/data/import/${endpoint}` && response.request().method() === 'POST', { timeout });
async function frames(page) {
  await deadline(() => page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })), timeout, 'two rendered UI frames');
}
async function ui(page) {
  return page.evaluate(() => ({
    status: document.querySelector('#data-transfer-status').textContent,
    summary: document.querySelector('#data-import-summary').textContent,
    confirmText: document.querySelector('#data-import-confirm').textContent,
    confirmDisabled: document.querySelector('#data-import-confirm').disabled,
    append: document.querySelector('#data-import-append').checked,
    reviewHidden: document.querySelector('#data-import-review').hidden
  }));
}
async function ready(page, mode, status = '备份验证通过') {
  await page.waitForFunction(({ mode, status }) => {
    const get = id => document.getElementById(id);
    return !get('data-import-confirm').disabled && !get('data-import-append').disabled &&
      !get('data-import').disabled && get('data-import-append').checked === (mode === 'append') &&
      get('data-transfer-status').textContent.includes(status) &&
      get('data-import-summary').textContent.includes(mode === 'append' ? '追加：新增 1 条，跳过 0 条' : '覆盖：完整替换当前数据');
  }, { mode, status }, { timeout });
}
async function upload(page, fixture, mode, bodyFor, scenario) {
  const bytes = await readFile(fixture.backups[0]);
  const selected = { index: scenario.uploads.length, name: path.basename(fixture.backups[0]), size: bytes.length, sha256: digest(bytes) };
  scenario.uploads.push(selected);
  const [response] = await Promise.all([responseFor(page, 'validate'),
    page.locator('#data-import-file').setInputFiles(fixture.backups[0])]);
  const body = await bodyFor(response);
  assert.equal(response.status(), 200, JSON.stringify(safeProtocolBody(body)));
  assert.equal(body.mode, mode); assert.equal(body.databaseVersion, 12);
  assert.match(body.revision, /^[a-f0-9]{64}$/);
  assert.equal(body.listeningCount, 1); assert.equal(body.currentCount, 1);
  await ready(page, mode);
  return body;
}
async function confirmAction(page, scenario, accepted) {
  const dialogTask = page.waitForEvent('dialog', { timeout }).then(async dialog => {
    const message = dialog.message();
    scenario.confirmations.push({ accepted, type: dialog.type(), message });
    try {
      assert.equal(dialog.type(), 'confirm');
      assert.match(message, scenario.mode === 'append' ? /将新增 1 条收听，跳过 0 条/ : /完整替换/);
    } catch (error) { await dialog.dismiss(); throw error; }
    await (accepted ? dialog.accept() : dialog.dismiss());
  });
  await Promise.all([dialogTask, page.locator('#data-import-confirm').click()]);
}
async function screenshots(page, scenario, label, widths = [1280, 390, 320]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 950 });
    await page.locator('#data-import-confirm').scrollIntoViewIfNeeded();
    await frames(page);
    const layout = await page.locator('#tab-data').evaluate(element => ({
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth
    }));
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `data tab fits ${width}px`);
    const filename = `${scenario.mode}-${scenario.name}-${label}-${width}.png`;
    await page.screenshot({ path: path.join(directory, filename) });
    observations.screenshots.push({ mode: scenario.mode, scenario: scenario.name, label, width, layout,
      path: filename, sha256: digest(await readFile(path.join(directory, filename))) });
  }
  await page.setViewportSize({ width: 1280, height: 950 });
}
async function committed(page, scenario, fixture, before, status, bodyFor) {
  const [response] = await Promise.all([responseFor(page, 'commit'), confirmAction(page, scenario, true)]);
  const body = await bodyFor(response);
  assert.equal(response.status(), 200, JSON.stringify(safeProtocolBody(body)));
  assert.equal(body.mode, scenario.mode); assert.equal(body.changed, true);
  assert.equal(body.addedCount, 1); assert.equal(body.skippedCount, 0);
  assert.match(body.safetyBackup, /^before-import-.*\.sqlite$/);
  await page.waitForFunction(status => {
    const get = id => document.getElementById(id);
    return get('data-transfer-status').textContent.includes(status) && get('data-import-review').hidden &&
      get('data-import-confirm').disabled && !get('data-import').disabled;
  }, status, { timeout });
  await frames(page);
  scenario.ui.committed = await ui(page);
  const after = recordSnapshot(scenario, fixture, 'committed');
  const expectedIds = (scenario.mode === 'append' ? [fixture.seeds[0].listeningId, fixture.seeds[1].listeningId] :
    [fixture.seeds[1].listeningId]).sort();
  assert.deepEqual(snapshotSummary(after).listeningIds, expectedIds);
  scenario.expectedListeningIds = expectedIds;
  if (scenario.mode === 'append') for (const [table, rows] of Object.entries(before.rows)) {
    const actual = new Set(after.rows[table].map(row => JSON.stringify(row)));
    assert.ok(rows.every(row => actual.has(JSON.stringify(row))), `append preserves every existing ${table} row`);
  }
  scenario.unfinishedAfterCommit = importedWorkObservation(fixture);
  assert.equal(fixture.calls.length, 0);
}

let browser;
await save();
try {
  observations.sourceStart = await importBrowserSourceStamp();
  await save();
  browser = await chromium.launch({ headless: true, timeout: 15000,
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  observations.tools.chromium = browser.version();
  for (const { mode, name } of cases) {
    const scenario = { mode, name, startedAt: new Date().toISOString(), finishedAt: null,
      complete: false, ok: false, checks: {}, http: [], uploads: [], confirmations: [], snapshots: [], ui: {}, pageErrors: [],
      providerCalls: [], clock: [], cleanup: [] };
    observations.scenarios.push(scenario);
    await save();
    let fixture, context, drain, bodyFor;
    try {
      fixture = await importProtocolFixture({ unfinished: true }); scenario.origin = new URL(fixture.base()).origin; scenario.backup = fixture.backupSnapshots[0];
      context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
      const page = await context.newPage();
      page.setDefaultTimeout(timeout); page.setDefaultNavigationTimeout(timeout);
      page.on('pageerror', error => scenario.pageErrors.push(failure(error)));
      ({ drain, bodyFor } = await observeRequests(page, scenario));
      await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'local-test-only'));
      await page.goto(fixture.base());
      await page.locator('#settings-trigger').click();
      await page.locator('#tab-data-button').click();
      assert.equal(await page.locator('#data-import-append').isChecked(), false);
      if (mode === 'append') await page.locator('#data-import-append').check();
      const initial = recordSnapshot(scenario, fixture, 'before-upload');
      const review = await upload(page, fixture, mode, bodyFor, scenario);
      scenario.ui.validated = await ui(page);
      assert.deepEqual(recordSnapshot(scenario, fixture, 'after-upload'), initial, 'upload is read-only');
      let beforeCommit = initial;
      if (name === 'stale-review') {
        await frames(page); await drain();
        const requestCount = scenario.http.length;
        await confirmAction(page, scenario, false);
        await frames(page); await drain();
        assert.equal(scenario.http.length, requestCount, 'cancel sends no HTTP request');
        assert.equal(count(scenario, 'commit'), 0);
        assert.deepEqual(recordSnapshot(scenario, fixture, 'after-cancel'), initial);
        scenario.cancel = { requestsBefore: requestCount, requestsAfter: scenario.http.length };
        await fixture.write('same');
        beforeCommit = recordSnapshot(scenario, fixture, 'after-same-connection-child-write');
        assert.notDeepEqual(beforeCommit.rows.knowledge_items, initial.rows.knowledge_items,
          'the production server connection made a real child-table write');
        const [rejection, refresh] = await Promise.all([responseFor(page, 'commit'), responseFor(page, 'preview'),
          confirmAction(page, scenario, true)]);
        assert.equal(rejection.status(), 409);
        assert.equal((await bodyFor(rejection)).code, 'IMPORT_PREVIEW_STALE');
        assert.equal(refresh.status(), 200);
        const refreshed = await bodyFor(refresh);
        assert.equal(refreshed.token, review.token); assert.equal(refreshed.mode, mode);
        assert.notEqual(refreshed.previewToken, review.previewToken);
        assert.notEqual(refreshed.revision, review.revision);
        await ready(page, mode, '预览已刷新');
        await frames(page); await drain();
        scenario.ui.staleReview = await ui(page);
        assert.equal(count(scenario, 'commit'), 1, 'refresh never automatically commits');
        assert.equal(count(scenario, 'preview'), 1);
        assert.deepEqual(recordSnapshot(scenario, fixture, 'after-stale-rejection'), beforeCommit,
          '409 and automatic preview preserve all current SQLite rows and schema');
        await screenshots(page, scenario, 'requires-second-confirmation');
        await drain();
        assert.equal(count(scenario, 'commit'), 1, 'only the first explicit confirmation has sent a commit');
        assert.deepEqual(recordSnapshot(scenario, fixture, 'before-second-confirmation'), beforeCommit);
      } else if (name === 'expired-upload') {
        const clock = await fixture.control('state'); scenario.clock.push(clock);
        assert.equal(clock.timers.length, 1);
        assert.equal(clock.timers[0].active, true);
        assert.equal(clock.timers[0].requestedMilliseconds, 900000);
        const expired = await fixture.control('expire', { timer: clock.timers[0].id }); scenario.clock.push(expired);
        assert.equal(expired.timers[0].active, false, 'the genuine retained-upload expiry callback ran');
        const [response] = await Promise.all([responseFor(page, 'commit'), confirmAction(page, scenario, true)]);
        assert.equal(response.status(), 410); assert.equal((await bodyFor(response)).code, 'IMPORT_EXPIRED');
        await page.locator('#data-transfer-status').filter({ hasText: '导入文件已过期，请重新选择备份文件' }).waitFor();
        await frames(page); await drain();
        scenario.ui.expired = await ui(page);
        assert.equal(count(scenario, 'commit'), 1); assert.equal(count(scenario, 'preview'), 0);
        assert.deepEqual(recordSnapshot(scenario, fixture, 'after-expired-rejection'), initial,
          'expiry and 410 preserve all current SQLite rows and schema');
        await screenshots(page, scenario, 'expired', [1280]);
        const recovered = await upload(page, fixture, mode, bodyFor, scenario);
        assert.notEqual(recovered.token, review.token);
        scenario.ui.reuploaded = await ui(page);
        await frames(page); await drain();
        assert.equal(count(scenario, 'commit'), 1, 'reupload still needs an explicit confirmation');
        assert.equal(count(scenario, 'validate'), 2);
        assert.deepEqual(recordSnapshot(scenario, fixture, 'after-fresh-upload'), initial);
      } else {
        await fixture.write('same');
        beforeCommit = recordSnapshot(scenario, fixture, 'after-same-connection-child-write');
        assert.notDeepEqual(beforeCommit.rows.knowledge_items, initial.rows.knowledge_items);
        scenario.routeErrors = [];
        // Delay only the genuine automatic preview request. No response is
        // mocked: the production TTL callback removes the retained token before
        // the real preview handler receives its ordinary HTTP request.
        await page.route('**/api/data/import/preview', async route => {
          try {
            const clock = await fixture.control('state'); scenario.clock.push(clock);
            const active = clock.timers.filter(timer => timer.active);
            assert.equal(active.length, 1); assert.equal(active[0].requestedMilliseconds, 900000);
            scenario.clock.push(await fixture.control('expire', { timer: active[0].id }));
            await route.continue();
          } catch (error) { scenario.routeErrors.push(failure(error)); await route.abort(); }
        }, { times: 1 });
        const [rejection, refresh] = await Promise.all([responseFor(page, 'commit'), responseFor(page, 'preview'),
          confirmAction(page, scenario, true)]);
        assert.equal(rejection.status(), 409);
        assert.equal((await bodyFor(rejection)).code, 'IMPORT_PREVIEW_STALE');
        assert.equal(refresh.status(), 410);
        const expired = await bodyFor(refresh);
        assert.equal(expired.code, 'IMPORT_EXPIRED');
        assert.equal(expired.error, '导入文件已过期，请重新选择备份文件');
        await page.waitForFunction(() => {
          const get = id => document.getElementById(id);
          return !get('data-import').disabled && !get('data-import-append').disabled &&
            /导入文件已过期|预览已刷新/.test(get('data-transfer-status').textContent);
        }, null, { timeout });
        await frames(page); await drain();
        scenario.ui.expiredRefresh = await ui(page);
        assert.deepEqual(scenario.routeErrors, []);
        assert.equal(count(scenario, 'commit'), 1, 'failed automatic preview cannot commit');
        assert.equal(count(scenario, 'preview'), 1);
        assert.deepEqual(recordSnapshot(scenario, fixture, 'after-stale-refresh-expiry'), beforeCommit,
          '409 followed by a real preview 410 changes no SQLite rows or schema');
        assert.equal(fixture.calls.length, 0); assert.deepEqual(scenario.pageErrors, []);
        await screenshots(page, scenario, 'expired-preview-error', [1280]);
        assert.equal(scenario.ui.expiredRefresh.confirmDisabled, true);
        assert.ok(scenario.ui.expiredRefresh.status.includes(expired.error),
          `failed stale refresh must preserve the real 410 error; UI said: ${scenario.ui.expiredRefresh.status}`);
        assert.doesNotMatch(scenario.ui.expiredRefresh.status, /预览已刷新/,
          'the UI must not claim a failed preview refreshed successfully');
        const recovered = await upload(page, fixture, mode, bodyFor, scenario);
        assert.notEqual(recovered.token, review.token);
        scenario.ui.reuploaded = await ui(page);
        assert.equal(count(scenario, 'commit'), 1);
        assert.deepEqual(recordSnapshot(scenario, fixture, 'after-fresh-upload'), beforeCommit);
      }
      await committed(page, scenario, fixture, beforeCommit, mode === 'append' ? '追加完成：新增 1 条，跳过 0 条' : '数据覆盖完成', bodyFor);
      await drain();
      assert.equal(count(scenario, 'commit'), 2, 'exactly two accepted dialogs issued exactly two HTTP commits');
      assert.deepEqual(scenario.http.filter(row => row.path.endsWith('/import/commit')).map(row => row.status),
        name === 'expired-upload' ? [410, 200] : [409, 200]);
      assert.deepEqual(scenario.pageErrors, []);
      assert.ok(scenario.http.every(row => !row.bodyError && !row.failure), 'HTTP evidence is complete');
      scenario.checks.browserProtocol = { complete: true, ok: true };
      // Restart the actual child, after closing the old-origin page. Reading
      // stopped job states also proves importing never implicitly resumes them.
      await deadline(() => context.close(), 5000, 'browser context close before restart'); context = null;
      await fixture.restart();
      assert.equal((await fixture.request('/api/listenings', { method: 'GET' })).status, 200);
      scenario.unfinishedAfterRestart = importedWorkObservation(fixture);
      assert.deepEqual(scenario.unfinishedAfterRestart, scenario.unfinishedAfterCommit);
      recordSnapshot(scenario, fixture, 'after-process-restart');
      assert.equal(fixture.calls.length, 0);
      scenario.checks.importedWorkStopped = { complete: true, ok: true };
      scenario.complete = true; scenario.ok = true;
    } catch (error) {
      scenario.error = failure(error);
      throw error;
    } finally {
      if (fixture) {
        scenario.providerCalls = [...fixture.calls]; scenario.lifecycle = [...fixture.lifecycle];
        scenario.clockEvents = [...fixture.clockEvents];
      }
      const cleanups = [['browser context', () => context?.close()], ['fixture', () => fixture?.close()]];
      const results = await Promise.allSettled(cleanups.map(([label, close]) => deadline(close, 8000, `${label} cleanup`)));
      if (fixture) scenario.providerCalls = [...fixture.calls];
      scenario.cleanup = results.map((result, index) => ({ target: cleanups[index][0], ok: result.status === 'fulfilled',
        ...(result.status === 'rejected' ? { error: failure(result.reason) } : {}) }));
      if (results.some(result => result.status === 'rejected')) scenario.complete = scenario.ok = false;
      if (scenario.pageErrors.length || scenario.providerCalls.length) {
        scenario.complete = scenario.ok = false;
        scenario.error ||= { name: 'AssertionError', message: 'Page errors or provider requests were observed' };
      }
      scenario.finishedAt = new Date().toISOString();
      await save();
      assert.ok(scenario.cleanup.every(row => row.ok), 'scenario cleanup finished successfully');
    }
  }
} catch (error) {
  observations.errors.push(failure(error));
} finally {
  try {
    await deadline(() => browser?.close(), 8000, 'Chromium cleanup');
    observations.cleanup.push({ target: 'Chromium', ok: true });
  } catch (error) { observations.cleanup.push({ target: 'Chromium', ok: false, error: failure(error) }); }
  try {
    observations.sourceEnd = await importBrowserSourceStamp();
    assert.deepEqual(observations.sourceEnd, observations.sourceStart, 'executed source/helper digests stayed unchanged');
  } catch (error) { observations.errors.push(failure(error)); }
  observations.finishedAt = new Date().toISOString();
  const summary = summarizeImportBrowserEvidence(observations);
  observations.complete = summary.complete;
  observations.ok = summary.ok;
  await save();
}
console.log(JSON.stringify({ directory, complete: observations.complete, ok: observations.ok,
  scenarios: observations.scenarios.map(({ mode, name, complete, ok, error }) => ({ mode, name, complete, ok, error })),
  errors: observations.errors }));
process.exitCode = observations.ok ? 0 : 1;
