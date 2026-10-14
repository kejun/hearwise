import assert from 'node:assert/strict';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { releaseEvidence } from './lib/release-evidence.mjs';
import { sourceVersion, writeJson, digest } from './lib/verification-evidence.mjs';
const values = {};
for (const arg of process.argv.slice(2)) { const match = arg.match(/^--(relation|revision|output)=(.+)$/); if (!match || values[match[1]]) throw new Error('Expected --relation=DIR --revision=DIR --output=DIR'); values[match[1]] = match[2]; }
if (!values.relation || !values.revision || !values.output) throw new Error('Two real report directories and output root required');
await mkdir(values.output, { recursive: true }); const directory = await mkdtemp(path.join(values.output, 'release-demo-'));
const manifest = relation => ({ schemaVersion: 1, evidence: [{ suite: 'relation-protocol', directory: path.resolve(relation) }, { suite: 'revision', directory: path.resolve(values.revision) }] });
const source = sourceVersion();
const options = { purpose: 'foundation-demo', profile: 'fast', base: sourceVersion().sha, release: true };
const success = await releaseEvidence(manifest(values.relation), options); await writeJson(path.join(directory, 'success.json'), success);
assert.equal(success.ok, true, 'Success demo requires the actual current clean Quint/replay and Lean/bridge reports'); assert.equal(success.fullProjectAcceptance, false);
const corrupt = path.join(directory, 'corrupt-copy'), missing = path.join(directory, 'incomplete-copy');
await cp(values.relation, corrupt, { recursive: true }); await cp(values.relation, missing, { recursive: true });
// Deliberately damaged copies test the reader; they are not new checker runs.
const reportFile = path.join(corrupt, 'report.json'), report = JSON.parse(await readFile(reportFile, 'utf8'));
const row = report.results.find(row => row.id === 'implementation-regressions');
const log = (await readFile(path.join(corrupt, row.log), 'utf8')).replace(/^# pass \d+$/m, '# pass 0');
await writeFile(path.join(corrupt, row.log), log); report.artifacts.find(item => item.path === row.log).sha256 = digest(log);
row.status = 'failed'; row.execution.code = 1; row.execution.ok = false; await writeJson(reportFile, report);
const partialFile = path.join(missing, 'report.json'), partial = JSON.parse(await readFile(partialFile, 'utf8'));
partial.complete = false; partial.execution.complete = false; partial.execution.timedOut = true; await writeJson(partialFile, partial);
assert.deepEqual(sourceVersion(), source, 'Demo output must be outside the checkout or in an ignored evidence directory');
const failed = await releaseEvidence(manifest(corrupt), options), incomplete = await releaseEvidence(manifest(missing), options);
assert.equal(failed.ok, false); assert.equal(failed.status, 'failed'); assert.equal(incomplete.ok, false); assert.equal(incomplete.status, 'incomplete');
await writeJson(path.join(directory, 'failed.json'), failed); await writeJson(path.join(directory, 'incomplete.json'), incomplete);
await writeJson(path.join(directory, 'demonstration.json'), { source: sourceVersion(), success: true, failedRejected: true, incompleteRejected: true,
  fullProjectAcceptance: false, boundary: 'Success uses actual reports. Failure and timeout flags are explicit controlled corruptions of isolated copies, not claims of additional model execution.' });
console.log(directory);
