import { nodeTestArgv } from './lib/node-test-evidence.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runTestSchedule } from './lib/test-schedule.mjs';
import { runProcess } from './lib/process.mjs';

import { findNodeTests, sourceSnapshot, sameSourceSnapshot, validBuildSource, executionEnvironment } from './lib/runner-evidence-contract.mjs';
import { digest } from './lib/verification-evidence.mjs';
import { readFile } from 'node:fs/promises';

const files = process.argv.length > 2 ? process.argv.slice(2) : await findNodeTests();
if (!files.length) throw new Error('No test files selected');
const directory = process.env.TEST_EVIDENCE_DIR || 'test-evidence';
await mkdir(directory, { recursive: true });
const sourceStart = await sourceSnapshot(), { sha, dirty } = sourceStart.source;
const metadata = executionEnvironment();
if (!validBuildSource(sourceStart)) throw new Error('Build source differs from checkout; run npm run build before testing');
const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
const results = [];
await writeFile(path.join(directory, 'results.json'), JSON.stringify({ schemaVersion: 2, sha, dirty, sourceStart, ...metadata, complete: false, ok: false, results }));
let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
// Nested profile/Quint workers run alone instead of multiplying the outer
// concurrency by each profile's internal child processes.
console.log(`Test environment: ${JSON.stringify({ availableParallelism: os.availableParallelism(), load: os.loadavg(), totalMemory: os.totalmem(), freeMemory: os.freemem() })}`);
await runTestSchedule(files, async (file, plan) => {
  const log = path.join(directory, file.replaceAll(/[\\/]/g, '_') + '.log');
  const startedAt = new Date().toISOString();
  console.log(`START ${file}${plan.exclusive ? ' [exclusive nested processes]' : ''}`);
  const events = log + '.events.ndjson', argv = nodeTestArgv(file, events);
  const result = await runProcess(process.execPath, argv, { env: childEnv, logFile: log, timeoutMs: plan.timeoutMs });
  const finishedAt = new Date().toISOString();
  let eventsSha256 = null; try { eventsSha256 = digest(await readFile(events)); } catch { /* Missing reporter output is incomplete evidence. */ }
  results.push({ file, log, argv, events, eventsSha256, logSha256: digest(await readFile(log)), startedAt, finishedAt, scheduling: plan, ...result });
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${file} (${result.durationMs}ms)${result.timedOut ? ' — file watchdog expired' : ''}`);
  if (!result.ok) console.error(result.tail);
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({ schemaVersion: 2, sha, dirty, sourceStart, ...metadata, complete: false, ok: false, results }, null, 2));
}, { stopped: () => stopping });
process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
const sourceEnd = await sourceSnapshot();
const complete = results.length === files.length && !stopping && sameSourceSnapshot(sourceStart, sourceEnd) && validBuildSource(sourceEnd);
const report = { schemaVersion: 2, sha, dirty, sourceStart, sourceEnd, ...metadata, complete,
  ok: complete && results.every(result => result.ok), selected: files.length, passed: results.filter(result => result.ok).length, results };
await writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2));
console.log(`Test files: ${report.passed}/${files.length} passed; complete=${complete}. Evidence: ${directory}/results.json`);
process.exitCode = report.ok ? 0 : 1;
