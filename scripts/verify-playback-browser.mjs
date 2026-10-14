import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './lib/process.mjs';
import { metadata, sourceVersion, writeJson } from './lib/verification-evidence.mjs';
import { playbackProperties, playbackProfile } from '../verification/playback-properties.mjs';

import { writePlaybackEvidence, checkPlaybackEvidence, playbackTap, runPlaybackChecks, summarizePlaybackResults, playbackRequiredChecks, checkPlaybackBrowser } from '../test-support/playback-evidence.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--node-only', '--release'].includes(arg))) throw new Error('Usage: node scripts/verify-playback-browser.mjs [--node-only] [--release]');
const nodeOnly = args.includes('--node-only');
const root = process.env.PLAYBACK_EVIDENCE_DIR || 'browser-evidence';
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'playback-'));
const context = await metadata(), startedAt = new Date().toISOString();
const report = { ...context, profile: 'playback', startedAt, finishedAt: null, complete: false, ok: false, results: [] };
await writeJson(path.join(directory, 'report.json'), report);
console.log(`Playback evidence: ${directory}`);
const temporary = await mkdtemp(path.join(directory, 'temporary-runtime-'));
const env = { ...process.env, TMPDIR: path.resolve(temporary), TMP: path.resolve(temporary), TEMP: path.resolve(temporary) };
// These are isolated subprocess tests, not recursive node:test registrations.
delete env.NODE_TEST_CONTEXT;
const specifications = [
  { name: 'identity', files: ['test/speech-generation-boundary.test.mjs', 'test/qwen-response-ownership.test.mjs', 'test/playback-protocol-adapter.test.mjs'], timeoutMs: 30000 },
  { name: 'text', files: ['test/playback-text-contract.test.mjs'], timeoutMs: 20000 },
  { name: 'transports', files: ['test/playback-websocket.test.mjs', 'test/speech-integration.test.mjs'], timeoutMs: 30000 },
  ...(!nodeOnly ? [{ name: 'browser', timeoutMs: 100000 }] : [])
];
const { checks, budgetExpired } = await runPlaybackChecks(specifications, async ({ name, files }, timeoutMs) => {
  const args = files ? ['--test', '--test-reporter=tap', '--test-timeout=30000', ...files] : ['test-support/playback-browser.mjs', directory];
  const execution = await runProcess(process.execPath, args, {
    env, timeoutMs, logFile: path.join(directory, `${name}.log`), onOutput: text => process.stdout.write(text)
  });
  if (files) {
    const tap = playbackTap(execution.tail, name);
    Object.assign(execution, { ...tap, ok: execution.ok && tap.ok });
  }
  return execution;
}, { cleanup: () => rm(temporary, { recursive: true, force: true }) });

let browser;
try { browser = JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8')); } catch { /* A failed launch has no completed browser observations. */ }
const observations = { checks, browser: browser || { complete: false, status: nodeOnly ? 'not_run' : 'incomplete' },
  boundary: 'Playback protocol and independently normalized text with stub providers. Finite formal gate is separate; no audible/device/real-service quality acceptance.' };
const artifacts = await writePlaybackEvidence(directory, observations);
const finishedAt = new Date().toISOString();
const browserRequired = () => true;
report.results = playbackProperties.map(property => {
  const requiredChecks = playbackRequiredChecks(property.id, nodeOnly);
  const applicable = checks.filter(check => requiredChecks.includes(check.name));
  const complete = applicable.length === requiredChecks.length && applicable.every(({ execution: e }) =>
    !e.timedOut && !e.interrupted && e.signal == null && [0, 1].includes(e.code) && e.testComplete !== false);
  const status = nodeOnly && browserRequired(property.id) ? 'not_run' : !complete ? 'incomplete' :
    applicable.every(({ execution: e }) => e.ok) && (!browserRequired(property.id) || checkPlaybackBrowser(browser)) ? 'passed' : 'failed';
  return { ...context, ...(browser?.chromium ? { tools: { ...context.tools, chromium: browser.chromium } } : {}),
    property: { id: property.id, version: property.version }, startedAt, finishedAt, complete,
    status, scope: { description: property.domain, scenario: 'playback-generation-text', samples: 1, seed: null }, artifacts };
});
const target = sourceVersion();
const { execution, summary } = summarizePlaybackResults({ results: report.results, target, checks, nodeOnly, budgetExpired,
  required: playbackProfile, sourceStable: target.sha === context.source.sha && target.dirty === context.source.dirty,
  release: args.includes('--release') || process.env.CI === 'true', artifactsValid: await Promise.all(report.results.map(result => checkPlaybackEvidence(directory, result))) });
Object.assign(report, { finishedAt, complete: execution.complete, ok: summary.ok, execution, summary });
await writeJson(path.join(directory, 'report.json'), report);
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, rows: summary.rows, fullProjectAcceptance: false }, null, 2));
process.exitCode = summary.ok ? 0 : 1;
