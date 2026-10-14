// Actual public Hearwise app + temporary SQLite + local ASR/model providers.
// This is browser evidence, not an ASR/MT quality, real-device, or general XSS proof.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { chromium } from 'playwright';
import { sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { securityFixture, SECURITY_KEY, SECURITY_FISH_KEY, credentialFindings } from './security-fixture.mjs';
import { deadline } from './lifecycle.mjs';
import { sha256, securityCorpus as corpus, seedSecurityBrowser, renderingMutant,
  assertTextIsolation, SecurityBoundaryViolation, redactSecurityDiagnostic, observeSecurityPage } from './security-browser-support.mjs';

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error('Usage: node test-support/security-browser.mjs EVIDENCE_DIRECTORY');
await mkdir(directory, { recursive: true });
const ids = ['stored-external-text', 'live-provider-text', 'credential-surfaces', 'dangerous-rendering-control'];
const observations = { schemaVersion: 1, startedAt: new Date().toISOString(), finishedAt: null,
  source: sourceVersion(), chromium: null, browserBuildSource: null, complete: false, ok: false,
  checks: ids.map(id => ({ id, status: 'not_run', complete: false, counts: {}, observations: {} })),
  artifacts: [], counts: {}, failure: null,
  boundary: 'Local stub providers and synthetic public data only. Chromium fake microphone. No real credentials, provider quality, deployment authentication, real devices, or arbitrary-payload completeness claim.' };
let browser, fixture, page, monitor;
const monitors = [], resources = new Set();
const until = async (predicate, label, ms = 10000) => {
  const end = Date.now() + ms;
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error(`${label} observation timed out`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
const exact = async (locator, text, label) => {
  await locator.waitFor({ state: 'visible' });
  await until(async () => await locator.textContent() === text, label);
};
async function runCheck(id, work) {
  const result = observations.checks.find(check => check.id === id);
  try { Object.assign(result, await work(), { status: 'passed', complete: true }); }
  catch (error) {
    Object.assign(result, { status: /timed out|exceeded|closed/i.test(error.message) ? 'incomplete' : 'failed',
      complete: !/timed out|exceeded|closed/i.test(error.message), failure: redactSecurityDiagnostic(error) });
    throw error;
  }
}
async function newPage({ mutant } = {}) {
  const next = await browser.newPage({ viewport: { width: 1280, height: 950 }, reducedMotion: 'reduce' });
  resources.add(next); next.setDefaultTimeout(10000); next.setDefaultNavigationTimeout(12000);
  await next.addInitScript(({ key, fish }) => {
    localStorage.setItem('tongsheng:qianwen-key', key);
    localStorage.setItem('hearwise:fish-key', fish);
  }, { key: SECURITY_KEY, fish: SECURITY_FISH_KEY });
  const observer = await observeSecurityPage(next, () => fixture.base, { mutant });
  monitors.push(observer); return { page: next, monitor: observer };
}
async function closePage(target) {
  if (!target) return;
  await monitors.find(observer => observer.page === target)?.drain();
  await deadline(() => target.close(), 4000, 'Security browser page cleanup'); resources.delete(target);
}
async function api(route, { method = 'GET', body, headers = {} } = {}) {
  const result = await page.evaluate(async ({ route, method, body, headers }) => {
    const response = await fetch(route, { method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
    return { status: response.status, body: await response.json() };
  }, { route, method, body, headers });
  assert.equal(credentialFindings(result).length, 0, 'Public API response exposed a synthetic credential');
  assert.ok(result.status >= 200 && result.status < 300, `Public fixture API rejected request with status ${result.status}`);
  return result.body;
}
async function safe(scope) {
  const snapshot = await monitor.snapshot(); assertTextIsolation(snapshot, scope); return snapshot;
}
async function screenshot(name) {
  // Never persist a screenshot before checking text, attributes, and non-key
  // form inputs. Settings key inputs stay masked and the dialog stays closed.
  await safe(`artifact-${name}`);
  assert.equal(await page.locator('#settings-modal').isVisible(), false, 'Do not capture credential settings');
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(directory, filename) });
  observations.artifacts.push({ path: filename, sha256: sha256(await readFile(path.join(directory, filename))) });
}
async function openHistory(title) {
  await page.locator('#history-listening').click();
  await exact(page.locator('.history-open strong').filter({ hasText: title }), title, 'Persisted history title');
  await safe('history-title');
  await page.getByRole('button', { name: `查看“${title}”`, exact: true }).click();
  await exact(page.locator('#record-title'), title, 'Persisted record title');
  await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
}
async function checkStoredViews(record, label) {
  await exact(page.locator('#record-title'), corpus.title, `${label} title`);
  await exact(page.locator('#record-notes'), corpus.notes, `${label} notes`);
  await page.locator('#knowledge-view-list').click();
  const first = page.locator(`.knowledge-item[data-id="${record.item.id}"]`);
  const second = page.locator(`.knowledge-item[data-id="${record.camera.id}"]`);
  for (const card of [first, second]) if (!await card.evaluate(node => node.open)) await card.locator('summary').click();
  await exact(first.locator('.knowledge-title-line strong'), corpus.name, `${label} name`);
  await exact(first.locator('.knowledge-brief'), corpus.summary, `${label} model summary`);
  await exact(first.locator('.knowledge-dialogue'), `本次提到：${corpus.fact}`, `${label} model fact`);
  assert.ok((await second.locator('.knowledge-aliases').textContent()).includes(corpus.alias), 'Stored alias is visible verbatim');
  assert.ok((await second.locator('.knowledge-background').textContent()).includes(corpus.background), 'Stored background is visible verbatim');
  assert.ok((await page.locator('#transcript-list').textContent()).includes(corpus.name), 'Corrected original is visible verbatim');
  await safe(`${label}-cards-transcript`);
  await page.locator('#knowledge-view-graph').click();
  await page.locator('#graph-count').filter({ hasText: '2 / 2' }).waitFor();
  await page.locator('#graph-viewport canvas').first().waitFor({ state: 'visible' });
  if (!await page.locator('.graph-results').evaluate(node => node.open)) await page.locator('.graph-results > summary').click();
  assert.equal(await page.locator('[data-result-node-id]').count(), 2);
  for (const [id, texts] of [[record.item.id, [corpus.name, corpus.summary, corpus.fact]],
    [record.camera.id, [corpus.alias, corpus.background]]]) {
    await page.locator(`[data-result-node-id="${id}"]`).click();
    const panel = page.locator('#graph-details'); await panel.waitFor({ state: 'visible' });
    for (const text of texts) assert.ok((await panel.textContent()).includes(text), `${label} graph details retain external text`);
    await safe(`${label}-graph-${id === record.item.id ? 'model' : 'fixture'}`);
    await page.keyboard.press('Escape');
  }
  return { historyRecords: 1, knowledgeCards: 2, graphNodes: 2, graphDetails: 2 };
}
async function inspectRuntime(label) {
  const currentLogs = fixture.logs();
  assert.equal(credentialFindings(currentLogs).length, 0, `${label} server logs and Trace must exclude credentials`);
  const db = new DatabaseSync(fixture.filename, { readOnly: true });
  let tables = 0, rows = 0, files = 0, bytes = 0;
  try {
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const data = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(); tables++; rows += data.length;
      assert.equal(credentialFindings(data).length, 0, `${label} SQLite business rows must exclude credentials`);
    }
  } finally { db.close(); }
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(name);
      else if (entry.isFile()) {
        const data = await readFile(name); files++; bytes += data.length;
        assert.equal(credentialFindings(data).length, 0, `${label} SQLite/runtime files must exclude credentials`);
      }
    }
  }
  await scan(fixture.directory);
  return { tables, rows, files, bytes, traceEvents: currentLogs.split('\n').filter(line => line.startsWith('execution_trace ')).length };
}

