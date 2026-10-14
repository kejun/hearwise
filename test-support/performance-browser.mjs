// Actual UI/CDP collector. This module never changes application code or returned data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const browserPhases = Object.freeze(['history-first-page', 'history-next-page', 'detail-primary', 'detail-next-page',
  'graph-initial-e2e', 'graph-prefetched-activation', 'record-switch-a-b-a', 'graph-fullscreen', 'graph-zoom-in',
  'graph-zoom-out', 'graph-fit', 'graph-relayout', 'graph-search', 'graph-type-filter', 'graph-node-detail',
  'graph-pan', 'graph-node-drag', 'graph-wheel-zoom', 'graph-overview', 'post-import-history', 'post-import-graph']);
export const browserMetrics = Object.freeze(['wallMs', 'phaseBlockingExcessMs', 'longTaskCount', 'rendererTaskDurationMs',
  'rendererScriptDurationMs', 'rendererLayoutDurationMs', 'jsHeapUsedAfterBytes', 'browserProcessCpuDeltaMs']);
const require = createRequire(import.meta.url);
const errorData = error => ({ name: error?.name || 'Error', message: error?.message || String(error) });
const hash = value => createHash('sha256').update(value).digest('hex');
const sorted = values => [...values].sort();
const integer = (value, min, max, label) => assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${label}`);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const uniqueIds = (ids, count, label) => {
  assert.ok(Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.length), `${label} IDs`);
  assert.equal(ids.length, count, `${label} count`); assert.equal(new Set(ids).size, count, `${label} duplicate IDs`);
};
export function validateBrowserManifest(m) {
  assert.equal(m?.schemaVersion, 1, 'manifest schemaVersion');
  const url = new URL(m.baseUrl);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Only a local loopback baseUrl is allowed');
  assert.ok(m.workload && typeof m.workload.tier === 'string' && typeof m.workload.id === 'string', 'workload identity');
  assert.match(m.workload.recipeDigest, /^[a-f0-9]{64}$/, 'recipe digest'); integer(m.workload.counts.listenings, 2, 2000, 'listenings');
  for (const [label, r] of [['primary', m.primary], ['secondary', m.secondary], ['import.record', m.import?.record]]) {
    assert.ok(r && typeof r.id === 'string' && r.id && typeof r.title === 'string' && r.title, label);
    for (const name of ['node', 'edge', 'segment']) { integer(r[`${name}Count`], 0, 100000, `${label} ${name} count`); uniqueIds(r[`${name}Ids`], r[`${name}Count`], `${label} ${name}`); }
    assert.ok(r.nodeCount >= 2 && r.segmentCount > 0 && typeof r.searchToken === 'string' && r.searchToken, `${label} graph/search domain`);
    assert.ok(r.typeCounts && r.typeCounts.person > 0 && Object.values(r.typeCounts).every(n => Number.isSafeInteger(n) && n >= 0) && Object.values(r.typeCounts).reduce((a, b) => a + b, 0) === r.nodeCount, `${label} typeCounts`);
  }
  assert.equal(new Set([m.primary.id, m.secondary.id, m.import.record.id]).size, 3, 'Distinct record IDs');
  assert.ok(path.isAbsolute(m.import.file), 'Absolute import file'); assert.match(m.import.sha256, /^[a-f0-9]{64}$/);
  assert.equal(m.import.addedCount, 1); assert.equal(m.import.expectedTotal, m.workload.counts.listenings + 1);
  integer(m.sampling?.warmups, 0, 20, 'warmups'); integer(m.sampling?.repetitions, 1, 100, 'repetitions');
  assert.ok(typeof m.network?.id === 'string'); integer(m.network.latencyMs, 0, 10000, 'network latency');
  for (const key of ['downloadBytesPerSecond', 'uploadBytesPerSecond']) assert.ok(m.network[key] === -1 || finite(m.network[key]) && m.network[key] > 0, `network ${key}`);
  integer(m.browser?.viewport?.width, 320, 7680, 'viewport width'); integer(m.browser.viewport.height, 320, 4320, 'viewport height');
  assert.ok(finite(m.browser.deviceScaleFactor) && m.browser.deviceScaleFactor > 0 && m.browser.deviceScaleFactor <= 4, 'deviceScaleFactor');
  assert.ok(typeof m.browser.locale === 'string' && typeof m.browser.timezoneId === 'string' && ['reduce', 'no-preference'].includes(m.browser.reducedMotion) && typeof m.browser.headless === 'boolean', 'browser configuration');
  integer(m.timeouts?.actionMs, 100, 120000, 'actionMs'); integer(m.timeouts?.overallMs, m.timeouts.actionMs, 3600000, 'overallMs');
  return true;
}

export function deriveBrowserMetrics(raw) {
  const issues = [], before = raw?.before, after = raw?.after, window = raw?.window;
  const metric = (snapshot, name) => snapshot?.performance?.metrics?.find(item => item.name === name)?.value;
  const delta = name => {
    const a = metric(before, name), b = metric(after, name);
    if (!finite(a) || !finite(b) || b < a) { issues.push(`Missing/nonmonotonic CDP ${name}`); return null; }
    return (b - a) * 1000;
  };
  let wallMs = null;
  if (finite(window?.controllerStartMs) && finite(window?.controllerEndMs) && window.controllerEndMs >= window.controllerStartMs) wallMs = window.controllerEndMs - window.controllerStartMs;
  else issues.push('Missing/nonmonotonic controller window');
  const clock = [before?.startedAtControllerMs, before?.finishedAtControllerMs, window?.controllerStartMs,
    window?.controllerEndMs, after?.startedAtControllerMs, after?.finishedAtControllerMs];
  if (!clock.every(value => finite(value) && value >= 0) || clock.some((value, index) => index > 0 && value < clock[index - 1]))
    issues.push('Resource snapshot windows do not bracket the measured action');
  for (const snapshot of [before, after]) if (!Array.isArray(snapshot?.errors) || snapshot.errors.length) issues.push('Resource snapshot has missing/error observations');
  const observer = raw?.observers, supported = observer?.supported?.includes('longtask');
  const longTasks = supported && Array.isArray(observer.longTasks) ? observer.longTasks : null;
  if (!longTasks || longTasks.some(entry => !finite(entry.duration) || entry.duration < 0 || !finite(entry.startTime))) issues.push('Long Task API unavailable or invalid');
  const validLongTasks = longTasks && !issues.includes('Long Task API unavailable or invalid') ? longTasks : null;
  if (!finite(window?.pageStartMs) || !finite(window?.pageEndMs) || window.pageEndMs < window.pageStartMs || validLongTasks?.some(entry => entry.startTime < window.pageStartMs || entry.startTime >= window.pageEndMs)) issues.push('Invalid observation window');
  const processesBefore = before?.processes?.processInfo, processesAfter = after?.processes?.processInfo;
  let browserProcessCpuDeltaMs = null, processChurn = null;
  const validProcesses = entries => Array.isArray(entries) && entries.length > 0 && entries.every(p => Number.isSafeInteger(p.id) && p.id > 0 && typeof p.type === 'string' && finite(p.cpuTime) && p.cpuTime >= 0) && new Set(entries.map(p => p.id)).size === entries.length;
  if (validProcesses(processesBefore) && validProcesses(processesAfter)) {
    const prior = new Map(processesBefore.map(p => [p.id, p]));
    const born = processesAfter.filter(p => !prior.has(p.id)).map(p => p.id), ended = processesBefore.filter(p => !processesAfter.some(q => q.id === p.id)).map(p => p.id);
    processChurn = { born, ended };
    if (born.length || ended.length || processesAfter.some(p => prior.get(p.id)?.type !== p.type || p.cpuTime < prior.get(p.id)?.cpuTime)) issues.push('Browser process churn or nonmonotonic CPU counters');
    else browserProcessCpuDeltaMs = processesAfter.reduce((sum, p) => sum + (p.cpuTime - prior.get(p.id).cpuTime) * 1000, 0);
  } else issues.push('Browser process CPU counters unavailable');
  const heap = after?.heap?.usedSize;
  if (!finite(heap) || heap < 0) issues.push('Renderer heap unavailable');
  for (const [name, snapshot] of [['before', before], ['after', after]]) {
    if (![snapshot?.heap?.usedSize, snapshot?.dom?.nodes, snapshot?.dom?.documents, snapshot?.dom?.jsEventListeners].every(value => finite(value) && value >= 0)) issues.push(`${name} heap/DOM counters unavailable`);
  }
  const metrics = { wallMs, phaseBlockingExcessMs: validLongTasks ? validLongTasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0) : null,
    longTaskCount: validLongTasks?.length ?? null, rendererTaskDurationMs: delta('TaskDuration'), rendererScriptDurationMs: delta('ScriptDuration'),
    rendererLayoutDurationMs: delta('LayoutDuration'), jsHeapUsedAfterBytes: finite(heap) && heap >= 0 ? heap : null, browserProcessCpuDeltaMs };
  const events = observer?.events;
  const diagnosticMetrics = { eventTimingMaxDurationMs: Array.isArray(events) && events.length ? Math.max(...events.map(e => e.duration)) : null,
    eventTimingStatus: !observer?.supported?.includes('event') ? 'unsupported' : events?.length ? 'observed' : 'not_observed' };
  return { metrics, diagnosticMetrics, complete: issues.length === 0, issues, processChurn };
}




function plannedCases(m) {
  return browserPhases.map(phase => {
    const reason = phase === 'history-next-page' && m.workload.counts.listenings <= 20 ? 'Exact fixture total is <=20; the UI has no next-history-page control.' :
      phase === 'detail-next-page' && m.primary.segmentCount <= 100 ? 'Exact primary segment count is <=100; the UI has no next-transcript-page control.' : null;
    return { id: `${m.workload.tier}/${m.network.id}/${phase}`, phase, status: reason ? 'not_applicable' : 'not_run', ...(reason ? { reason } : {}), samples: [] };
  });
}
function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded (${ms}ms)`)), ms); })]).finally(() => clearTimeout(timer));
}
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

