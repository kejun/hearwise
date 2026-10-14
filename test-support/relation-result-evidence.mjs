import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, writeJson, checkArtifacts } from '../scripts/lib/verification-evidence.mjs';

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

export { tapSummary as relationTapSummary, checkExecution as relationExecution, runChecks as runRelationChecks } from '../scripts/lib/verification-checks.mjs';
import { summarizeChecks } from '../scripts/lib/verification-checks.mjs';

const requiredChecks = (id, nodeOnly) => id === 'HW-05-02' ? ['source-integrity'] :
  id === 'HW-05-03' ? ['source-integrity', 'http-results', ...(nodeOnly ? [] : ['browser'])] : nodeOnly ? [] : ['browser'];
export function summarizeRelationResults(options) {
  const { nodeOnly = false } = options;
  return summarizeChecks({ ...options,
    expectedChecks: ['source-integrity', 'http-results', ...(nodeOnly ? [] : ['browser'])],
    checksForProperty: id => requiredChecks(id, nodeOnly) });
}
