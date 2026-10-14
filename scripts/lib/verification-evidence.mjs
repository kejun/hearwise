import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { specification, properties } from '../../verification/properties.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const registryDigest = digest(JSON.stringify({ specification, properties }));
export function sourceVersion() {
  const git = args => execFileSync('git', args, { encoding: 'utf8', timeout: 5000 }).trim();
  return { sha: git(['rev-parse', '--verify', 'HEAD']), dirty: Boolean(git(['status', '--porcelain', '--untracked-files=normal'])) };
}
export async function metadata() {
  return { schemaVersion: 1, source: sourceVersion(), specification: { ...specification, digest: registryDigest },
    tools: { node: process.version, sqlite: process.versions.sqlite, lockDigest: digest(await readFile('package-lock.json')) },
    environment: { platform: process.platform, arch: process.arch, release: os.release() },
    mode: 'implementation-scenario', extensions: { quality: null, performance: null, device: null } };
}
export async function writeJson(file, data) {
  // An interrupted write must never leave a parseable partial passing report.
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n');
  await rename(temporary, file);
}
const nonempty = value => typeof value === 'string' && value.length > 0;
const validTime = value => nonempty(value) && Number.isFinite(Date.parse(value));
export function validateResult(result) {
  if (!result || typeof result !== 'object') return false;
  return result.schemaVersion === 1 && /^HW-\d{2}-\d{2}$/.test(result.property?.id) && Number.isInteger(result.property?.version) &&
    /^[a-f0-9]{40}$/.test(result.source?.sha) && typeof result.source?.dirty === 'boolean' &&
    result.specification?.id === specification.id && nonempty(result.specification.version) &&
    Number.isInteger(result.specification.registryVersion) && /^[a-f0-9]{64}$/.test(result.specification.digest) &&
    ['node', 'sqlite', 'lockDigest'].every(key => nonempty(result.tools?.[key])) &&
    ['platform', 'arch', 'release'].every(key => nonempty(result.environment?.[key])) &&
    result.mode === 'implementation-scenario' && nonempty(result.scope?.description) &&
    nonempty(result.scope?.scenario) && result.scope?.samples === 1 && result.scope?.seed === null &&
    validTime(result.startedAt) && validTime(result.finishedAt) && Date.parse(result.finishedAt) >= Date.parse(result.startedAt) &&
    typeof result.complete === 'boolean' && ['passed', 'failed', 'not_run', 'incomplete', 'not_applicable'].includes(result.status) &&
    result.extensions && ['quality', 'performance', 'device'].every(key => Object.hasOwn(result.extensions, key)) &&
    Array.isArray(result.artifacts) && result.artifacts.length === 2 &&
    ['observations.json', 'worker.log'].every(name => result.artifacts.filter(artifact => artifact?.path === name).length === 1) &&
    result.artifacts.every(artifact => /^[a-f0-9]{64}$/.test(artifact?.sha256));
}
export async function checkArtifacts(directory, result) {
  if (!Array.isArray(result?.artifacts) || !result.artifacts.length) return false;
  for (const artifact of result.artifacts) {
    if (!nonempty(artifact?.path) || path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes('..')) return false;
    try { if (digest(await readFile(path.join(directory, artifact.path))) !== artifact.sha256) return false; }
    catch { return false; }
  }
  return true;
}
// Required IDs come from the caller's checked-in profile, never from the report.
export function summarize({ results, target, required, execution, release = false, artifactsValid = [] }) {
  if (!required?.length || new Set(required).size !== required.length || required.some(id => !properties.some(p => p.id === id))) {
    throw new Error('Expected a nonempty, unique, registered required-property profile');
  }
  const rows = required.map(id => {
    const matches = results.map((result, index) => ({ result, index })).filter(({ result }) => result?.property?.id === id);
    const row = { id, status: 'not_run', stale: false, reasons: [] };
    if (!matches.length) { row.reasons.push('missing'); return row; }
    if (matches.length !== 1) { row.status = 'incomplete'; row.reasons.push('duplicate'); return row; }
    const { result, index } = matches[0], property = properties.find(p => p.id === id);
    row.status = result.status;
    if (!validateResult(result)) { row.status = 'incomplete'; row.reasons.push('invalid_contract'); }
    if (!artifactsValid[index]) { row.status = 'incomplete'; row.reasons.push('missing_or_changed_artifact'); }
    if (result.source?.sha !== target.sha || result.specification?.digest !== registryDigest ||
      result.specification?.version !== specification.version || result.specification?.registryVersion !== specification.registryVersion ||
      result.property?.version !== property.version) { row.stale = true; row.reasons.push('stale'); }
    if (result.complete !== true || execution?.complete !== true || execution?.timedOut !== false ||
      execution?.interrupted !== false || ![0, 1].includes(execution?.code) || execution?.signal != null) {
      row.status = 'incomplete'; row.reasons.push('incomplete_execution');
    } else if (execution.code !== 0 && row.status === 'passed') { row.status = 'failed'; row.reasons.push('nonzero_exit'); }
    if (release && (result.source?.dirty !== false || target.dirty !== false)) row.reasons.push('uncommitted_source');
    // This pilot profile has no approved exclusions. N/A can never bypass it.
    if (row.status === 'not_applicable') row.reasons.push('unapproved_exclusion');
    return row;
  });
  const ok = rows.every(row => row.status === 'passed' && !row.stale && !row.reasons.length);
  return { ok, release, target, required, rows, coverage: properties.map(property => ({
    id: property.id, title: property.title, status: rows.find(row => row.id === property.id)?.status || 'not_run',
    stale: rows.find(row => row.id === property.id)?.stale || false, gaps: property.gaps, issues: property.issues
  })), fullProjectAcceptance: false };
}