export async function collectBrowserSamples(manifest, options = {}) {
  const report = { schemaVersion: 1, component: 'browser', startedAt: new Date().toISOString(), finishedAt: null, complete: false, status: 'not_run',
    environment: { actualVersion: null, requested: manifest?.browser ?? null, network: manifest?.network ?? null,
      cachePolicy: 'Fresh nonpersistent browser context for each sample, HTTP cache explicitly disabled; setup navigation excluded. Browser process reused. No claim about cold OS filesystem/SQLite caches.',
      scopes: { wallMs: 'Controller monotonic elapsed time immediately before action dispatch through real readiness and two requestAnimationFrame callbacks; includes automation/transport overhead.',
        rendererDurations: 'CDP Performance cumulative renderer-duration deltas over the before/after snapshot interval, including observation overhead; not physical CPU time.',
        browserProcessCpuDeltaMs: 'Sum of SystemInfo process CPU seconds deltas for the same complete process-ID/type set, across this owned browser. Snapshot windows enclose action timing and include CDP/observation overhead; raw controller timestamps preserve their wider bounds. Process churn/unavailability is incomplete.',
        memory: 'Runtime.getHeapUsage and DOM.getDOMCounters endpoint snapshots of the page renderer. No process RSS, peak memory, or server memory claim.',
        phaseBlockingExcessMs: 'Sum max(0,longtask.duration-50) for tasks starting in the raw page-clock observation window around the action (slightly wider than controller wall timing). Not Lighthouse Total Blocking Time.',
        eventTiming: 'Optional observed PerformanceEventTiming durations with threshold 16ms; missing is null, not field INP.' } },
    cases: [], negative: { status: 'not_run', kind: 'bounded-main-thread-cost-on-real-fit-click', requestedMs: 150 }, errors: [], cleanup: { complete: false, browserClosed: false, contextsClosed: 0 } };
  let browser, browserCdp, timer, aborted = options.signal?.aborted === true;
  const contexts = new Set();
  const abort = () => { aborted = true; };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    validateBrowserManifest(manifest); report.cases = plannedCases(manifest);
    if (aborted) throw new Error('Browser collection interrupted before launch');
    const playwright = require('playwright');
    const executablePath = process.env.CHROMIUM_EXECUTABLE || playwright.chromium.executablePath();
    const args = ['--no-sandbox', '--no-zygote', '--disable-gpu', '--enable-automation'];
    report.environment.playwrightVersion = require('playwright/package.json').version;
    report.environment.executablePath = executablePath; report.environment.requestedFlags = args;
    const launch = options.launch || (configuration => playwright.chromium.launch(configuration));
    const run = async () => {
      browser = await launch({ executablePath, headless: manifest.browser.headless, timeout: Math.min(manifest.timeouts.actionMs, 30000), args });
      if (aborted) throw new Error('Collection interrupted');
      report.status = 'collecting'; report.environment.actualVersion = browser.version();
      browserCdp = await browser.newBrowserCDPSession();
      report.environment.protocolVersion = await browserCdp.send('Browser.getVersion');
      try { report.environment.actualCommandLine = (await browserCdp.send('Browser.getBrowserCommandLine')).arguments; }
      catch (error) { report.environment.actualCommandLine = null; report.environment.commandLineError = errorData(error); }
      await runCases({ manifest, report, browser, browserCdp, contexts, stopped: () => aborted });
      report.complete = report.cases.every(row => ['collected', 'not_applicable'].includes(row.status)) && report.negative.status === 'collected' && report.errors.length === 0;
      report.status = report.complete ? 'collected' : 'incomplete';
    };
    const interruption = new Promise((_, reject) => {
      timer = setInterval(() => { if (options.signal?.aborted) { aborted = true; reject(new Error('Browser collection interrupted')); } }, 100);
    });
    await bounded(Promise.race([run(), interruption]), manifest.timeouts.overallMs, 'Browser overall');
  } catch (error) {
    aborted = true; report.errors.push(errorData(error)); report.complete = false;
    report.status = browser ? 'incomplete' : 'not_run';
    for (const row of report.cases) if (row.status === 'collecting') row.status = 'incomplete';
  } finally {
    clearInterval(timer); options.signal?.removeEventListener('abort', abort);
    for (const context of contexts) {
      try { await bounded(context.close(), 3000, 'Context cleanup'); report.cleanup.contextsClosed++; }
      catch (error) { report.errors.push({ ...errorData(error), stage: 'context-cleanup' }); }
    }
    contexts.clear();
    try { if (browser) await bounded(browser.close(), 5000, 'Browser cleanup'); report.cleanup.browserClosed = true; }
    catch (error) { report.errors.push({ ...errorData(error), stage: 'browser-cleanup' }); }
    report.cleanup.complete = report.cleanup.browserClosed && !report.errors.some(error => error.stage?.endsWith('cleanup'));
    if (!report.cleanup.complete) { report.complete = false; report.status = 'incomplete'; }
    report.finishedAt = new Date().toISOString();
  }
  if (report.complete) {
    report.evidenceValidation = validateBrowserEvidence(report, manifest);
    if (!report.evidenceValidation.valid) {
      report.complete = false; report.status = 'incomplete';
      report.errors.push({ name: 'EvidenceValidation', message: report.evidenceValidation.errors.join('; ') });
    }
  }
  return report;
}

