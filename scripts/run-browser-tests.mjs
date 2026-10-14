import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './lib/process.mjs';

import { browserChecks as checks, rootScreenshots, sourceSnapshot, sameSourceSnapshot, executionEnvironment, evidenceFiles, hashEvidenceFiles } from './lib/runner-evidence-contract.mjs';
const selected = process.argv.slice(2);
if (selected.some(name => !checks.includes(name))) throw new Error(`Unknown browser check; choose ${checks.join(', ')}`);
const directory = process.env.BROWSER_EVIDENCE_DIR || 'browser-evidence';
await mkdir(directory, { recursive: true });
const evidenceDirectory = await mkdtemp(path.join(directory, 'run-'));
const sourceStart = await sourceSnapshot(), { sha, dirty } = sourceStart.source;
const metadata = executionEnvironment();
const screenshotEnv = Object.fromEntries(Object.entries(rootScreenshots).map(([key, file]) => [key, process.env[key] || path.join(directory, file)]));
const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
const results = [];
await writeFile(`${directory}/results.json`, JSON.stringify({ schemaVersion: 2, sha, dirty, sourceStart, ...metadata, evidenceDirectory, complete: false, ok: false, artifacts: [], results }));
for (const name of selected.length ? selected : checks) {
  console.log(`START browser:${name}`);
  const result = await runProcess(process.execPath, [`scripts/verify-${name}-browser.mjs`], {
    timeoutMs: 180000, logFile: `${evidenceDirectory}/${name}.log`, onOutput: text => process.stdout.write(text),
    env: { ...childEnv, ...screenshotEnv, SPEECH_SEEK_EVIDENCE_DIR: evidenceDirectory, KNOWLEDGE_EDIT_EVIDENCE_DIR: evidenceDirectory,
      GRAPH_EVIDENCE_DIR: evidenceDirectory, DATA_TRANSFER_EVIDENCE_DIR: evidenceDirectory, TRACE_EVIDENCE_DIR: evidenceDirectory,
      TRANSCRIPT_EVIDENCE_DIR: evidenceDirectory, KNOWLEDGE_NAME_EVIDENCE_DIR: evidenceDirectory,
      KNOWLEDGE_REVISION_EVIDENCE_DIR: evidenceDirectory, SESSION_EVIDENCE_DIR: evidenceDirectory, RELATION_RESULT_EVIDENCE_DIR: evidenceDirectory }
  });
  results.push({ name, argv: [`scripts/verify-${name}-browser.mjs`], log: `${evidenceDirectory}/${name}.log`, ...result });
  await writeFile(`${directory}/results.json`, JSON.stringify({ schemaVersion: 2, sha, dirty, sourceStart, ...metadata, evidenceDirectory,
    complete: false, ok: false, artifacts: [], results }, null, 2));
  if (!result.ok) { process.exitCode = 1; break; }
}

const sourceEnd = await sourceSnapshot();
const runPrefix = path.basename(evidenceDirectory) + '/';
const artifacts = await hashEvidenceFiles(directory, (await evidenceFiles(directory)).filter(file => file.startsWith(runPrefix) || Object.values(rootScreenshots).includes(file)));
const complete = results.length === (selected.length || checks.length) && sameSourceSnapshot(sourceStart, sourceEnd);
const report = { schemaVersion: 2, sha, dirty, sourceStart, sourceEnd, ...metadata, evidenceDirectory, complete,
  ok: complete && results.every(row => row.ok), artifacts, results };
await writeFile(`${directory}/results.json`, JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.ok ? 0 : 1;
