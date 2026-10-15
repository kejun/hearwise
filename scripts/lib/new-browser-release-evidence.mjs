import { validateFlatTap } from './release-tap-evidence.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, sourceVersion, checkArtifacts, metadata } from './verification-evidence.mjs';
import { sourceSnapshot, sameSourceSnapshot, validBuildSource, evidenceFiles, browserScreenshots } from './runner-evidence-contract.mjs';
import { tapSummary, parseTapFooter } from './tap-summary.mjs';
import { knowledgeRevision } from '../../knowledge-revision.mjs';
import { editConsistencyProfile } from '../../verification/edit-consistency-properties.mjs';
import { editScenarios, checkEditEvidence, summarizeEditResults } from '../../test-support/edit-consistency-evidence.mjs';
import { securityProfile } from '../../verification/security-properties.mjs';
import { securitySourceSnapshot, stableSecuritySources, securityPropertyState, summarizeSecurity, verifySecurityBrowserArtifacts, validSecurityBrowserCheck, securityTableNames } from '../../test-support/security-evidence.mjs';
import { renderingMutant } from '../../test-support/security-browser-support.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
export const newNestedChecks = {
  'edit-consistency': [
    { name: 'notification', files: ['test/edit-commit-notification.test.mjs'], count: 2, timeoutMs: 20000 },
    { name: 'http', files: ['test/edit-protocol-http.test.mjs'], count: 6, timeoutMs: 30000 }, { name: 'browser', timeoutMs: 100000 }],
  security: [
    { name: 'credentials', files: ['test/security-credentials.test.mjs', 'test/security-persistence.test.mjs', 'test/security-speech.test.mjs'], count: 10, timeoutMs: 30000 },
    { name: 'boundaries', files: ['test/security-http.test.mjs', 'test/security-websocket-limit.test.mjs', 'test/security-websocket-shape.test.mjs', 'test/security-provider-shape.test.mjs'], count: 13, timeoutMs: 30000 },
    { name: 'negative', files: ['test/security-negative.test.mjs', 'test/security-browser-support.test.mjs'], count: 12, timeoutMs: 20000 }, { name: 'browser', timeoutMs: 100000 }]
};
export async function nestedTestNames(files) {
  return (await Promise.all([...files].sort().map(async file => {
    const source = await readFile(file, 'utf8'), names = [];
    for (const match of source.matchAll(/(?:^|\b)test\((['`])([^\n]+?)\1,/gm)) {
      if (match[1] === "'") names.push(match[2]);
      else if (match[2].includes('${status}')) names.push(...[401, 429, 503].map(status => match[2].replace('${status}', status)));
      else if (match[2].includes('${route}')) names.push(...['/ws', '/ws/tts'].map(route => match[2].replace('${route}', route)));
      else throw new Error('Unknown generated nested test roster');
    }
    return names;
  }))).flat();
}
const sameKeys = (actual, expected) => assert.deepEqual(Object.keys(actual).sort(), [...expected].sort());
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function capture(row) {
  assert.ok(row?.snapshot?.item); assert.equal(knowledgeRevision(row.snapshot), row.snapshot.revision); assert.ok(hash(row.snapshot.revision));
  sameKeys(row.tables, securityTableNames); const tables = Object.fromEntries(Object.entries(row.tables).map(([name, rows]) => [name, rows.map(text => JSON.parse(text))]));
  const item = tables.knowledge_items.find(item => item.id === row.snapshot.item.id); assert.ok(item);
  for (const key of ['id', 'listening_id', 'canonical_name', 'name_override', 'name_override_identity']) assert.equal(item[key], row.snapshot.item[key]);
  assert.equal(row.providerCalls, 0); assert.deepEqual(row.errors, []);
  const client = row.client; assert.ok(Number.isSafeInteger(client.writes) && client.writes >= 0); assert.equal(client.submissions.length, client.writes);
  assert.ok(Number.isSafeInteger(client.explicitSaves) && client.explicitSaves >= 0 && Number.isSafeInteger(client.receiptReads) && client.receiptReads >= 0);
  assert.ok(client.submissions.every(value => hash(value.revision) && ['Tibo', 'Mira'].includes(value.name)));
  assert.ok(typeof row.ui.open === 'boolean' && typeof row.ui.status === 'string' && typeof row.ui.name === 'string');
  sameKeys(row.ui.disabled, ['name', 'save', 'delete', 'suggest', 'close']); assert.ok(Object.values(row.ui.disabled).every(value => typeof value === 'boolean'));
  return tables;
}
function visible(row, width) {
  assert.equal(row.ui.open, true); assert.equal(row.ui.width, width); assert.ok(row.ui.clientWidth > 0 && row.ui.scrollWidth <= row.ui.clientWidth && row.ui.left >= 0 && row.ui.right <= width);
}
export async function validateEditBrowserObservations(browser) {
  assert.equal(browser.complete, true); assert.ok(typeof browser.chromium === 'string' && browser.chromium && !browser.error);
  assert.deepEqual(browser.widths.map(row => row.width), [1280, 390]);
  for (const width of browser.widths) {
    assert.deepEqual(width.results.map(row => row.scenario), editScenarios);
    for (const result of width.results) {
      assert.equal(result.complete, true); assert.equal(result.providerCalls, 0);
      const records = new Map(); for (const row of result.evidence) { assert.ok(!records.has(row.label)); records.set(row.label, row); capture(row); assert.equal(row.client.writes, row.client.explicitSaves); }
      const get = label => { assert.ok(records.has(label)); return records.get(label); }, initial = get('initial');
      assert.equal(initial.snapshot.item.canonical_name, 'Deebo'); assert.equal(initial.client.writes, 0);
      if (result.scenario === 'conflict') {
        const conflict = get('conflict'), reopened = get('reopened'), continued = get('continued'); visible(conflict, width.width);
        assert.equal(conflict.ui.name, 'Mira'); assert.equal(conflict.ui.source, 'Tibo'); assert.match(conflict.ui.status, /已读取最新内容，输入已保留/);
        assert.equal(conflict.snapshot.item.canonical_name, 'Tibo'); assert.equal(conflict.client.writes, 1); assert.equal(conflict.client.submissions[0].revision, initial.snapshot.revision);
        assert.equal(reopened.ui.name, 'Tibo'); assert.equal(reopened.client.writes, 1); assert.deepEqual(reopened.tables, conflict.tables);
        assert.equal(continued.client.writes, 2); assert.equal(continued.snapshot.item.canonical_name, 'Mira'); assert.equal(continued.client.submissions[1].revision, reopened.snapshot.revision);
        assert.deepEqual(result.clients.map(row => [row.writes, row.explicitSaves]), [[1, 1], [2, 2]]); assert.equal(result.clients[0].submissions[0].revision, initial.snapshot.revision);
      } else if (result.scenario.startsWith('unknown-')) {
        const unknown = get('unknown'), reopened = get('reopened'), continued = get('continued'); visible(unknown, width.width);
        assert.equal(unknown.snapshot.item.canonical_name, 'Tibo'); assert.notEqual(unknown.snapshot.revision, initial.snapshot.revision);
        assert.equal(unknown.client.writes, 1); assert.equal(unknown.client.receiptReads, 1); assert.equal(unknown.ui.name, 'Tibo'); assert.match(unknown.ui.status, /保存结果尚未确认/);
        for (const name of ['save', 'delete', 'suggest']) assert.equal(unknown.ui.disabled[name], true); assert.equal(unknown.ui.disabled.close, false);
        assert.equal(result.receipt.saved, true); assert.equal(result.receipt.state, 'succeeded'); assert.ok(unknown.tables.knowledge_edit_jobs.map(JSON.parse).some(row => row.id === result.receipt.id && row.state === 'succeeded'));
        assert.deepEqual(reopened.tables, unknown.tables); assert.equal(reopened.client.writes, 1); assert.equal(reopened.ui.name, 'Tibo'); assert.equal(reopened.ui.disabled.save, false);
        assert.equal(continued.client.writes, 2); assert.equal(continued.snapshot.item.canonical_name, 'Mira');
      } else if (result.scenario === 'rollback') {
        const failed = get('rolled-back'), continued = get('continued'); visible(failed, width.width); assert.deepEqual(failed.tables, initial.tables);
        assert.equal(failed.client.writes, 1); assert.equal(failed.client.receiptReads, 0); assert.equal(failed.ui.name, 'Tibo'); assert.equal(failed.ui.disabled.save, false); assert.match(failed.ui.status, /原内容未更改/);
        assert.equal(continued.client.writes, 2); assert.equal(continued.snapshot.item.canonical_name, 'Tibo');
      } else {
        const busy = get('busy-after-commit'), later = get('later-save'), reopened = get('reopened');
        assert.equal(busy.snapshot.item.canonical_name, 'Tibo'); assert.equal(busy.ui.disabled.close, true); assert.equal(busy.ui.open, true);
        assert.equal(later.snapshot.item.canonical_name, 'Mira'); assert.equal(later.client.writes, 1);
        visible(reopened, width.width); assert.equal(reopened.ui.name, 'Mira'); assert.equal(reopened.snapshot.revision, later.snapshot.revision); assert.equal(reopened.client.writes, 1); assert.deepEqual(reopened.tables, later.tables);
      }
    }
  }
  const negative = browser.negative; assert.equal(negative.complete, true); assert.equal(negative.classification, 'implementation_mismatch'); assert.equal(negative.property, 'HW-06-06');
  assert.equal(negative.evidence.length, 2); const [before, after] = negative.evidence; capture(before); capture(after);
  assert.equal(before.snapshot.item.canonical_name, 'Tibo'); assert.equal(before.client.writes, 0); assert.equal(after.snapshot.item.canonical_name, 'Mira');
  assert.equal(after.client.writes, 2); assert.equal(after.client.explicitSaves, 1); assert.notEqual(after.client.submissions[0].revision, after.client.submissions[1].revision); assert.equal(after.client.submissions[1].revision, before.snapshot.revision);
  assert.deepEqual(negative.counterexample.submissions, after.client.submissions); assert.equal(negative.counterexample.firstExcessRequest, 2);
  const source = await readFile('public/knowledge-editor.js', 'utf8'), anchor = 'current.revision = snapshot.revision;'; assert.equal(source.split(anchor).length, 2);
  const mutant = source.replace(anchor, anchor + "\n    setTimeout(() => { void save('POST'); }, 0); // Deliberately broken response-handler retry.");
  assert.equal(negative.sourceSha256, digest(source)); assert.equal(negative.mutantSha256, digest(mutant)); return true;
}

export async function validateNewNestedBrowserEvidence(kind, directory, { release = true } = {}) {
  const result = { kind, ok: false, status: 'not_run', reasons: [], fullProjectAcceptance: false };
  let report, observations;
  try { report = await json(path.join(directory, 'report.json')); observations = await json(path.join(directory, 'observations.json')); }
  catch { result.reasons.push('missing_nested_report'); return result; }
  try {
    const required = kind === 'security' ? securityProfile : editConsistencyProfile, specifications = newNestedChecks[kind], target = sourceVersion(), context = report.executionContext;
    assert.equal(report.profile, kind); assert.equal(report.complete, true); assert.deepEqual(report.source, target); assert.equal(report.results.length, required.length);
    assert.ok(context && path.isAbsolute(context.repositoryRoot) && path.isAbsolute(context.evidenceDirectory) && path.isAbsolute(context.nodeExecutable)); assert.equal(context.overallTimeoutMs, 150000);
    if (release) assert.equal(target.dirty, false);
    const currentMetadata = await metadata(); for (const row of [report, ...report.results]) {
      assert.deepEqual(row.source, target); assert.deepEqual(row.specification, currentMetadata.specification); assert.deepEqual(row.environment, currentMetadata.environment);
      for (const key of ['node', 'sqlite', 'lockDigest']) assert.equal(row.tools[key], currentMetadata.tools[key]);
    }
    assert.deepEqual(observations.checks.map(row => row.name), specifications.map(row => row.name)); const logs = [];
    for (const [index, check] of observations.checks.entries()) {
      const expected = specifications[index], execution = check.execution, log = await readFile(path.join(directory, `${check.name}.log`), 'utf8'); logs.push(`CHECK ${check.name}\n${log}`);
      assert.equal(execution.code, 0); assert.equal(execution.signal, null); assert.equal(execution.timedOut, false); assert.equal(execution.interrupted, false); assert.ok(!execution.error); assert.equal(execution.tail, log.slice(-12000));
      const argv = expected.files ? ['--test', '--test-reporter=tap', '--test-timeout=20000', ...expected.files] : [`test-support/${kind}-browser.mjs`, kind === 'security' ? path.relative(context.repositoryRoot, context.evidenceDirectory) : path.relative(context.repositoryRoot, context.evidenceDirectory)];
      // The runner may be configured with an absolute evidence root. Bind the
      // recorded child directory to its execution origin, never the reader cwd.
      const actualArgv = kind === 'security' ? check.command.slice(1) : execution.argv;
      if (!expected.files) { assert.equal(actualArgv.length, 2); assert.equal(path.resolve(context.repositoryRoot, actualArgv[1]), context.evidenceDirectory); argv[1] = actualArgv[1]; }
      assert.deepEqual(actualArgv, argv);
      if (kind === 'security') assert.equal(check.command[0], context.nodeExecutable);
      const configured = kind === 'security' ? check.configuredTimeoutMs : execution.configuredTimeoutMs, timeout = kind === 'security' ? check.timeoutMs : execution.timeoutMs;
      assert.equal(configured, expected.timeoutMs); assert.ok(Number.isFinite(timeout) && timeout > 0 && timeout <= configured);
      if (expected.files) {
        const tap = tapSummary(log), names = await nestedTestNames(expected.files); assert.equal(tap.ok, true); assert.equal(tap.testCount, expected.count); assert.equal(execution.testCount, tap.testCount); assert.equal(execution.testComplete, true);
        validateFlatTap(log, names);
      }
    }
    assert.equal(logs.join('\n'), await readFile(path.join(directory, 'worker.log'), 'utf8')); await evidenceFiles(directory);
    for (const name of browserScreenshots[kind]) assert.ok((await readFile(path.join(directory, name))).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    const browser = await json(path.join(directory, 'browser.json')); assert.deepEqual(browser, observations.browser); assert.equal(browser.complete, true); assert.ok(browser.chromium && !browser.failure && !browser.error);
    if (kind === 'edit-consistency') {
      assert.ok(validBuildSource(report.sourceStart) && validBuildSource(report.sourceEnd) && sameSourceSnapshot(report.sourceStart, report.sourceEnd) && sameSourceSnapshot(report.sourceEnd, await sourceSnapshot()));
      await validateEditBrowserObservations(browser);
      const artifactsValid = await Promise.all(report.results.map(row => checkEditEvidence(directory, row)));
      const summary = summarizeEditResults({ results: report.results, checks: observations.checks, target, required, nodeOnly: false, sourceStable: true, release, artifactsValid });
      assert.equal(summary.summary.ok, true); assert.deepEqual(report.execution, summary.execution);
      return { ...result, ok: true, status: 'passed', propertyRows: summary.summary.rows, chromium: browser.chromium };
    }
    assert.equal(report.nodeOnly, false); assert.equal(report.profileVersion, 1);
    assert.ok(stableSecuritySources(report.sourceStart, report.sourceEnd)); assert.deepEqual(report.sourceEnd, await securitySourceSnapshot());
    assert.deepEqual(observations.sourceStart, report.sourceStart); assert.deepEqual(observations.sourceEnd, report.sourceEnd);
    assert.equal(observations.cleanupOk, true); assert.equal(observations.budgetExpired, false); assert.ok(!observations.failure && !browser.lateObservationFailure && !browser.cleanupFailures?.length);
    const app = await readFile('public/app.js', 'utf8'), mutant = renderingMutant(app), expectedMutation = { normalAppSha256: digest(app), mutantAppSha256: digest(mutant.source), anchor: mutant.anchor, replacement: mutant.replacement, replacements: mutant.replacements };
    assert.deepEqual(observations.expectedRenderingMutation, expectedMutation); assert.deepEqual(browser.source, target);
    assert.equal(browser.browserBuildSource.appSha256, digest(app)); assert.equal(browser.browserBuildSource.servedAppSha256, digest(app)); assert.equal(browser.browserBuildSource.serverBuildSha256, report.sourceStart.digests['dist/server/index.js']);
    assert.equal(browser.browserBuildSource.playwrightVersion, (await json('node_modules/playwright/package.json')).version); assert.equal(browser.browserBuildSource.browserVersion, browser.chromium);
    assert.deepEqual(browser.checks.map(row => row.id), ['stored-external-text', 'live-provider-text', 'credential-surfaces', 'dangerous-rendering-control']);
    for (const check of browser.checks) assert.equal(validSecurityBrowserCheck(check, expectedMutation), true);
    assert.equal(await verifySecurityBrowserArtifacts(directory, browser), true);
    for (const row of report.results) assert.deepEqual({ status: row.status, complete: row.complete }, securityPropertyState(row.property.id, { checks: observations.checks, browser, nodeOnly: false, sourceStable: true, cleanupOk: true, browserArtifactsValid: true, expectedRenderingMutation: expectedMutation }));
    const summary = summarizeSecurity({ results: report.results, checks: observations.checks, target, nodeOnly: false, sourceStable: true, cleanupOk: true, release, artifactsValid: await Promise.all(report.results.map(row => checkArtifacts(directory, row))) });
    assert.equal(summary.ok, true); return { ...result, ok: true, status: 'passed', propertyRows: summary.rows, chromium: browser.chromium };
  } catch (error) { return { ...result, status: 'incomplete', reasons: [error.message] }; }
}
