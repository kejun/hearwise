import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateSchedulerEvidence, loadSchedulerConfig, schedulerFiles, schedulerPlan, schedulerCommandBound, schedulerRegressionTestCount } from './scheduler-protocol-evidence.mjs';
import { validateTapTree } from './release-tap-evidence.mjs';
import { evidenceFiles, safeRelative } from './runner-evidence-contract.mjs';
import { sourceVersion } from './verification-evidence.mjs';
import regressionNames from '../../verification/release/scheduler-regressions.json' with { type: 'json' };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const interval = row => {
  const times = ['startedAt', 'finishedAt'].map(key => {
    assert.ok(typeof row[key] === 'string' && Number.isFinite(Date.parse(row[key])) && new Date(row[key]).toISOString() === row[key], 'invalid_scheduler_timestamp');
    return Date.parse(row[key]);
  });
  assert.ok(times[0] <= times[1], 'reversed_scheduler_interval'); return times;
};
// The domain validator owns TLC conclusions, trace/replay semantics, source and
// runtime binding. This adapter only adds release-level raw execution bindings.
export async function validateSchedulerReleaseContract(report, directory) {
  const config = await loadSchedulerConfig(), plan = schedulerPlan(config, await schedulerFiles());
  assert.ok(['fast', 'deep'].includes(report.profile));
  assert.equal(report.execution.timeoutMs, report.profile === 'deep' ? 1200000 : 900000, 'wrong_scheduler_profile_budget');
  assert.deepEqual(report.results.map(row => row.id), plan.map(row => row.id), 'wrong_scheduler_stage_order');
  const root = report.execution.repositoryRoot, evidenceRoot = path.dirname(path.dirname(report.results[0].cwd));
  assert.ok(path.isAbsolute(root) && path.normalize(root) === root);
  assert.ok(path.isAbsolute(evidenceRoot) && path.normalize(evidenceRoot) === evidenceRoot);
  assert.equal(path.basename(evidenceRoot), path.basename(directory), 'wrong_scheduler_output_directory');
  const disk = new Set(await evidenceFiles(directory)), artifacts = new Set(report.artifacts.map(row => row.path));
  for (const file of artifacts) assert.ok(safeRelative(file) && disk.has(file), 'missing_or_unsafe_scheduler_artifact');
  const asset = file => { assert.ok(safeRelative(file) && artifacts.has(file) && disk.has(file), `unbound_scheduler_artifact:${file}`); return path.join(directory, file); };
  const [started, finished] = interval(report); let previousEnd = started;
  for (const [index, row] of report.results.entries()) {
    const entry = plan[index], [start, end] = interval(row);
    assert.ok(start >= previousEnd && end <= finished, `scheduler_stage_interval:${row.id}`); previousEnd = end;
    assert.equal(row.kind, entry.kind); assert.equal(row.log, `${row.id}.log`); asset(row.log);
    if (['implementation-replay', 'implementation-negative'].includes(row.kind)) {
      assert.equal(row.data, `${row.id}.json`); const values = await json(asset(row.data)); assert.equal(row.samples, values.length);
      let replayEnd = start;
      for (const replay of values) {
        const [from, to] = interval(replay);
        assert.ok(from >= replayEnd && to <= end, `scheduler_replay_interval:${row.id}`); replayEnd = to;
      }
      assert.deepEqual(await json(asset(row.log)), values.map(value => ({ trace: value.sourceTrace, complete: value.complete, ok: value.ok, classification: value.classification })), 'scheduler_replay_log_binding');
    } else {
      assert.equal(row.cwd, row.kind === 'implementation-regression' ? root : path.join(evidenceRoot, 'work', row.id), 'wrong_scheduler_cwd');
      assert.equal(schedulerCommandBound(entry, row.argv, config, report.profile, row.cwd, root), true, 'wrong_scheduler_command');
      const timeout = row.kind === 'implementation-regression' ? 90000 : ['finite-model-check', 'temporal-model-check'].includes(row.kind) ? entry.deadlineMs : 60000;
      assert.equal(row.timeoutMs, timeout, `wrong_scheduler_stage_budget:${row.id}`);
      assert.ok(Number.isSafeInteger(row.execution.durationMs) && row.execution.durationMs >= 0 && row.execution.durationMs <= end - start && row.execution.durationMs <= timeout, 'invalid_scheduler_duration');
    }
  }
  const diagnostic = report.diagnostics.apalache, [diagnosticStart, diagnosticEnd] = interval(diagnostic);
  assert.equal(diagnostic.timeoutMs, 90000); assert.equal(diagnostic.cwd, path.join(evidenceRoot, 'work', 'apalache-diagnostic'));
  assert.equal(diagnostic.log, 'apalache-diagnostic.log'); asset(diagnostic.log); diagnostic.logs.forEach(asset);
  const lastFormal = report.results.findLast(row => ['finite-model-check', 'temporal-model-check'].includes(row.kind));
  const firstWitness = report.results.find(row => row.kind === 'model-witness');
  assert.ok(diagnosticStart >= interval(lastFormal)[1] && diagnosticEnd <= interval(firstWitness)[0], 'scheduler_diagnostic_interval');
  const regression = report.results.find(row => row.id === 'implementation-regressions');
  const count = rows => rows.reduce((sum, row) => sum + 1 + (typeof row === 'object' ? count(row.children) : 0), 0);
  assert.equal(count(regressionNames), schedulerRegressionTestCount, 'scheduler_regression_roster_changed');
  validateTapTree(await readFile(asset(regression.log), 'utf8'), regressionNames);
  return true;
}
export async function validateSchedulerReleaseEvidence(directory, { release = true, requireProfile = 'fast' } = {}) {
  const checked = await validateSchedulerEvidence(directory, { release, requireProfile });
  const result = { ...checked, kind: 'scheduler', source: null, status: 'not_run', ok: false, stale: checked.reasons.includes('stale'),
    methods: ['finite-state-safety-and-temporal-fairness', 'actual-scheduler-http-sqlite-replay'], fullProjectAcceptance: false };
  let report; try { report = await json(path.join(directory, 'report.json')); } catch { return result; }
  result.source = report.source; result.status = 'incomplete';
  try {
    assert.equal(checked.ok, true); assert.deepEqual(report.source, sourceVersion());
    assert.equal(report.tools.node, process.version); assert.equal(report.tools.sqlite, process.versions.sqlite);
    await validateSchedulerReleaseContract(report, directory);
    result.scope = { profile: report.profile, domain: report.domain, propertyRows: checked.propertyRows, boundedDiagnostic: checked.boundedDiagnostic };
    result.status = 'passed'; result.ok = true;
  } catch (error) { result.reasons.push(error.message); }
  return result;
}
