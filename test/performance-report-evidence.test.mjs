import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validatePerformanceEvidence, performanceMeasurementDigest } from '../scripts/lib/performance-evidence.mjs';
import { fileSha256, performanceRoot } from '../scripts/lib/performance-files.mjs';

test('actual incomplete collection stays incomplete and rehashed report corruptions fail closed', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'performance-report-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, PERFORMANCE_EVIDENCE_DIR: directory }; delete env.NODE_TEST_CONTEXT;
  const prepare = spawnSync(process.execPath, ['scripts/prepare-performance.mjs', directory, 'smoke'], { cwd: performanceRoot, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(prepare.status, 0, prepare.stdout + prepare.stderr);
  const fixture = JSON.parse(prepare.stdout.trim().split('\n').at(-1)).path;
  const collect = spawnSync(process.execPath, ['scripts/collect-performance.mjs', fixture, 'smoke', '--skip-browser'], { cwd: performanceRoot, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(collect.status, 3, collect.stdout + collect.stderr);
  const reportFile = JSON.parse(collect.stdout.trim().split('\n').at(-1)).path, source = path.dirname(reportFile);
  const inspected = await validatePerformanceEvidence(source, { requireComplete: false });
  assert.equal(inspected.valid, true, JSON.stringify(inspected)); assert.equal(inspected.collectionComplete, false); assert.equal(inspected.performanceEvaluated, false);
  assert.equal((await validatePerformanceEvidence(source)).valid, false, 'Missing real browser measurements cannot be accepted');
  assert.equal((await validatePerformanceEvidence(source, { release: true })).valid, false, 'Smoke is not the release collection');
  const mutations = [
    ['false performance pass', report => { report.performanceEvaluated = true; report.performancePassed = true; }],
    ['false collection completion', report => { report.collectionComplete = true; report.execution.code = 0; }],
    ['missing result', report => { report.results.pop(); }],
    ['missing artifacts', report => { report.artifacts.pop(); }],
    ['wrong source', report => { report.source.sha = 'a'.repeat(40); }],
    ['changed executed build', report => { report.runtimeBuild.git_sha = 'a'.repeat(40); }],
    ['wrong profile', report => { report.profile = 'baseline'; }],
    ['wrong sampling', report => { report.sampling.repetitions++; }],
    ['missing load', report => { delete report.conditions; }],
    ['wrong measurement version', report => { report.measurementDigest = '0'.repeat(64); }],
    ['wrong command source', report => { report.results[0].argv[0] = 'scripts/fake.mjs'; }],
    ['false quantile', report => { report.cases[0].statistics.wallMs.p95 = 0; }],
    ['wrong property roster', report => { report.propertyCoverage.pop(); }],
    ['raw counter rewrite', async (report, root) => {
      const file = report.results[0].output, location = path.join(root, file), raw = JSON.parse(await readFile(location, 'utf8'));
      raw.cases[0].samples[0].after.cpuUsage.user += 100000; await writeFile(location, JSON.stringify(raw));
      report.artifacts.find(row => row.path === file).sha256 = await fileSha256(location);
    }],
    ['wrong frozen scale', async (report, root) => {
      const file = report.datasets[0].manifest, location = path.join(root, file), raw = JSON.parse(await readFile(location, 'utf8'));
      raw.counts.nodes--; await writeFile(location, JSON.stringify(raw)); report.artifacts.find(row => row.path === file).sha256 = await fileSha256(location);
    }]
  ];
  const relocated = path.join(directory, 'relocated'); await cp(source, relocated, { recursive: true });
  assert.equal((await validatePerformanceEvidence(relocated, { requireComplete: false })).valid, true, 'Artifacts can move while recorded execution origin stays intact');
  for (const [index, [label, mutate]] of mutations.entries()) {
    const copy = path.join(directory, `mutant-${index}`); await cp(source, copy, { recursive: true });
    const report = JSON.parse(await readFile(path.join(copy, 'report.json'), 'utf8')); await mutate(report, copy);
    await writeFile(path.join(copy, 'report.json'), JSON.stringify(report));
    assert.equal((await validatePerformanceEvidence(copy, { requireComplete: false })).valid, false, label);
  }
});


test('measurement identity binds execution and cleanup helpers independently of product changes', () => {
  const helpers = ['scripts/lib/process.mjs', 'scripts/lib/verification-evidence.mjs', 'test-support/lifecycle.mjs'];
  const sources = Object.fromEntries([...helpers, 'scripts/collect-performance.mjs', 'server.mjs'].map(file => [file, 'a'.repeat(64)]));
  const baseline = performanceMeasurementDigest(sources);
  for (const helper of helpers) {
    assert.notEqual(performanceMeasurementDigest({ ...sources, [helper]: 'b'.repeat(64) }), baseline, helper);
    const missing = { ...sources }; delete missing[helper];
    assert.throws(() => performanceMeasurementDigest(missing), /Missing measurement dependency/, helper);
  }
  assert.equal(performanceMeasurementDigest({ ...sources, 'server.mjs': 'b'.repeat(64) }), baseline, 'The measured product may change between baseline and candidate');
});
