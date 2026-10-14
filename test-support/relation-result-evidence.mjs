import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, writeJson, checkArtifacts } from '../scripts/lib/verification-evidence.mjs';

export async function writeRelationResultEvidence(directory, observations) {
  await writeJson(path.join(directory, 'observations.json'), observations);
  await writeFile(path.join(directory, 'worker.log'), (await Promise.all(observations.checks.map(async ({ name }) =>
    `CHECK ${name}\n${await readFile(path.join(directory, `${name}.log`), 'utf8')}`))).join('\n'));
  const names = ['observations.json', 'worker.log', ...(await readdir(directory)).filter(name => name.endsWith('.png') || name === 'browser.json')];
  return Promise.all(names.map(async name => ({ path: name, sha256: digest(await readFile(path.join(directory, name))) })));
}
export const checkRelationResultEvidence = checkArtifacts;
