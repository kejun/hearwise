import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { profile, requiredSteps, requiredArtifacts, gate } from '../verification/revision/profile.mjs';
import { sourceVersion, writeJson, digest, checkArtifacts } from './lib/verification-evidence.mjs';
import { runProcess } from './lib/process.mjs';
import { tapMetrics } from './lib/tap-summary.mjs';
import { revisionSources as sources } from './lib/lean-source-files.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--release')) throw new Error('Usage: npm run verify:revision -- [--release]');
const root = path.resolve(process.env.REVISION_EVIDENCE_DIR || 'revision-evidence');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'run-'));
const leanDirectory = path.resolve('verification/lean');
const profileDigest = digest(JSON.stringify(profile));
const report = { schemaVersion: 1, profileVersion: profile.version, profileDigest, profile, source: sourceVersion(),
  startedAt: new Date().toISOString(), finishedAt: null, complete: false, interrupted: false, ok: false,
  tools: { node: process.version, sqlite: process.versions.sqlite, lean: null, lake: null },
  environment: { platform: process.platform, arch: process.arch, release: os.release() },
  sourceDigests: {}, steps: requiredSteps.map(name => ({ name, status: 'not_run' })), artifacts: [] };
const save = () => writeJson(path.join(directory, 'report.json'), report);
const stop = () => { report.interrupted = true; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
await save();
console.log(`Revision evidence: ${directory}`);
const deadline = Date.now() + 360000;
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT; // Node's runner marker can silently suppress nested node --test runs.
try {
  for (const file of sources) report.sourceDigests[file] = digest(await readFile(file));
  for (const file of ['Revision.lean', 'Main.lean', 'AxiomAudit.lean']) {
    const text = await readFile(path.join(leanDirectory, file), 'utf8');
    if (/\b(sorry|admit|sorryAx|native_decide|axiom)\b/.test(text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''))) {
      throw new Error(`Forbidden unfinished proof or custom axiom declaration in ${file}`);
    }
  }
  const stages = [
    ['lean-version', process.env.LEAN_BIN || 'lean', ['--version'], leanDirectory, 15000],
    ['lake-version', process.env.LAKE_BIN || 'lake', ['--version'], leanDirectory, 15000],
    ['proof-build', process.env.LAKE_BIN || 'lake', ['build'], leanDirectory, 120000],
    ['axiom-audit', process.env.LAKE_BIN || 'lake', ['env', 'lean', 'AxiomAudit.lean'], leanDirectory, 30000],
    ['differential', process.execPath, ['verification/revision/differential.mjs', directory], process.cwd(), 90000],
    ['legacy-regression', process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=30000', 'test/knowledge-revision.test.mjs'], process.cwd(), 90000]
  ];
  for (const [name, command, commandArgs, cwd, budget] of stages) {
    if (report.interrupted) break;
    const execution = await runProcess(command, commandArgs, { cwd, env: childEnv, logFile: path.join(directory, `${name}.log`),
      timeoutMs: Math.max(1, Math.min(budget, deadline - Date.now())) });
    const step = report.steps.find(step => step.name === name);
    Object.assign(step, { execution, status: execution.ok ? 'passed' : execution.error?.includes('ENOENT') ? 'not_run' :
      execution.timedOut || execution.interrupted || execution.signal ? 'incomplete' : 'failed' });
    if (name === 'lean-version') {
      report.tools.lean = execution.tail.trim();
      if (execution.ok && (!report.tools.lean.includes(`version ${profile.lean},`) || !report.tools.lean.includes(profile.leanCommit))) step.status = 'failed';
    }
    if (name === 'lake-version') {
      report.tools.lake = execution.tail.trim();
      if (execution.ok && !report.tools.lake.includes(`Lean version ${profile.lean}`)) step.status = 'failed';
    }
    if (name === 'legacy-regression') {
      const log = await readFile(path.join(directory, 'legacy-regression.log'), 'utf8');
      report.legacy = tapMetrics(log);
      if (step.status === 'passed' && !(report.legacy.tapComplete && report.legacy.tests >= 8 &&
          report.legacy.passed === report.legacy.tests && report.legacy.failed === 0)) step.status = 'failed';
    }
    await save();
    if (step.status !== 'passed') break;
  }
  if (report.steps.find(step => step.name === 'axiom-audit').status === 'passed') {
    const audits = (await readFile(path.join(leanDirectory, 'AxiomAudit.lean'), 'utf8')).split('\n')
      .filter(line => line.startsWith('/-- info: ')).map(line => line.slice(10, -3).trim());
    if (audits.length !== profile.properties[0].theorems.length) throw new Error('Axiom roster is incomplete');
    await writeJson(path.join(directory, 'axioms.json'), { complete: true, method: 'Lean #guard_msgs over transitive #print axioms', audits });
  }
  try { report.differential = JSON.parse(await readFile(path.join(directory, 'differential.json'), 'utf8')); } catch { /* Not run or interrupted. */ }
} catch (error) {
  report.error = error.stack;
} finally {
  await rm(path.join(directory, 'temporary-database'), { recursive: true, force: true });
  await rm(path.join(directory, 'temporary-mutants'), { recursive: true, force: true });
  for (const name of requiredArtifacts) {
    try { report.artifacts.push({ path: name, sha256: digest(await readFile(path.join(directory, name))) }); }
    catch { /* Missing evidence remains visible and fails the gate. */ }
  }
  report.finishedAt = new Date().toISOString();
  report.complete = !report.error && !report.interrupted && report.legacy?.tapComplete === true && report.steps.every(step => step.execution &&
    !step.execution.timedOut && !step.execution.interrupted && step.execution.signal == null && step.execution.code != null);
  report.summary = gate(report, { target: sourceVersion(), release: args.includes('--release'), profileDigest,
    artifactsValid: await checkArtifacts(directory, report) });
  report.ok = report.summary.ok;
  await save();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, summary: report.summary }, null, 2));
process.exitCode = report.ok ? 0 : 1;
