import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { importAtomicityFixture, afterImport, importedSnapshot } from './import-atomicity-fixture.mjs';
import { databaseSnapshot } from './import-protocol-fixture.mjs';
import { observeImportFetch } from './import-protocol-browser-observer.mjs';
import { deadline } from './lifecycle.mjs';
import { hash } from './import-atomicity-evidence.mjs';
import { writeJson } from '../scripts/lib/verification-evidence.mjs';

const directory = process.argv[2], output = path.join(directory, 'browser.json');
const evidence = { version: '1.0', chromium: null, scenarios: [], cleanup: [], complete: false, ok: false };
let browser;
await writeJson(output, evidence);
try {
  browser = await chromium.launch({ headless: true, timeout: 15000, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  evidence.chromium = browser.version();
  for (const mode of ['append', 'replace']) {
    let fixture, context;
    const row = { mode, snapshots: [], http: [], screenshots: [], providerCalls: [], pageErrors: [], cleanup: [], complete: false, ok: false };
    evidence.scenarios.push(row); await writeJson(output, evidence);
    try {
      fixture = await importAtomicityFixture(); context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 950 } });
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
      page.on('pageerror', error => row.pageErrors.push(error.message));
      await page.addInitScript(observeImportFetch);
      await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'local-test-only'));
      await page.goto(fixture.base()); await page.locator('#settings-trigger').click(); await page.locator('#tab-data-button').click();
      const record = label => { const database = fixture.snapshot(); row.snapshots.push({ label, database }); return database; };
      const before = record('before');
      const downloadReady = page.waitForEvent('download'); await page.locator('#data-export').click(); const download = await downloadReady;
      const exported = path.join(fixture.directory, 'settings-export.sqlite'); await download.saveAs(exported);
      row.download = { name: download.suggestedFilename(), bytes: (await readFile(exported)).length, database: databaseSnapshot(exported) };
      assert.deepEqual(row.download.database, before);
      if (mode === 'append') await page.locator('#data-import-append').check();
      async function upload(filename) {
        await page.locator('#data-import-file').setInputFiles(filename);
        await page.waitForFunction(() => !document.querySelector('#data-import-confirm').disabled &&
          document.querySelector('#data-transfer-status').textContent.includes('备份验证通过'));
      }
      async function commit(expectedStatus) {
        const n = await page.evaluate(() => window.__importProtocolResponses.filter(value => value.url.endsWith('/api/data/import/commit')).length);
        page.once('dialog', dialog => dialog.accept()); await page.locator('#data-import-confirm').click();
        await page.waitForFunction(index => window.__importProtocolResponses.filter(value => value.url.endsWith('/api/data/import/commit'))[index]?.done, n);
        const response = await page.evaluate(index => window.__importProtocolResponses.filter(value => value.url.endsWith('/api/data/import/commit'))[index], n);
        const { token, previewToken, ...body } = response.body;
        row.http.push({ status: response.status, body }); assert.equal(response.status, expectedStatus, JSON.stringify(body));
        await page.waitForFunction(() => !document.querySelector('#data-import').disabled);
        return body;
      }
      await upload(fixture.backups[0]); row.incoming = await fixture.preparedSnapshot();
      await fixture.arm({ fault: 'write' }); await commit(mode === 'append' ? 409 : 500); await fixture.disarm();
      assert.deepEqual(record('after-failure'), before); row.failureEvents = await fixture.events();
      assert.ok(row.failureEvents.some(event => event.event === 'sqlite-error' && event.errcode === 8 && event.mutations === 1));
      row.failureStatus = await page.locator('#data-transfer-status').textContent(); assert.match(row.failureStatus, /失败/);
      for (const label of ['failure']) {
        const name = `atomicity-${mode}-${label}.png`; await page.screenshot({ path: path.join(directory, name) });
        row.screenshots.push({ path: name, sha256: hash(await readFile(path.join(directory, name))) });
      }
      await upload(fixture.backups[0]); const result = await commit(200);
      assert.deepEqual(record('after-explicit-retry'), importedSnapshot(before, row.incoming, mode));
      const safetyFile = path.join(fixture.directory, 'backups', result.safetyBackup);
      row.safetyBackup = databaseSnapshot(safetyFile); assert.deepEqual(row.safetyBackup, before);
      if (mode === 'append') await page.locator('#data-import-append').uncheck();
      await upload(safetyFile); await commit(200);
      await page.locator('#data-transfer-status').filter({ hasText: '数据覆盖完成' }).waitFor();
      assert.deepEqual(record('after-safety-restore'), afterImport(before));
      const screenshot = `atomicity-${mode}-restored.png`; await page.screenshot({ path: path.join(directory, screenshot) });
      row.screenshots.push({ path: screenshot, sha256: hash(await readFile(path.join(directory, screenshot))) });
      assert.equal(fixture.calls.length, 0); assert.deepEqual(row.pageErrors, []);
      row.complete = row.ok = true;
    } catch (error) { row.error = { name: error.name, message: error.message }; throw error; }
    finally {
      if (fixture) row.providerCalls = [...fixture.calls];
      for (const [target, close] of [['context', () => context?.close()], ['fixture', () => fixture?.close()]]) {
        try { await deadline(close, 8000, `${target} cleanup`); row.cleanup.push({ target, ok: true }); }
        catch (error) { row.cleanup.push({ target, ok: false, message: error.message }); row.complete = row.ok = false; }
      }
      await writeJson(output, evidence);
    }
  }
} catch (error) { evidence.error = { name: error.name, message: error.message }; }
finally {
  try { await deadline(() => browser?.close(), 8000, 'Chromium cleanup'); evidence.cleanup.push({ target: 'Chromium', ok: true }); }
  catch (error) { evidence.cleanup.push({ target: 'Chromium', ok: false, message: error.message }); }
  evidence.complete = evidence.scenarios.length === 2 && evidence.scenarios.every(row => row.complete) && evidence.cleanup.every(row => row.ok);
  evidence.ok = evidence.complete && evidence.scenarios.every(row => row.ok) && !evidence.error;
  await writeJson(output, evidence);
}
process.exitCode = evidence.ok ? 0 : 1;
