import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { runProcess } from './lib/process.mjs';

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory() ? findTests(path.join(directory, entry.name)) :
    /\.test\.[cm]?js$/.test(entry.name) ? [path.join(directory, entry.name)] : []));
  return files.flat().sort();
}
const files = process.argv.length > 2 ? process.argv.slice(2) : await findTests('test');
if (!files.length) throw new Error('No test files selected');
const directory = process.env.TEST_EVIDENCE_DIR || 'test-evidence';
await mkdir(directory, { recursive: true });
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim());
const results = [];
await writeFile(path.join(directory, 'results.json'), JSON.stringify({ sha, dirty, complete: false, ok: false, results }));
let next = 0, stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
// Bounded concurrency keeps local provider fixtures predictable on small CI runners.
await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
  while (next < files.length && !stopping) {
    const file = files[next++], log = path.join(directory, file.replaceAll(/[\\/]/g, '_') + '.log');
    console.log(`START ${file}`);
    const result = await runProcess(process.execPath, ['--test', '--test-timeout=30000', file], { logFile: log, timeoutMs: 90000 });
    results.push({ file, log, ...result });
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${file} (${result.durationMs}ms)${result.timedOut ? ' — file watchdog expired' : ''}`);
    if (!result.ok) console.error(result.tail);
    await writeFile(path.join(directory, 'results.json'), JSON.stringify({ sha, dirty, complete: false, ok: false, results }, null, 2));
  }
}));
process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
const complete = results.length === files.length && !stopping;
const report = { sha, dirty, complete,
  ok: complete && results.every(result => result.ok), selected: files.length, passed: results.filter(result => result.ok).length, results };
await writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2));
console.log(`Test files: ${report.passed}/${files.length} passed; complete=${complete}. Evidence: ${directory}/results.json`);
process.exitCode = report.ok ? 0 : 1;
