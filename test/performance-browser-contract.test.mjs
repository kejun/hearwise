import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { validateBrowserManifest, deriveBrowserMetrics, browserPhases, validateBrowserEvidence, collectBrowserSamples, assertSampleReadiness, validateBrowserResponse } from '../test-support/performance-browser.mjs';

function manifest() {
  const record = prefix => ({ id: prefix, title: `${prefix} title`, nodeIds: [`${prefix}-n0`, `${prefix}-n1`], edgeIds: [`${prefix}-e0`], segmentIds: [`${prefix}-s0`], nodeCount: 2, edgeCount: 1, segmentCount: 1, searchToken: 'Node000000', typeCounts: { person: 1, other: 1 } });
  return { schemaVersion: 1, baseUrl: 'http://127.0.0.1:34567', workload: { id: 'test', tier: 'small', seed: 1, recipeDigest: 'a'.repeat(64), counts: { listenings: 20 }, topology: {} },
    primary: record('a'), secondary: record('b'), import: { file: '/tmp/synthetic.sqlite', sha256: 'b'.repeat(64), record: record('c'), addedCount: 1, expectedTotal: 21 },
    sampling: { warmups: 0, repetitions: 2 }, network: { id: 'loopback', latencyMs: 0, downloadBytesPerSecond: -1, uploadBytesPerSecond: -1 },
    browser: { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'UTC', reducedMotion: 'reduce', headless: true }, timeouts: { actionMs: 1000, overallMs: 3000 } };
}

test('browser manifest rejects non-loopback destinations, inconsistent identifiers and unbounded runs', () => {
  assert.equal(validateBrowserManifest(manifest()), true);
  const external = manifest(); external.baseUrl = 'https://example.com';
  assert.throws(() => validateBrowserManifest(external), /loopback/);
  const wrong = manifest(); wrong.primary.nodeCount = 3;
  assert.throws(() => validateBrowserManifest(wrong), /node/);
  const unlimited = manifest(); unlimited.timeouts.overallMs = Infinity;
  assert.throws(() => validateBrowserManifest(unlimited), /overallMs/);
});

function raw() {
  const snapshot = (cpu, task, heap) => ({ startedAtControllerMs: cpu === 1 ? 90 : 305, finishedAtControllerMs: cpu === 1 ? 95 : 310, errors: [], performance: { metrics: [{ name: 'TaskDuration', value: task }, { name: 'ScriptDuration', value: task / 2 }, { name: 'LayoutDuration', value: task / 4 }] }, heap: { usedSize: heap }, dom: { nodes: 50, documents: 1, jsEventListeners: 10 }, processes: { processInfo: [{ id: 10, type: 'browser', cpuTime: cpu }, { id: 11, type: 'renderer', cpuTime: cpu }] } });
  return { window: { controllerStartMs: 100, controllerEndMs: 300, pageStartMs: 1000, pageEndMs: 1200 }, before: snapshot(1, 1, 1000), after: snapshot(1.125, 1.25, 2000),
    observers: { supported: ['longtask', 'event'], longTasks: [{ startTime: 1010, duration: 40 }, { startTime: 1060, duration: 90 }], events: [] } };
}

test('metrics recompute raw counters with accurate scopes and missing Event Timing stays null', () => {
  const derived = deriveBrowserMetrics(raw());
  assert.deepEqual(derived.metrics, { wallMs: 200, phaseBlockingExcessMs: 40, longTaskCount: 2, rendererTaskDurationMs: 250,
    rendererScriptDurationMs: 125, rendererLayoutDurationMs: 62.5, jsHeapUsedAfterBytes: 2000, browserProcessCpuDeltaMs: 250 });
  assert.equal(derived.complete, true);
  assert.deepEqual(derived.diagnosticMetrics, { eventTimingMaxDurationMs: null, eventTimingStatus: 'not_observed' });
  const churn = raw(); churn.after.processes.processInfo[1].id = 12;
  const incomplete = deriveBrowserMetrics(churn);
  assert.equal(incomplete.complete, false); assert.equal(incomplete.metrics.browserProcessCpuDeltaMs, null);
  assert.deepEqual(incomplete.processChurn, { born: [12], ended: [11] });
  const unavailable = raw(); unavailable.observers.supported = []; unavailable.before.processes = null;
  assert.equal(deriveBrowserMetrics(unavailable).metrics.phaseBlockingExcessMs, null);
  assert.equal(deriveBrowserMetrics(unavailable).metrics.browserProcessCpuDeltaMs, null);
});

