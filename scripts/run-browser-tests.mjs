import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runProcess } from './lib/process.mjs';

const checks = ['speech', 'speech-seek', 'graph', 'relation-progress', 'trace', 'transcript', 'knowledge-edit', 'data-transfer', 'knowledge-name'];
const selected = process.argv.slice(2);
if (selected.some(name => !checks.includes(name))) throw new Error(`Unknown browser check; choose ${checks.join(', ')}`);
const directory = process.env.BROWSER_EVIDENCE_DIR || 'browser-evidence';
await mkdir(directory, { recursive: true });
const evidenceDirectory = await mkdtemp(path.join(directory, 'run-'));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim());
const results = [];
await writeFile(`${directory}/results.json`, JSON.stringify({ sha, dirty, evidenceDirectory, complete: false, ok: false, results }));
for (const name of selected.length ? selected : checks) {
  console.log(`START browser:${name}`);
  const result = await runProcess(process.execPath, [`scripts/verify-${name}-browser.mjs`], {
    timeoutMs: 180000, logFile: `${evidenceDirectory}/${name}.log`, onOutput: text => process.stdout.write(text),
    env: { ...process.env, SPEECH_SEEK_EVIDENCE_DIR: evidenceDirectory, KNOWLEDGE_EDIT_EVIDENCE_DIR: evidenceDirectory,
      GRAPH_EVIDENCE_DIR: evidenceDirectory, DATA_TRANSFER_EVIDENCE_DIR: evidenceDirectory, TRACE_EVIDENCE_DIR: evidenceDirectory,
      TRANSCRIPT_EVIDENCE_DIR: evidenceDirectory, KNOWLEDGE_NAME_EVIDENCE_DIR: evidenceDirectory }
  });
  results.push({ name, log: `${evidenceDirectory}/${name}.log`, ...result });
  await writeFile(`${directory}/results.json`, JSON.stringify({ sha, dirty, evidenceDirectory,
    complete: results.length === (selected.length || checks.length), ok: results.length === (selected.length || checks.length) && results.every(row => row.ok), results }, null, 2));
  if (!result.ok) { process.exitCode = 1; break; }
}
