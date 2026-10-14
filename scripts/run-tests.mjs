import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './lib/process.mjs';

import { findNodeTests, sourceSnapshot, sameSourceSnapshot, executionEnvironment } from './lib/runner-evidence-contract.mjs';
import { digest } from './lib/verification-evidence.mjs';
import { readFile } from 'node:fs/promises';

const files = process.argv.length > 2 ? process.argv.slice(2) : await findNodeTests();
if (!files.length) throw new Error('No test files selected');
const directory = process.env.TEST_EVIDENCE_DIR || 'test-evidence';
await mkdir(directory, { recursive: true });
const sourceStart = await sourceSnapshot(), { sha, dirty } = sourceStart.source;
const metadata = executionEnvironment();
const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
const results = [];
await writeFile(path.join(directory, 'results.json'), JSON.stringify({ schemaVersion: 2, sha, dirty, sourceStart, ...metadata, complete: false, ok: false, results }));
let next = 0, stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
// Bounded concurrency keeps local provider fixtures predictable on small CI runners.
await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
  while (next < files.length && !stopping) {
    const file = files[next++], log = path.join(directory, file.replaceAll(/[\\/]/g, '_') + '.log');
    console.log(`START ${file}`);
    const result = await runProcess(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=30000', file], { env: childEnv, logFile: log, timeoutMs: 90000 });
    results.push({ file, log, logSha256: digest(await readFile(log)), ...result });
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${file} (${result.durationMs}ms)${result.timedOut ? ' — file watchdog expired' : ''}`);
    if (!result.ok) console.error(result.tail);
    await writeFile(path.join(directory, 'results.json'), JSON.stringify({ schemaVersion: 2, sha, dirty, sourceStart, ...metadata, complete: false, ok: false, results }, null, 2));
  }
}));
process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
const sourceEnd = await sourceSnapshot();
const complete = results.length === files.length && !stopping && sameSourceSnapshot(sourceStart, sourceEnd);
const report = { schemaVersion: 2, sha, dirty, sourceStart, sourceEnd, ...metadata, complete,
  ok: complete && results.every(result => result.ok), selected: files.length, passed: results.filter(result => result.ok).length, results };
await writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2));
console.log(`Test files: ${report.passed}/${files.length} passed; complete=${complete}. Evidence: ${directory}/results.json`);
process.exitCode = report.ok ? 0 : 1;