test('unavailable browser produces every planned case without fabricated samples and closes cleanly', async () => {
  const result = await collectBrowserSamples(manifest(), { launch: async () => { throw new Error('spawn EPERM'); } });
  assert.equal(result.complete, false); assert.equal(result.status, 'not_run');
  assert.equal(result.cases.length, 21); assert.deepEqual(result.cases.map(c => c.phase), browserPhases);
  assert.ok(result.cases.every(c => c.samples.length === 0));
  assert.equal(result.cases.find(c => c.phase === 'history-next-page').status, 'not_applicable');
  assert.equal(result.cases.find(c => c.phase === 'detail-next-page').status, 'not_applicable');
  assert.ok(result.cases.filter(c => !['history-next-page', 'detail-next-page'].includes(c.phase)).every(c => c.status === 'not_run'));
  assert.equal(result.cleanup.complete, true); assert.match(result.errors[0].message, /EPERM/);
  assert.equal(validateBrowserEvidence(result, manifest()).valid, false);
});

// These tiny literals exercise the evidence validator only. They are never
// written to a measurement artifact and never represent a browser run.
function unitGraphSample(m, index = 0) {
  const r = m.primary, body = {
    detail: { listening: { id: 'a', title: 'a title' }, segmentCount: 1, knowledge: [{ id: 'a-n0' }, { id: 'a-n1' }], segments: [{ id: 'a-s0' }] },
    graph: { listeningId: 'a', nodes: [{ id: 'a-n0' }, { id: 'a-n1' }], relations: [{ id: 'a-e0' }] }
  };
  const response = kind => ({ kind, url: `${m.baseUrl}/api/listenings/a${kind === 'graph' ? '/graph' : '?page=1'}`, status: 200, byteLength: 100, sha256: 'c'.repeat(64),
    projection: body[kind], expected: { recordId: 'a', ...(kind === 'detail' ? { page: 1 } : {}) } });
  const after = { recordTitle: 'a title', recordVisible: true, loadingHidden: true, historyVisible: false, segmentIds: ['a-s0'], detailMoreVisible: false,
    graphActive: true, search: '', type: '', fullscreen: false, modal: false,
    graph: { nodeIds: ['a-n0', 'a-n1'], edgeIds: ['a-e0'], visibleNodeIds: ['a-n0', 'a-n1'], visibleEdgeIds: ['a-e0'],
      nodes: [{ id: 'a-n0', label: 'Node000000', typeLabel: '人物', position: { x: 100, y: 100 } }, { id: 'a-n1', label: 'Node000001', typeLabel: '组织', position: { x: 200, y: 100 } }],
      edges: [{ id: 'a-e0', source: 'a-n0', target: 'a-n1' }], zoom: 1, pan: { x: 0, y: 0 }, width: 1000, height: 500, clientWidth: 1000, clientHeight: 500,
      bounds: { x1: 30, y1: 30, x2: 970, y2: 470, w: 940, h: 440 }, canvasCount: 1 } };
  const data = { ...raw(), actionError: null, frames: [1100, 1116], responses: [response('detail'), response('graph')], setupResponses: [],
    readiness: { before: { historyVisible: true, recordVisible: false }, after, checkpoints: [] }, pageErrors: [], blockedRequests: [] };
  const d = deriveBrowserMetrics(data);
  return { index, warmup: false, status: 'collected', timing: { wallMs: 200 }, metrics: d.metrics, diagnosticMetrics: d.diagnosticMetrics, processChurn: d.processChurn, issues: [], raw: data };
}

test('readiness requires real response identity, exact rendered nodes AND edges, and settled frames', () => {
  const m = manifest(), sample = unitGraphSample(m);
  assert.equal(assertSampleReadiness('graph-initial-e2e', sample, m), true);
  const missingEdge = structuredClone(sample); missingEdge.raw.readiness.after.graph.edgeIds = [];
  assert.throws(() => assertSampleReadiness('graph-initial-e2e', missingEdge, m), /edge IDs/);
  const stale = structuredClone(sample); stale.raw.responses[1].projection.listeningId = 'b';
  assert.throws(() => assertSampleReadiness('graph-initial-e2e', stale, m), /record identity/);
  const prefetchedOnly = structuredClone(sample); prefetchedOnly.raw.setupResponses = [prefetchedOnly.raw.responses.pop()];
  assert.throws(() => assertSampleReadiness('graph-initial-e2e', prefetchedOnly, m), /real graph response/);
  const pendingRender = structuredClone(sample); pendingRender.raw.frames = [1100];
  assert.throws(() => assertSampleReadiness('graph-initial-e2e', pendingRender, m), /two settled/);
  assert.throws(() => validateBrowserResponse('graph', { listeningId: 'a', nodes: [{ id: 'a-n0' }, { id: 'a-n1' }], relations: [] }, m.primary), /edge IDs/);
});

