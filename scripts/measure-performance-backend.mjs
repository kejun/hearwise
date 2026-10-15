import { readFile, writeFile } from 'node:fs/promises';
import { collectBackendSamples } from '../test-support/performance-backend.mjs';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Expected MANIFEST.json OUTPUT.json');
const result = await collectBackendSamples(JSON.parse(await readFile(input, 'utf8')));
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ complete: result.complete, cases: result.cases.length, error: result.error }));
if (!result.complete) process.exitCode = 1;