export function validateBrowserResponse(kind, body, record, { total, page = 1 } = {}) {
  if (kind === 'history') {
    assert.equal(body.total, total, 'history total'); assert.equal(body.page, page, 'history page'); assert.equal(body.pageSize, 20, 'history page size');
    assert.equal(body.items.length, Math.min(20, Math.max(0, total - (page - 1) * 20)), 'history page count');
    uniqueIds(body.items.map(item => item.id), body.items.length, 'history items');
  } else if (kind === 'graph') {
    assert.equal(body.listeningId, record.id, 'graph record identity');
    assert.deepEqual(sorted(body.nodes.map(item => item.id)), sorted(record.nodeIds), 'graph node IDs');
    assert.deepEqual(sorted(body.relations.map(item => item.id)), sorted(record.edgeIds), 'graph edge IDs');
  } else if (kind === 'detail') {
    assert.equal(body.listening.id, record.id, 'detail record identity'); assert.equal(body.listening.title, record.title, 'detail title');
    assert.equal(body.segmentCount, record.segmentCount, 'detail segment count');
    assert.deepEqual(sorted(body.knowledge.map(item => item.id)), sorted(record.nodeIds), 'detail knowledge IDs');
    assert.deepEqual(sorted(body.segments.map(item => item.id)), sorted(record.segmentIds.slice((page - 1) * 100, page * 100)), 'detail segment IDs');
  } else throw new Error(`Unsupported response kind: ${kind}`);
  return true;
}
function projectResponse(kind, body) {
  if (kind === 'history') return { total: body.total, page: body.page, pageSize: body.pageSize, items: body.items.map(({ id, title }) => ({ id, title })) };
  if (kind === 'detail') return { listening: { id: body.listening.id, title: body.listening.title }, segmentCount: body.segmentCount,
    knowledge: body.knowledge.map(({ id }) => ({ id })), segments: body.segments.map(({ id }) => ({ id })) };
  return { listeningId: body.listeningId, graphRevision: body.graphRevision,
    nodes: body.nodes.map(({ id, type, display_label, canonical_name }) => ({ id, type, display_label, canonical_name })),
    relations: body.relations.map(({ id, subject_item_id, object_item_id }) => ({ id, subject_item_id, object_item_id })) };
}
function responseGate(page, route, kind, record, expected, collected) {
  return page.waitForResponse(response => {
    const url = new URL(response.url()); return `${url.pathname}${url.search}` === route && response.request().method() === 'GET';
  }).then(async response => {
    assert.equal(response.status(), 200, `${route} response status`);
    const bytes = await response.body(), body = JSON.parse(bytes.toString('utf8'));
    validateBrowserResponse(kind, body, record, expected);
    collected.push({ kind, url: response.url(), status: response.status(), byteLength: bytes.length, sha256: hash(bytes),
      projection: projectResponse(kind, body), expected: { recordId: record?.id ?? null, ...expected } });
    return body;
  });
}
async function snapshot(cdp, browserCdp) {
  const errors = [], startedAtControllerMs = performance.now();
  const read = async (name, session, method) => {
    try { return await bounded(session.send(method), 3000, method); }
    catch (error) { errors.push({ name, ...errorData(error) }); return null; }
  };
  const [performanceMetrics, heap, dom, processes] = await Promise.all([
    read('performance', cdp, 'Performance.getMetrics'), read('heap', cdp, 'Runtime.getHeapUsage'),
    read('dom', cdp, 'Memory.getDOMCounters'), read('processes', browserCdp, 'SystemInfo.getProcessInfo')]);
  return { performance: performanceMetrics, heap, dom, processes, startedAtControllerMs, finishedAtControllerMs: performance.now(), errors };
}
function installObservers() {
  const supported = [...PerformanceObserver.supportedEntryTypes], records = { longTasks: [], events: [] }, observers = [];
  for (const [type, key] of [['longtask', 'longTasks'], ['event', 'events']]) {
    if (!supported.includes(type)) continue;
    const observer = new PerformanceObserver(list => records[key].push(...list.getEntries().map(entry => entry.toJSON())));
    observer.observe(type === 'event' ? { type, buffered: false, durationThreshold: 16 } : { type, buffered: false }); observers.push({ observer, key });
  }
  window.__hearwisePerformance = {
    reset() { for (const { observer } of observers) observer.takeRecords(); records.longTasks = []; records.events = []; return performance.now(); },
    read(start, end) {
      for (const { observer, key } of observers) records[key].push(...observer.takeRecords().map(entry => entry.toJSON()));
      return { supported, longTasks: records.longTasks.filter(entry => entry.startTime >= start && entry.startTime < end),
        events: records.events.filter(entry => entry.startTime >= start && entry.startTime < end) };
    }
  };
}
// All Cytoscape access below is observation only. Gestures use real browser input.
async function readState(page) {
  return page.evaluate(() => {
    const el = id => document.getElementById(id), visible = node => Boolean(node && !node.hidden && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const viewport = el('graph-viewport'), cy = viewport?._cyreg?.cy;
    return { recordTitle: el('record-title')?.textContent, recordVisible: visible(el('record-panel')), loadingHidden: !visible(el('record-loading')),
      historyVisible: visible(el('history-view')), historyTitles: [...document.querySelectorAll('.history-open')].map(node => node.getAttribute('aria-label')),
      historyMoreVisible: visible(el('history-more')), segmentIds: [...document.querySelectorAll('#transcript-list .transcript-item')].map(node => node.id.slice(8)),
      detailMoreVisible: visible(el('load-more')), graphActive: el('knowledge-view-graph')?.getAttribute('aria-pressed') === 'true',
      search: el('graph-search')?.value, type: el('graph-type')?.value, countText: el('graph-count')?.textContent,
      fullscreen: Boolean(el('graph-fullscreen-dialog')?.open), modal: Boolean(el('graph-fullscreen-dialog')?.matches(':modal')),
      detailVisible: visible(el('graph-details')), detailTitle: el('graph-detail-title')?.textContent,
      graph: cy ? { nodeIds: cy.nodes().map(node => node.id()), edgeIds: cy.edges().map(edge => edge.data('relationId')),
        visibleNodeIds: cy.nodes(':visible').map(node => node.id()), visibleEdgeIds: cy.edges(':visible').map(edge => edge.data('relationId')),
        nodes: cy.nodes().map(node => ({ id: node.id(), label: node.data('label'), typeLabel: node.data('typeLabel'), position: node.position(), renderedPosition: node.renderedPosition(), selected: node.hasClass('selected') })),
        edges: cy.edges().map(edge => ({ id: edge.data('relationId'), source: edge.data('source'), target: edge.data('target') })),
        zoom: cy.zoom(), pan: cy.pan(), width: cy.width(), height: cy.height(), clientWidth: viewport.clientWidth, clientHeight: viewport.clientHeight,
        bounds: cy.elements(':visible').renderedBoundingBox({ includeLabels: true, includeOverlays: false }), canvasCount: viewport.querySelectorAll('canvas').length } : null };
  });
}
function checkGraphState(state, record, { filtered = false } = {}) {
  assert.equal(state.graphActive, true, 'graph tab is active'); assert.ok(state.graph?.canvasCount > 0, 'graph canvas exists');
  assert.deepEqual(sorted(state.graph.nodeIds), sorted(record.nodeIds), 'rendered graph node IDs');
  assert.deepEqual(sorted(state.graph.edgeIds), sorted(record.edgeIds), 'rendered graph edge IDs');
  if (!filtered) {
    assert.deepEqual(sorted(state.graph.visibleNodeIds), sorted(record.nodeIds), 'visible graph node IDs');
    assert.deepEqual(sorted(state.graph.visibleEdgeIds), sorted(record.edgeIds), 'visible graph edge IDs');
  }
  assert.ok(state.graph.nodes.every(node => finite(node.position.x) && finite(node.position.y)), 'finite layout coordinates');
  assert.equal(state.graph.width, state.graph.clientWidth, 'Cytoscape viewport width adopted'); assert.equal(state.graph.height, state.graph.clientHeight, 'Cytoscape viewport height adopted');
}
function checkRecordState(state, record, page = 1) {
  assert.equal(state.recordTitle, record.title); assert.equal(state.recordVisible, true); assert.equal(state.loadingHidden, true);
  assert.deepEqual(sorted(state.segmentIds), sorted(record.segmentIds.slice(0, page * 100)), 'rendered segment identity');
  assert.equal(state.detailMoreVisible, record.segmentCount > page * 100, 'transcript pagination domain');
}
function checkFit(graph) {
  const { bounds: b, width, height } = graph;
  assert.ok(width > 0 && height > 0 && b.w > 0 && b.h > 0, 'nonempty fitted graph');
  assert.ok(Math.abs((b.x1 + b.x2 - width) / 2) < 2 && Math.abs((b.y1 + b.y2 - height) / 2) < 2, 'fit centered');
  assert.ok(b.x1 >= -1 && b.y1 >= -1 && b.x2 <= width + 1 && b.y2 <= height + 1, 'fit bounds contained');
}
async function waitGraph(page, record, visibleCount = record.nodeCount) {
  await page.waitForFunction(({ nodeIds, edgeIds, visibleCount }) => {
    const cy = document.querySelector('#graph-viewport')?._cyreg?.cy;
    const same = (actual, expected) => JSON.stringify(actual.sort()) === JSON.stringify([...expected].sort());
    return cy && same(cy.nodes().map(node => node.id()), nodeIds) && same(cy.edges().map(edge => edge.data('relationId')), edgeIds) && cy.nodes(':visible').length === visibleCount && cy.width() === document.querySelector('#graph-viewport').clientWidth;
  }, { nodeIds: record.nodeIds, edgeIds: record.edgeIds, visibleCount });
}
async function openHistory(page, manifest, collected, pageNumber = 1, postImport = false) {
  const total = postImport ? manifest.import.expectedTotal : manifest.workload.counts.listenings;
  const result = responseGate(page, `/api/listenings?page=${pageNumber}`, 'history', null, { total, page: pageNumber }, collected);
  await Promise.all([result, page.locator(pageNumber === 1 ? '#history-listening' : '#history-more').click()]);
  await page.waitForFunction(expected => document.querySelectorAll('.history-open').length === expected, Math.min(pageNumber * 20, total));
}
async function selectRecord(page, record, collected, withGraph = true) {
  const detail = responseGate(page, `/api/listenings/${record.id}?page=1`, 'detail', record, { page: 1 }, collected);
  const graph = withGraph ? responseGate(page, `/api/listenings/${record.id}/graph`, 'graph', record, {}, collected) : Promise.resolve();
  await Promise.all([detail, graph, page.getByRole('button', { name: `查看“${record.title}”`, exact: true }).click()]);
  await page.locator('#record-loading').waitFor({ state: 'hidden' }); await page.locator('#record-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(title => document.getElementById('record-title').textContent === title, record.title);
  if (withGraph && await page.locator('#knowledge-view-graph').getAttribute('aria-pressed') === 'true') await waitGraph(page, record);
}
export async function realPointer(page, kind, record) {
  const viewport = page.locator('#graph-viewport'); await viewport.scrollIntoViewIfNeeded();
  const point = await viewport.evaluate((element, input) => {
    const cy = element._cyreg.cy, rect = element.getBoundingClientRect();
    if (input.kind === 'node-drag') {
      const node = cy.getElementById(input.id), position = node.renderedPosition();
      return { x: rect.x + element.clientLeft + position.x, y: rect.y + element.clientTop + position.y, dx: 32, dy: 24 };
    }
    const boxes = cy.nodes(':visible').map(node => node.renderedBoundingBox({ includeLabels: true, includeOverlays: false }));
    const candidates = [{ x: 12, y: 12 }, { x: element.clientWidth - 12, y: 12 }, { x: 12, y: element.clientHeight - 12 }, { x: element.clientWidth - 12, y: element.clientHeight - 12 }];
    const chosen = candidates.find(p => boxes.every(b => p.x < b.x1 - 4 || p.x > b.x2 + 4 || p.y < b.y1 - 4 || p.y > b.y2 + 4));
    if (!chosen) throw new Error('No real graph background pointer target');
    return { x: rect.x + element.clientLeft + chosen.x, y: rect.y + element.clientTop + chosen.y, dx: chosen.x > element.clientWidth / 2 ? -60 : 60, dy: chosen.y > element.clientHeight / 2 ? -40 : 40 };
  }, { kind, id: record.nodeIds[0] });
  await page.mouse.move(point.x, point.y);
  if (kind === 'wheel') {
    // Cytoscape's locked renderer suppresses wheel-to-zoom during page scroll.
    // Observe its actual guard instead of sleeping or sending ignored gestures.
    await page.waitForFunction(() => {
      const renderer = document.getElementById('graph-viewport')?._cyreg?.cy?.renderer();
      return Boolean(renderer) && renderer.scrollingPage !== true;
    });
    await page.mouse.wheel(0, -240);
  }
  else { await page.mouse.down(); await page.mouse.move(point.x + point.dx, point.y + point.dy, { steps: 12 }); await page.mouse.up(); }
  return { kind, ...point, mechanism: 'Playwright real mouse input; Cytoscape read-only coordinate observation' };
}

async function createSession(state, view = 'graph') {
  const { manifest: m, browser, report, contexts } = state;
  const { headless: _headless, ...contextOptions } = m.browser;
  const context = await browser.newContext({ ...contextOptions, serviceWorkers: 'block' }); contexts.add(context);
  await context.addInitScript(value => localStorage.setItem('tongsheng:knowledge-view', value), view);
  await context.addInitScript(installObservers);
  const page = await context.newPage(), cdp = await context.newCDPSession(page), pageErrors = [], blockedRequests = [];
  page.setDefaultTimeout(m.timeouts.actionMs); page.setDefaultNavigationTimeout(m.timeouts.actionMs);
  page.on('pageerror', error => pageErrors.push(errorData(error)));
  // Defensive routing blocks third-party destinations; all allowed requests pass
  // through unchanged. Routing/cache-off policy is recorded, never called cold OS.
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(m.baseUrl).origin) {
      blockedRequests.push({ url: `${url.origin}${url.pathname}`, method: request.method() }); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await cdp.send('Performance.enable'); await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const network = { offline: false, latency: m.network.latencyMs, downloadThroughput: m.network.downloadBytesPerSecond, uploadThroughput: m.network.uploadBytesPerSecond };
  await cdp.send('Network.emulateNetworkConditions', network);
  await page.goto(m.baseUrl, { waitUntil: 'load' }); await page.locator('#history-listening').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  if (!report.environment.actualPage) {
    report.environment.actualPage = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, deviceScaleFactor: devicePixelRatio,
      locale: navigator.language, timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference', userAgent: navigator.userAgent,
      fonts: { status: document.fonts.status, chineseProbe: '历史收听中文图谱', systemUiCheck: document.fonts.check('16px system-ui', '历史收听中文图谱'),
        notoCjkCheck: document.fonts.check('16px "Noto Sans CJK SC"', '历史收听中文图谱'), computedFamily: getComputedStyle(document.getElementById('history-listening')).fontFamily,
        note: 'document.fonts.check alone does not prove CJK glyph coverage; actual platform font evidence is recorded separately.' } }));
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#history-listening' });
    report.environment.actualPage.fonts.platformFonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    report.environment.networkApplied = network;
  }
  return { page, cdp, context, pageErrors, blockedRequests, async close() {
    await bounded(context.close(), 3000, 'Sample context cleanup'); contexts.delete(context); report.cleanup.contextsClosed++;
  } };
}
async function preparePhase(session, phase, state) {
  const { page } = session, { manifest: m } = state, setupResponses = [];
  const record = phase.startsWith('post-import') ? m.import.record : m.primary;
  const postImport = phase.startsWith('post-import') || state.databaseImported === true;
  if (phase === 'history-first-page' || phase === 'post-import-history') return { record, setupResponses };
  await openHistory(page, m, setupResponses, 1, postImport);
  if (['history-next-page', 'detail-primary', 'graph-initial-e2e', 'post-import-graph'].includes(phase)) return { record, setupResponses };
  await selectRecord(page, record, setupResponses, true); await settle(page);
  if (phase === 'graph-prefetched-activation') {
    assert.equal(await page.locator('#knowledge-view-list').getAttribute('aria-pressed'), 'true');
  } else if (phase !== 'detail-next-page') {
    await waitGraph(page, record); await page.locator('#graph-viewport').scrollIntoViewIfNeeded(); await settle(page);
  }
  if (phase === 'graph-zoom-in') await page.locator('#graph-zoom-out').click();
  if (phase === 'graph-fit') { await page.locator('#graph-zoom-in').click(); await realPointer(page, 'pan', record); }
  if (phase === 'graph-relayout') await realPointer(page, 'node-drag', record);
  if (phase === 'graph-node-detail') await page.locator('.graph-results > summary').click();
  if (phase === 'graph-overview') { await page.locator('#graph-search').fill(record.searchToken); await waitGraph(page, record, 1); }
  await settle(page);
  return { record, setupResponses };
}
async function performPhase(session, phase, state, prepared, responses, checkpoints, input) {
  const { page } = session, { manifest: m } = state, { record } = prepared;
  if (phase === 'history-first-page' || phase === 'post-import-history') await openHistory(page, m, responses, 1, phase.startsWith('post-import'));
  else if (phase === 'history-next-page') await openHistory(page, m, responses, 2);
  else if (phase === 'detail-primary') await selectRecord(page, record, responses, false);
  else if (phase === 'detail-next-page') {
    const response = responseGate(page, `/api/listenings/${record.id}?page=2`, 'detail', record, { page: 2 }, responses);
    await Promise.all([response, page.locator('#load-more').click()]);
    await page.waitForFunction(expected => document.querySelectorAll('#transcript-list .transcript-item').length === expected, Math.min(200, record.segmentCount));
  } else if (['graph-initial-e2e', 'post-import-graph'].includes(phase)) await selectRecord(page, record, responses, true);
  else if (phase === 'graph-prefetched-activation') { await page.locator('#knowledge-view-graph').click(); await waitGraph(page, record); }
  else if (phase === 'record-switch-a-b-a') {
    for (const next of [m.secondary, m.primary]) {
      const stepResponses = []; await openHistory(page, m, stepResponses); await selectRecord(page, next, stepResponses, true); await settle(page);
      const observed = await readState(page); checkRecordState(observed, next); checkGraphState(observed, next);
      checkpoints.push({ recordId: next.id, observed, responses: stepResponses }); responses.push(...stepResponses);
    }
  } else if (phase === 'graph-fullscreen') {
    await page.locator('#graph-fullscreen').click();
    await page.waitForFunction(() => {
      const d = document.getElementById('graph-fullscreen-dialog'), v = document.getElementById('graph-viewport'), cy = v?._cyreg?.cy;
      if (!d?.open || !d.matches(':modal') || !cy || cy.width() !== v.clientWidth || cy.height() !== v.clientHeight) return false;
      const b = cy.elements(':visible').renderedBoundingBox({ includeLabels: true, includeOverlays: false });
      return Math.abs((b.x1 + b.x2 - cy.width()) / 2) < 2 && Math.abs((b.y1 + b.y2 - cy.height()) / 2) < 2;
    });
  } else if (['graph-zoom-in', 'graph-zoom-out', 'graph-fit', 'graph-relayout'].includes(phase)) await page.locator(`#${phase}`).click();
  else if (phase === 'graph-search') { await page.locator('#graph-search').fill(record.searchToken); await waitGraph(page, record, 1); }
  else if (phase === 'graph-type-filter') { await page.locator('#graph-type').selectOption('人物'); await waitGraph(page, record, record.typeCounts.person); }
  else if (phase === 'graph-node-detail') {
    await page.locator(`[data-result-node-id="${record.nodeIds[0]}"]`).click(); await page.locator('#graph-details').waitFor({ state: 'visible' });
  } else if (['graph-pan', 'graph-node-drag', 'graph-wheel-zoom'].includes(phase)) {
    const before = await readState(page), kind = phase === 'graph-node-drag' ? 'node-drag' : phase === 'graph-pan' ? 'pan' : 'wheel';
    Object.assign(input, await realPointer(page, kind, record));
    await page.waitForFunction(({ kind, before, id }) => {
      const cy = document.querySelector('#graph-viewport')?._cyreg?.cy;
      if (!cy) return false;
      if (kind === 'wheel') return cy.zoom() !== before.zoom;
      if (kind === 'pan') return cy.pan().x !== before.pan.x || cy.pan().y !== before.pan.y;
      const p = cy.getElementById(id).position(), old = before.nodes.find(node => node.id === id).position;
      return Math.abs(p.x - old.x) + Math.abs(p.y - old.y) > 1;
    }, { kind, before: before.graph, id: record.nodeIds[0] });
  } else if (phase === 'graph-overview') { await page.locator('#graph-search').fill(''); await page.locator('#graph-type').selectOption(''); await page.locator('#graph-fit').click(); await waitGraph(page, record); }
  else throw new Error(`Unknown phase ${phase}`);
}
async function measurePhase(session, phase, state, prepared, index, warmup) {
  const { page, cdp } = session, responses = [], checkpoints = [], input = {};
  const beforeState = await readState(page), before = await snapshot(cdp, state.browserCdp);
  const pageStartMs = await page.evaluate(() => window.__hearwisePerformance.reset());
  const controllerStartMs = performance.now();
  let actionError = null;
  try { await performPhase(session, phase, state, prepared, responses, checkpoints, input); }
  catch (error) { actionError = errorData(error); }
  const frames = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(first => requestAnimationFrame(second => resolve([first, second])))));
  const controllerEndMs = performance.now();
  const pageEndMs = await page.evaluate(() => performance.now());
  const observed = await readState(page);
  const observers = await page.evaluate(({ start, end }) => window.__hearwisePerformance.read(start, end), { start: pageStartMs, end: pageEndMs });
  const after = await snapshot(cdp, state.browserCdp);
  const raw = { window: { controllerStartMs, controllerEndMs, pageStartMs, pageEndMs }, before, after, observers, frames, input,
    responses, setupResponses: prepared.setupResponses, actionError, readiness: { before: beforeState, after: observed, checkpoints }, pageErrors: [...session.pageErrors], blockedRequests: [...session.blockedRequests] };
  const derived = deriveBrowserMetrics(raw);
  const sample = { index, warmup, status: derived.complete ? 'collected' : 'incomplete', timing: { wallMs: derived.metrics.wallMs,
    scope: state.report.environment.scopes.wallMs }, metrics: derived.metrics, diagnosticMetrics: derived.diagnosticMetrics,
    issues: derived.issues, processChurn: derived.processChurn, raw };
  try {
    assert.equal(actionError, null, 'measured action completed');
    assertSampleReadiness(phase, sample, state.manifest);
  } catch (error) { sample.status = 'incomplete'; sample.issues.push(error.message); sample.readinessError = errorData(error); }
  if (phase === 'graph-fullscreen' && observed.fullscreen) {
    try {
      await page.keyboard.press('Escape'); await settle(page); raw.readiness.afterExit = await readState(page);
      assert.equal(raw.readiness.afterExit.fullscreen, false); assert.equal(raw.readiness.afterExit.modal, false);
      assert.deepEqual(raw.readiness.afterExit.graph.nodes.map(node => node.position), beforeState.graph.nodes.map(node => node.position));
    } catch (error) { sample.status = 'incomplete'; sample.issues.push(`Fullscreen exit: ${error.message}`); }
  }
  return sample;
}
export function captureJsonResponse(page, pathname) {
  // Start consuming the body as soon as the wire response arrives, before the
  // triggering UI action can finish or navigate and evict Chromium's body cache.
  const captured = page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST')
    .then(async response => ({ status: response.status(), body: await response.json() }));
  captured.catch(() => {}); // The owner awaits the original promise after input.
  return captured;
}
async function importOnce(state) {
  const { manifest: m, report } = state;
  const bytes = await readFile(m.import.file); assert.equal(hash(bytes), m.import.sha256, 'Frozen import file hash');
  const session = await createSession(state, 'list');
  try {
    const { page } = session;
    await page.locator('#settings-trigger').click(); await page.locator('#tab-data-button').click(); await page.locator('#data-import-append').check();
    const validated = captureJsonResponse(page, '/api/data/import/validate');
    await page.locator('#data-import-file').setInputFiles(m.import.file); const { status: previewStatus, body: preview } = await validated;
    assert.equal(previewStatus, 200); assert.equal(preview.mode, 'append'); assert.equal(preview.addedCount, 1); assert.ok(preview.previewToken);
    await page.locator('#data-import-summary').filter({ hasText: '新增 1 条' }).waitFor();
    const committed = captureJsonResponse(page, '/api/data/import/commit');
    page.once('dialog', async dialog => { if (dialog.type() === 'confirm' && dialog.message().includes('将新增 1 条收听')) await dialog.accept(); else await dialog.dismiss(); });
    await page.locator('#data-import-confirm').click(); const { status: commitStatus, body: result } = await committed;
    assert.equal(commitStatus, 200); assert.equal(result.mode, 'append'); assert.equal(result.addedCount, 1); assert.equal(result.listeningCount, m.import.addedCount, 'Imported backup record count, not destination total');
    await page.locator('#data-transfer-status').filter({ hasText: '追加完成：新增 1 条' }).waitFor();
    const reload = page.waitForEvent('load'); await page.locator('#close-settings').click(); await reload;
    const historyResponses = []; await openHistory(page, m, historyResponses, 1, true);
    assert.ok(historyResponses[0].projection.items.some(item => item.id === m.import.record.id), 'Imported record read back through real history response');
    report.import = { status: 'collected', count: 1, inputSha256: hash(bytes), addedCount: result.addedCount, expectedTotal: m.import.expectedTotal,
      preview: { mode: preview.mode, addedCount: preview.addedCount, skippedCount: preview.skippedCount, hasPreviewToken: Boolean(preview.previewToken) },
      result: { mode: result.mode, addedCount: result.addedCount, listeningCount: result.listeningCount, changed: result.changed },
      historyResponse: historyResponses[0], reloadedOnClose: true, timingScope: 'One real UI append per isolated database, outside repeated read-only post-import samples.' };
    assert.deepEqual(session.pageErrors, []); assert.deepEqual(session.blockedRequests, []);
  } finally { await session.close(); }
}
async function runCases(state) {
  const { report, manifest: m } = state;
  for (const row of report.cases) {
    if (state.stopped()) throw new Error('Browser collection stopped');
    if (row.status === 'not_applicable') continue;
    if (row.phase === 'post-import-history') { await importOnce(state); state.databaseImported = true; }
    row.status = 'collecting';
    for (let index = 0; index < m.sampling.warmups + m.sampling.repetitions; index++) {
      if (state.stopped()) throw new Error('Browser collection stopped');
      const view = ['detail-primary', 'detail-next-page', 'graph-prefetched-activation'].includes(row.phase) ? 'list' : 'graph';
      const session = await createSession(state, view);
      try {
        const prepared = await preparePhase(session, row.phase, state);
        row.samples.push(await measurePhase(session, row.phase, state, prepared, index, index < m.sampling.warmups));
      } catch (error) { row.errors ||= []; row.errors.push(errorData(error)); throw error; }
      finally { await session.close(); }
    }
    row.status = row.samples.every(sample => sample.status === 'collected') ? 'collected' : 'incomplete';
    if (row.status === 'incomplete') report.errors.push({ name: 'IncompleteSamples', message: `${row.phase}: ${[...new Set(row.samples.flatMap(sample => sample.issues))].join('; ')}` });
  }
  // Fixed cost is injected only in this diagnostic's real button event handler.
  // It is never included in product baseline samples or edited into metrics.
  const session = await createSession(state, 'graph');
  try {
    const prepared = await preparePhase(session, 'graph-fit', state);
    await session.page.locator('#graph-fit').evaluate((button, ms) => {
      button.addEventListener('click', () => {
        const start = performance.now(); while (performance.now() - start < ms) { /* bounded test-only main-thread workload */ }
        window.__hearwiseControlledCost = { startTime: start, duration: performance.now() - start, requestedMs: ms, invocationCount: 1 };
      }, { once: true, capture: true });
    }, report.negative.requestedMs);
    const sample = await measurePhase(session, 'graph-fit', state, prepared, 0, false);
    const controlledCost = await session.page.evaluate(() => window.__hearwiseControlledCost);
    assert.equal(controlledCost.invocationCount, 1); assert.ok(controlledCost.duration >= 150);
    assert.ok(sample.metrics.wallMs >= 150, 'negative action wall time includes injected work');
    assert.ok(sample.raw.observers.longTasks.some(entry => entry.startTime <= controlledCost.startTime + 2 && entry.startTime + entry.duration >= controlledCost.startTime + controlledCost.duration - 2), 'negative real click recorded as a long task');
    report.negative = { ...report.negative, status: sample.status, controlledCost, sample };
  } finally { await session.close(); }
}