test('evidence gate recomputes raw metrics and rejects forged readiness, missing samples and unsupported counters', async () => {
  const m = manifest(), report = await collectBrowserSamples(m, { launch: async () => { throw new Error('unit unavailable'); } });
  const row = report.cases.find(c => c.phase === 'graph-initial-e2e'); row.status = 'collected'; row.samples = [unitGraphSample(m), unitGraphSample(m, 1)];
  const errorsForPhase = evidence => validateBrowserEvidence(evidence, m).errors.filter(error => error.startsWith('graph-initial-e2e:'));
  assert.deepEqual(errorsForPhase(report), []);
  assert.equal(validateBrowserEvidence(report, m).valid, false, 'partial test evidence is never a full collection');
  const claimed = structuredClone(report); claimed.cases.find(c => c.phase === row.phase).samples[0].metrics.wallMs = 1;
  assert.match(errorsForPhase(claimed).join(), /raw recomputation/);
  const changedRaw = structuredClone(report); changedRaw.cases.find(c => c.phase === row.phase).samples[0].raw.window.controllerEndMs = 299;
  assert.match(errorsForPhase(changedRaw).join(), /raw recomputation/);
  const wrongReady = structuredClone(report); wrongReady.cases.find(c => c.phase === row.phase).samples[0].raw.readiness.after.graph.nodeIds = ['stale'];
  assert.match(errorsForPhase(wrongReady).join(), /node IDs/);
  const unavailable = structuredClone(report); unavailable.cases.find(c => c.phase === row.phase).samples[0].raw.before.processes = null;
  assert.match(errorsForPhase(unavailable).join(), /CPU counters unavailable/);
  const absent = structuredClone(report); absent.cases.find(c => c.phase === row.phase).samples.pop();
  assert.ok(errorsForPhase(absent).length > 0);
});

test('browser CPU and heap snapshots must bracket the measured action without errors or negative counters', () => {
  for (const change of [
    data => { data.before.startedAtControllerMs = 900; data.before.finishedAtControllerMs = 1000; },
    data => { data.after.startedAtControllerMs = 200; },
    data => { delete data.before.startedAtControllerMs; },
    data => { delete data.after.errors; },
    data => { data.before.errors.push({ message: 'CDP failure' }); },
    data => { data.before.heap.usedSize = -1; }, data => { data.after.dom.nodes = -1; },
    data => { data.before.dom.documents = -1; }, data => { data.after.dom.jsEventListeners = -1; }
  ]) {
    const data = raw(); change(data); assert.equal(deriveBrowserMetrics(data).complete, false, change.toString());
  }
});

test('browser overall deadline produces incomplete evidence instead of waiting indefinitely', async () => {
  const m = manifest(); m.timeouts = { actionMs: 100, overallMs: 100 };
  const start = performance.now();
  const result = await collectBrowserSamples(m, { launch: () => new Promise(() => {}) });
  assert.equal(result.status, 'not_run'); assert.equal(result.complete, false); assert.equal(result.cleanup.complete, true);
  assert.match(result.errors[0].message, /overall deadline/); assert.ok(performance.now() - start < 2000);
});

test('CLI missing-browser result is structured exit 3 with no invented samples', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'browser-cli-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'manifest.json'), output = path.join(directory, 'report.json');
  await writeFile(input, JSON.stringify(manifest()));
  const child = spawnSync(process.execPath, ['scripts/measure-performance-browser.mjs', input, output], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, CHROMIUM_EXECUTABLE: path.join(directory, 'intentionally-absent-chromium') }
  });
  assert.equal(child.status, 3, child.stderr); assert.equal(child.signal, null);
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.status, 'not_run'); assert.equal(result.complete, false); assert.equal(result.cases.length, 21);
  assert.ok(result.cases.every(row => row.samples.length === 0)); assert.equal(result.environment.actualVersion, null);
  assert.equal(result.cleanup.complete, true); assert.equal(result.evidenceValidation.valid, false);
  assert.match(result.errors[0].message, /intentionally-absent-chromium/);
});

