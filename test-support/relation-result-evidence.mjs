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
export async function runRelationChecks(specifications, execute, { cleanup = async () => {} } = {}) {
  const checks = [];
  try {
    for (const specification of specifications) {
      const execution = await execute(specification, specification.timeoutMs);
      checks.push({ name: specification.name, execution });
      if (execution.interrupted) break;
    }
    return { checks, budgetExpired: false };
  } finally { await cleanup(); }
}
export function summarizeRelationResults({ results, checks, target, required, artifactsValid, release, sourceStable }) {
  const execution = relationExecution(checks);
  if (!sourceStable) execution.complete = false;
  return { execution, summary: summarize({ results, target, required, artifactsValid, release, execution }) };
}
