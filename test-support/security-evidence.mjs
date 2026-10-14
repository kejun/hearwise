import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sourceVersion, digest, summarize } from '../scripts/lib/verification-evidence.mjs';
import { securityProfile, securityNodeProfile } from '../verification/security-properties.mjs';

export async function securitySourceSnapshot() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const names = [...new Set([...files, 'dist/server/index.js', 'public/vendor/cytoscape.js'])].sort();
  return { source: sourceVersion(), digests: Object.fromEntries(await Promise.all(names.map(async name => [name, digest(await readFile(name))]))) };
}
const minimumNodeTests = { credentials: 10, boundaries: 13, negative: 12 };
const needed = { 'HW-12-02': ['credentials', 'negative'], 'HW-12-03': ['browser'], 'HW-12-04': ['boundaries'], 'HW-12-05': ['browser'] };
const browserChecks = { 'HW-12-03': ['stored-external-text', 'live-provider-text', 'dangerous-rendering-control'], 'HW-12-05': ['credential-surfaces'] };
const cleanExecution = execution => execution && execution.timedOut === false && execution.interrupted === false && execution.signal == null && [0, 1].includes(execution.code) && execution.testComplete !== false;
export function stableSecuritySources(start, end) {
  const required = ['server.mjs', 'knowledge.mjs', 'speech-service.mjs', 'qwen-tts.mjs', 'package-lock.json', 'public/app.js', 'dist/server/index.js', 'public/vendor/cytoscape.js', 'test-support/security-evidence.mjs', 'scripts/verify-security-browser.mjs'];
  return Boolean(start && end && /^[a-f0-9]{40}$/.test(start.source?.sha) && typeof start.source?.dirty === 'boolean' &&
    required.every(name => /^[a-f0-9]{64}$/.test(start.digests?.[name])) && JSON.stringify(start) === JSON.stringify(end));
}
const normalSnapshot = snapshot => snapshot && ['executionCount', 'injectedNodeCount', 'probeRequests', 'externalRequests', 'credentialFindings', 'observationErrors', 'pageErrors'].every(key => snapshot[key] === 0);
const nonzero = (counts, keys) => keys.every(key => Number.isSafeInteger(counts?.[key]) && counts[key] > 0);
export function validSecurityBrowserCheck(check) {
  if (!check || check.complete !== true || check.status !== 'passed') return false;
  const { counts, observations } = check;
  if (check.id !== 'dangerous-rendering-control' && !normalSnapshot(observations?.final)) return false;
  if (check.id === 'stored-external-text') return nonzero(counts, ['metadataWrites', 'nameReplacementWrites', 'modelRegenerationWrites', 'browserReloads', 'serverRestarts', 'knowledgeCards', 'graphDetails']);
  if (check.id === 'live-provider-text') return nonzero(counts, ['asrFinals', 'persistedSegments', 'modelTranslations', 'browserReloads']);
  if (check.id === 'credential-surfaces') return nonzero(counts, ['exports', 'providerAuthorizations', 'sqliteTables', 'sqliteRows', 'runtimeFiles', 'traceEvents']) &&
    ['keyStorage', 'fishStorage', 'keyInput', 'fishInput', 'masked'].every(key => observations?.allowed?.[key] === true);
  if (check.id === 'dangerous-rendering-control') return counts?.mutants === 1 && counts.replacements === 1 && counts.mutantResourceResponses === 1 &&
    counts.injectedNodes > 0 && (counts.probeRequests > 0 || counts.scriptExecutions > 0) && observations?.expectedFailure === true &&
    normalSnapshot(observations.normal) && /^[a-f0-9]{64}$/.test(observations.normalAppSha256) && /^[a-f0-9]{64}$/.test(observations.mutantAppSha256) &&
    observations.normalAppSha256 !== observations.mutantAppSha256 && observations.detected?.includes('unexpected-nodes');
  return false;
}
export function securityPropertyState(id, { checks, browser, nodeOnly = false, sourceStable = true, cleanupOk = true, browserArtifactsValid = true }) {
  if (!needed[id]) throw new Error('Unknown security property');
  if (nodeOnly && browserChecks[id]) return { status: 'not_run', complete: false };
  const applicable = checks.filter(row => needed[id].includes(row.name));
  if (!sourceStable || !cleanupOk || applicable.length !== needed[id].length || !applicable.every(row => cleanExecution(row.execution))) return { status: 'incomplete', complete: false };
  if (!browserChecks[id]) {
    if (!applicable.every(row => row.execution.testComplete === true && row.execution.testCount >= minimumNodeTests[row.name])) return { status: 'incomplete', complete: false };
    return { status: applicable.every(row => row.execution.ok) ? 'passed' : 'failed', complete: true };
  }
  if (!browserArtifactsValid || browser?.cleanupFailures?.length || !browser?.chromium || !browser?.browserBuildSource || !Array.isArray(browser.checks)) return { status: 'incomplete', complete: false };
  const selected = browserChecks[id].map(name => browser.checks.filter(row => row.id === name));
  if (selected.some(rows => rows.length !== 1 || !rows[0].complete)) return { status: 'incomplete', complete: false };
  return { status: selected.every(rows => validSecurityBrowserCheck(rows[0])) ? 'passed' : 'failed', complete: true };
}
export function summarizeSecurity({ results, checks, target, nodeOnly = false, sourceStable, cleanupOk, artifactsValid, release = false }) {
  const required = nodeOnly ? securityNodeProfile : securityProfile;
  const rows = required.flatMap(id => {
    const matches = results.map((result, index) => ({ result, index })).filter(row => row.result.property?.id === id);
    const status = matches[0]?.result;
    const execution = { code: status?.status === 'passed' ? 0 : 1, signal: null, timedOut: false, interrupted: false,
      complete: sourceStable && cleanupOk && status?.complete === true };
    return summarize({ results: matches.map(row => row.result), target, required: [id], execution, release,
      artifactsValid: matches.map(row => artifactsValid[row.index]) }).rows;
  });
  const expected = nodeOnly ? ['credentials', 'boundaries', 'negative'] : ['credentials', 'boundaries', 'negative', 'browser'];
  const complete = sourceStable && cleanupOk && checks.length === expected.length && expected.every(name => checks.filter(row => row.name === name).length === 1) &&
    checks.every(row => cleanExecution(row.execution) && (row.name === 'browser' || row.execution.testComplete === true && row.execution.testCount >= minimumNodeTests[row.name]));
  return { complete, ok: complete && checks.every(row => row.execution.ok) && rows.every(row => row.status === 'passed' && !row.stale && !row.reasons.length),
    required, rows, nodeOnly, fullSecurityProfile: !nodeOnly, fullProjectAcceptance: false };
}
export async function verifySecurityBrowserArtifacts(directory, browser) {
  if (!Array.isArray(browser?.artifacts) || !browser.artifacts.length) return false;
  const seen = new Set();
  for (const artifact of browser.artifacts) {
    if (typeof artifact.path !== 'string' || path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes('..') || seen.has(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return false;
    seen.add(artifact.path);
    try { if (digest(await readFile(path.join(directory, artifact.path))) !== artifact.sha256) return false; } catch { return false; }
  }
  return true;
}
