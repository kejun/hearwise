import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { speechFixture } from '../test-support/speech-fixture.mjs';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
function seed(store, title) {
  const run = store.createRun(null, settings, title);
  const segment = store.addSegment(run.listeningId, run.runId, { id: 's1', text: 'Acme Camera.' }).segment;
  store.setTranslation(segment.id, '相机。', false); store.finishRun(run.runId); return run;
}
const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-import-browser-'));
const fixture = await speechFixture({ seed(store) { return seed(store, '本地收听 <img onerror=alert(1)>'); } });
let browser;
try {
  const backup = path.join(directory, 'backup.sqlite');
  await writeFile(backup, Buffer.from(await (await fetch(`${fixture.base}/api/data/export`)).arrayBuffer()));
  const source = new ListeningStore(backup);
  const added = seed(source, '追加的收听'); source.close();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'local-test-only'));
  await page.goto(fixture.base);
  const open = async () => { await page.locator('#settings-trigger').click(); await page.locator('#tab-data-button').click(); };
  const summary = page.locator('#data-import-summary'), mode = page.locator('#data-import-append'), confirm = page.locator('#data-import-confirm');
  await open();
  assert.equal(await mode.isChecked(), false);
  await page.locator('#data-import-file').setInputFiles(backup);
  await summary.filter({ hasText: '覆盖：完整替换当前数据' }).waitFor();
  assert.equal(await confirm.textContent(), '确认覆盖');
  await mode.check();
  await summary.filter({ hasText: '新增 1 条，跳过 1 条' }).waitFor();
  assert.equal(await confirm.textContent(), '确认追加');
  await page.locator('#data-import-skipped summary').click();
  assert.match(await page.locator('#data-import-skipped-list').textContent(), /<img onerror/);
  assert.equal(await page.locator('#data-import-skipped-list img').count(), 0);
  // An older response must not put the UI back into the prior mode.
  await mode.uncheck(); await summary.filter({ hasText: '覆盖：完整替换当前数据' }).waitFor();
  let releaseOld;
  const oldResponseGate = new Promise(resolve => { releaseOld = resolve; });
  let oldFetched;
  const fetched = new Promise(resolve => { oldFetched = resolve; });
  await page.route('**/api/data/import/preview', async route => {
    const response = await route.fetch(); oldFetched(); await oldResponseGate; await route.fulfill({ response });
  }, { times: 1 });
  await mode.check(); await fetched;
  assert.equal(await confirm.isDisabled(), true);
  await mode.uncheck(); await summary.filter({ hasText: '覆盖：完整替换当前数据' }).waitFor();
  const delivered = page.waitForResponse(response => response.url().endsWith('/api/data/import/preview') && response.ok());
  releaseOld(); await delivered;
  assert.equal(await mode.isChecked(), false); assert.equal(await confirm.textContent(), '确认覆盖');
  await mode.check(); await summary.filter({ hasText: '新增 1 条，跳过 1 条' }).waitFor();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.locator('#tab-data').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    if (process.env.DATA_TRANSFER_EVIDENCE_DIR) {
      await mkdir(process.env.DATA_TRANSFER_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.DATA_TRANSFER_EVIDENCE_DIR, `data-transfer-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1280, height: 950 });
  page.once('dialog', dialog => dialog.dismiss()); await confirm.click();
  assert.equal((await fetch(`${fixture.base}/api/listenings`).then(r => r.json())).total, 1);
  // A modification after preview is rejected; the UI fetches a fresh review and
  // requires a second explicit confirmation.
  await page.request.patch(`${fixture.base}/api/listenings/${fixture.seeded.listeningId}`, { data: { title: '本地修改保留', notes: 'local notes' } });
  page.once('dialog', dialog => { assert.match(dialog.message(), /将新增 1 条收听，跳过 1 条/); return dialog.accept(); });
  await confirm.click();
  await page.locator('#data-transfer-status').filter({ hasText: '预览已刷新' }).waitFor();
  assert.equal((await fetch(`${fixture.base}/api/listenings`).then(r => r.json())).total, 1);
  page.once('dialog', dialog => dialog.accept()); await confirm.click();
  await page.locator('#data-transfer-status').filter({ hasText: '追加完成：新增 1 条，跳过 1 条' }).waitFor();
  assert.match(await page.locator('#data-transfer-status').textContent(), /before-import/);
  let history = await fetch(`${fixture.base}/api/listenings`).then(r => r.json());
  assert.equal(history.total, 2); assert.equal(history.items.find(x => x.id === fixture.seeded.listeningId).title, '本地修改保留');
  assert.ok(history.items.some(x => x.id === added.listeningId));
  await page.locator('#close-settings').click(); await page.waitForLoadState(); await open();
  assert.equal(await mode.isChecked(), false);
  await mode.check(); await page.locator('#data-import-file').setInputFiles(backup);
  await page.locator('#data-transfer-status').filter({ hasText: '没有可追加的数据' }).waitFor();
  assert.equal(await confirm.isDisabled(), true);
  await mode.uncheck(); await summary.filter({ hasText: '覆盖：完整替换当前数据' }).waitFor();
  page.once('dialog', dialog => { assert.match(dialog.message(), /完整替换/); return dialog.accept(); });
  await confirm.click(); await page.locator('#data-transfer-status').filter({ hasText: '数据覆盖完成' }).waitFor();
  history = await fetch(`${fixture.base}/api/listenings`).then(r => r.json());
  assert.equal(history.items.find(x => x.id === fixture.seeded.listeningId).title, '本地收听 <img onerror=alert(1)>');
  assert.equal(fixture.stats.providerRequests.length, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['default replacement', 'append/replace mode previews', 'out-of-order responses',
    'safe skipped titles', 'desktop/390/320 layout', 'cancel', 'stale review refresh', 'append preserves edits',
    'backup summary', 'mode reset', 'repeat no-op', 'replacement', 'no model calls', 'no page errors'] }));
} finally { await browser?.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
