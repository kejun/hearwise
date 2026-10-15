import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { sourceSnapshot, sameSourceSnapshot, validBuildSource } from './lib/runner-evidence-contract.mjs';
import { runProcess } from './lib/process.mjs';
import { metadata, sourceVersion, writeJson } from './lib/verification-evidence.mjs';
import { editConsistencyProperties, editConsistencyProfile } from '../verification/edit-consistency-properties.mjs';
import { tapSummary, runChecks, writeEditEvidence, checkEditEvidence, editRequiredChecks, summarizeEditResults } from '../test-support/edit-consistency-evidence.mjs';
const args = process.argv.slice(2);
if (args.some(arg => !['--node-only', '--release'].includes(arg))) throw new Error('Usage: verify-edit-consistency-browser.mjs [--node-only] [--release]');
const nodeOnly = args.includes('--node-only'), root = process.env.EDIT_CONSISTENCY_EVIDENCE_DIR || 'browser-evidence';
await mkdir(root, { recursive: true }); const directory = await mkdtemp(path.join(root, 'edit-consistency-'));
const sourceStart = await sourceSnapshot();
if (!validBuildSource(sourceStart)) throw new Error('Build source differs from checkout; run npm run build before testing');
const context = await metadata(), startedAt = new Date().toISOString();
const report = { ...context, sourceStart, executionContext: { repositoryRoot: process.cwd(), evidenceDirectory: path.resolve(directory), nodeExecutable: process.execPath, overallTimeoutMs: 150000 }, profile: 'edit-consistency', startedAt, finishedAt: null, complete: false, ok: false, results: [] };
await writeJson(path.join(directory, 'report.json'), report); console.log(`Edit consistency evidence: ${directory}`);
const temporary = await mkdtemp(path.join(directory, 'temporary-runtime-'));
const env = { ...process.env, TMPDIR: path.resolve(temporary), TMP: path.resolve(temporary), TEMP: path.resolve(temporary) }; delete env.NODE_TEST_CONTEXT;
const specifications = [{ name: 'notification', file: 'test/edit-commit-notification.test.mjs', count: 2, timeoutMs: 20000 },
  { name: 'http', file: 'test/edit-protocol-http.test.mjs', count: 6, timeoutMs: 30000 }, ...(!nodeOnly ? [{ name: 'browser', timeoutMs: 100000 }] : [])];
const { checks, budgetExpired } = await runChecks(specifications, async ({ name, file, count, timeoutMs: configuredTimeoutMs }, timeoutMs) => {
  const argv = file ? ['--test', '--test-reporter=tap', '--test-timeout=20000', file] : ['test-support/edit-consistency-browser.mjs', directory];
  const execution = await runProcess(process.execPath, argv, { env, timeoutMs, logFile: path.join(directory, name + '.log'), onOutput: text => process.stdout.write(text) });
  if (file) { const tap = tapSummary(execution.tail); Object.assign(execution, { ...tap, ok: execution.ok && tap.ok && tap.testCount === count }); }
  return { ...execution, argv, timeoutMs, configuredTimeoutMs };
}, { cleanup: () => rm(temporary, { recursive: true, force: true }) });
let browser;
try { browser = JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8')); } catch { /* Missing browser coverage cannot pass. */ }
const artifacts = await writeEditEvidence(directory, { checks, browser: browser || { complete: false, status: nodeOnly ? 'not_run' : 'incomplete' },
  boundary: 'This report covers actual HTTP/SQLite and browser scenarios. The separate edit-protocol report gates Quint/TLC/bounded checks and model replay. No paid-model, crash or unbounded-domain claim.' });
const finishedAt = new Date().toISOString();
report.results = editConsistencyProperties.map(property => {
  const names = editRequiredChecks(property.id, nodeOnly), applicable = checks.filter(check => names.includes(check.name));
  const complete = applicable.length === names.length && applicable.every(({ execution: e }) => !e.timedOut && !e.interrupted && e.signal == null && [0, 1].includes(e.code) && e.testComplete !== false);
  const status = nodeOnly ? 'not_run' : !complete ? 'incomplete' : applicable.every(({ execution: e }) => e.ok) && browser?.complete && browser.ok ? 'passed' : 'failed';
  return { ...context, ...(browser?.chromium ? { tools: { ...context.tools, chromium: browser.chromium } } : {}),
    property: { id: property.id, version: property.version }, startedAt, finishedAt, complete, status,
    scope: { description: property.domain, scenario: 'edit-consistency-http-browser', samples: 1, seed: null }, artifacts };
});
const target = sourceVersion(); report.sourceEnd = await sourceSnapshot();
const { execution, summary } = summarizeEditResults({ results: report.results, checks, target, required: editConsistencyProfile, nodeOnly, budgetExpired,
  sourceStable: target.sha === context.source.sha && target.dirty === context.source.dirty && sameSourceSnapshot(sourceStart, report.sourceEnd) && validBuildSource(report.sourceEnd), release: args.includes('--release') || process.env.CI === 'true',
  artifactsValid: await Promise.all(report.results.map(result => checkEditEvidence(directory, result))) });
Object.assign(report, { finishedAt, complete: execution.complete, ok: summary.ok, execution, summary });
await writeJson(path.join(directory, 'report.json'), report); console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, rows: summary.rows, fullProjectAcceptance: false }));
process.exitCode = report.ok ? 0 : 1;
