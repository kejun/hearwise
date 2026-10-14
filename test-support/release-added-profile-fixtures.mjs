// Synthetic offline reader fixtures ONLY. No browser, model checker, production
// HTTP request or real verification execution is represented by these reports.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, metadata, sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { sourceSnapshot, browserScreenshots, hashEvidenceFiles } from '../scripts/lib/runner-evidence-contract.mjs';
import { newNestedChecks, nestedTestNames } from '../scripts/lib/new-browser-release-evidence.mjs';
import { importBrowserSourceStamp, importBrowserCases, summarizeImportBrowserEvidence } from './import-protocol-browser-evidence.mjs';
import { securitySourceSnapshot, securityTableNames } from './security-evidence.mjs';
import { renderingMutant } from './security-browser-support.mjs';
import { editConsistencyProfile } from '../verification/edit-consistency-properties.mjs';
import { securityProfile } from '../verification/security-properties.mjs';
import { summarizeEditResults, writeEditEvidence } from './edit-consistency-evidence.mjs';
import { knowledgeRevision } from '../knowledge-revision.mjs';
export const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const json = (file, value) => writeFile(file, JSON.stringify(value));
const time = '2026-01-01T00:00:00.000Z';
const synthetic = 'TEST ONLY: synthetic raw reader fixture, not browser acceptance';
const emptyTables = () => Object.fromEntries(securityTableNames.map(name => [name, []]));
const client = (writes = 0, names = [], revisions = []) => ({ writes, explicitSaves: writes, receiptReads: 0, submissions: names.map((name, i) => ({ name, revision: revisions[i] })) });
const snapshot = name => {
  const result = { item: { id: 'item', listening_id: 'local', canonical_name: name, name_override: null, name_override_identity: null, aliases: [], mentions: [], revisions: [], facts: [] }, segments: [] };
  result.revision = knowledgeRevision(result); return result;
};
function editCapture(label, name, width, value = client()) {
  const view = snapshot(name), tables = emptyTables(); tables.knowledge_items = [JSON.stringify(view.item)];
  if (name !== 'Deebo') tables.knowledge_edit_jobs = [JSON.stringify({ id: 'receipt', state: 'succeeded' })];
  return { label, snapshot: view, tables, client: value, errors: [], providerCalls: 0,
    ui: { open: true, name, source: name, status: '', disabled: { name: false, save: false, delete: false, suggest: false, close: false }, scrollWidth: width - 10, clientWidth: width - 10, left: 0, right: width - 10, width } };
}
export async function syntheticEditBrowser() {
  const first = snapshot('Deebo').revision, second = snapshot('Tibo').revision;
  const widths = [1280, 390].map(width => ({ width, results: ['conflict', 'unknown-502', 'unknown-lost', 'rollback', 'late-success'].map(scenario => {
    const initial = editCapture('initial', 'Deebo', width), one = client(1, ['Tibo'], [first]), two = client(2, ['Tibo', 'Mira'], [first, second]); let evidence, details = {};
    if (scenario === 'conflict') {
      const conflict = editCapture('conflict', 'Tibo', width, client(1, ['Mira'], [first])); conflict.ui.name = 'Mira'; conflict.ui.status = '已读取最新内容，输入已保留';
      const reopened = { ...structuredClone(conflict), label: 'reopened', ui: { ...conflict.ui, name: 'Tibo' } };
      evidence = [initial, conflict, reopened, editCapture('continued', 'Mira', width, two)]; details.clients = [one, two];
    } else if (scenario.startsWith('unknown-')) {
      const unknown = editCapture('unknown', 'Tibo', width, { ...one, receiptReads: 1 }); unknown.ui.status = '保存结果尚未确认'; for (const key of ['save', 'delete', 'suggest']) unknown.ui.disabled[key] = true;
      const reopened = editCapture('reopened', 'Tibo', width, { ...one, receiptReads: 1 }); evidence = [initial, unknown, reopened, editCapture('continued', 'Mira', width, two)]; details.receipt = { id: 'receipt', state: 'succeeded', saved: true };
    } else if (scenario === 'rollback') {
      const failed = editCapture('rolled-back', 'Deebo', width, one); failed.ui.name = 'Tibo'; failed.ui.status = '原内容未更改';
      evidence = [initial, failed, editCapture('continued', 'Tibo', width, client(2, ['Tibo', 'Tibo'], [first, first]))];
    } else {
      const busy = editCapture('busy-after-commit', 'Tibo', width, one); busy.ui.disabled.close = true;
      evidence = [initial, busy, editCapture('later-save', 'Mira', width, client(1, ['Mira'], [second])), editCapture('reopened', 'Mira', width, one)];
    }
    return { scenario, complete: true, ok: true, providerCalls: 0, evidence, ...details };
  }) }));
  const source = await readFile('public/knowledge-editor.js', 'utf8'), anchor = 'current.revision = snapshot.revision;';
  const mutant = source.replace(anchor, anchor + "\n    setTimeout(() => { void save('POST'); }, 0); // Deliberately broken response-handler retry.");
  const before = editCapture('before-mutant-save', 'Tibo', 390), after = editCapture('after-mutant-save', 'Mira', 390, { ...client(2, ['Mira', 'Mira'], [first, second]), explicitSaves: 1 });
  return { complete: true, ok: true, chromium: synthetic, widths, negative: { complete: true, classification: 'implementation_mismatch', property: 'HW-06-06', evidence: [before, after],
    sourceSha256: digest(source), mutantSha256: digest(mutant), counterexample: { ...after.client, overwrittenName: 'Tibo', persistedName: 'Mira', firstExcessRequest: 2 } } };
}
export async function syntheticSecurityBrowser() {
  const zero = { executionCount: 0, injectedNodeCount: 0, probeRequests: 0, externalRequests: 0, credentialFindings: 0, observationErrors: 0, pageErrors: 0 };
  const app = await readFile('public/app.js', 'utf8'), mutant = renderingMutant(app), expectedRenderingMutation = { normalAppSha256: digest(app), mutantAppSha256: digest(mutant.source), anchor: mutant.anchor, replacement: mutant.replacement, replacements: mutant.replacements };
  const tableRows = Object.fromEntries(securityTableNames.map(name => [name, 1])); Object.assign(tableRows, { listenings: 2, listening_runs: 2, segments: 3, knowledge_items: 2 }); const rows = Object.values(tableRows).reduce((a, b) => a + b, 0);
  return { expectedRenderingMutation, browser: { source: sourceVersion(), complete: true, ok: true, chromium: synthetic, browserBuildSource: { appSha256: digest(app), servedAppSha256: digest(app), serverBuildSha256: digest(await readFile('dist/server/index.js')), playwrightVersion: JSON.parse(await readFile('node_modules/playwright/package.json')).version, browserVersion: synthetic }, checks: [
    { id: 'stored-external-text', status: 'passed', complete: true, counts: { metadataWrites: 1, nameReplacementWrites: 1, modelRegenerationWrites: 1, browserReloads: 1, serverRestarts: 1, knowledgeCards: 4, graphDetails: 4 }, observations: { final: zero } },
    { id: 'live-provider-text', status: 'passed', complete: true, counts: { asrFinals: 1, persistedSegments: 1, modelTranslations: 1, browserReloads: 1 }, observations: { final: zero } },
    { id: 'credential-surfaces', status: 'passed', complete: true, counts: { exports: 5, providerAuthorizations: 9, sqliteTables: securityTableNames.length, sqliteRows: rows, runtimeFiles: 1, traceEvents: 1 }, observations: { final: zero, storage: { tableRows, tables: securityTableNames.length, rows, files: 1, bytes: 10, fileNames: ['business.sqlite'], traceEvents: 1 }, exports: ['original', 'original', 'translation', 'translation', 'database'].map(kind => ({ kind, bytes: 1 })), allowed: { keyStorage: true, fishStorage: true, keyInput: true, fishInput: true, masked: true } } },
    { id: 'dangerous-rendering-control', status: 'passed', complete: true, counts: { mutants: 1, replacements: 1, mutantResourceResponses: 1, injectedNodes: 1, probeRequests: 1, scriptExecutions: 0 }, observations: { ...expectedRenderingMutation, expectedFailure: true, normal: zero, mutated: { ...zero, injectedNodeCount: 1, probeRequests: 1 }, detected: ['unexpected-nodes', 'probe-request'] } }
  ] } };
}
function business(ids) {
  const rows = emptyTables(); rows.listenings = ids.map(id => ({ id, relation_enabled: 0, relation_waiting_key: 0 })); rows.knowledge_items = ids.map(id => ({ id: `item-${id}`, listening_id: id, name: 'original' }));
  if (ids.includes('imported')) for (const [table, values] of [['segments', { translation_state: 'failed' }], ['extraction_jobs', { state: 'failed', last_error: 'IMPORT_REQUIRES_RESUME' }], ['relation_jobs', { state: 'cancelled', last_error: 'IMPORT_REQUIRESUME' }], ['relation_rounds', { state: 'paused', stop_reason: 'IMPORT_REQUIRES_RESUME' }], ['knowledge_edit_jobs', { state: 'failed' }]]) rows[table] = [{ id: table, listening_id: 'imported', ...values }];
  if (rows.relation_jobs.length) rows.relation_jobs[0].last_error = 'IMPORT_REQUIRES_RESUME';
  return { rows, schema: securityTableNames.map(name => ({ name, type: 'table', sql: `CREATE TABLE ${name} (id TEXT)` })), integrity: 'ok', foreignKeyErrors: [] };
}
export async function syntheticImportBrowser() {
  const stamp = await importBrowserSourceStamp(), hash = label => digest(label);
  const scenarios = importBrowserCases.map(({ mode, name }) => {
    const stale = name === 'stale-review', expiry = name === 'expired-upload', initial = business(['local']), changed = structuredClone(initial); changed.rows.knowledge_items[0].name = 'changed';
    const base = expiry ? initial : changed, after = business(mode === 'append' ? ['local', 'imported'] : ['imported']);
    if (mode === 'append') after.rows.knowledge_items[0] = base.rows.knowledge_items[0];
    const snapshots = [['before-upload', initial], ['after-upload', initial], ...(!expiry ? [['after-same-connection-child-write', changed]] : []), ...(stale ? [['after-cancel', initial], ['after-stale-rejection', base], ['before-second-confirmation', base]] : [[expiry ? 'after-expired-rejection' : 'after-stale-refresh-expiry', base], ['after-fresh-upload', base]]), ['committed', after], ['after-process-restart', after]].map(([label, database]) => ({ label, database }));
    const review = { mode, databaseVersion: 12, listeningCount: 1, currentCount: 1, tokenSha256: hash('token'), previewTokenSha256: hash('preview'), revision: hash('revision') };
    const refreshed = { ...review, tokenSha256: stale ? review.tokenSha256 : hash('token2'), previewTokenSha256: hash('preview2'), revision: hash('revision2') };
    const http = [], request = (endpoint, status, response, body) => http.push({ index: http.length, path: `/api/data/import/${endpoint}`, method: 'POST', status, response, request: body });
    request('validate', 200, review, { mode, uploadBytes: 100 }); request('commit', expiry ? 410 : 409, { code: expiry ? 'IMPORT_EXPIRED' : 'IMPORT_PREVIEW_STALE' }, review);
    if (!expiry) request('preview', stale ? 200 : 410, stale ? refreshed : { code: 'IMPORT_EXPIRED' }, { mode });
    if (!stale) request('validate', 200, refreshed, { mode, uploadBytes: 100 });
    request('commit', 200, { mode, changed: true, addedCount: 1, skippedCount: 0, safetyBackup: 'before-import-test.sqlite' }, refreshed);
    const fields = [['translations', 'segments', ['id', 'translation_state']], ['extraction', 'extraction_jobs', ['id', 'state', 'last_error']], ['relations', 'relation_jobs', ['id', 'state', 'last_error']], ['rounds', 'relation_rounds', ['id', 'state', 'stop_reason']], ['edits', 'knowledge_edit_jobs', ['id', 'state']]];
    const work = { providerCalls: 0, ...Object.fromEntries(fields.map(([field, table, names]) => [field, after.rows[table].map(row => Object.fromEntries(names.map(key => [key, row[key]])))])) };
    return { mode, name, backup: business(['imported']), complete: true, ok: true, pageErrors: [], providerCalls: [], routeErrors: [], snapshots, http, cancel: { requestsBefore: 1, requestsAfter: 1 },
      confirmations: (stale ? [false, true, true] : [true, true]).map(accepted => ({ accepted, type: 'confirm', message: mode === 'append' ? '将新增 1 条收听，跳过 0 条' : '完整替换' })),
      clock: [{ timers: [{ id: 0, active: true, requestedMilliseconds: 900000 }] }, { timers: [{ id: 0, active: false }] }],
      ui: { staleReview: { status: '预览已刷新', confirmDisabled: false }, expired: { status: '导入文件已过期' }, expiredRefresh: { status: '导入文件已过期', confirmDisabled: true }, committed: { status: mode === 'append' ? '追加完成：新增 1 条，跳过 0 条' : '数据覆盖完成', confirmDisabled: true, reviewHidden: true } },
      expectedListeningIds: after.rows.listenings.map(row => row.id).sort(), unfinishedAfterCommit: work, unfinishedAfterRestart: structuredClone(work), lifecycle: [{ action: 'start' }, { action: 'crash', signal: 'SIGKILL' }, { action: 'start' }],
      checks: { importedWorkStopped: { complete: true, ok: true }, browserProtocol: { complete: true, ok: true } }, cleanup: [{ target: 'browser context', ok: true }, { target: 'fixture', ok: true }] };
  });
  return { schemaVersion: 1, profile: 'import-protocol-browser', complete: true, ok: true, sourceStart: stamp, sourceEnd: structuredClone(stamp), tools: { node: process.version, sqlite: process.versions.sqlite, chromium: synthetic }, scenarios, errors: [], cleanup: [{ target: 'Chromium', ok: true }], screenshots: browserScreenshots['import-protocol'].map(name => {
    const match = name.match(/^(append|replace)-(stale-review|expired-upload|stale-refresh-expiry)-(.+)-(1280|390|320)\.png$/);
    return { path: name, mode: match[1], scenario: match[2], label: match[3], width: Number(match[4]), sha256: digest(png), layout: { scrollWidth: Number(match[4]), clientWidth: Number(match[4]) } };
  }) };
}
export async function writeSyntheticImport(directory, observations) {
  await json(path.join(directory, 'observations.json'), observations);
  const scenarios = observations.scenarios.map(({ snapshots, ...scenario }) => ({ ...scenario, requestCounts: { total: scenario.http.length, ...Object.fromEntries(['validate', 'preview', 'commit'].map(name => [name, scenario.http.filter(row => row.path === `/api/data/import/${name}`).length])) }, commitStatuses: scenario.http.filter(row => row.path === '/api/data/import/commit').map(row => row.status), snapshots: snapshots.map(({ label, database }) => ({ label, sha256: digest(JSON.stringify(database)), rowCounts: Object.fromEntries(Object.entries(database.rows).map(([table, rows]) => [table, rows.length])), listeningIds: database.rows.listenings.map(row => row.id).sort(), integrity: database.integrity, foreignKeyErrors: database.foreignKeyErrors })) }));
  await json(path.join(directory, 'report.json'), { ...observations, scenarios, results: summarizeImportBrowserEvidence(observations).results, artifacts: await hashEvidenceFiles(directory, ['observations.json', ...browserScreenshots['import-protocol']]) });
}
export async function addedNestedFixture(kind, directory) {
  await mkdir(directory, { recursive: true }); for (const name of browserScreenshots[kind]) await writeFile(path.join(directory, name), png);
  if (kind === 'import-protocol') { const observations = await syntheticImportBrowser(); await writeSyntheticImport(directory, observations); return observations; }
  const context = await metadata(), executionContext = { repositoryRoot: '/synthetic/checkout', evidenceDirectory: '/synthetic/evidence/' + kind, nodeExecutable: '/synthetic/bin/node', overallTimeoutMs: 150000 }, checks = [];
  for (const spec of newNestedChecks[kind]) {
    const names = spec.files ? await nestedTestNames(spec.files) : [], count = names.length;
    const log = count ? 'TAP version 13\n' + names.map((name, i) => `ok ${i + 1} - ${name}\n`).join('') + `1..${count}\n# tests ${count}\n# suites 0\n# pass ${count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n` : synthetic;
    await writeFile(path.join(directory, `${spec.name}.log`), log);
    const argv = spec.files ? ['--test', '--test-reporter=tap', '--test-timeout=20000', ...spec.files] : [`test-support/${kind}-browser.mjs`, executionContext.evidenceDirectory];
    const execution = { code: 0, signal: null, timedOut: false, interrupted: false, ok: true, tail: log.slice(-12000), ...(count ? { testCount: count, testComplete: true } : {}) };
    checks.push(kind === 'security' ? { name: spec.name, command: [executionContext.nodeExecutable, ...argv], timeoutMs: spec.timeoutMs, configuredTimeoutMs: spec.timeoutMs, execution } : { name: spec.name, execution: { ...execution, argv, timeoutMs: spec.timeoutMs, configuredTimeoutMs: spec.timeoutMs } });
  }
  const details = kind === 'security' ? await syntheticSecurityBrowser() : { browser: await syntheticEditBrowser() };
  const sourceStart = kind === 'security' ? await securitySourceSnapshot() : await sourceSnapshot(), browser = details.browser;
  if (kind === 'security') browser.artifacts = await hashEvidenceFiles(directory, browserScreenshots[kind]);
  await json(path.join(directory, 'browser.json'), browser);
  const observations = { checks, ...details, ...(kind === 'security' ? { sourceStart, sourceEnd: sourceStart, cleanupOk: true, budgetExpired: false } : {}) };
  let artifacts;
  if (kind === 'edit-consistency') artifacts = await writeEditEvidence(directory, observations);
  else { await json(path.join(directory, 'observations.json'), observations); await writeFile(path.join(directory, 'worker.log'), (await Promise.all(checks.map(async row => `CHECK ${row.name}\n${await readFile(path.join(directory, row.name + '.log'), 'utf8')}`))).join('\n')); artifacts = await hashEvidenceFiles(directory, ['observations.json', 'worker.log']); }
  const required = kind === 'security' ? securityProfile : editConsistencyProfile, results = required.map(id => ({ ...context, property: { id, version: 1 }, complete: true, status: 'passed', startedAt: time, finishedAt: time, scope: { description: synthetic, scenario: 'unit-only', samples: 1, seed: null }, artifacts }));
  const report = { ...context, executionContext, profile: kind, profileVersion: 1, nodeOnly: false, sourceStart, sourceEnd: sourceStart, complete: true, ok: true, results };
  if (kind === 'edit-consistency') report.execution = summarizeEditResults({ results, checks, target: context.source, required, sourceStable: true, artifactsValid: results.map(() => true) }).execution;
  await json(path.join(directory, 'report.json'), report); return observations;
}
