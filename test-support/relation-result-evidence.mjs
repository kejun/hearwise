import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, writeJson, checkArtifacts, summarize } from '../scripts/lib/verification-evidence.mjs';

const scenarios = ['shortage', 'empty', 'filtered', 'qualified', 'partial', 'error'];
const browserAssets = ['browser.json', ...[1280, 390].flatMap(width => scenarios.map(name => `relations-${width}-${name}.png`))];
const hashFiles = (directory, names) => Promise.all(names.map(async name => ({ path: name, sha256: digest(await readFile(path.join(directory, name))) })));

export async function writeRelationResultEvidence(directory, observations) {
  // Keep the shared two-artifact contract. Its observations digest binds this
  // manifest; every referenced browser file is independently checked below.
  const names = observations.browser?.complete ? browserAssets :
    (await readdir(directory)).filter(name => name.endsWith('.png') || name === 'browser.json');
  const attachments = await hashFiles(directory, names);
  await writeJson(path.join(directory, 'observations.json'), { ...observations, attachments });
  await writeFile(path.join(directory, 'worker.log'), (await Promise.all(observations.checks.map(async ({ name }) =>
    `CHECK ${name}\n${await readFile(path.join(directory, `${name}.log`), 'utf8')}`))).join('\n'));
  return hashFiles(directory, ['observations.json', 'worker.log']);
}
export async function checkRelationResultEvidence(directory, result) {
  if (!await checkArtifacts(directory, result)) return false;
  try {
    const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
    const references = observations.attachments;
    if (!Array.isArray(references) || new Set(references.map(item => item?.path)).size !== references.length) return false;
    if (observations.browser?.complete && (references.length !== browserAssets.length ||
      browserAssets.some(name => references.filter(item => item?.path === name).length !== 1))) return false;
    return references.length === 0 || await checkArtifacts(directory, { artifacts: references });
  } catch { return false; }
}

export function relationTapSummary(tail) {
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => {
    const match = tail.match(new RegExp(`# ${key} (\\d+)(?:\\r?\\n|$)`));
    return [key, match ? Number(match[1]) : null];
  }));
  const testComplete = Object.values(counts).every(Number.isInteger) && counts.tests > 0 &&
    counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0 && counts.pass + counts.fail === counts.tests;
  return { testCount: counts.tests || 0, testComplete, ok: testComplete && counts.fail === 0 };
}

export function relationExecution(checks) {
  return { code: checks.every(({ execution: e }) => e.ok) ? 0 : 1, signal: null,
    timedOut: checks.some(({ execution: e }) => e.timedOut), interrupted: checks.some(({ execution: e }) => e.interrupted),
    complete: checks.every(({ execution: e }) => !e.timedOut && !e.interrupted && e.signal == null && [0, 1].includes(e.code) && e.testComplete !== false) };
}
// The browser parent gives this profile 180s. Reserve 30s for process-group
// termination, runtime cleanup, hashing, source checks and the final report.
export async function runRelationChecks(specifications, execute, { budgetMs = 150000, now = Date.now, cleanup = async () => {} } = {}) {
  const checks = [], deadline = now() + budgetMs;
  let budgetExpired = false;
  try {
    for (const specification of specifications) {
      const remaining = deadline - now();
      if (remaining <= 0) { budgetExpired = true; break; }
      const execution = await execute(specification, Math.min(specification.timeoutMs, remaining));
      checks.push({ name: specification.name, execution });
      if (execution.timedOut || execution.interrupted || execution.signal != null || execution.testComplete === false) break;
    }
    return { checks, budgetExpired };
  } finally { await cleanup(); }
}
const requiredChecks = (id, nodeOnly) => id === 'HW-05-02' ? ['source-integrity'] :
  id === 'HW-05-03' ? ['source-integrity', 'http-results', ...(nodeOnly ? [] : ['browser'])] : nodeOnly ? [] : ['browser'];
export function summarizeRelationResults({ results, checks, target, required, artifactsValid, release, sourceStable, nodeOnly = false, budgetExpired = false }) {
  const execution = relationExecution(checks);
  execution.timedOut ||= budgetExpired;
  const expected = nodeOnly ? ['source-integrity', 'http-results'] : ['source-integrity', 'http-results', 'browser'];
  execution.complete &&= sourceStable && !budgetExpired && expected.every(name => checks.some(check => check.name === name));
  // A failed browser must not rewrite an independently completed SQLite result.
  // Each shared gate sees only the execution scope that produced its property.
  const template = summarize({ results: [], target, required, release, execution, artifactsValid: [] });
  const summaries = required.map(id => {
    const matches = results.map((result, index) => ({ result, index })).filter(({ result }) => result.property?.id === id);
    const names = requiredChecks(id, nodeOnly);
    const applicable = checks.filter(check => names.includes(check.name));
    const scoped = relationExecution(applicable);
    scoped.complete &&= sourceStable && applicable.length === names.length;
    return summarize({ results: matches.map(match => match.result), target, required: [id], release, execution: scoped,
      artifactsValid: matches.map(match => artifactsValid[match.index]) });
  });
  const rows = summaries.flatMap(summary => summary.rows);
  const summary = { ...template, rows,
    ok: execution.complete && execution.code === 0 && summaries.every(summary => summary.ok),
    coverage: template.coverage.map(property => ({ ...property, ...(rows.find(row => row.id === property.id) || {}) })) };
  return { execution, summary };
}