try {
  const appSource = await readFile('public/app.js', 'utf8');
  const playwright = JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8'));
  observations.browserBuildSource = { mode: process.env.CHROMIUM_EXECUTABLE ? 'explicit-executable-override' : 'locked-playwright-managed-chromium',
    executablePath: process.env.CHROMIUM_EXECUTABLE || chromium.executablePath(), playwrightVersion: playwright.version,
    appSha256: sha256(appSource), serverBuildSha256: sha256(await readFile('dist/server/index.js')), servedAppSha256: null };
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, timeout: 15000,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  observations.chromium = browser.version(); observations.browserBuildSource.browserVersion = browser.version();
  fixture = await securityFixture({ seed: seedSecurityBrowser });
  ({ page, monitor } = await newPage()); await page.goto(fixture.base);
  const record = fixture.seeded, root = `/api/listenings/${record.listeningId}`;
  await runCheck('stored-external-text', async () => {
    await openHistory('名称纠正测试');
    await page.locator('#edit-record').click();
    await page.locator('#record-title-input').fill(corpus.title); await page.locator('#record-notes-input').fill(corpus.notes);
    await page.locator('#save-record').click();
    await page.locator('#record-edit-status').filter({ hasText: '标题与备注已保存' }).waitFor();
    const target = `${root}/knowledge/${record.item.id}`;
    const before = await api(target);
    await api(`${target}/name-replacements`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() },
      body: { name: corpus.name, revision: before.revision } });
    fixture.control.modelOutput = body => {
      const input = JSON.parse(body.messages.at(-1).content);
      assert.equal(input.name, corpus.name, 'Manual regeneration reaches the actual provider input');
      return { short_description: corpus.summary, dialogue_summary: corpus.summary,
        facts: [{ content: corpus.fact, segment_id: input.segments[0].id, quote: input.segments[0].text }] };
    };
    const next = await api(target);
    await api(target, { method: 'PATCH', body: { name: corpus.name, source: corpus.name, revision: next.revision, key: SECURITY_KEY } });
    const stored = await api(root), item = stored.knowledge.find(item => item.id === record.item.id);
    assert.equal(stored.listening.title, corpus.title); assert.equal(stored.listening.notes, corpus.notes);
    assert.equal(item.canonical_name, corpus.name); assert.equal(item.short_description, corpus.summary); assert.equal(item.facts[0].content, corpus.fact);
    await safe('stored-writes-before-reload');
    await monitor.drain(); await page.reload(); await openHistory(corpus.title);
    const first = await checkStoredViews(record, 'reload'); await screenshot('security-stored-text');
    const persisted = await inspectRuntime('before-reopen');
    await closePage(page); page = null; await fixture.restart();
    ({ page, monitor } = await newPage()); await page.goto(fixture.base); await openHistory(corpus.title);
    const reopened = await checkStoredViews(record, 'server-reopen'); await screenshot('security-reopened-graph');
    return { counts: { metadataWrites: 1, nameReplacementWrites: 1, modelRegenerationWrites: 1, browserReloads: 1, serverRestarts: 1,
      knowledgeCards: first.knowledgeCards + reopened.knowledgeCards, graphDetails: first.graphDetails + reopened.graphDetails },
    observations: { persisted, ingress: ['public metadata form PATCH', 'public name-replacements POST', 'public knowledge PATCH → local model → validated model commit'],
      fixtureOnlyFields: { fields: ['alias', 'background_note'], ingress: 'ListeningStore.applyKnowledge before initial database close; no public setter' },
      views: ['history title', 'record title and notes', 'original transcript', 'knowledge cards', 'Cytoscape canvas and accessible nodes', 'graph details'], final: await safe('reopened-all') } };
  });
  let liveId;
  await runCheck('live-provider-text', async () => {
    fixture.control.modelOutput = body => body.model === 'qwen-mt-flash' ? corpus.translation : { items: [] };
    await page.locator('#new-listening').click(); await page.getByRole('button', { name: '开始聆听', exact: true }).click();
    await page.getByRole('button', { name: '停止聆听', exact: true }).waitFor();
    await until(() => fixture.stats.asrClients.size === 1 && monitor.state.listeningIds.length > 0, 'Live ASR connection');
    liveId = monitor.state.listeningIds.at(-1); fixture.final(corpus.original, 'security-live-original');
    await exact(page.locator('#original'), corpus.original, 'Live original from ASR');
    await exact(page.locator('#translation'), corpus.translation, 'Live translation from model');
    await safe('live-provider-captions');
    await page.getByRole('button', { name: '停止聆听', exact: true }).click();
    await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
    const stored = await api(`/api/listenings/${liveId}`);
    assert.equal(stored.segments.length, 1); assert.equal(stored.segments[0].original_text, corpus.original);
    assert.equal(stored.segments[0].translation_text, corpus.translation);
    await safe('live-persistence-before-reload');
    await monitor.drain(); await page.reload(); await openHistory(stored.listening.title);
    await exact(page.locator('.transcript-original'), corpus.original, 'Reloaded ASR original');
    await exact(page.locator('.transcript-translation'), corpus.translation, 'Reloaded model translation');
    await safe('live-provider-reload'); await screenshot('security-live-provider-text');
    return { counts: { asrFinals: 1, persistedSegments: stored.segments.length, modelTranslations: 1, browserReloads: 1 },
      observations: { ingress: ['local ASR WebSocket final → real app SQLite', 'local translation provider HTTP response → real app SQLite'],
        final: await safe('live-complete') } };
  });
  await runCheck('credential-surfaces', async () => {
    const permitted = await page.evaluate(({ key, fish }) => ({
      keyStorage: localStorage.getItem('tongsheng:qianwen-key') === key,
      fishStorage: localStorage.getItem('hearwise:fish-key') === fish,
      keyInput: document.getElementById('api-key').value === key,
      fishInput: document.getElementById('speech-fish-key').value === fish,
      masked: ['api-key', 'speech-fish-key'].every(id => document.getElementById(id).type === 'password')
    }), { key: SECURITY_KEY, fish: SECURITY_FISH_KEY });
    assert.ok(Object.values(permitted).every(Boolean), 'Synthetic credentials remain in the explicitly allowed masked input/storage slots');
    await page.locator('#settings-trigger').click();
    fixture.control.modelOutput = undefined; fixture.control.modelStatus = 401; fixture.control.asrFailure = true;
    await page.locator('#test-connection').click();
    await exact(page.locator('#test-summary'), '有服务未通过检查', 'Provider failure status');
    await safe('provider-error-settings');
    fixture.control.modelStatus = 200; fixture.control.asrFailure = false;
    await page.locator('#test-connection').click();
    await exact(page.locator('#test-summary'), '连接成功，可以开始使用', 'Recovered provider status');
    await page.locator('#close-settings').click();
    const exports = [];
    for (const route of [`${root}/export?kind=original`, `${root}/export?kind=translation`,
      `/api/listenings/${liveId}/export?kind=original`, `/api/listenings/${liveId}/export?kind=translation`, '/api/data/export']) {
      const response = await fetch(fixture.base + route, { signal: AbortSignal.timeout(8000) });
      assert.equal(response.status, 200); const data = Buffer.from(await response.arrayBuffer());
      assert.equal(credentialFindings(data).length, 0, 'Transcript/database export must exclude credentials');
      assert.equal(credentialFindings(JSON.stringify([...response.headers])).length, 0, 'Export headers must exclude credentials');
      exports.push({ kind: route === '/api/data/export' ? 'database' : route.endsWith('original') ? 'original' : 'translation', bytes: data.length });
    }
    const storage = await inspectRuntime('final');
    assert.ok(storage.traceEvents > 0, 'Actual structured Trace must be observed');
    assert.ok(fixture.stats.requests.length >= 8, 'Credential flow must include actual successful and failed provider requests');
    assert.ok(fixture.stats.requests.every(request => request.authorization === `Bearer ${SECURITY_KEY}`), 'Only the intended local providers receive the exact synthetic authorization');
    assert.equal(credentialFindings(fixture.stats.requests.map(request => request.body ?? null)).length, 0, 'Provider business bodies must exclude credentials');
    await safe('credential-final');
    return { counts: { exports: exports.length, providerAuthorizations: fixture.stats.requests.length, sqliteTables: storage.tables,
      sqliteRows: storage.rows, runtimeFiles: storage.files, traceEvents: storage.traceEvents },
    observations: { allowed: permitted, exports, storage, final: await safe('credential-complete'),
      allowedLocations: ['masked key inputs', 'key localStorage slots', 'request inputs and transient memory', 'target local provider Authorization'],
      forbiddenLocations: ['rendered body/status/non-key inputs/attributes', 'console/page errors', 'HTTP and WebSocket responses', 'server logs/Trace', 'SQLite and runtime files', 'text/database exports'],
      fishScope: 'Synthetic Fish key input/localStorage only; no TTS request is triggered by this ASR/MT-only fixture.' } };
  });
  await runCheck('dangerous-rendering-control', async () => {
    // Reuse the same persisted malicious title at the same sink on both sides.
    await openHistory(corpus.title);
    const normal = await safe('normal-before-mutation');
    await closePage(page); page = null;
    const mutant = renderingMutant(appSource);
    ({ page, monitor } = await newPage({ mutant })); await page.goto(fixture.base);
    await page.locator('#history-listening').click();
    await page.getByRole('button', { name: `查看“${corpus.title}”`, exact: true }).click();
    await page.getByRole('button', { name: '继续收听', exact: true }).waitFor();
    await until(async () => {
      const state = await monitor.snapshot();
      return state.injectedNodeCount > 0 || state.executionCount > 0 || state.probeRequests > 0;
    }, 'Actual-app rendering mutant detection');
    const mutated = await monitor.snapshot(); let detected;
    try { assertTextIsolation(mutated, 'actual-app-rendering-mutant'); }
    catch (error) { if (!(error instanceof SecurityBoundaryViolation)) throw error; detected = error.findings; }
    assert.ok(detected?.includes('unexpected-nodes'), 'The same oracle must reject actual injected nodes');
    assert.ok(detected.includes('script-execution') || detected.includes('probe-request'), 'The mutation must execute its handler or initiate its probe');
    assert.equal(mutated.credentialFindings, 0, 'Even mutation diagnostics must never leak credentials');
    assert.equal(mutated.externalRequests, 0); assert.equal(mutated.observationErrors, 0); assert.equal(mutated.pageErrors, 0);
    assert.equal(monitor.state.mutationResponses, 1, 'Exactly one actual app resource response was mutated');
    assert.deepEqual(monitor.state.servedAppHashes, [sha256(mutant.source)], 'Chromium loaded the copied mutated actual-app resource');
    return { counts: { mutants: 1, replacements: mutant.replacements, mutantResourceResponses: monitor.state.mutationResponses,
      injectedNodes: mutated.injectedNodeCount, probeRequests: mutated.probeRequests, scriptExecutions: mutated.executionCount },
    observations: { normal, mutated, detected, expectedFailure: true, scope: 'Single record-title rendering sink in copied actual /app.js; all app APIs/SQLite/resources remain real and unchanged.',
      anchor: mutant.anchor, replacement: mutant.replacement, normalAppSha256: sha256(appSource), mutantAppSha256: sha256(mutant.source) } };
  });
  const normalHashes = monitors.filter(observer => observer.state.mutationResponses === 0).flatMap(observer => observer.state.servedAppHashes);
  assert.ok(normalHashes.length >= 4 && normalHashes.every(hash => hash === sha256(appSource)), 'Every normal navigation must serve the unmodified actual app');
  observations.browserBuildSource.servedAppSha256 = normalHashes[0];
  observations.counts = { checks: observations.checks.length, passed: observations.checks.filter(check => check.status === 'passed').length,
    normalAppResponses: normalHashes.length, pageContexts: monitors.length,
    apiResponses: monitors.reduce((sum, observer) => sum + observer.state.apiResponses, 0),
    websocketResponses: monitors.reduce((sum, observer) => sum + observer.state.wsResponses, 0),
    domSnapshots: monitors.reduce((sum, observer) => sum + observer.state.snapshots, 0),
    consoleMessages: monitors.reduce((sum, observer) => sum + observer.state.consoleMessages, 0), artifacts: observations.artifacts.length };
  observations.complete = observations.checks.every(check => check.complete);
  observations.ok = observations.complete && observations.checks.every(check => check.status === 'passed');
} catch (error) { observations.failure = redactSecurityDiagnostic(error); process.exitCode = 1; }
finally {
  const cleanup = await Promise.allSettled([...resources].map(target => closePage(target)));
  if (fixture) cleanup.push(await fixture.close().then(() => ({ status: 'fulfilled' }), reason => ({ status: 'rejected', reason })));
  if (browser) cleanup.push(await deadline(() => browser.close(), 5000, 'Security Chromium cleanup').then(() => ({ status: 'fulfilled' }), reason => ({ status: 'rejected', reason })));
  const failures = cleanup.filter(result => result.status === 'rejected');
  if (failures.length) { observations.complete = false; observations.ok = false;
    observations.cleanupFailures = failures.map(result => redactSecurityDiagnostic(result.reason)); process.exitCode = 1; }
  // Include events arriving after the last DOM checkpoint and during teardown.
  // A positive mutation permits only its expected local probe/script evidence.
  const lateUnsafe = monitors.some(({ state }) => state.credentialHits || state.observationErrors || state.pageErrors || state.external ||
    state.mutationResponses === 0 && state.probes);
  if (lateUnsafe) { observations.complete = false; observations.ok = false;
    observations.lateObservationFailure = true; process.exitCode = 1; }
  observations.finishedAt = new Date().toISOString();
  assert.equal(credentialFindings(observations).length, 0, 'Evidence must never serialize credential sentinels');
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify(observations, null, 2) + '\n');
  console.log(JSON.stringify({ complete: observations.complete, ok: observations.ok, chromium: observations.chromium,
    checks: observations.checks.map(({ id, status }) => ({ id, status })), counts: observations.counts, failure: observations.failure }));
  if (!observations.ok) process.exitCode = 1;
}
