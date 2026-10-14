import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './lib/process.mjs';
import { tapSummary } from './lib/tap-summary.mjs';
import { metadata, writeJson, digest, checkArtifacts } from './lib/verification-evidence.mjs';
import { securityProperties } from '../verification/security-properties.mjs';
import { securitySourceSnapshot, stableSecuritySources, securityPropertyState, summarizeSecurity, verifySecurityBrowserArtifacts } from '../test-support/security-evidence.mjs';
import { redactSecurityDiagnostic } from '../test-support/security-browser-support.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--node-only', '--release'].includes(arg))) throw new Error('Usage: node scripts/verify-security-browser.mjs [--node-only] [--release]');
const nodeOnly = args.includes('--node-only'), release = args.includes('--release') || process.env.CI === 'true';
const root = process.env.SECURITY_EVIDENCE_DIR || 'verification-evidence/security'; await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'security-'));
const temporary = await mkdtemp(path.join(directory, 'temporary-runtime-'));
const context = await metadata(), sourceStart = await securitySourceSnapshot(), startedAt = new Date().toISOString();
const report = { ...context, profile: 'security', profileVersion: 1, nodeOnly, sourceStart, startedAt, finishedAt: null, complete: false, ok: false, results: [] };
await writeJson(path.join(directory, 'report.json'), report); console.log(`Security evidence: ${directory}`);
const env = { ...process.env, TMPDIR: path.resolve(temporary), TMP: path.resolve(temporary), TEMP: path.resolve(temporary) }; delete env.NODE_TEST_CONTEXT;
const specifications = [
  { name: 'credentials', files: ['test/security-credentials.test.mjs', 'test/security-persistence.test.mjs', 'test/security-speech.test.mjs'], timeoutMs: 30000 },
  { name: 'boundaries', files: ['test/security-http.test.mjs', 'test/security-websocket-limit.test.mjs', 'test/security-websocket-shape.test.mjs', 'test/security-provider-shape.test.mjs'], timeoutMs: 30000 },
  { name: 'negative', files: ['test/security-negative.test.mjs', 'test/security-browser-support.test.mjs'], timeoutMs: 20000 },
  ...(!nodeOnly ? [{ name: 'browser', timeoutMs: 100000 }] : [])
];
const checks = [], expires = Date.now() + 150000; let cleanupOk = false, failure, budgetExpired = false;
try {
  for (const check of specifications) {
    const remaining = expires - Date.now(); if (remaining <= 0) { budgetExpired = true; break; }
    const command = check.files ? ['--test', '--test-reporter=tap', '--test-timeout=20000', ...check.files] : ['test-support/security-browser.mjs', directory];
    const execution = await runProcess(process.execPath, command, { env, timeoutMs: Math.min(check.timeoutMs, remaining),
      logFile: path.join(directory, `${check.name}.log`), onOutput: text => process.stdout.write(text) });
    if (check.files) { const tap = tapSummary(execution.tail); Object.assign(execution, tap, { ok: execution.ok && tap.ok }); }
    checks.push({ name: check.name, command: [process.execPath, ...command], configuredTimeoutMs: check.timeoutMs, execution });
    if (execution.timedOut || execution.interrupted || execution.signal != null || execution.testComplete === false) break;
  }
} catch (error) { failure = redactSecurityDiagnostic(error); }
finally {
  try { await rm(temporary, { recursive: true, force: true }); cleanupOk = true; }
  catch (error) { failure = redactSecurityDiagnostic(error); }
}
let browser; try { browser = JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8')); } catch { /* Missing browser output is not passing. */ }
let sourceEnd, sourceStable = false;
try { sourceEnd = await securitySourceSnapshot(); sourceStable = stableSecuritySources(sourceStart, sourceEnd); }
catch (error) { failure = redactSecurityDiagnostic(error); }
let browserArtifactsValid = nodeOnly ? false : await verifySecurityBrowserArtifacts(directory, browser);
if (browser?.cleanupFailures?.length) cleanupOk = false;
if (browser && (browser.source?.sha !== context.source.sha || browser.source?.dirty !== context.source.dirty ||
  browser.browserBuildSource?.appSha256 !== sourceStart.digests['public/app.js'] || browser.browserBuildSource?.serverBuildSha256 !== sourceStart.digests['dist/server/index.js'] ||
  browser.browserBuildSource?.servedAppSha256 !== sourceStart.digests['public/app.js'])) browserArtifactsValid = false;
const observations = { sourceStart, sourceEnd, sourceStable, checks, cleanupOk, budgetExpired, failure,
  browser: browser || { status: nodeOnly ? 'not_run' : 'incomplete', complete: false, ok: false }, browserArtifactsValid,
  boundary: 'Fixed synthetic local-provider security cases. Node-only does not claim Chromium; no real credentials, remote authentication, TLS or arbitrary payload completeness.' };
await writeJson(path.join(directory, 'observations.json'), observations);
await writeFile(path.join(directory, 'worker.log'), (await Promise.all(checks.map(async check =>
  `CHECK ${check.name}\n${await readFile(path.join(directory, `${check.name}.log`), 'utf8')}`))).join('\n'));
const artifacts = await Promise.all(['observations.json', 'worker.log'].map(async name => ({ path: name, sha256: digest(await readFile(path.join(directory, name))) })));
const finishedAt = new Date().toISOString();
report.results = securityProperties.map(property => ({ ...context, property: { id: property.id, version: property.version }, startedAt, finishedAt,
  ...securityPropertyState(property.id, { checks, browser, nodeOnly, sourceStable: sourceStable && !budgetExpired && !failure, cleanupOk, browserArtifactsValid }),
  scope: { description: property.domain, scenario: 'security-fixed-boundaries', samples: 1, seed: null }, artifacts }));
const summary = summarizeSecurity({ results: report.results, checks, target: sourceEnd?.source || context.source, nodeOnly,
  sourceStable: sourceStable && !budgetExpired && !failure, cleanupOk, release,
  artifactsValid: await Promise.all(report.results.map(row => checkArtifacts(directory, row))) });
Object.assign(report, { sourceEnd, finishedAt, complete: summary.complete, ok: summary.ok, summary });
await writeJson(path.join(directory, 'report.json'), report);
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, rows: summary.rows, nodeOnly, fullSecurityProfile: !nodeOnly, fullProjectAcceptance: false }, null, 2));
process.exitCode = summary.ok ? 0 : 1;
