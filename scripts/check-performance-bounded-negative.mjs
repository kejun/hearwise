// Reader negative controls on actual collected artifacts, never new measurements.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compareBoundedDirectories } from './lib/performance-bounded.mjs';
const [input] = process.argv.slice(2);
if (!input) throw new Error('Expected completed PAIR_DIRECTORY');
const pair = JSON.parse(await readFile(path.join(input, 'pair.json'), 'utf8'));
const policy = JSON.parse(await readFile(path.join(input, pair.policy), 'utf8'));
const baseline = path.join(input, pair.baseline), candidate = path.join(input, pair.candidate);
assert.equal((await compareBoundedDirectories(baseline, candidate, policy)).evidenceValid, true, 'Positive original control must pass first');
const tests = [
  ['timeout', report => { report.execution.timedOut = true; }],
  ['missing case', report => { report.cases.pop(); }],
  ['changed environment', report => { report.environmentDigest = '0'.repeat(64); }],
  ['changed frozen import', report => { report.inputDatabaseDigests['small-import'] = '0'.repeat(64); }],
  ['posthoc policy', report => { report.policyAtStart.digest = '0'.repeat(64); }],
  ['summary-only inflation', report => { report.cases.find(row => row.status === 'collected').samples[0].metrics.wallMs += 1000; }],
  ['forged pass', report => { report.performancePassed = true; }]
];
const outcomes = [];
for (const [name, mutate] of tests) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bounded-negative-'));
  try {
    await cp(candidate, directory, { recursive: true });
    const file = path.join(directory, 'report.json'), report = JSON.parse(await readFile(file, 'utf8')); mutate(report);
    await writeFile(file, JSON.stringify(report));
    const result = await compareBoundedDirectories(baseline, directory, policy);
    assert.equal(result.evidenceValid, false, name); assert.equal(result.passed, false, name);
    outcomes.push({ name, rejected: true, reason: result.reason, detail: result.detail });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
await writeFile(path.join(input, 'negative-controls.json'), JSON.stringify({ actualArtifactNegativeControls: true, outcomes }, null, 2) + '\n');
console.log(JSON.stringify({ rejected: outcomes.length, total: tests.length }));
