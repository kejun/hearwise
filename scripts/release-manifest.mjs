import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sourceVersion, writeJson } from './lib/verification-evidence.mjs';
import { technicalSuites } from '../verification/release/policy.mjs';
const args = Object.fromEntries(process.argv.slice(2).map(arg => { const match = arg.match(/^--(artifact-root|output|source)=(.+)$/); if (!match) throw new Error('Expected --artifact-root=DIR --output=FILE [--source=SHA]'); return match.slice(1); }));
if (!args['artifact-root'] || !args.output) throw new Error('Artifact root and output are required');
const source = sourceVersion().sha;
if (args.source && args.source !== source) throw new Error('Artifact source must match the current checkout');
const root = path.resolve(args['artifact-root']);
const artifact = name => path.join(root, `${name}-evidence-${source}`);
async function reports(directory, filename = 'report.json') {
  const files = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Artifact symlinks are forbidden');
      if (entry.isDirectory()) files.push(...await reports(file, filename));
      else if (entry.isFile() && entry.name === filename) files.push(file);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return files;
}
const evidence = [];
for (const suite of technicalSuites) {
  if (suite === 'node' || suite === 'browser') { evidence.push({ suite, directory: suite === 'node' ? path.join(artifact('test'), 'test-evidence') : artifact('browser') }); continue; }
  const directory = suite === 'import-atomicity' ? path.join(artifact('test'), 'verification-evidence', 'import-atomicity') : suite === 'semantic-offline' ? path.join(artifact('test'), 'verification-evidence', 'semantic-quality') : suite === 'quality-offline' ? path.join(artifact('test'), 'verification-evidence', 'asr-translation-quality') : suite === 'pilot' ? path.join(artifact('test'), 'verification-evidence') : artifact(suite);
  const candidates = [];
  for (const file of await reports(directory, suite === 'semantic-offline' ? 'summary.json' : suite === 'quality-offline' ? 'offline-summary.json' : 'report.json')) {
    // Every semantic/atomicity/upgrade attempt is mandatory, including malformed reports.
    if (['semantic-offline', 'import-atomicity', 'install-upgrade'].includes(suite)) { candidates.push(path.dirname(file)); continue; }
    let report; try { report = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    if (suite !== 'pilot' || report.profile === 'pilot') candidates.push(path.dirname(file));
  }
  evidence.push({ suite, directory: candidates[0] || directory, ...(candidates.length !== 1 ? { discoveryError: candidates.length ? 'ambiguous_report_artifacts' : 'missing_report_artifact' } : {}) });
}
await writeJson(args.output, { schemaVersion: 1, source, evidence });
