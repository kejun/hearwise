import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runProcess } from './lib/process.mjs';
import { metadata, sourceVersion, writeJson, digest } from './lib/verification-evidence.mjs';
import { runChecks, summarizeChecks } from './lib/verification-checks.mjs';
import { strictNameTap } from './lib/name-protocol-evidence.mjs';
import { nameProperties, nameProfile } from '../verification/name-properties.mjs';
import { nameBrowserAssets, nameBrowserChecks, nameHttpRoster, nameSourceSnapshot, validNameBuild, nameBrowserMutation, validNameBrowser, checkNameEvidence } from '../test-support/name-protocol-browser-evidence.mjs';
const args = process.argv.slice(2); if (args.some(arg => !['--node-only', '--release'].includes(arg))) throw new Error('Usage: verify-name-browser.mjs [--node-only] [--release]');
const nodeOnly = args.includes('--node-only'), root = process.env.NAME_BROWSER_EVIDENCE_DIR || 'browser-evidence';
await mkdir(root, { recursive: true }); const directory = await mkdtemp(path.join(root, 'name-protocol-'));
const context = await metadata(), sourceStart = await nameSourceSnapshot(), mutation = await nameBrowserMutation(), startedAt = new Date().toISOString();
const report = { ...context, profile: 'name-protocol-browser', startedAt, finishedAt: null, complete: false, ok: false, results: [] };
await writeJson(path.join(directory, 'report.json'), report); console.log(`Name browser evidence: ${directory}`);
const temporary = await mkdtemp(path.join(directory, 'temporary-runtime-'));
const env = { ...process.env, TMPDIR: path.resolve(temporary), TMP: path.resolve(temporary), TEMP: path.resolve(temporary) }; delete env.NODE_TEST_CONTEXT;
const specifications = nameBrowserChecks.filter(row => !nodeOnly || row.name !== 'browser');
const { checks, budgetExpired } = await runChecks(specifications, async (spec, timeoutMs) => {
  const argv = spec.file ? ['--test', '--test-reporter=tap', '--test-timeout=20000', spec.file] : ['test-support/name-protocol-browser.mjs', directory];
  const e = await runProcess(process.execPath, argv, { env, timeoutMs, logFile: path.join(directory, spec.name + '.log'), onOutput: text => process.stdout.write(text) });
  Object.assign(e, { command: [process.execPath, ...argv], configuredTimeoutMs: spec.timeoutMs, timeoutMs, cwd: process.cwd() });
  if (spec.file) { const tap = strictNameTap(await readFile(path.join(directory, spec.name + '.log'), 'utf8'), await nameHttpRoster()); Object.assign(e, { testComplete: tap.ok, testCount: tap.tests, ok: e.ok && tap.ok }); }
  return e;
}, { cleanup: () => rm(temporary, { recursive: true, force: true }) });
let browser; try { browser = JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8')); } catch { browser = { complete: false }; }
const sourceEnd = await nameSourceSnapshot(), sourceStable = validNameBuild(sourceStart) && validNameBuild(sourceEnd) && isDeepStrictEqual(sourceStart, sourceEnd);
const hashFiles = names => Promise.all(names.map(async file => ({ path: file, sha256: digest(await readFile(path.join(directory, file))) })));
let attachments = []; try { attachments = await hashFiles(nameBrowserAssets); } catch { /* A partial run cannot manufacture absent assets. */ }
await writeJson(path.join(directory, 'observations.json'), { checks, sourceStart, sourceEnd, browser, mutation, attachments,
  executionContext: { cwd: process.cwd(), executable: process.execPath, evidenceDirectory: path.resolve(directory), outputArgument: directory } });
await writeFile(path.join(directory, 'worker.log'), (await Promise.all(checks.map(async row => `CHECK ${row.name}\n${await readFile(path.join(directory, row.name + '.log'), 'utf8')}`))).join('\n'));
const artifacts = await hashFiles(['observations.json', 'worker.log']), finishedAt = new Date().toISOString();
const browserPassed = validNameBrowser(browser, sourceEnd, mutation), complete = !budgetExpired && checks.length === specifications.length && checks.every(({ execution: e }) => !e.timedOut && !e.interrupted && e.signal === null && [0, 1].includes(e.code) && e.testComplete !== false);
report.results = nameProperties.map(property => ({ ...context, property: { id: property.id, version: property.version }, startedAt, finishedAt,
  complete, status: nodeOnly ? 'not_run' : !complete || !sourceStable ? 'incomplete' : checks.every(row => row.execution.ok) && browserPassed ? 'passed' : 'failed',
  scope: { description: property.domain, scenario: 'name-http-browser', samples: 1, seed: null }, artifacts }));
const { execution, summary } = summarizeChecks({ results: report.results, checks, target: sourceVersion(), required: nameProfile, release: args.includes('--release') || process.env.CI === 'true', sourceStable,
  expectedChecks: nameBrowserChecks.map(row => row.name), checksForProperty: () => nameBrowserChecks.map(row => row.name), budgetExpired,
  artifactsValid: await Promise.all(report.results.map(row => checkNameEvidence(directory, row))) });
Object.assign(report, { finishedAt, complete: execution.complete, ok: summary.ok, execution, summary }); await writeJson(path.join(directory, 'report.json'), report);
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, rows: summary.rows, fullProjectAcceptance: false })); process.exitCode = report.ok ? 0 : 1;
