import path from 'node:path';
import { readManifest, releaseEvidence } from './lib/release-evidence.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
const args = process.argv.slice(2), values = {};
for (const arg of args) {
  const match = arg.match(/^--(purpose|profile|base|manifest|output)=(.+)$/);
  if (!match || Object.hasOwn(values, match[1])) throw new Error('Usage: node scripts/release-gate.mjs --purpose=pr|release|foundation-demo --manifest=FILE [--profile=fast|deep] [--base=SHA] [--output=FILE]');
  values[match[1]] = match[2];
}
if (!values.purpose || !values.manifest) throw new Error('Explicit purpose and manifest required');
const result = await releaseEvidence(await readManifest(values.manifest), { purpose: values.purpose, profile: values.profile || 'fast', base: values.base || 'origin/main', directory: path.dirname(path.resolve(values.manifest)) });
if (values.output) await writeJson(values.output, result);
console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
