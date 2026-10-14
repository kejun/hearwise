import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
export async function nameMutation(directory, mutation) {
  const original = await readFile(new URL('../knowledge-name-replacement.mjs', import.meta.url), 'utf8');
  let changed = original;
  const replace = (before, after) => { assert.equal(changed.split(before).length, 2, 'Mutation must identify exactly one production guard'); changed = changed.replace(before, after); };
  if (mutation === 'bypass_fingerprint') replace('previous.fingerprint !== fingerprint(input)', 'false /* deliberately broken fingerprint check */');
  else if (mutation === 'non_atomic_receipt') {
    replace('return this.tx(() => {', 'return (() => {');
    replace('    });\n  }\n};', '    })();\n  }\n};');
  } else throw new Error('Unknown fixed name mutation');
  const runnable = changed.replace(/from '(\.\/.+?)'/g, (_all, specifier) => `from '${new URL('../' + specifier.slice(2), import.meta.url).href}'`);
  const filename = path.join(directory, `${mutation}.mjs`); await writeFile(filename, runnable);
  const methods = (await import(pathToFileURL(filename).href)).knowledgeNameReplacementMethods;
  class MutantStore extends ListeningStore {}
  Object.assign(MutantStore.prototype, methods);
  return { Store: MutantStore, evidence: { mutation, source: 'knowledge-name-replacement.mjs', sourceDigest: digest(original),
    mutatedDigest: digest(changed), runnableDigest: digest(runnable), executionRepositoryRoot: path.resolve('.'),
    boundary: 'Explicit isolated production-copy negative control; never installed in the application or claimed as a real defect.' } };
}