export function assertSampleReadiness(phase, sample, m) {
  const raw = sample.raw, before = raw.readiness.before, after = raw.readiness.after;
  assert.equal(raw.actionError, null, 'measured action completed');
  assert.equal(raw.frames.length, 2, 'two settled render frames'); assert.ok(raw.frames.every(finite) && raw.frames[1] > raw.frames[0] && raw.frames[0] >= raw.window.pageStartMs && raw.frames[1] <= raw.window.pageEndMs, 'render frame timestamps inside observation window');
  assert.deepEqual(raw.pageErrors, [], 'no page errors'); assert.deepEqual(raw.blockedRequests, [], 'no third-party network');
  const record = phase.startsWith('post-import') ? m.import.record : m.primary;
  for (const response of [...raw.setupResponses, ...raw.responses]) {
    assert.equal(response.status, 200); assert.match(response.sha256, /^[a-f0-9]{64}$/); assert.ok(response.byteLength > 0);
    const expectedRecord = [m.primary, m.secondary, m.import.record].find(item => item.id === response.expected.recordId);
    validateBrowserResponse(response.kind, response.projection, expectedRecord, response.expected);
    assert.equal(new URL(response.url).origin, new URL(m.baseUrl).origin);
  }
  const hasResponse = (kind, recordId, page = null) => raw.responses.some(response => response.kind === kind && response.expected.recordId === recordId && (page === null || response.expected.page === page));
  if (phase.includes('history')) {
    const postImport = phase.startsWith('post-import'), page = phase === 'history-next-page' ? 2 : 1, total = postImport ? m.import.expectedTotal : m.workload.counts.listenings;
    assert.equal(after.historyVisible, true); assert.equal(after.historyTitles.length, Math.min(page * 20, total));
    assert.equal(after.historyMoreVisible, total > page * 20); assert.equal(hasResponse('history', null, page), true, 'real history response in measured phase');
    const response = raw.responses.find(response => response.kind === 'history' && response.expected.page === page);
    assert.equal(response.projection.total, total, 'history workload total');
    const pages = [...raw.setupResponses, ...raw.responses].filter(item => item.kind === 'history' && item.expected.total === total && item.expected.page <= page).sort((a, b) => a.expected.page - b.expected.page);
    assert.equal(pages.length, page, 'one real response for each displayed history page');
    const items = pages.flatMap(item => item.projection.items); uniqueIds(items.map(item => item.id), Math.min(page * 20, total), 'displayed history');
    assert.deepEqual(after.historyTitles, items.map(item => `查看“${item.title}”`), 'all history response titles rendered in order');
    if (postImport) assert.ok(after.historyTitles.includes(`查看“${record.title}”`), 'appended record visible in history');
    return true;
  }
  checkRecordState(after, record, phase === 'detail-next-page' ? 2 : 1);
  if (phase.startsWith('detail')) {
    assert.equal(hasResponse('detail', record.id, phase === 'detail-next-page' ? 2 : 1), true, 'real detail response in measured phase'); return true;
  }
  checkGraphState(after, record, { filtered: ['graph-search', 'graph-type-filter'].includes(phase) });
  if (['graph-initial-e2e', 'post-import-graph'].includes(phase)) {
    assert.equal(hasResponse('detail', record.id, 1), true); assert.equal(hasResponse('graph', record.id), true, 'real graph response in initial end-to-end phase');
    assert.equal(before.historyVisible, true); assert.equal(before.recordVisible, false);
  } else if (phase === 'graph-prefetched-activation') {
    assert.equal(before.graphActive, false); assert.ok(raw.setupResponses.some(response => response.kind === 'graph' && response.expected.recordId === record.id), 'graph prefetched before tab timing');
  } else if (phase === 'record-switch-a-b-a') {
    checkRecordState(before, m.primary); checkGraphState(before, m.primary);
    assert.deepEqual(raw.readiness.checkpoints.map(point => point.recordId), [m.secondary.id, m.primary.id]);
    for (const checkpoint of raw.readiness.checkpoints) {
      const next = checkpoint.recordId === m.primary.id ? m.primary : m.secondary;
      checkRecordState(checkpoint.observed, next); checkGraphState(checkpoint.observed, next);
      assert.ok(checkpoint.responses.some(response => response.kind === 'graph' && response.expected.recordId === next.id));
      assert.ok(checkpoint.responses.some(response => response.kind === 'detail' && response.expected.recordId === next.id));
    }
  } else if (phase === 'graph-fullscreen') {
    assert.equal(before.fullscreen, false); assert.equal(after.fullscreen, true); assert.equal(after.modal, true); checkFit(after.graph);
    assert.ok(after.graph.height > before.graph.height, 'fullscreen viewport expands');
  } else if (phase === 'graph-zoom-in') assert.ok(after.graph.zoom > before.graph.zoom, 'real zoom-in');
  else if (phase === 'graph-zoom-out') assert.ok(after.graph.zoom < before.graph.zoom, 'real zoom-out');
  else if (['graph-fit', 'graph-relayout', 'graph-overview'].includes(phase)) {
    checkFit(after.graph);
    if (phase === 'graph-relayout') assert.notDeepEqual(after.graph.nodes.map(n => n.position), before.graph.nodes.map(n => n.position), 'relayout changed displaced node');
    if (phase === 'graph-overview') { assert.equal(before.search, record.searchToken); assert.equal(after.search, ''); assert.equal(after.type, ''); }
  } else if (phase === 'graph-search' || phase === 'graph-type-filter') {
    const matches = before.graph.nodes.filter(node => phase === 'graph-search' ? node.label.includes(record.searchToken) : node.typeLabel === '人物').map(node => node.id);
    assert.equal(matches.length, phase === 'graph-search' ? 1 : record.typeCounts.person, 'exact fixture filter domain');
    assert.deepEqual(sorted(after.graph.visibleNodeIds), sorted(matches), 'exact filter IDs');
    const edges = before.graph.edges.filter(edge => matches.includes(edge.source) && matches.includes(edge.target)).map(edge => edge.id);
    assert.deepEqual(sorted(after.graph.visibleEdgeIds), sorted(edges), 'exact filtered relation IDs');
    assert.ok(after.countText.includes(`${matches.length} / ${record.nodeCount}`));
    assert.equal(phase === 'graph-search' ? after.search : after.type, phase === 'graph-search' ? record.searchToken : '人物');
  } else if (phase === 'graph-node-detail') {
    const node = before.graph.nodes.find(node => node.id === record.nodeIds[0]);
    assert.equal(after.detailVisible, true); assert.equal(after.detailTitle, node.label);
    assert.equal(after.graph.nodes.find(item => item.id === node.id).selected, true);
  } else if (phase === 'graph-pan') {
    assert.equal(raw.input.kind, 'pan'); assert.notDeepEqual(after.graph.pan, before.graph.pan); assert.equal(after.graph.zoom, before.graph.zoom);
  } else if (phase === 'graph-node-drag') {
    assert.equal(raw.input.kind, 'node-drag'); const id = record.nodeIds[0];
    assert.notDeepEqual(after.graph.nodes.find(node => node.id === id).position, before.graph.nodes.find(node => node.id === id).position);
  } else if (phase === 'graph-wheel-zoom') { assert.equal(raw.input.kind, 'wheel'); assert.ok(after.graph.zoom > before.graph.zoom); }
  else throw new Error(`Unsupported readiness phase ${phase}`);
  return true;
}

