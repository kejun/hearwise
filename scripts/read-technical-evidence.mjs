import { readTechnicalEvidence } from './lib/release-evidence.mjs';
import { historicalBindings } from './lib/historical-release-evidence.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
const [suite, directory, output, profile] = process.argv.slice(2);
if (!suite || !directory || !output || !['fast', 'deep'].includes(profile)) throw new Error('Expected suite, evidence directory, output file and fixed profile');
const verdict = await readTechnicalEvidence(suite, directory, { release: true, profile });
const bindings = await historicalBindings(suite, profile);
await writeJson(output, { verdict, bindings }); process.exitCode = verdict.ok ? 0 : 1;
