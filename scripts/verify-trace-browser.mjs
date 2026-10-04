import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { traceReportFixture } from '../test-support/trace-report-fixture.mjs';
import { createTraceReport } from './trace-report.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const evidence = process.env.TRACE_EVIDENCE_DIR;
const directory = evidence ? path.resolve(evidence) : await mkdtemp(path.join(tmpdir(), 'trace-browser-'));
await mkdir(directory, { recursive: true });
let browser;
const errors = [], requests = [], checks = [];
try {
  const snapshot = await traceReportFixture(), baseline = await traceReportFixture({ recovered: false });
  const input = path.join(directory, 'trace-current.json'), before = path.join(directory, 'trace-baseline.json');
  const output = path.join(directory, 'trace-report.html');
  await writeFile(input, JSON.stringify(snapshot)); await writeFile(before, JSON.stringify(baseline));
  await createTraceReport(input, output, before);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.goto(pathToFileURL(output).href);
  await page.getByText('当前进程缓冲完整', { exact: false }).waitFor();
  const job = page.locator('#tree .job').first();
  await job.locator(':scope > summary').click();
  const root = job.locator('.span-node').first();
  await root.locator(':scope > summary').click();
  const extract = root.locator('.span-node').first();
  await extract.locator(':scope > summary').click();
  const http = extract.locator('.span-node').first();
  await http.locator(':scope > summary').click();
  await http.locator(':scope > summary .inspect').click();
  assert.equal(await page.locator('#evidence h2').textContent(), 'knowledge.http');
  await page.locator('#evidence .event').first().locator('summary').click();
  assert.match(await page.locator('#evidence pre').textContent(), /span_id/);
  assert.equal(await page.locator('#evidence .breadcrumbs button').count(), 3);
  checks.push('five levels reach real HTTP event evidence');

  await page.getByRole('textbox', { name: '筛选' }).fill('HTTP_429');
  await page.locator('#tree .search-result').first().click();
  assert.match(await page.locator('#evidence').textContent(), /HTTP_429/);
  await page.getByRole('textbox', { name: '筛选' }).fill('');
  assert.equal(await job.getAttribute('open'), '');
  assert.equal(await http.getAttribute('open'), '');
  checks.push('error search reaches failed attempt and clearing preserves branch expansion');

  const diff = page.locator('#comparison .diff').first();
  await diff.locator('summary').click();
  assert.ok(await diff.locator('.search-result').count() > 0);
  await diff.locator('.search-result').first().click();
  assert.match(await page.locator('#evidence').textContent(), /基准/);
  assert.equal(await page.locator('#side').inputValue(), 'current');
  checks.push('version comparison links to baseline evidence without silently switching the current tree');

  const downloadReady = page.waitForEvent('download'); await page.getByRole('button', { name: '导出脱敏证据 JSON' }).click();
  const download = await downloadReady;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.format, 'hearwise-trace-report/v1');
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_/);
  checks.push('offline evidence export contains no provider secrets or raw transcript');
  if (evidence) await page.screenshot({ path: path.join(directory, 'trace-desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('textbox', { name: '筛选' }).fill('HTTP_429');
  await page.locator('#tree .search-result').first().click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  if (evidence) await page.screenshot({ path: path.join(directory, 'trace-mobile.png'), fullPage: false });
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  checks.push('mobile layout fits viewport; no browser errors or network requests');
  console.log(JSON.stringify({ ok: true, checks }));
} finally {
  await browser?.close();
  if (!evidence) await rm(directory, { recursive: true, force: true });
}
