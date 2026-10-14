import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './lib/process.mjs';
import { metadata, sourceVersion, writeJson, summarize } from './lib/verification-evidence.mjs';
import { relationResultProperties, relationResultProfile } from '../verification/relation-result-properties.mjs';

import { writeRelationResultEvidence, checkRelationResultEvidence } from '../test-support/relation-result-evidence.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--node-only', '--release'].includes(arg))) throw new Error('Usage: node scripts/verify-relation-result-browser.mjs [--node-only] [--release]');
const nodeOnly = args.includes('--node-only');
const root = process.env.RELATION_RESULT_EVIDENCE_DIR || 'browser-evidence';
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'relation-result-'));
const context = await metadata(), startedAt = new Date().toISOString();
const report = { ...context, profile: 'relation-result', startedAt, finishedAt: null, complete: false, ok: false, results: [] };
await writeJson(path.join(directory, 'report.json'), report);
console.log(`Relation result evidence: ${directory}`);
const checks = [];
const temporary = await mkdtemp(path.join(directory, 'temporary-runtime-'));
const env = { ...process.env, TMPDIR: path.resolve(temporary), TMP: path.resolve(temporary), TEMP: path.resolve(temporary) };
// These are isolated subprocess tests, not recursive node:test registrations.
delete env.NODE_TEST_CONTEXT;
for (const [name, files] of [
  ['source-integrity', ['test/relations.test.mjs', 'test/relation-storage.test.mjs', 'test/relation-evidence-e2e.test.mjs']],
  ['http-results', ['test/relation-result.test.mjs']]
]) {
  const execution = await runProcess(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=30000', ...files], {
    env, timeoutMs: 40000, logFile: path.join(directory, `${name}.log`), onOutput: text => process.stdout.write(text)
  });
  const count = Number(execution.tail.match(/# tests (\d+)/)?.[1] || 0);
  execution.testCount = count;
  if (!count || !/# fail 0(?:\r?\n|$)/.test(execution.tail) || !/# cancelled 0(?:\r?\n|$)/.test(execution.tail)) execution.ok = false;
  checks.push({ name, execution });
  if (execution.interrupted) break;
}
if (!nodeOnly && !checks.some(check => check.execution.interrupted)) checks.push({ name: 'browser', execution: await runProcess(process.execPath, ['test-support/relation-result-browser.mjs', directory], {
  env, timeoutMs: 100000, logFile: path.join(directory, 'browser.log'), onOutput: text => process.stdout.write(text)
}) });
await rm(temporary, { recursive: true, force: true });
let browser;
try { browser = JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8')); } catch { /* A failed launch has no completed browser observations. */ }
const observations = { checks, browser: browser || { complete: false, status: nodeOnly ? 'not_run' : 'incomplete' },
  boundary: 'Only structural/source/result consistency with hand-authored provider outputs. Real relation quality and devices are not run.' };
const artifacts = await writeRelationResultEvidence(directory, observations);
const finishedAt = new Date().toISOString();
const browserRequired = id => id !== 'HW-05-02';
report.results = relationResultProperties.map(property => {
  const requiredChecks = property.id === 'HW-05-02' ? ['source-integrity'] :
    property.id === 'HW-05-03' ? ['source-integrity', 'http-results', ...(nodeOnly ? [] : ['browser'])] : nodeOnly ? [] : ['browser'];
  const applicable = checks.filter(check => requiredChecks.includes(check.name));
  const complete = applicable.length === requiredChecks.length && applicable.every(({ execution: e }) =>
    !e.timedOut && !e.interrupted && e.signal == null && [0, 1].includes(e.code));
  const status = nodeOnly && browserRequired(property.id) ? 'not_run' : !complete ? 'incomplete' :
    applicable.every(({ execution: e }) => e.ok) && (!browserRequired(property.id) || browser?.complete) ? 'passed' : 'failed';
  return { ...context, ...(browser?.chromium ? { tools: { ...context.tools, chromium: browser.chromium } } : {}),
    property: { id: property.id, version: property.version }, startedAt, finishedAt, complete,
    status, scope: { description: property.domain, scenario: 'relation-result-integrity', samples: 1, seed: null }, artifacts };
});
const execution = { code: checks.every(({ execution: e }) => e.ok) ? 0 : 1, signal: null,
  timedOut: checks.some(({ execution: e }) => e.timedOut), interrupted: checks.some(({ execution: e }) => e.interrupted),
  complete: checks.every(({ execution: e }) => !e.timedOut && !e.interrupted && e.signal == null && [0, 1].includes(e.code)) };
const target = sourceVersion();
if (target.sha !== context.source.sha || target.dirty !== context.source.dirty) execution.complete = false;
const summary = summarize({ results: report.results, target, required: relationResultProfile, execution,
  release: args.includes('--release') || process.env.CI === 'true', artifactsValid: await Promise.all(report.results.map(result => checkRelationResultEvidence(directory, result))) });
Object.assign(report, { finishedAt, complete: execution.complete, ok: summary.ok, execution, summary });
await writeJson(path.join(directory, 'report.json'), report);
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, rows: summary.rows, fullProjectAcceptance: false }, null, 2));
process.exitCode = summary.ok ? 0 : 1;