export function validateBrowserEvidence(report, manifest) {
  const errors = [], check = (label, work) => { try { work(); } catch (error) { errors.push(`${label}: ${error.message}`); } };
  check('manifest', () => validateBrowserManifest(manifest));
  if (errors.length) return { valid: false, errors };
  check('report', () => {
    assert.equal(report.schemaVersion, 1); assert.equal(report.component, 'browser'); assert.equal(report.complete, true); assert.equal(report.status, 'collected');
    assert.ok(Number.isFinite(Date.parse(report.startedAt)) && Date.parse(report.finishedAt) >= Date.parse(report.startedAt));
    assert.equal(report.cleanup.complete, true); assert.equal(report.cleanup.browserClosed, true); assert.deepEqual(report.errors, []);
    assert.deepEqual(report.cases.map(row => row.phase), browserPhases); assert.equal(new Set(report.cases.map(row => row.id)).size, browserPhases.length);
  });
  check('environment', () => {
    assert.ok(report.environment.actualVersion && report.environment.playwrightVersion && report.environment.executablePath);
    assert.ok(Array.isArray(report.environment.actualCommandLine) && report.environment.actualCommandLine.length > 0, 'actual browser flags');
    assert.deepEqual(report.environment.requested, manifest.browser); assert.deepEqual(report.environment.network, manifest.network);
    const actual = report.environment.actualPage;
    assert.deepEqual(actual.viewport, manifest.browser.viewport); assert.equal(actual.deviceScaleFactor, manifest.browser.deviceScaleFactor);
    assert.equal(actual.locale, manifest.browser.locale); assert.equal(actual.timezoneId, manifest.browser.timezoneId); assert.equal(actual.reducedMotion, manifest.browser.reducedMotion);
    assert.equal(actual.fonts.status, 'loaded'); assert.ok(actual.fonts.platformFonts.some(font => font.glyphCount > 0 && /CJK|Han|Hei|Song|PingFang|SimSun|WenQuanYi|Noto Sans SC/i.test(font.familyName)), 'actual CJK glyph font');
    assert.deepEqual(report.environment.networkApplied, { offline: false, latency: manifest.network.latencyMs, downloadThroughput: manifest.network.downloadBytesPerSecond, uploadThroughput: manifest.network.uploadBytesPerSecond });
  });
  const planned = plannedCases(manifest);
  for (const expected of planned) {
    const row = Array.isArray(report?.cases) ? report.cases.find(item => item?.phase === expected.phase) : null;
    check(expected.phase, () => {
      assert.ok(row); assert.equal(row.id, expected.id);
      if (expected.status === 'not_applicable') { assert.equal(row.status, 'not_applicable'); assert.equal(row.reason, expected.reason); assert.deepEqual(row.samples, []); return; }
      assert.equal(row.status, 'collected'); assert.equal(row.samples.length, manifest.sampling.warmups + manifest.sampling.repetitions);
      row.samples.forEach((sample, index) => {
        assert.equal(sample.index, index); assert.equal(sample.warmup, index < manifest.sampling.warmups); assert.equal(sample.status, 'collected');
        const derived = deriveBrowserMetrics(sample.raw); assert.equal(derived.complete, true, derived.issues.join('; '));
        assert.deepEqual(sample.metrics, derived.metrics, 'metrics must equal raw recomputation'); assert.deepEqual(sample.diagnosticMetrics, derived.diagnosticMetrics);
        assert.equal(sample.timing.wallMs, derived.metrics.wallMs); assert.deepEqual(sample.issues, []); assert.deepEqual(sample.processChurn, derived.processChurn);
        assertSampleReadiness(row.phase, sample, manifest);
        if (row.phase === 'graph-fullscreen') {
          const exit = sample.raw.readiness.afterExit; assert.equal(exit?.fullscreen, false); assert.equal(exit?.modal, false);
          assert.deepEqual(exit.graph.nodes.map(node => node.position), sample.raw.readiness.before.graph.nodes.map(node => node.position));
          assert.equal(exit.graph.zoom, sample.raw.readiness.before.graph.zoom); assert.deepEqual(exit.graph.pan, sample.raw.readiness.before.graph.pan);
        }
      });
    });
  }
  check('import', () => {
    assert.equal(report.import.status, 'collected'); assert.equal(report.import.count, 1); assert.equal(report.import.inputSha256, manifest.import.sha256);
    assert.equal(report.import.addedCount, 1); assert.equal(report.import.expectedTotal, manifest.import.expectedTotal);
    assert.equal(report.import.preview.hasPreviewToken, true); assert.equal(report.import.result.mode, 'append');
    assert.equal(report.import.result.addedCount, 1); assert.equal(report.import.result.listeningCount, manifest.import.addedCount); assert.equal(report.import.reloadedOnClose, true);
    const history = report.import.historyResponse; assert.equal(history.status, 200); assert.match(history.sha256, /^[a-f0-9]{64}$/);
    validateBrowserResponse('history', history.projection, null, { total: manifest.import.expectedTotal, page: 1 });
    assert.ok(history.projection.items.some(item => item.id === manifest.import.record.id));
  });
  check('controlled negative', () => {
    const negative = report.negative; assert.equal(negative.status, 'collected'); assert.equal(negative.requestedMs, 150);
    assert.equal(negative.controlledCost.invocationCount, 1); assert.ok(negative.controlledCost.duration >= 150);
    const derived = deriveBrowserMetrics(negative.sample.raw); assert.equal(derived.complete, true); assert.deepEqual(negative.sample.metrics, derived.metrics);
    assert.ok(derived.metrics.wallMs >= 150); assert.ok(negative.sample.raw.observers.longTasks.some(entry => entry.startTime <= negative.controlledCost.startTime + 2 && entry.startTime + entry.duration >= negative.controlledCost.startTime + negative.controlledCost.duration - 2));
    assertSampleReadiness('graph-fit', negative.sample, manifest);
  });
  return { valid: errors.length === 0, errors };
}
