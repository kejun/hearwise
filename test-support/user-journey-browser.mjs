// Complete UI journey over ONE empty SQLite store per viewport. Public GETs and
// native read-only SQLite are oracles; all user mutations go through rendered UI.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { userJourneyFixture, journeyText } from './user-journey-fixture.mjs';
import { databaseSnapshot } from './import-protocol-fixture.mjs';
import { journeyWidths, journeyStages } from './user-journey-contract.mjs';
import { observeJourneyPage, journeyUi, safeJourneyValue, staleJourneyEditorVariant } from './user-journey-observer.mjs';
import { deadline } from './lifecycle.mjs';
import { journeyRecord } from '../scripts/lib/user-journey-evidence.mjs';
import { sourceVersion, digest, writeJson } from '../scripts/lib/verification-evidence.mjs';

const directory = path.resolve(process.argv[2]); await mkdir(directory, { recursive: true });
const now = () => new Date().toISOString();
const report = { schemaVersion: 1, profile: 'user-journey', source: sourceVersion(), startedAt: now(), finishedAt: null,
  chromium: null, playwright: JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8')).version,
  complete: false, widths: [], cleanup: [] };
const persist = () => writeJson(path.join(directory, 'browser.json'), report);
async function until(read, test, label, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (test(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Journey deadline: ' + label);
}
let browser;
async function journey(width) {
  const fixture = await userJourneyFixture(), contexts = [], observers = [];
  const row = { width, fixtureId: fixture.fixtureId, base: fixture.base, startedAt: now(), finishedAt: null, complete: false,
    mainId: null, unrelatedId: null, itemId: null, stages: [], actions: [], http: [], websockets: [], providerLedger: [], served: [],
    errors: [], cleanup: [], downloads: [], exportResponses: [], faults: [], clockEvents: [], ttsLedger: [], negative: null };
  report.widths.push(row);
  let a, competitor, failed = false;
  const dbPathSha256 = digest(fixture.seeded.filename);
  const action = (client, type, target, value) => { const entry = { index: row.actions.length, contextId: client?.id ?? 'supplier', at: now(), type, target, ...(value === undefined ? {} : { value }) }; row.actions.push(entry); return entry.index; };
  const click = async (client, selector) => { action(client, 'click', selector); await client.page.locator(selector).click(); };
  const fill = async (client, selector, value) => { action(client, 'fill', selector, selector === '#key' ? '[synthetic credential omitted]' : value); await client.page.locator(selector).fill(value); };
  const press = async (client, selector, key) => { action(client, 'press', selector, key); await client.page.locator(selector).focus(); await client.page.keyboard.press(key); };
  const get = async suffix => {
    const response = await fetch(fixture.base + suffix, { signal: AbortSignal.timeout(3000) });
    if (response.status === 404) return null; assert.equal(response.status, 200); return response.json();
  };
  const detail = () => get(`/api/listenings/${row.mainId}`);
  const graph = () => get(`/api/listenings/${row.mainId}/graph`);
  const snapshot = () => fixture.snapshot();
  const frames = client => client.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function client(suffix, mutation) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, acceptDownloads: true }); contexts.push(context);
    const page = await context.newPage(); page.setDefaultTimeout(7000); const value = { context, page, id: `${width}-${suffix}` };
    value.observer = await observeJourneyPage(page, row, value.id); observers.push(value.observer);
    if (mutation) await page.route('**/knowledge-editor.js', route => route.fulfill({ contentType: 'text/javascript', body: mutation.changed }));
    action(value, 'goto', fixture.base); await page.goto(fixture.base); return value;
  }
  async function capture(name, client = a, extra = {}) {
    assert.equal(name, journeyStages[row.stages.length], 'fixed continuous stage ordering');
    await client.observer.drain(); await frames(client);
    const database = snapshot(), publicDetail = row.mainId ? await detail() : null, publicGraph = row.mainId ? await graph() : null;
    const ui = await journeyUi(client.page); await client.observer.drain();
    const item = { index: row.stages.length, name, at: now(), contextId: client.id, dbPathSha256,
      selectedId: client.selectedId ?? null, database, detail: publicDetail, graph: publicGraph, ui,
      actionThrough: row.actions.length, httpThrough: row.http.length, providerThrough: fixture.providerLedger.length, websocketThrough: row.websockets.length,
      screenshot: `journey-${width}-${name}.png`, ...extra };
    assert.equal(database.integrity, 'ok'); assert.deepEqual(database.foreignKeyErrors, []);
    assert.ok(item.ui.viewport.scrollWidth <= width, `no horizontal overflow at ${name}`);
    await client.page.screenshot({ path: path.join(directory, item.screenshot) }); row.stages.push(item); await persist(); return item;
  }
  async function configure(client) {
    await click(client, '#settings-trigger'); await click(client, '#tab-connection-button');
    action(client, 'fill', 'API Key', '[synthetic credential omitted]'); await client.page.getByLabel('API Key', { exact: true }).fill('journey-synthetic-only');
    await press(client, '#tab-connection-button', 'ArrowRight');
    assert.equal(await client.page.locator('#tab-language-button').evaluate(node => node === document.activeElement && node.getAttribute('aria-selected') === 'true'), true);
    action(client, 'select', '#source-language', 'en'); await client.page.locator('#source-language').selectOption('en');
    action(client, 'select', '#target-language', 'Chinese'); await client.page.locator('#target-language').selectOption('Chinese');
    await click(client, '#tab-connection-button');
    action(client, 'click', '保存并继续'); await client.page.getByRole('button', { name: '保存并继续', exact: true }).click();
  }
  async function metadata(client, title, notes) {
    await click(client, '#edit-record'); await fill(client, '#record-title-input', title); await fill(client, '#record-notes-input', notes);
    await click(client, '#save-record'); await client.page.locator('#record-editor').waitFor({ state: 'hidden' });
    await client.page.locator('#record-title').filter({ hasText: title }).waitFor();
  }
  async function open(client, title, id) {
    await click(client, '#history-listening'); action(client, 'click', `查看“${title}”`);
    await client.page.getByRole('button', { name: `查看“${title}”`, exact: true }).click(); client.selectedId = id;
    await client.page.locator('#record-title').filter({ hasText: title }).waitFor();
    await client.page.locator('#record-loading').waitFor({ state: 'hidden' });
  }
  async function startRecord(client, title, main = false) {
    const framesBefore = fixture.stats.audioFrames;
    await press(client, '#toggle', 'Enter'); await client.page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
    const ready = await until(() => row.websockets.filter(ws => ws.contextId === client.id && ws.path === '/ws').at(-1)?.received.find(event => event.type === 'listening-ready'), Boolean, 'real listening-ready');
    client.selectedId = ready.listeningId; if (main) row.mainId = ready.listeningId; else row.unrelatedId = ready.listeningId;
    await until(() => fixture.stats.audioFrames, value => value > framesBefore, 'actual microphone PCM');
    if (main) await capture('listening-started');
    for (const [index, text] of journeyText.original.entries()) {
      action(null, 'supplier-final', ready.listeningId, { text, sentenceId: `journey-${title}-${index}` });
      fixture.final(text, true, `journey-${title}-${index}`);
    }
    await until(() => get(`/api/listenings/${ready.listeningId}`), value => value.segments.length === 2 && value.segments.every(segment => segment.translation_state === 'complete'), 'authored translations persisted');
    await client.page.locator('#translation').filter({ hasText: journeyText.translation[1] }).waitFor();
    if (main) await capture('captions');
    await press(client, '#toggle', 'Enter'); await client.page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
    const value = await until(() => get(`/api/listenings/${ready.listeningId}`), value => value.knowledge.length === 2 && value.jobs.length > 0 && value.jobs.every(job => job.state === 'complete'), 'complete knowledge extraction');
    await until(() => fixture.stats.asrClients.size, count => count === 0, 'ASR transport closed');
    await metadata(client, title, main ? 'Continuous main record' : 'Unrelated record must remain unchanged');
    await click(client, '#knowledge-view-list'); await client.page.locator('.knowledge-item[data-id]').first().waitFor();
    assert.deepEqual(value.segments.map(segment => segment.original_text), journeyText.original);
    assert.deepEqual(value.segments.map(segment => segment.translation_text), journeyText.translation);
    return value;
  }
  async function openEditor(client) {
    await click(client, '#knowledge-view-list'); const card = client.page.locator(`.knowledge-item[data-id="${row.itemId}"]`);
    if (!await card.evaluate(node => node.open)) { action(client, 'click', `knowledge:${row.itemId}:summary`); await card.locator('summary').click(); }
    action(client, 'click', `knowledge:${row.itemId}:correct-name`); await card.getByRole('button', { name: /^纠正 .* 的名称$/ }).click();
    await client.page.waitForFunction(() => !document.querySelector('#knowledge-edit-name').disabled);
  }
  async function keyboardReachName(client) {
    for (let step = 0; step < 10; step++) {
      if (await client.page.locator('#knowledge-edit-name').evaluate(node => node === document.activeElement)) return;
      action(client, 'press', 'document', 'Tab'); await client.page.keyboard.press('Tab');
    }
    assert.fail('The retained editor draft is not reachable with the keyboard');
  }
  async function saveName(client, name, { completed = true } = {}) {
    await fill(client, '#knowledge-edit-name', name); await press(client, '#knowledge-edit-name', 'Enter');
    if (completed) {
      await client.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
      await client.page.waitForFunction(({ id, name }) => document.querySelector(`.knowledge-item[data-id="${id}"] .knowledge-title-line strong`)?.textContent === name, { id: row.itemId, name });
    }
  }
  async function views(client, name) {
    await click(client, '#knowledge-view-list');
    await client.page.locator(`.knowledge-item[data-id="${row.itemId}"] .knowledge-title-line strong`).filter({ hasText: name }).waitFor();
    await click(client, '#knowledge-view-graph'); await client.page.locator('#graph-count').filter({ hasText: '2 / 2' }).waitFor();
    await client.page.locator('#graph-viewport canvas').first().waitFor({ state: 'visible' });
    if (!await client.page.locator('.graph-results').evaluate(node => node.open)) await click(client, '.graph-results > summary');
    if (!await client.page.locator('.graph-relations').evaluate(node => node.open)) await click(client, '.graph-relations > summary');
    await press(client, `[data-result-node-id="${row.itemId}"]`, 'Enter');
    await client.page.locator('#graph-detail-title').filter({ hasText: name }).waitFor();
    assert.equal(await client.page.locator('#graph-detail-title').textContent(), name);
    await press(client, '#graph-close', 'Enter');
  }
  async function openData(client) { await click(client, '#settings-trigger'); await click(client, '#tab-data-button'); }
  async function exportBackup(client, label) {
    await openData(client); const downloadPromise = client.page.waitForEvent('download'); const actionIndex = action(client, 'download', '#data-export');
    const startedAt = now();
    await client.page.locator('#data-export').click(); const download = await downloadPromise;
    const file = `journey-${width}-${label}.sqlite`; await download.saveAs(path.join(directory, file));
    assert.equal(await download.failure(), null); const bytes = await readFile(path.join(directory, file));
    const result = { name: label, path: file, url: download.url(), suggestedFilename: download.suggestedFilename(), startedAt, finishedAt: now(),
      sha256: digest(bytes), bytes: bytes.length, database: databaseSnapshot(path.join(directory, file)), actionIndex };
    row.downloads.push(result); return result;
  }
  async function closeData(client) { await click(client, '#close-settings'); await client.page.waitForLoadState(); }
  async function remove(client, title, id) {
    await click(client, '#history-listening');
    client.page.once('dialog', async dialog => { action(client, 'dialog-accept', 'delete-listening', dialog.message()); await dialog.accept(); });
    action(client, 'click', `删除“${title}”`); await client.page.getByRole('button', { name: `删除“${title}”`, exact: true }).click();
    await until(() => get('/api/listenings'), value => !value.items.some(item => item.id === id), 'UI deletion');
    await client.page.getByRole('button', { name: `查看“${title}”`, exact: true }).waitFor({ state: 'hidden' });
    if (client.selectedId === id) client.selectedId = null;
  }
  async function upload(client, backup) {
    const append = client.page.locator('#data-import-append');
    if (!await append.isChecked()) { action(client, 'check', '#data-import-append'); await append.check(); }
    action(client, 'upload', '#data-import-file', { path: backup.path, bytes: backup.bytes, sha256: backup.sha256 });
    await client.page.locator('#data-import-file').setInputFiles(path.join(directory, backup.path));
    await client.page.locator('#data-import-summary').filter({ hasText: '追加：新增 1 条，跳过 1 条' }).waitFor();
    await client.page.waitForFunction(() => !document.querySelector('#data-import-confirm').disabled && !document.querySelector('#data-import').disabled);
  }
  async function confirmImport(client) {
    client.page.once('dialog', async dialog => { assert.match(dialog.message(), /将新增 1 条收听，跳过 1 条/); action(client, 'dialog-accept', 'append-import', dialog.message()); await dialog.accept(); });
    await press(client, '#data-import-confirm', 'Enter');
  }

  try {
    a = await client('main'); await capture('empty'); assert.equal(snapshot().rows.listenings.length, 0); await configure(a);
    const created = await startRecord(a, 'Journey main', true); row.itemId = created.knowledge.find(item => item.canonical_name === 'Eastman Kodak').id;
    await capture('stopped');
    await click(a, '#knowledge-view-graph'); fixture.holdNextRelation(); await press(a, '#graph-generate', 'Enter');
    await until(() => fixture.heldRelations.length, count => count === 1, 'held real relation HTTP supplier');
    await capture('graph-held'); await press(a, '#graph-cancel', 'Enter');
    await until(graph, value => value.status.state === 'cancelled' && value.status.runningJobs === 0, 'graph cancel durable terminal');
    await capture('graph-cancelled');
    await a.page.locator('#graph-generate').waitFor({ state: 'visible' }); await press(a, '#graph-generate', 'Enter');
    await until(graph, value => value.relations.length === 1 && value.status.runningJobs === 0 && value.status.pendingJobs === 0, 'new legitimate round completes while old provider remains held');
    assert.equal(fixture.heldRelations[0].row.completedAt, null);
    await views(a, 'Eastman Kodak'); const beforeLate = await capture('graph-retry-complete');
    action(null, 'supplier-release', 'obsolete-relation', fixture.heldRelations[0].row.sequence); fixture.releaseRelations();
    await until(() => fixture.heldRelations[0].row.completedAt, Boolean, 'old physical supplier return');
    await until(() => fixture.heldRelations[0].row.transport.some(event => event.type === 'close'), Boolean, 'old HTTP socket completion/closure');
    const afterLate = await capture('graph-late-completed', a, { cancellation: { oldProviderSequence: fixture.heldRelations[0].row.sequence,
      transportClaim: 'Physical provider completion after cancellation; no claim that a disconnected response reached an application callback.', applicationLateCallbackEvidence: 'same-source generation-isolation profile required separately' } });
    assert.deepEqual(afterLate.database, beforeLate.database);
    await click(a, '#new-listening'); await startRecord(a, 'Journey unrelated'); await capture('unrelated-created');
    const unrelatedBefore = journeyRecord(snapshot(), row.unrelatedId); await open(a, 'Journey main', row.mainId);
    await openEditor(a); await saveName(a, 'Kodak'); await views(a, 'Kodak'); await capture('name-corrected');
    assert.deepEqual(journeyRecord(snapshot(), row.unrelatedId), unrelatedBefore);
    // Competing actual page starts from the same revision; neither browser writes
    // through page.request/fetch. A rejected draft requires an explicit next save.
    competitor = await client('competitor'); await open(competitor, 'Journey main', row.mainId);
    await openEditor(a); await openEditor(competitor); await capture('conflict-opened', competitor);
    await saveName(a, 'Kodak Company'); await saveName(competitor, 'Eastman Kodak Company', { completed: false });
    await competitor.page.locator('#knowledge-edit-status').filter({ hasText: '已读取最新内容，输入已保留' }).waitFor();
    await keyboardReachName(competitor); await capture('conflict-rejected', competitor);
    await press(competitor, '#knowledge-edit-name', 'Enter'); await competitor.page.locator('#knowledge-editor').waitFor({ state: 'hidden' });
    await views(competitor, 'Eastman Kodak Company'); await capture('conflict-recovered', competitor);
    await open(a, 'Journey main', row.mainId);
    const nameUrl = `${fixture.base}/api/listenings/${row.mainId}/knowledge/${row.itemId}/name-replacements`;
    async function lostResponse(name, receiptUnavailable) {
      await openEditor(a);
      if (receiptUnavailable) await a.page.route(`${fixture.base}/api/listenings/${row.mainId}/knowledge/${row.itemId}/edits/**`, route =>
        route.fulfill({ status: 502, contentType: 'text/html', body: 'Synthetic unavailable receipt' }), { times: 1 });
      await a.page.route(nameUrl, async route => {
        const response = await route.fetch(); const body = await response.json(); assert.equal(response.status(), 200);
        row.faults.push({ kind: receiptUnavailable ? 'unknown-save' : 'receipt-recovery', contextId: a.id, at: now(), request: route.request().postDataJSON(),
          idempotencyKey: route.request().headers()['idempotency-key'], status: response.status(), response: safeJourneyValue(body) });
        await route.fulfill({ status: 502, contentType: 'text/html', body: 'Synthetic lost success after actual database commit' });
      }, { times: 1 });
      await saveName(a, name, { completed: !receiptUnavailable });
    }
    await lostResponse('Kodak Incorporated', false); await views(a, 'Kodak Incorporated'); await capture('receipt-recovered');
    await lostResponse('Kodak Final', true); await a.page.locator('#knowledge-edit-status').filter({ hasText: '保存结果尚未确认' }).waitFor();
    await keyboardReachName(a); await capture('save-uncertain'); await press(a, '#knowledge-edit-close', 'Enter'); await openEditor(a);
    assert.equal(await a.page.locator('#knowledge-edit-name').inputValue(), 'Kodak Final'); await capture('save-reopened');
    await press(a, '#knowledge-edit-close', 'Enter'); await views(a, 'Kodak Final');
    const corrected = [journeyText.original[0].replace('Eastman Kodak', 'Kodak Final'), journeyText.original[1]];
    const persisted = await detail(); assert.deepEqual(persisted.segments.map(segment => segment.original_text), corrected);
    assert.deepEqual(persisted.segments.map(segment => segment.translation_text), journeyText.translation);
    assert.deepEqual(journeyRecord(snapshot(), row.unrelatedId), unrelatedBefore);
    for (const [kind, expected, label] of [['original', corrected, 'source-played'], ['translation', journeyText.translation, 'translation-played']]) {
      const from = fixture.stats.commits.length, socketFrom = row.websockets.length;
      await press(a, `#transcript-speech-${kind}`, 'Enter');
      await a.page.locator('#transcript-speech-status').filter({ hasText: kind === 'original' ? '原文全文播报完成' : '译文全文播报完成' }).waitFor();
      await until(() => row.websockets.slice(socketFrom).filter(ws => ws.path === '/ws/tts').every(ws => ws.closedAt), Boolean, 'full speech transport closed');
      assert.deepEqual(fixture.stats.commits.slice(from), expected);
      await capture(label, a, { playback: { kind, expected, commitFrom: from, commits: fixture.stats.commits.slice(from), sockets: structuredClone(row.websockets.slice(socketFrom)) } });
    }
    fixture.holdTts(true); const seekFrom = fixture.stats.commits.length, seekSocketFrom = row.websockets.length;
    await press(a, '#transcript-speech-translation', 'Enter'); await until(() => fixture.heldSpeech.length, count => count === 1, 'held first speech unit');
    await click(a, '#transcript-speech-pause'); await a.page.locator('#transcript-speech-pause').filter({ hasText: '继续播报' }).waitFor();
    await press(a, '#transcript-speech-seek', 'End');
    await until(() => row.websockets.slice(seekSocketFrom).filter(ws => ws.path === '/ws/tts'), values => values.length === 2 && values[1].received.some(event => event.type === 'speech.ready'), 'paused seek creates current transport');
    assert.deepEqual(fixture.stats.commits.slice(seekFrom), [journeyText.translation[0]]);
    await capture('paused-seek', a, { playback: { commitFrom: seekFrom, commits: fixture.stats.commits.slice(seekFrom), sockets: structuredClone(row.websockets.slice(seekSocketFrom)) } });
    await click(a, '#transcript-speech-pause'); await until(() => fixture.heldSpeech.length, count => count === 2, 'resume current last speech unit');
    await until(() => fixture.heldSpeech[0].request.ws.readyState, value => value === 3, 'old provider transport closed');
    assert.equal(fixture.heldSpeech[0].deliver(), false); assert.equal(fixture.heldSpeech[1].deliver(), true); fixture.holdTts(false);
    await a.page.locator('#transcript-speech-status').filter({ hasText: '译文全文播报完成' }).waitFor();
    await capture('seek-resumed', a, { playback: { commitFrom: seekFrom, commits: fixture.stats.commits.slice(seekFrom), sockets: structuredClone(row.websockets.slice(seekSocketFrom)) } });
    await open(a, 'Journey main', row.mainId); await views(a, 'Kodak Final'); await capture('history-reopened');
    action(a, 'close-context', 'main-context'); await deadline(() => a.context.close(), 3000, 'close original context');
    a = await client('reopened'); await open(a, 'Journey main', row.mainId); await views(a, 'Kodak Final'); await capture('context-reopened');
    const first = await exportBackup(a, 'initial'); await capture('exported'); await closeData(a);
    await remove(a, 'Journey unrelated', row.unrelatedId); await capture('unrelated-deleted');
    await openData(a); await upload(a, first); await capture('import-reviewed-stale');
    await open(competitor, 'Journey main', row.mainId); await metadata(competitor, 'Journey main', 'Local metadata changed after import preview');
    const beforeStale = snapshot(); await confirmImport(a); await a.page.locator('#data-transfer-status').filter({ hasText: '预览已刷新' }).waitFor();
    await capture('import-stale-rejected'); assert.deepEqual(snapshot(), beforeStale);
    const timers = await fixture.importClock('state'), timer = timers.timers.find(value => value.active); assert.ok(timer);
    action(null, 'clock-expire', 'production-import-ttl', { timer: timer.id, requestedMilliseconds: timer.requestedMilliseconds });
    await fixture.importClock('expire', { timer: timer.id }); await capture('import-token-expired');
    await confirmImport(a); await a.page.locator('#data-transfer-status').filter({ hasText: '导入文件已过期' }).waitFor();
    await capture('import-expiry-rejected'); assert.deepEqual(snapshot(), beforeStale);
    await upload(a, first); await capture('import-reuploaded'); await confirmImport(a);
    await a.page.locator('#data-transfer-status').filter({ hasText: '追加完成：新增 1 条，跳过 1 条' }).waitFor();
    await capture('import-collision-preserved'); assert.deepEqual(journeyRecord(snapshot(), row.mainId), journeyRecord(beforeStale, row.mainId));
    await closeData(a); await open(a, 'Journey main', row.mainId); await views(a, 'Kodak Final');
    const last = await exportBackup(a, 'final'); await capture('final-exported'); await closeData(a);
    await remove(a, 'Journey main', row.mainId); await capture('main-deleted');
    await openData(a); await upload(a, last); await capture('import-reviewed'); await confirmImport(a);
    await a.page.locator('#data-transfer-status').filter({ hasText: '追加完成：新增 1 条，跳过 1 条' }).waitFor();
    await capture('import-restored'); assert.deepEqual(snapshot(), last.database, 'same exported identities and complete durable content restored');
    await closeData(a); await open(a, 'Journey main', row.mainId); await views(a, 'Kodak Final');
    await capture('restored-reopened'); assert.deepEqual(snapshot(), last.database);
    // Mutation uses the actual editor module in a new page on this same store.
    // The UI is deliberately NOT reopened/refreshed before checking stale output.
    const variant = await staleJourneyEditorVariant(), broken = await client('negative', variant);
    await open(broken, 'Journey main', row.mainId); await openEditor(broken); const before = { at: now(), contextId: broken.id, dbPathSha256, selectedId: broken.selectedId, actionThrough: row.actions.length, httpThrough: row.http.length, database: snapshot(), ui: await journeyUi(broken.page) };
    const post = broken.page.waitForResponse(response => response.url() === nameUrl && response.status() === 200);
    await fill(broken, '#knowledge-edit-name', 'Kodak Broken Refresh'); await press(broken, '#knowledge-edit-name', 'Enter'); await post;
    await broken.page.locator('#knowledge-editor').waitFor({ state: 'hidden' }); await frames(broken); await broken.observer.drain();
    const after = { at: now(), contextId: broken.id, dbPathSha256, selectedId: broken.selectedId, actionThrough: row.actions.length, httpThrough: row.http.length, database: snapshot(), ui: await journeyUi(broken.page) };
    assert.equal(after.database.rows.knowledge_items.find(item => item.id === row.itemId).canonical_name, 'Kodak Broken Refresh');
    assert.equal(after.ui.knowledge.find(item => item.id === row.itemId).name, 'Kodak Final', 'omitted real onSaved callback leaves the visible list stale');
    const screenshot = `journey-${width}-negative.png`; await broken.page.screenshot({ path: path.join(directory, screenshot) });
    row.negative = { contextId: broken.id, property: 'HW-11-06', before, after, screenshot,
      mutation: Object.fromEntries(['file', 'anchor', 'replacement', 'sourceSha256', 'mutantSha256'].map(key => [key, variant[key]])) };
    assert.deepEqual(row.stages.map(stage => stage.name), journeyStages); assert.deepEqual(row.errors, []); row.complete = true;
  } catch (error) {
    failed = true; row.failure = { name: error.name, message: error.message }; process.exitCode = 1;
    try {
      row.failure.database = snapshot(); row.failure.logs = fixture.logs();
      if (a && !a.page.isClosed()) { row.failure.ui = await journeyUi(a.page); row.failure.dom = await a.page.content(); await a.page.screenshot({ path: path.join(directory, `journey-${width}-failure.png`) }); }
    } catch (diagnostic) { row.failure.diagnosticError = diagnostic.message; }
    await persist(); throw error;
  } finally {
    row.cleanupStartedAt = now();
    try { fixture.releaseRelations(); } catch (error) { row.errors.push({ message: error.message, phase: 'release-held-provider' }); }
    // Diagnostics are best-effort independently of resource closure. Their
    // failures remain gate failures but cannot prevent contexts/server cleanup.
    const diagnostics = await Promise.allSettled([
      ...observers.map(observer => deadline(() => observer.drain(), 3000, 'Journey observation cleanup')),
      deadline(() => fixture.workletCapture.read(), 3000, 'Journey worklet observations')
    ]);
    for (const [index, result] of diagnostics.entries()) {
      if (result.status === 'rejected') row.errors.push({ message: result.reason?.message ?? String(result.reason), phase: 'diagnostic-cleanup' });
      else if (index === observers.length) {
        row.exportResponses.push(...result.value.filter(value => value.kind === 'data-export'));
        row.served.push(...result.value.filter(value => value.kind !== 'data-export'));
      }
    }
    try {
      row.providerLedger = structuredClone(fixture.providerLedger); row.ttsLedger = structuredClone(fixture.ttsLedger); row.clockEvents = structuredClone(fixture.clockEvents);
      row.audioFrames = fixture.stats.audioFrames;
    } catch (error) { row.errors.push({ message: error.message, phase: 'copy-ledgers' }); }
    const results = await Promise.allSettled([...contexts.map((context, index) => deadline(() => context.close(), 3000, `Journey context ${index} cleanup`)), fixture.close()]);
    row.cleanup = results.map((result, index) => ({ resource: index < contexts.length ? `context-${index}` : 'fixture', status: result.status,
      ...(result.status === 'rejected' ? { error: String(result.reason?.message ?? result.reason) } : {}) }));
    try { row.serverLog = fixture.logs(); await writeFile(path.join(directory, `journey-${width}-server.log`), row.serverLog); }
    catch (error) { row.errors.push({ message: error.message, phase: 'server-log-save' }); }
    row.finishedAt = now();
    try { await persist(); } catch (error) { console.error('Journey report save failed after resource closure:', error.message); if (!failed) throw error; }
    if (!failed && (row.errors.length || row.cleanup.some(item => item.status !== 'fulfilled'))) throw new Error('Journey diagnostic collection or cleanup failed');

  }
}
try {
  // Identical supported CI launch policy to the existing speech browser suite.
  // This program is not launched in denied local environments.
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  report.chromium = browser.version();
  for (const width of journeyWidths) await journey(width);
  report.complete = true;
} catch (error) { report.failure = { name: error.name, message: error.message }; console.error(error.stack); process.exitCode = 1; }
finally {
  report.cleanupStartedAt = now();
  try { await deadline(() => browser?.close(), 3000, 'Journey Chromium close'); report.cleanup.push({ resource: 'chromium', status: 'fulfilled' }); }
  catch (error) { report.cleanup.push({ resource: 'chromium', status: 'rejected', error: error.message }); process.exitCode = 1; }
  report.finishedAt = now(); await persist();
}
