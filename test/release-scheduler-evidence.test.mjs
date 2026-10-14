import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadSchedulerConfig, schedulerFiles, schedulerPlan, schedulerRegressionFiles, schedulerCoverage, schedulerMetadata } from '../scripts/lib/scheduler-protocol-evidence.mjs';
import { validateSchedulerReleaseContract } from '../scripts/lib/scheduler-release-evidence.mjs';
import { readTechnicalEvidence } from '../scripts/lib/release-evidence.mjs';
import { technicalSuites, purposes, domainSuites } from '../verification/release/policy.mjs';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import names from '../verification/release/scheduler-regressions.json' with { type: 'json' };
const time = offset => new Date(Date.UTC(2026, 9, 14) + offset).toISOString();
const json = (file, value) => writeFile(file, JSON.stringify(value));
function exactTap() {
  const lines = ['TAP version 13']; let count = 0;
  const group = (rows, depth = 0) => {
    rows.forEach((row, index) => { const node = typeof row === 'string' ? { name: row } : row; if (node.children) group(node.children, depth + 1);
      lines.push(`${'    '.repeat(depth)}ok ${index + 1} - ${node.name.replaceAll('\\', '\\\\').replaceAll('#', '\\#')}`); count++; });
    lines.push(`${'    '.repeat(depth)}1..${rows.length}`);
  };
  group(names); lines.push(`# tests ${count}`, '# suites 0', `# pass ${count}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 1');
  return lines.join('\n') + '\n';
}
// These synthetic shapes test release bindings only. Their formal logs and
// replay rows intentionally cannot pass the real scheduler domain validator.
async function fixture(t, profile = 'fast') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-scheduler-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = '/original-ci/checkout', output = '/original-ci/evidence/' + path.basename(directory), model = root + '/verification/scheduler-protocol', cli = root + '/node_modules/@informalsystems/quint/dist/src/cli.js';
  const config = await loadSchedulerConfig(), plan = schedulerPlan(config, await schedulerFiles());
  const report = { ...await schedulerMetadata(), profile, domain: config, propertyCoverage: schedulerCoverage(config, plan), startedAt: time(0), finishedAt: time(10000), complete: true, ok: true,
    results: [], artifacts: [], execution: { repositoryRoot: root, complete: true, code: 0, signal: null, timedOut: false, interrupted: false, timeoutMs: profile === 'deep' ? 1200000 : 900000 }, tools: { node: process.version, sqlite: process.versions.sqlite } };
  const put = async (file, content) => { await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    const text = typeof content === 'string' ? content : JSON.stringify(content); await writeFile(path.join(directory, file), text);
    const asset = { path: file, sha256: digest(text) }, existing = report.artifacts.findIndex(row => row.path === file);
    if (existing < 0) report.artifacts.push(asset); else report.artifacts[existing] = asset;
  };
  for (const [index, entry] of plan.entries()) {
    const row = { id: entry.id, kind: entry.kind, startedAt: time(index * 100 + 10), finishedAt: time(index * 100 + 20), log: entry.id + '.log', complete: true, status: 'passed' };
    if (['implementation-replay', 'implementation-negative'].includes(entry.kind)) {
      row.data = entry.id + '.json'; row.samples = 1;
      const value = { sourceTrace: 'synthetic-trace', startedAt: time(index * 100 + 12), finishedAt: time(index * 100 + 18), complete: true, ok: entry.kind !== 'implementation-negative', classification: entry.kind === 'implementation-negative' ? 'implementation_mismatch' : 'matched' };
      await put(row.data, [value]); await put(row.log, [{ trace: value.sourceTrace, complete: value.complete, ok: value.ok, classification: value.classification }]);
    } else {
      row.cwd = entry.kind === 'implementation-regression' ? root : path.join(output, 'work', entry.id);
      row.timeoutMs = entry.kind === 'implementation-regression' ? 90000 : ['finite-model-check', 'temporal-model-check'].includes(entry.kind) ? entry.deadlineMs : 60000;
      row.execution = { code: 0, signal: null, timedOut: false, interrupted: false, ok: true, durationMs: 10 };
      if (entry.kind === 'typecheck') row.argv = [cli, 'typecheck', path.join(model, entry.specification)];
      else if (['finite-model-check', 'temporal-model-check'].includes(entry.kind)) row.argv = [cli, 'verify', path.join(model, entry.specification), '--main', entry.main, '--init', entry.init, '--step', entry.step,
        ...(entry.temporal ? ['--temporal', entry.temporal] : ['--invariant', entry.invariant]), '--backend', 'tlc', '--apalache-version', '0.62.1', '--tlc-config', path.join(model, 'tlc.json'), '--server-endpoint', '127.0.0.1:12345', '--verbosity', '3'];
      else if (entry.kind === 'model-witness') row.argv = [cli, 'test', path.join(model, config.witnesses.specification), '--main', entry.main, '--backend', 'typescript', '--seed', config.witnesses.seed, '--max-samples', String(config.witnesses.maxSamples), '--out-itf', path.join(output, 'witnesses', entry.main, `${entry.main}-{test}-{seq}.itf.json`)];
      else if (entry.kind === 'simulation') { const simulation = config.simulation, sample = config.profiles[profile].simulation;
        row.argv = [cli, 'run', path.join(model, simulation.specification), '--main', simulation.main, '--init', simulation.init, '--step', simulation.step, '--invariant', simulation.invariant, '--backend', 'typescript', '--seed', sample.seed, '--max-samples', String(sample.samples), '--max-steps', String(sample.maxSteps), '--n-traces', String(sample.selectedTraces), '--verbosity', '1', '--out-itf', path.join(output, 'simulation', `${simulation.main}-{seq}.itf.json`)];
      } else row.argv = ['--test', '--test-reporter=tap', '--test-timeout=30000', ...schedulerRegressionFiles.map(file => path.join(root, file))];
      await put(row.log, entry.kind === 'implementation-regression' ? exactTap() : 'Synthetic contract log; no model execution.\n');
    }
    report.results.push(row);
  }
  const index = report.results.findIndex(row => row.kind === 'model-witness');
  report.diagnostics = { apalache: { timeoutMs: 90000, cwd: path.join(output, 'work', 'apalache-diagnostic'), log: 'apalache-diagnostic.log', logs: ['apalache-diagnostic.log'], startedAt: time(index * 100 - 50), finishedAt: time(index * 100 - 40) } };
  await put('apalache-diagnostic.log', 'Synthetic diagnostic only.\n');
  const save = () => json(path.join(directory, 'report.json'), report); await save();
  return { directory, report, put, save };
}
test('scheduler is mandatory for PR and release with existing CI raw artifacts and no silent skip', async t => {
  assert.equal(technicalSuites.filter(suite => suite === 'scheduler').length, 1);
  for (const purpose of ['pr', 'release']) assert.ok(purposes[purpose].includes('scheduler'));
  for (const domain of ['HW-03', 'HW-11', 'HW-13']) assert.ok(domainSuites[domain].includes('scheduler'));
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /needs: \[[^\n]*scheduler[^\n]*\]/); assert.match(workflow, /name: scheduler-evidence-\$\{\{ github.sha \}\}/);
  assert.match(workflow, /npm run verify:scheduler -- --release/);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'missing-scheduler-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await readTechnicalEvidence('scheduler', directory, { release: false });
  assert.equal(result.ok, false); assert.equal(result.status, 'not_run'); assert.equal(result.fullProjectAcceptance, false);
});
test('scheduler release binding accepts exact portable fast/deep commands but never substitutes for the domain validator', async t => {
  for (const profile of ['fast', 'deep']) {
    const { report, directory } = await fixture(t, profile);
    assert.equal(await validateSchedulerReleaseContract(report, directory), true);
    const result = await readTechnicalEvidence('scheduler', directory, { release: false, profile });
    assert.equal(result.ok, false); assert.equal(result.status, 'incomplete'); assert.ok(result.rows.some(row => row.status === 'incomplete'));
  }
});
test('scheduler release binding rejects missing raw stages, wrong commands, budgets and contradictory replay logs', async t => {
  const { report, directory, put } = await fixture(t), baseline = structuredClone(report);
  for (const [name, change] of [
    ['missing stage', r => { r.results.pop(); }], ['duplicate stage', r => { r.results[1] = r.results[0]; }],
    ['stage order', r => { [r.results[0], r.results[1]] = [r.results[1], r.results[0]]; }],
    ['profile budget', r => { r.execution.timeoutMs++; }], ['stage budget', r => { r.results[0].timeoutMs++; }],
    ['diagnostic budget', r => { r.diagnostics.apalache.timeoutMs++; }],
    ['wrong cwd', r => { r.results[0].cwd = '/other/work/' + r.results[0].id; }],
    ['wrong command', r => { r.results[0].argv[2] = '/other/model.qnt'; }],
    ['missing regression file', r => { r.results.at(-1).argv.pop(); }],
    ['wrong replay samples', r => { r.results.find(row => row.id === 'replay-witnesses').samples++; }],
    ['overlapping execution', r => { r.results[1].startedAt = r.results[0].startedAt; }],
    ['diagnostic outside formal-witness boundary', r => { r.diagnostics.apalache.startedAt = time(0); }],
    ['unbound log', r => { r.artifacts = r.artifacts.filter(row => row.path !== 'simulation.log'); }],
    ['wrong raw log path', r => { r.results[0].log = r.results[1].log; }]
  ]) { const changed = structuredClone(baseline); change(changed); await assert.rejects(validateSchedulerReleaseContract(changed, directory), undefined, name); }
  await put('replay-witnesses.log', []); await assert.rejects(validateSchedulerReleaseContract(report, directory), /scheduler_replay_log_binding/);
});
test('scheduler release binding requires the complete 175-test TAP tree, not a count-only or renamed nested body', async t => {
  const { report, directory, put } = await fixture(t), tap = exactTap();
  for (const changed of [tap.replace(/^\s*ok .*\n/gm, ''), tap.replace(/^    ok (\d+) - .+$/m, '    ok $1 - wrong nested regression'), tap.replace('TAP version 13\n', 'TAP version 13\n    not ok 1 - hidden failure\n')]) {
    await put('implementation-regressions.log', changed); await assert.rejects(validateSchedulerReleaseContract(report, directory));
  }
  await put('implementation-regressions.log', tap); await symlink(path.join(directory, 'simulation.log'), path.join(directory, 'unbound-symlink'));
  await assert.rejects(validateSchedulerReleaseContract(report, directory), /unsafe path or symlink/);
});

test('scheduler raw replay timestamps stay within their stage in actual serial order independently of controlled clocks', async t => {
  const { report, directory, put } = await fixture(t), row = report.results.find(row => row.id === 'replay-witnesses');
  const values = JSON.parse(await readFile(path.join(directory, row.data), 'utf8')), first = values[0];
  const set = async replay => { row.samples = replay.length; await put(row.data, replay); await put(row.log, replay.map(value => ({ trace: value.sourceTrace, complete: value.complete, ok: value.ok, classification: value.classification }))); };
  for (const offset of [-365 * 86400000, 365 * 86400000]) {
    const changed = structuredClone(first); for (const key of ['startedAt', 'finishedAt']) changed[key] = new Date(Date.parse(changed[key]) + offset).toISOString();
    await set([changed]); await assert.rejects(validateSchedulerReleaseContract(report, directory), /scheduler_replay_interval/);
  }
  const a = { ...first, finishedAt: new Date(Date.parse(first.startedAt) + 1).toISOString() };
  const b = { ...first, sourceTrace: 'synthetic-second-trace', startedAt: a.finishedAt };
  await set([a, b]); assert.equal(await validateSchedulerReleaseContract(report, directory), true);
  await set([b, a]); await assert.rejects(validateSchedulerReleaseContract(report, directory), /scheduler_replay_interval/);
  await set([first, { ...first, sourceTrace: b.sourceTrace }]); await assert.rejects(validateSchedulerReleaseContract(report, directory), /scheduler_replay_interval/);
});
