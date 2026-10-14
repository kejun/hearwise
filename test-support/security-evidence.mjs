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
export const securityScreenshotNames = ['security-stored-text.png', 'security-reopened-graph.png', 'security-live-provider-text.png'];
export const securityTableNames = ['extraction_jobs', 'extraction_parts', 'knowledge_aliases', 'knowledge_candidates', 'knowledge_corrections', 'knowledge_edit_jobs', 'knowledge_facts', 'knowledge_items', 'knowledge_manual_items', 'knowledge_mentions', 'knowledge_revisions', 'listening_runs', 'listenings', 'relation_assertions', 'relation_jobs', 'relation_requests', 'relation_revisions', 'relation_rounds', 'relation_supports', 'relation_windows', 'relations', 'segments'];
const exactCounts = (actual, expected) => Object.entries(expected).every(([key, value]) => actual?.[key] === value);
export function validSecurityBrowserCheck(check, expectedRenderingMutation) {
  if (!check || check.complete !== true || check.status !== 'passed') return false;
  const { counts, observations } = check;
  if (check.id !== 'dangerous-rendering-control' && !normalSnapshot(observations?.final)) return false;
  if (check.id === 'stored-external-text') return exactCounts(counts, { metadataWrites: 1, nameReplacementWrites: 1, modelRegenerationWrites: 1, browserReloads: 1, serverRestarts: 1, knowledgeCards: 4, graphDetails: 4 });
  if (check.id === 'live-provider-text') return exactCounts(counts, { asrFinals: 1, persistedSegments: 1, modelTranslations: 1, browserReloads: 1 });
  if (check.id === 'credential-surfaces') {
    const storage = observations?.storage, exports = observations?.exports, tableRows = storage?.tableRows;
    return counts?.exports === 5 && Number.isSafeInteger(counts.providerAuthorizations) && counts.providerAuthorizations >= 9 && counts.sqliteTables === securityTableNames.length &&
      nonzero(counts, ['sqliteRows', 'runtimeFiles', 'traceEvents']) &&
      JSON.stringify(Object.keys(tableRows || {}).sort()) === JSON.stringify([...securityTableNames].sort()) &&
      Object.values(tableRows).every(value => Number.isSafeInteger(value) && value >= 0) &&
      tableRows.listenings >= 2 && tableRows.listening_runs >= 2 && tableRows.segments >= 3 && tableRows.knowledge_items === 2 && tableRows.knowledge_facts >= 1 && tableRows.knowledge_edit_jobs >= 1 &&
      counts.sqliteRows === Object.values(tableRows).reduce((sum, value) => sum + value, 0) &&
      storage.tables === counts.sqliteTables && storage.rows === counts.sqliteRows && storage.files === counts.runtimeFiles && storage.traceEvents === counts.traceEvents &&
      storage.bytes > 0 && Array.isArray(storage.fileNames) && storage.fileNames.length === storage.files && new Set(storage.fileNames).size === storage.files && storage.fileNames.includes('business.sqlite') &&
      Array.isArray(exports) && exports.length === 5 && exports.every(row => Number.isSafeInteger(row.bytes) && row.bytes > 0) &&
      exports.filter(row => row.kind === 'original').length === 2 && exports.filter(row => row.kind === 'translation').length === 2 && exports.filter(row => row.kind === 'database').length === 1 &&
      ['keyStorage', 'fishStorage', 'keyInput', 'fishInput', 'masked'].every(key => observations?.allowed?.[key] === true);
  }
  if (check.id === 'dangerous-rendering-control') {
    const mutated = observations?.mutated;
    return expectedRenderingMutation && observations?.anchor === expectedRenderingMutation.anchor && observations.replacement === expectedRenderingMutation.replacement &&
      observations.normalAppSha256 === expectedRenderingMutation.normalAppSha256 && observations.mutantAppSha256 === expectedRenderingMutation.mutantAppSha256 &&
      counts?.mutants === 1 && counts.replacements === expectedRenderingMutation.replacements && counts.replacements === 1 && counts.mutantResourceResponses === 1 && observations?.expectedFailure === true &&
      Number.isSafeInteger(mutated?.injectedNodeCount) && mutated.injectedNodeCount > 0 && Number.isSafeInteger(mutated.probeRequests) && mutated.probeRequests >= 0 && Number.isSafeInteger(mutated.executionCount) && mutated.executionCount >= 0 &&
      counts.injectedNodes === mutated.injectedNodeCount && counts.probeRequests === mutated.probeRequests && counts.scriptExecutions === mutated.executionCount &&
      (mutated.probeRequests > 0 || mutated.executionCount > 0) && ['credentialFindings', 'externalRequests', 'observationErrors', 'pageErrors'].every(key => mutated[key] === 0) &&
      normalSnapshot(observations.normal) && /^[a-f0-9]{64}$/.test(observations.normalAppSha256) && /^[a-f0-9]{64}$/.test(observations.mutantAppSha256) &&
      observations.normalAppSha256 !== observations.mutantAppSha256 && Array.isArray(observations.detected) &&
      JSON.stringify([...observations.detected].sort()) === JSON.stringify(['unexpected-nodes', ...(mutated.executionCount ? ['script-execution'] : []), ...(mutated.probeRequests ? ['probe-request'] : [])].sort());
  }
  return false;
}

export function securityPropertyState(id, { checks, browser, nodeOnly = false, sourceStable = true, cleanupOk = true, browserArtifactsValid = true, expectedRenderingMutation }) {
  if (!needed[id]) throw new Error('Unknown security property');
  if (nodeOnly && browserChecks[id]) return { status: 'not_run', complete: false };
  const applicable = checks.filter(row => needed[id].includes(row.name));
  if (!sourceStable || !cleanupOk || applicable.length !== needed[id].length || !applicable.every(row => cleanExecution(row.execution))) return { status: 'incomplete', complete: false };
  if (!browserChecks[id]) {
    if (!applicable.every(row => row.execution.testComplete === true && row.execution.testCount >= minimumNodeTests[row.name])) return { status: 'incomplete', complete: false };
    return { status: applicable.every(row => row.execution.ok) ? 'passed' : 'failed', complete: true };
  }
  if (browser?.lateObservationFailure) return { status: 'failed', complete: true };
  if (!browserArtifactsValid || browser?.cleanupFailures?.length || !browser?.chromium || !browser?.browserBuildSource || !Array.isArray(browser.checks)) return { status: 'incomplete', complete: false };
  const selected = browserChecks[id].map(name => browser.checks.filter(row => row.id === name));
  if (selected.some(rows => rows.length !== 1 || !rows[0].complete)) return { status: 'incomplete', complete: false };
  return { status: selected.every(rows => validSecurityBrowserCheck(rows[0], expectedRenderingMutation)) ? 'passed' : 'failed', complete: true };
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
  if (!Array.isArray(browser?.artifacts) || browser.artifacts.length !== securityScreenshotNames.length ||
    !securityScreenshotNames.every(name => browser.artifacts.filter(row => row.path === name).length === 1)) return false;
  const seen = new Set();
  for (const artifact of browser.artifacts) {
    if (typeof artifact.path !== 'string' || path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes('..') || seen.has(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return false;
    seen.add(artifact.path);
    try { if (digest(await readFile(path.join(directory, artifact.path))) !== artifact.sha256) return false; } catch { return false; }
  }
  return true;
}
