import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './lib/process.mjs';
import { tapSummary } from './lib/tap-summary.mjs';
import { metadata, writeJson, digest, checkArtifacts, summarize } from './lib/verification-evidence.mjs';
import { traceBusinessProperties, traceBusinessProfile, traceBusinessNodeProfile } from '../verification/trace-business-properties.mjs';
import { traceSourceSnapshot, sameTraceSources, validateTraceBusinessObservations, validTraceBrowser, checkTraceArtifacts,
  traceBrowserArtifacts, traceBrowserReportNames, traceBrowserDocuments, tracePropertyState, cleanTraceExecution, traceRegressionFiles } from '../test-support/trace-business-evidence.mjs';
import { expectedTraceMutations } from '../test-support/trace-business-negative.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--node-only', '--release'].includes(arg))) throw new Error('Usage: npm run verify:trace-business -- [--node-only] [--release]');
const nodeOnly = args.includes('--node-only'), release = args.includes('--release') || process.env.CI === 'true';
const root = process.env.TRACE_BUSINESS_EVIDENCE_DIR || 'verification-evidence/trace-business'; await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'trace-business-')), temporary = await mkdtemp(path.join(directory, 'temporary-'));
const context = await metadata(), sourceStart = await traceSourceSnapshot(), mutations = await expectedTraceMutations(), startedAt = new Date().toISOString();
const report = { ...context, profile: 'trace-business', profileVersion: 1, nodeOnly, sourceStart, startedAt, finishedAt: null, complete: false, ok: false, results: [] };
await writeJson(path.join(directory, 'report.json'), report); console.log(`Trace business evidence: ${directory}`);
const env = { ...process.env, TMPDIR: path.resolve(temporary), TMP: path.resolve(temporary), TEMP: path.resolve(temporary) }; delete env.NODE_TEST_CONTEXT;
const specifications = [
  { name: 'workflows', command: ['test-support/trace-business-worker.mjs', directory], timeoutMs: 40000 },
  { name: 'regressions', command: ['--test', '--test-reporter=tap', '--test-timeout=25000', ...traceRegressionFiles], timeoutMs: 45000 },
  ...(!nodeOnly ? [{ name: 'browser', command: ['test-support/trace-business-browser.mjs', directory], timeoutMs: 60000 }] : [])
];
const checks = [], expires = Date.now() + 150000; let cleanupOk = false, failure, budgetExpired = false;
try {
  for (const specification of specifications) {
    const remaining = expires - Date.now(); if (remaining <= 0) { budgetExpired = true; break; }
    const execution = await runProcess(process.execPath, specification.command, { env, timeoutMs: Math.min(specification.timeoutMs, remaining),
      logFile: path.join(directory, `${specification.name}.log`), onOutput: text => process.stdout.write(text) });
    if (specification.name === 'regressions') { const tap = tapSummary(await readFile(path.join(directory, 'regressions.log'), 'utf8')); Object.assign(execution, tap, { ok: execution.ok && tap.ok }); }
    checks.push({ name: specification.name, command: [process.execPath, ...specification.command], ...(specification.name === 'regressions' ? { files: traceRegressionFiles } : {}), configuredTimeoutMs: specification.timeoutMs, execution });
    if (execution.timedOut || execution.interrupted || execution.signal != null || execution.testComplete === false) break;
  }
} catch (error) { failure = String(error.message).slice(0, 1000); }
finally { try { await rm(temporary, { recursive: true, force: true }); cleanupOk = true; } catch (error) { failure = error.message; } }
let business, browser;
try { business = JSON.parse(await readFile(path.join(directory, 'business-observations.json'), 'utf8')); } catch { /* Incomplete worker. */ }
try { browser = JSON.parse(await readFile(path.join(directory, 'trace-browser.json'), 'utf8')); } catch { /* Browser not run or incomplete. */ }
let sourceEnd, sourceStable = false;
try { sourceEnd = await traceSourceSnapshot(); sourceStable = sameTraceSources(sourceStart, sourceEnd); } catch (error) { failure = error.message; }
sourceStable &&= !budgetExpired && !failure;
const validation = validateTraceBusinessObservations(business, { source: context.source, mutations });
let browserValid = validTraceBrowser(browser, business) && JSON.stringify(browser.source) === JSON.stringify(context.source) &&
  await checkTraceArtifacts(directory, browser.artifacts, [...traceBrowserArtifacts, 'trace-safe-export.json']) &&
  await checkTraceArtifacts(directory, browser.reports, traceBrowserReportNames);
if (browserValid) browserValid = traceBrowserDocuments(business).every(expected => browser.reports.some(row => row.path === expected.name && row.sha256 === expected.sha256));
if (browser?.cleanup === false) cleanupOk = false;
const observations = { sourceStart, sourceEnd, sourceStable, checks, cleanupOk, budgetExpired, failure, validation,
  businessArtifact: business ? { path: 'business-observations.json', sha256: digest(await readFile(path.join(directory, 'business-observations.json'))) } : null,
  browser: browser || { status: nodeOnly ? 'not_run' : 'incomplete', complete: false, ok: false }, browserValid, mutations,
  boundary: 'Fixed real workflow/SQLite/HTTP/WS cases and offline report UI. JSONL completeness remains unknown. Speech completion is client feedback. No arbitrary replay, paid service or real-device claim.' };
await writeJson(path.join(directory, 'observations.json'), observations);
await writeFile(path.join(directory, 'worker.log'), (await Promise.all(checks.map(async row => `CHECK ${row.name}\n${await readFile(path.join(directory, `${row.name}.log`), 'utf8')}`))).join('\n'));
const artifacts = await Promise.all(['observations.json', 'worker.log'].map(async name => ({ path: name, sha256: digest(await readFile(path.join(directory, name))) })));
const rawValid = observations.businessArtifact && await checkTraceArtifacts(directory, [observations.businessArtifact], ['business-observations.json']);
const finishedAt = new Date().toISOString();
report.results = traceBusinessProperties.map(property => ({ ...context, property: { id: property.id, version: property.version }, startedAt, finishedAt,
  ...tracePropertyState(property.id, { checks, observationsValid: validation.ok, artifactsValid: Boolean(rawValid), browserValid, sourceStable, cleanupOk, nodeOnly }),
  scope: { description: property.domain, scenario: 'trace-business-fixed-boundaries', samples: property.id === 'HW-15-02' ? 15 : 1, seed: null }, artifacts }));
const required = nodeOnly ? traceBusinessNodeProfile : traceBusinessProfile, rows = [];
for (const id of required) {
  const result = report.results.find(row => row.property.id === id);
  rows.push(...summarize({ results: [result], required: [id], target: sourceEnd?.source || context.source, release,
    execution: { code: result.status === 'passed' ? 0 : 1, signal: null, interrupted: false, timedOut: false, complete: result.complete },
    artifactsValid: [await checkArtifacts(directory, result)] }).rows);
}
const complete = sourceStable && cleanupOk && checks.length === specifications.length && checks.every(row => cleanTraceExecution(row.execution));
const ok = complete && checks.every(row => row.execution.ok) && rows.every(row => row.status === 'passed' && !row.stale && !row.reasons.length);
Object.assign(report, { sourceEnd, finishedAt, complete, ok, summary: { required, rows, nodeOnly, fullTraceBusinessProfile: !nodeOnly, fullProjectAcceptance: false } });
await writeJson(path.join(directory, 'report.json'), report);
console.log(JSON.stringify({ directory, complete, ok, rows, nodeOnly, fullTraceBusinessProfile: !nodeOnly, fullProjectAcceptance: false }, null, 2));
process.exitCode = ok ? 0 : 1;
