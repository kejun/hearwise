import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, writeJson, checkArtifacts } from '../scripts/lib/verification-evidence.mjs';
import { summarizeChecks } from '../scripts/lib/verification-checks.mjs';
export { tapSummary, runChecks } from '../scripts/lib/verification-checks.mjs';
export const editScenarios = ['conflict', 'unknown-502', 'unknown-lost', 'rollback', 'late-success'];
export const editBrowserAssets = ['browser.json', ...[1280, 390].flatMap(width => editScenarios.map(name => `edits-${width}-${name}.png`)), 'edits-390-auto-resend-negative.png'];
const hashFiles = (directory, names) => Promise.all(names.map(async name => ({ path: name, sha256: digest(await readFile(path.join(directory, name))) })));
export const editRequiredChecks = (id, nodeOnly = false) => {
  const names = id === 'HW-06-06' ? ['http', 'browser'] : id === 'HW-06-07' ? ['http', 'notification', 'browser'] : id === 'HW-11-04' ? ['browser'] : null;
  if (!names) throw new Error(`Unknown edit property ${id}`);
  return names.filter(name => !nodeOnly || name !== 'browser');
};
export async function writeEditEvidence(directory, observations) {
  const names = observations.browser?.complete ? editBrowserAssets : (await readdir(directory)).filter(name => name.endsWith('.png') || name === 'browser.json');
  await writeJson(path.join(directory, 'observations.json'), { ...observations, attachments: await hashFiles(directory, names) });
  await writeFile(path.join(directory, 'worker.log'), (await Promise.all(observations.checks.map(async ({ name }) => `CHECK ${name}\n${await readFile(path.join(directory, name + '.log'), 'utf8')}`))).join('\n'));
  return hashFiles(directory, ['observations.json', 'worker.log']);
}
export async function checkEditEvidence(directory, result) {
  if (!await checkArtifacts(directory, result)) return false;
  try {
    const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8')), references = observations.attachments;
    if (!Array.isArray(references) || new Set(references.map(item => item?.path)).size !== references.length) return false;
    if (observations.browser?.complete) {
      const browser = JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8'));
      if (!isDeepStrictEqual(browser, observations.browser) || browser.ok !== true || !isDeepStrictEqual(browser.widths?.map(row => row.width), [1280, 390]) ||
        browser.widths.some(row => !isDeepStrictEqual(row.results?.map(result => result.scenario), editScenarios) || row.results.some(result => result.complete !== true || result.ok !== true)) ||
        browser.negative?.complete !== true || browser.negative.classification !== 'implementation_mismatch' || browser.negative.property !== 'HW-06-06' ||
        browser.negative.counterexample?.writes !== 2 || browser.negative.counterexample?.explicitSaves !== 1 || browser.negative.counterexample?.persistedName !== 'Mira' ||
        references.length !== editBrowserAssets.length || editBrowserAssets.some(name => references.filter(item => item?.path === name).length !== 1)) return false;
    }
    return references.length === 0 || await checkArtifacts(directory, { artifacts: references });
  } catch { return false; }
}
export function summarizeEditResults(options) {
  const { nodeOnly = false } = options;
  return summarizeChecks({ ...options, expectedChecks: ['notification', 'http', ...(nodeOnly ? [] : ['browser'])],
    checksForProperty: id => editRequiredChecks(id, nodeOnly) });
}
