import { readFile, writeFile } from 'node:fs/promises';
import { collectBrowserSamples, validateBrowserEvidence } from '../test-support/performance-browser.mjs';

const [input, output] = process.argv.slice(2), controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
let result;
try {
  if (!input || !output) throw new Error('Expected MANIFEST.json OUTPUT.json');
  const manifest = JSON.parse(await readFile(input, 'utf8'));
  result = await collectBrowserSamples(manifest, { signal: controller.signal });
  result.evidenceValidation = validateBrowserEvidence(result, manifest);
  if (!result.evidenceValidation.valid) { result.complete = false; if (result.status === 'collected') result.status = 'incomplete'; }
} catch (error) {
  result = { schemaVersion: 1, component: 'browser', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    complete: false, status: 'not_run', environment: { actualVersion: null }, cases: [],
    errors: [{ name: error.name, message: error.message }], cleanup: { complete: true, browserClosed: true, contextsClosed: 0 } };
} finally {
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ component: 'browser', complete: result.complete, status: result.status, cases: result.cases.length, errors: result.errors }));
if (!result.complete) process.exitCode = 3;