test('pagination N/A is tied to exact fixture domain and cannot hide a missing case', async () => {
  const m = manifest(), report = await collectBrowserSamples(m, { launch: async () => { throw new Error('unit unavailable'); } });
  let errors = validateBrowserEvidence(report, m).errors;
  assert.ok(!errors.some(error => error.startsWith('history-next-page:')));
  const changedDomain = manifest(); changedDomain.workload.counts.listenings = 21; changedDomain.import.expectedTotal = 22;
  errors = validateBrowserEvidence(report, changedDomain).errors;
  assert.ok(errors.some(error => error.startsWith('history-next-page:')));
  const forged = structuredClone(report); forged.cases.find(row => row.phase === 'graph-initial-e2e').status = 'not_applicable';
  assert.ok(validateBrowserEvidence(forged, m).errors.some(error => error.startsWith('graph-initial-e2e:')));
});

test('wheel input waits for the renderer page-scroll guard before dispatching the real gesture', async () => {
  const { realPointer } = await import('../test-support/performance-browser.mjs');
  const renderer = { scrollingPage: true }, events = [];
  const oldDocument = globalThis.document;
  globalThis.document = { getElementById: () => ({ _cyreg: { cy: { renderer: () => renderer } } }) };
  try {
    const page = {
      locator: () => ({ scrollIntoViewIfNeeded: async () => events.push('scroll'), evaluate: async () => ({ x: 12, y: 12 }) }),
      waitForFunction: async predicate => {
        events.push('guard'); assert.equal(Boolean(predicate()), false, 'A page scroll still suppresses wheel input');
        renderer.scrollingPage = false; assert.equal(predicate(), true);
      },
      mouse: { move: async () => events.push('move'), wheel: async (x, y) => {
        assert.equal(renderer.scrollingPage, false, 'Wheel must not be silently dropped during the renderer scroll guard');
        assert.deepEqual([x, y], [0, -240]); events.push('wheel');
      } }
    };
    await realPointer(page, 'wheel', { nodeIds: ['node'] });
    assert.deepEqual(events, ['scroll', 'move', 'guard', 'wheel']);
  } finally { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; }
});


test('real import fetch Response clones remain readable when the DevTools body is unavailable', async () => {
  const { createServer } = await import('node:http');
  const { observeImportFetch } = await import('../test-support/import-protocol-browser-observer.mjs');
  const { captureJsonResponse } = await import('../test-support/performance-browser.mjs');
  const oldWindow = globalThis.window, oldLocation = globalThis.location;
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++; assert.equal(request.method, 'POST');
    let bytes = 0; for await (const chunk of request) bytes += chunk.length;
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ mode: 'append', addedCount: 1, bytes }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  globalThis.window = { fetch: globalThis.fetch }; globalThis.location = { href: base };
  try {
    observeImportFetch();
    for (const route of ['/api/data/import/validate', '/api/data/import/commit']) {
      const received = Promise.withResolvers();
      const wire = { url: () => base + route, status: () => 200, request: () => ({ method: () => 'POST' }),
        json: async () => { throw new Error('Network.getResponseBody: inspector cache evicted'); } };
      const page = {
        waitForResponse: predicate => { assert.equal(predicate(wire), true); return received.promise; },
        waitForFunction: async (predicate, value) => {
          const deadline = Date.now() + 2000;
          while (!predicate(value)) { assert.ok(Date.now() < deadline, 'Real clone must complete'); await new Promise(resolve => setTimeout(resolve, 1)); }
        },
        evaluate: async (predicate, value) => structuredClone(predicate(value))
      };
      const captured = captureJsonResponse(page, route);
      const response = await window.fetch(base + route, { method: 'POST', body: Buffer.alloc(700000, 1), signal: AbortSignal.timeout(2000) });
      received.resolve(wire);
      const originalBody = await response.json();
      assert.deepEqual(await captured, { status: 200, body: originalBody });
      assert.equal(originalBody.bytes, 700000, 'The genuine upload was delivered once, with no refetch');
    }
    assert.equal(requests, 2);
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('import response observation rejects duplicate, mismatched and missing real bodies', async () => {
  const { captureJsonResponse } = await import('../test-support/performance-browser.mjs');
  const url = 'http://127.0.0.1:1234/api/data/import/commit';
  const baseline = { url, status: 409, done: true, body: { error: 'stale' } };
  const run = entries => captureJsonResponse({
    waitForResponse: async () => ({ url: () => url, status: () => 409 }),
    waitForFunction: async () => {}, evaluate: async () => entries
  }, '/api/data/import/commit');
  assert.deepEqual(await run([baseline]), { status: 409, body: { error: 'stale' } });
  for (const entries of [[], [baseline, baseline], [{ ...baseline, status: 200 }], [{ ...baseline, url: url + '?wrong=1' }],
    [{ ...baseline, done: false }], [{ ...baseline, error: 'stream failed' }], [{ url, status: 409, done: true }]]) await assert.rejects(run(entries));
});
