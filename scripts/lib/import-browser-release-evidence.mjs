import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { browserScreenshots, evidenceFiles } from './runner-evidence-contract.mjs';
import { importBrowserSourceStamp, importBrowserCases, summarizeImportBrowserEvidence } from '../../test-support/import-protocol-browser-evidence.mjs';
import { validateBusinessSnapshot, validateImportedRows } from './import-release-durable.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const snapshotSummary = snapshot => ({ sha256: digest(JSON.stringify(snapshot)), rowCounts: Object.fromEntries(Object.entries(snapshot.rows).map(([table, rows]) => [table, rows.length])), listeningIds: snapshot.rows.listenings.map(row => row.id).sort(), integrity: snapshot.integrity, foreignKeyErrors: snapshot.foreignKeyErrors });
export function validateImportBrowserObservations(observations) {
  assert.deepEqual(observations.scenarios.map(({ mode, name }) => ({ mode, name })), importBrowserCases);
  assert.deepEqual(observations.errors, []); assert.equal(typeof observations.tools.chromium, 'string'); assert.ok(observations.tools.chromium);
  for (const scenario of observations.scenarios) {
    assert.equal(scenario.complete, true); assert.ok(!scenario.error); assert.deepEqual(scenario.pageErrors, []); assert.deepEqual(scenario.providerCalls, []);
    const snapshots = new Map();
    for (const row of scenario.snapshots) { assert.ok(!snapshots.has(row.label)); validateBusinessSnapshot(row.database); snapshots.set(row.label, row.database); }
    const get = name => { assert.ok(snapshots.has(name), `missing ${name}`); return snapshots.get(name); };
    const before = get('before-upload'); assert.equal(before.rows.listenings.length, 1); assert.deepEqual(get('after-upload'), before);
    assert.ok(scenario.http.every((row, i) => row.index === i && Number.isInteger(row.status) && !row.bodyError && !row.failure));
    const requests = endpoint => scenario.http.filter(row => row.path === `/api/data/import/${endpoint}`);
    const validates = requests('validate'), previews = requests('preview'), commits = requests('commit');
    const stale = scenario.name === 'stale-review', expiry = scenario.name === 'expired-upload';
    assert.equal(validates.length, stale ? 1 : 2); assert.equal(previews.length, expiry ? 0 : 1); assert.equal(commits.length, 2);
    for (const row of [...validates, ...previews, ...commits]) { assert.equal(row.method, 'POST'); assert.ok(row.request && row.response); }
    const urlCounts = new Map();
    for (const [index, row] of scenario.http.filter(row => row.path.startsWith('/api/data/import/')).entries()) {
      assert.equal(new URL(row.url).origin, scenario.origin); assert.equal(new URL(row.url).pathname, row.path);
      assert.equal(row.fetch.index, index); assert.equal(row.fetch.url, row.url); assert.equal(row.fetch.method, row.method);
      assert.equal(row.responseIndex, urlCounts.get(row.url) || 0); urlCounts.set(row.url, row.responseIndex + 1);
    }
    assert.equal(scenario.uploads.length, validates.length);
    for (const [index, row] of validates.entries()) {
      const selected = scenario.uploads[index], inputBody = row.fetch.requestBody;
      assert.equal(selected.index, index); assert.ok(Number.isSafeInteger(selected.size) && selected.size > 0); assert.ok(hash(selected.sha256));
      assert.equal(inputBody.kind, 'File'); assert.equal(inputBody.name, selected.name); assert.equal(inputBody.size, selected.size); assert.equal(typeof inputBody.type, 'string');
      // Chromium may omit File-backed inspector bytes; preserve that raw fact.
      // The genuine fetch argument and selected input file provide the size.
      assert.ok(row.request.uploadBytes === null || row.request.uploadBytes === selected.size);
      assert.equal(new URL(row.url).searchParams.get('mode'), scenario.mode);
      assert.equal(row.status, 200); assert.equal(row.request.mode, scenario.mode);
      const body = row.response; assert.equal(body.mode, scenario.mode); assert.equal(body.databaseVersion, 12); assert.equal(body.listeningCount, 1); assert.equal(body.currentCount, 1);
      assert.ok(hash(body.tokenSha256) && hash(body.previewTokenSha256) && hash(body.revision));
    }
    const original = validates[0].response;
    assert.deepEqual(commits.map(row => row.status), [expiry ? 410 : 409, 200]);
    assert.equal(commits[0].response.code, expiry ? 'IMPORT_EXPIRED' : 'IMPORT_PREVIEW_STALE');
    assert.equal(commits[0].request.tokenSha256, original.tokenSha256); assert.equal(commits[0].request.previewTokenSha256, original.previewTokenSha256);
    assert.deepEqual(scenario.confirmations.map(row => row.accepted), stale ? [false, true, true] : [true, true]);
    assert.ok(scenario.confirmations.every(row => row.type === 'confirm' && (scenario.mode === 'append' ? /将新增 1 条收听，跳过 0 条/ : /完整替换/).test(row.message)));
    const base = expiry ? before : get('after-same-connection-child-write');
    if (!expiry) assert.notDeepEqual(base.rows.knowledge_items, before.rows.knowledge_items);
    if (stale) {
      assert.deepEqual(get('after-cancel'), before); assert.equal(scenario.cancel.requestsBefore, scenario.cancel.requestsAfter);
      assert.deepEqual(get('after-stale-rejection'), base); assert.deepEqual(get('before-second-confirmation'), base);
      const row = previews[0]; assert.equal(row.status, 200); assert.equal(row.response.tokenSha256, original.tokenSha256);
      assert.notEqual(row.response.previewTokenSha256, original.previewTokenSha256); assert.notEqual(row.response.revision, original.revision);
      assert.equal(row.response.mode, scenario.mode); assert.equal(commits[1].request.previewTokenSha256, row.response.previewTokenSha256);
      assert.ok(scenario.ui.staleReview.status.includes('预览已刷新')); assert.equal(scenario.ui.staleReview.confirmDisabled, false);
    } else {
      assert.deepEqual(get(expiry ? 'after-expired-rejection' : 'after-stale-refresh-expiry'), base); assert.deepEqual(get('after-fresh-upload'), base);
      assert.notEqual(validates[1].response.tokenSha256, original.tokenSha256); assert.equal(commits[1].request.tokenSha256, validates[1].response.tokenSha256);
      assert.equal(commits[1].request.previewTokenSha256, validates[1].response.previewTokenSha256);
      const clocks = scenario.clock; assert.equal(clocks.length, 2); assert.equal(clocks[0].timers.length, 1);
      assert.equal(clocks[0].timers[0].active, true); assert.equal(clocks[0].timers[0].requestedMilliseconds, 900000); assert.equal(clocks[1].timers[0].active, false);
      assert.equal(clocks[1].timers[0].id, clocks[0].timers[0].id);
      if (!expiry) { assert.deepEqual(scenario.routeErrors, []); assert.equal(previews[0].status, 410); assert.equal(previews[0].response.code, 'IMPORT_EXPIRED');
        assert.equal(scenario.ui.expiredRefresh.confirmDisabled, true); assert.match(scenario.ui.expiredRefresh.status, /导入文件已过期/); assert.doesNotMatch(scenario.ui.expiredRefresh.status, /预览已刷新/); }
      else assert.match(scenario.ui.expired.status, /导入文件已过期/);
    }
    const committed = commits[1].response; assert.equal(committed.mode, scenario.mode); assert.equal(committed.changed, true); assert.equal(committed.addedCount, 1); assert.equal(committed.skippedCount, 0); assert.match(committed.safetyBackup, /^before-import-.*\.sqlite$/);
    const after = get('committed'); validateImportedRows(scenario.backup, base, after, scenario.mode, { stoppedWork: true });
    const previousId = before.rows.listenings[0].id, added = after.rows.listenings.filter(row => row.id !== previousId);
    assert.equal(added.length, 1); assert.equal(after.rows.listenings.length, scenario.mode === 'append' ? 2 : 1);
    assert.deepEqual(scenario.expectedListeningIds, after.rows.listenings.map(row => row.id).sort());
    if (scenario.mode === 'append') for (const [table, rows] of Object.entries(base.rows)) { const actual = new Set(after.rows[table].map(row => JSON.stringify(row))); assert.ok(rows.every(row => actual.has(JSON.stringify(row)))); }
    assert.equal(scenario.ui.committed.confirmDisabled, true); assert.equal(scenario.ui.committed.reviewHidden, true);
    assert.match(scenario.ui.committed.status, scenario.mode === 'append' ? /追加完成：新增 1 条，跳过 0 条/ : /数据覆盖完成/);
    const restarted = get('after-process-restart');
    const stableRestart = value => ({ ...value, rows: { ...value.rows, listenings: value.rows.listenings.map(({ relation_waiting_key, ...row }) => row) } });
    assert.deepEqual(stableRestart(restarted), stableRestart(after));
    for (const row of restarted.rows.listenings) assert.equal(row.relation_waiting_key, row.relation_enabled);
 assert.deepEqual(restarted.rows.listenings.map(row => row.id).sort(), scenario.expectedListeningIds);
    for (const [field, table, fields] of [['translations', 'segments', ['id', 'translation_state']], ['extraction', 'extraction_jobs', ['id', 'state', 'last_error']], ['relations', 'relation_jobs', ['id', 'state', 'last_error']], ['rounds', 'relation_rounds', ['id', 'state', 'stop_reason']], ['edits', 'knowledge_edit_jobs', ['id', 'state']]]) {
      for (const [snapshot, observed] of [[after, scenario.unfinishedAfterCommit], [restarted, scenario.unfinishedAfterRestart]]) {
        const rows = snapshot.rows[table].filter(row => row.listening_id === added[0].id).map(row => Object.fromEntries(fields.map(key => [key, row[key]])));
        assert.deepEqual([...observed[field]].sort((a, b) => a.id.localeCompare(b.id)), rows.sort((a, b) => a.id.localeCompare(b.id)));
      }
    }
  }
  assert.equal(summarizeImportBrowserEvidence(observations).ok, true); return true;
}
export async function validateImportBrowserReleaseEvidence(directory, { release = true } = {}) {
  const result = { kind: 'import-protocol', ok: false, status: 'not_run', reasons: [], fullProjectAcceptance: false };
  let report, observations; try { report = JSON.parse(await readFile(path.join(directory, 'report.json'))); observations = JSON.parse(await readFile(path.join(directory, 'observations.json'))); }
  catch { result.reasons.push('missing_nested_report'); return result; }
  try {
    assert.equal(report.profile, 'import-protocol-browser'); assert.equal(report.schemaVersion, 1); assert.equal(report.complete, true);
    assert.deepEqual(observations.sourceStart, observations.sourceEnd); assert.deepEqual(observations.sourceEnd, await importBrowserSourceStamp());
    const target = sourceVersion(); if (release) assert.equal(target.dirty, false);
    assert.equal(observations.tools.node, process.version); assert.equal(observations.tools.sqlite, process.versions.sqlite);
    validateImportBrowserObservations(observations);
    const { scenarios, results, artifacts, ...header } = report; const { scenarios: rawScenarios, ...rawHeader } = observations; assert.deepEqual(header, rawHeader);
    const expectedScenarios = rawScenarios.map(({ snapshots, ...scenario }) => ({ ...scenario,
      requestCounts: { total: scenario.http.length, ...Object.fromEntries(['validate', 'preview', 'commit'].map(name => [name, scenario.http.filter(row => row.path === `/api/data/import/${name}`).length])) },
      commitStatuses: scenario.http.filter(row => row.path === '/api/data/import/commit').map(row => row.status), snapshots: snapshots.map(({ label, database }) => ({ label, ...snapshotSummary(database) })) }));
    assert.deepEqual(scenarios, expectedScenarios); assert.deepEqual(results, summarizeImportBrowserEvidence(observations).results);
    assert.deepEqual(observations.screenshots.map(row => row.path).sort(), [...browserScreenshots['import-protocol']].sort());
    const disk = new Set(await evidenceFiles(directory));
    assert.deepEqual(artifacts.map(row => row.path).sort(), ['observations.json', ...browserScreenshots['import-protocol']].sort());
    for (const row of artifacts) { assert.ok(disk.has(row.path)); assert.equal(digest(await readFile(path.join(directory, row.path))), row.sha256); }
    for (const row of observations.screenshots) { assert.ok((await readFile(path.join(directory, row.path))).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))); assert.ok(row.layout.scrollWidth <= row.layout.clientWidth + 1 && row.layout.clientWidth > 0); assert.equal(row.path, `${row.mode}-${row.scenario}-${row.label}-${row.width}.png`); assert.equal(artifacts.find(artifact => artifact.path === row.path).sha256, row.sha256); }
    return { ...result, ok: true, status: 'passed', propertyRows: results, chromium: observations.tools.chromium };
  } catch (error) { return { ...result, status: 'incomplete', reasons: [error.message] }; }
}
