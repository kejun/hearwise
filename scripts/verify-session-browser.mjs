import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './lib/process.mjs';
import { metadata, sourceVersion, writeJson, digest, checkArtifacts } from './lib/verification-evidence.mjs';
import { sessionProperties, sessionProfile } from '../verification/session-properties.mjs';

import { sessionTapSummary, runSessionChecks, summarizeSessionResults, sessionRequiredChecks } from '../test-support/session-evidence.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--node-only', '--release'].includes(arg))) throw new Error('Usage: node scripts/verify-session-browser.mjs [--node-only] [--release]');
const nodeOnly = args.includes('--node-only');
const root = process.env.SESSION_EVIDENCE_DIR || 'browser-evidence';
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'session-'));
const context = await metadata(), startedAt = new Date().toISOString();
const report = { ...context, profile: 'session', startedAt, finishedAt: null, complete: false, ok: false, results: [] };
await writeJson(path.join(directory, 'report.json'), report);
console.log(`Session evidence: ${directory}`);
const temporary = await mkdtemp(path.join(directory, 'temporary-runtime-'));
const env = { ...process.env, TMPDIR: path.resolve(temporary), TMP: path.resolve(temporary), TEMP: path.resolve(temporary) };
// These are isolated subprocess tests, not recursive node:test registrations.
delete env.NODE_TEST_CONTEXT;
const specifications = [
  { name: 'identity-and-source', files: ['test/session-consistency.test.mjs'], timeoutMs: 30000 },
  { name: 'caption-frontier', files: ['test/caption-frontier.test.mjs', 'test/interim-translation-ui.test.mjs'], timeoutMs: 30000 },
  ...(!nodeOnly ? [{ name: 'browser', timeoutMs: 100000 }] : [])
];
const { checks, budgetExpired } = await runSessionChecks(specifications, async ({ name, files }, timeoutMs) => {
  const args = files ? ['--test', '--test-reporter=tap', '--test-timeout=20000', ...files] : ['test-support/session-browser.mjs', directory];
  const execution = await runProcess(process.execPath, args, {
    env, timeoutMs, logFile: path.join(directory, `${name}.log`), onOutput: text => process.stdout.write(text)
  });
  if (files) {
    const tap = sessionTapSummary(execution.tail);
    Object.assign(execution, { ...tap, ok: execution.ok && tap.ok });
  }
  return execution;
}, { cleanup: () => rm(temporary, { recursive: true, force: true }) });

let browser;
try { browser = JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8')); } catch { /* A failed launch has no completed browser observations. */ }
const observations = { checks, browser: browser || { complete: false, status: nodeOnly ? 'not_run' : 'incomplete' },
  boundary: 'Only protocol consistency with stub providers. Real ASR/MT quality and devices are not run.' };
await writeJson(path.join(directory, 'observations.json'), observations);
await writeFile(path.join(directory, 'worker.log'), (await Promise.all(checks.map(async ({ name }) =>
  `CHECK ${name}\n${await readFile(path.join(directory, `${name}.log`), 'utf8')}`))).join('\n'));
const artifacts = await Promise.all(['observations.json', 'worker.log'].map(async name => ({ path: name, sha256: digest(await readFile(path.join(directory, name))) })));
const finishedAt = new Date().toISOString();
const browserRequired = id => id !== 'HW-01-02';
report.results = sessionProperties.map(property => {
  const names = sessionRequiredChecks(property.id, nodeOnly);
  const applicable = checks.filter(check => names.includes(check.name));
  const complete = applicable.length === names.length && applicable.every(({ execution: e }) =>
    !e.timedOut && !e.interrupted && e.signal == null && [0, 1].includes(e.code) && e.testComplete !== false);
  const status = nodeOnly && browserRequired(property.id) ? 'not_run' : !complete ? 'incomplete' :
    applicable.every(({ execution: e }) => e.ok) && (!browserRequired(property.id) || browser?.complete) ? 'passed' : 'failed';
  return { ...context, ...(browser?.chromium ? { tools: { ...context.tools, chromium: browser.chromium } } : {}),
    property: { id: property.id, version: property.version }, startedAt, finishedAt, complete,
    status, scope: { description: property.domain, scenario: 'session-consistency', samples: 1, seed: null }, artifacts };
});
const target = sourceVersion();
const { execution, summary } = summarizeSessionResults({ results: report.results, target, checks, nodeOnly, budgetExpired,
  required: sessionProfile, sourceStable: target.sha === context.source.sha && target.dirty === context.source.dirty,
  release: args.includes('--release') || process.env.CI === 'true', artifactsValid: await Promise.all(report.results.map(result => checkArtifacts(directory, result))) });
Object.assign(report, { finishedAt, complete: execution.complete, ok: summary.ok, execution, summary });
await writeJson(path.join(directory, 'report.json'), report);
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, rows: summary.rows, fullProjectAcceptance: false }, null, 2));
process.exitCode = summary.ok ? 0 : 1;
