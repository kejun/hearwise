import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { digest, sourceVersion, writeJson } from '../scripts/lib/verification-evidence.mjs';
import { traceBrowserArtifacts, traceBrowserDocuments, traceStateLabels } from './trace-business-evidence.mjs';
import { deadline } from './lifecycle.mjs';

const directory = process.argv[2]; if (!directory) throw new Error('Trace browser evidence directory is required');
const data = JSON.parse(await readFile(path.join(directory, 'business-observations.json'), 'utf8'));
assert.equal(data.complete, true); assert.equal(data.ok, true);
const result = { source: sourceVersion(), complete: false, ok: false, cleanup: false, checks: [], reports: [], artifacts: [], errors: [], networkRequests: [], identityObservations: [], captureObservations: {} };
const full = data.boundaries.find(row => row.name === 'full-public-boundary');
const check = (id, counts) => result.checks.push({ id, complete: true, ok: true, counts });
let browser;
try {
  const documents = traceBrowserDocuments(data);
  for (const { name, report, html } of documents) {
    await writeFile(path.join(directory, name), html, { flag: 'wx' });
    result.reports.push({ path: name, sha256: digest(html), eventCount: report.eventCount, completeness: report.completeness });
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-gpu'] });
  result.chromium = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(5000);
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') result.errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) result.networkRequests.push(request.url()); });
  const open = async name => {
    await page.goto(pathToFileURL(path.join(directory, name)).href);
    await page.locator('#domains .domain-card').first().waitFor();
    const intended = documents.find(row => row.name === name).report;
    assert.deepEqual(await page.locator('#trace-data').evaluate(node => JSON.parse(node.textContent).current), JSON.parse(JSON.stringify(intended)));
  };
  await open('trace-full.html');
  assert.equal(await page.locator('#domains .domain-card').count(), 5);
  for (const domain of ['recognition', 'translation', 'knowledge', 'relation', 'speech']) {
    const card = page.locator(`#domains [data-domain="${domain}"]`); assert.match(await card.textContent(), /已观测/);
  }
  await page.getByRole('button', { name: '未关联业务记录', exact: true }).click();
  assert.equal(await page.locator('#work-items .business-task').count(), 1);
  assert.match(await page.locator('#work-items').textContent(), /翻译.*预览 \/ 试听/);
  await page.locator('#tasks button').filter({ hasText: '收听记录' }).first().click();
  check('business-domains', { domains: 5, unownedPreviews: 1 });

  let tasks = 0, eventIdentities = 0;
  for (const domain of ['translation', 'knowledge', 'relation', 'speech']) {
    await page.locator(`#domains [data-domain="${domain}"]`).click();
    const expected = full.business.tasks.filter(task => task.domain === domain);
    assert.equal(await page.locator('#work-items .business-task').count(), expected.length);
    const item = page.locator('#work-items .business-task').first(), id = await item.getAttribute('data-task');
    const task = expected.find(row => row.id === id); assert.ok(task);
    await item.locator(':scope > summary').click();
    let span = item.locator(':scope > .span-node').first(); await span.waitFor();
    await span.locator(':scope > summary .inspect').click();
    assert.ok((await page.locator('#evidence').textContent()).includes(task.job));
    assert.ok((await page.locator('#evidence').textContent()).includes(full.actual.listeningId));
    // Follow explicit child links to a real HTTP/stream event, not a timestamp-inferred edge.
    for (let depth = 0; depth < 3; depth++) {
      const spanId = await span.getAttribute('data-span'), declared = full.report.spans.find(row => row.id === spanId);
      if (!declared.children.length) break;
      await span.locator(':scope > summary').click();
      const child = span.locator(':scope > .branch > .span-node').first();
      await child.waitFor();
      span = child; await span.locator(':scope > summary .inspect').click();
    }
    await page.locator('#evidence .event').first().locator('summary').click();
    const event = JSON.parse(await page.locator('#evidence .event pre').first().textContent());
    assert.equal(event.attributes.job_id, task.job); assert.equal(event.attributes.listening_id, full.actual.listeningId);
    assert.ok(full.report.spans.some(row => row.events.some(value => value.event_id === event.event_id)));
    result.identityObservations.push({ domain, taskId: task.id, jobId: task.job, eventId: event.event_id, listeningId: event.attributes.listening_id });
    tasks++; eventIdentities++;
  }
  check('identity-drilldown', { tasks, eventIdentities });
  await page.screenshot({ path: path.join(directory, 'trace-business-desktop.png'), fullPage: true });

  const terminalObservations = [];
  for (const [state, label] of Object.entries(traceStateLabels)) {
    await open(`trace-state-${state}.html`);
    const badges = page.locator(`#work-items > .business-task > summary > .badge.${state}`);
    assert.ok(await badges.count() > 0, `Actual ${state} business state must be visible`);
    assert.equal(await badges.first().textContent(), label);
    terminalObservations.push({ state, badges: await badges.count(), text: await badges.first().textContent() });
  }
  check('terminal-states', { cases: terminalObservations.length }); result.terminalObservations = terminalObservations;
  await open('trace-full.html'); result.captureObservations.jsonl = await page.locator('#integrity').textContent(); assert.match(result.captureObservations.jsonl, /完整性未知/);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export').click();
  const download = await downloadPromise; await download.saveAs(path.join(directory, 'trace-safe-export.json'));
  const exported = await readFile(path.join(directory, 'trace-safe-export.json'), 'utf8');
  assert.doesNotMatch(exported, /TRACE_SECRET_KEY|PRIVATE_TRACE_TRANSCRIPT|PRIVATE_PREVIEW_TEXT/);
  result.captureObservations.exportedEvents = JSON.parse(exported).current.eventCount;
  assert.equal(result.captureObservations.exportedEvents, full.report.eventCount);
  await open('trace-incomplete.html'); result.captureObservations.missing = await page.locator('#integrity').textContent(); assert.match(result.captureObservations.missing, /采集不完整/);
  assert.ok(await page.locator('.quality-label').filter({ hasText: '缺口' }).count() > 0);
  assert.match(await page.locator('#capture-time').textContent(), /离线快照，不代表现在仍在运行/);
  await page.screenshot({ path: path.join(directory, 'trace-business-incomplete.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 950 });
  result.captureObservations.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(result.captureObservations.mobileOverflow, false);
  await page.locator('#domains [data-domain="knowledge"]').focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('#work-title').textContent(), /知识整理/);
  await page.screenshot({ path: path.join(directory, 'trace-business-mobile.png'), fullPage: true });
  check('incomplete-and-export', { missingBoundary: 1, jsonlUnknown: 1, safeExports: 1, mobileWidth: 390 });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.networkRequests, []);
  result.complete = true; result.ok = true;
} catch (error) { result.failure = { name: error.name, message: error.message.slice(0, 3000) }; process.exitCode = 1; }
finally {
  try { if (browser) await deadline(() => browser.close(), 5000, 'Trace browser cleanup'); result.cleanup = true; }
  catch (error) { result.failure = { name: error.name, message: error.message }; result.ok = false; result.complete = false; process.exitCode = 1; }
  for (const name of [...traceBrowserArtifacts, 'trace-safe-export.json']) {
    try { result.artifacts.push({ path: name, sha256: digest(await readFile(path.join(directory, name))) }); } catch { /* Missing files fail the final evidence gate. */ }
  }
  await writeJson(path.join(directory, 'trace-browser.json'), result);
  console.log(JSON.stringify({ complete: result.complete, ok: result.ok, checks: result.checks, failure: result.failure }));
}
