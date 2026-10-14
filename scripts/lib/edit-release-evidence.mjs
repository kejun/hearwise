import { validateFlatTap } from './release-tap-evidence.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { editConfig, validateEditProtocolEvidence } from './edit-protocol-evidence.mjs';
import { sourceSnapshot, sameSourceSnapshot, validBuildSource, evidenceFiles, safeRelative } from './runner-evidence-contract.mjs';
import { tapSummary, parseTapFooter } from './tap-summary.mjs';
import { validMatchedEditDurable } from './edit-protocol-durable.mjs';
import { editConfiguration } from './edit-protocol-evidence.mjs';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export async function editCommandContract(report) {
  const config = await editConfig(), pin = await json('verification/relation-protocol/toolchain.json'), context = report.executionContext;
  assert.ok(context && path.isAbsolute(context.repositoryRoot) && path.isAbsolute(context.evidenceDirectory));
  assert.match(path.basename(context.evidenceDirectory), /^run-[A-Za-z0-9]+$/); assert.equal(context.overallTimeoutMs, config.limits.overallMs); assert.equal(context.jvmArgs, '-Xmx2G');
  assert.equal(context.quintCli, path.join(context.repositoryRoot, 'node_modules/@informalsystems/quint/dist/src/cli.js'));
  assert.equal(report.tools.node, process.version); assert.equal(report.tools.sqlite, process.versions.sqlite); assert.ok(!report.error);
  const model = file => path.join(context.repositoryRoot, 'verification/edit-protocol', file), output = file => path.join(context.evidenceDirectory, file);
  for (const row of report.results) {
    if (['implementation-replay', 'implementation-negative'].includes(row.kind)) continue;
    const main = row.id.replace(/^(typecheck|tlc|bounded|witnesses|simulation|negative)-/, ''); let args, timeout = 60000, bound;
    assert.ok(row.execution && !row.execution.error); assert.equal(row.execution.ok, row.kind !== 'model-negative');
    const server = () => { const endpoint = row.argv[row.argv.indexOf('--server-endpoint') + 1]; assert.match(endpoint, /^127\.0\.0\.1:[1-9][0-9]{0,4}$/); assert.ok(Number(endpoint.split(':')[1]) <= 65535); return endpoint; };
    if (row.kind === 'typecheck') args = ['typecheck', model(`${main}.qnt`)];
    else if (['finite-state-complete', 'bounded-model-check'].includes(row.kind)) {
      const entry = config.configurations.find(value => value.main === main); assert.ok(entry);
      args = ['verify', model(config.specification), '--main', main, '--init', config.init, '--step', config.step, '--invariant', config.invariant, '--apalache-version', pin.apalache.version, '--verbosity', '3'];
      if (row.kind === 'finite-state-complete') { timeout = config.limits.tlcMs; args.push('--backend', 'tlc', '--tlc-config', model('tlc.json'), '--server-endpoint', server()); }
      else { timeout = config.limits.boundedMs; bound = entry.apalacheDepth; args.push('--backend', 'apalache', '--max-steps', String(bound), '--server-endpoint', server()); }
    } else if (row.kind === 'model-witness') {
      assert.ok(config.witnesses.mains.includes(main)); timeout = config.limits.witnessMs;
      args = ['test', model(config.witnesses.specification), '--main', main, '--backend', 'typescript', '--seed', config.witnesses.seed, '--max-samples', String(config.witnesses.maxSamples), '--out-itf', output(`witnesses/${main}-{test}-{seq}.itf.json`)];
    } else if (row.kind === 'simulation') {
      assert.ok(config.configurations.some(row => row.main === main)); timeout = config.limits.simulationMs; assert.deepEqual(row.parameters, config.simulation);
      args = ['run', model(config.specification), '--main', main, '--init', config.init, '--step', config.step, '--invariant', config.invariant, '--backend', 'typescript', '--seed', config.simulation.seed, '--max-samples', String(config.simulation.samples), '--max-steps', String(config.simulation.maximumSteps), '--n-traces', String(config.simulation.selectedTraces), '--out-itf', output(`simulation/${main}-{seq}.itf.json`)];
    } else if (row.kind === 'model-negative') {
      const mutant = config.mutants.find(row => row.main === main); assert.ok(mutant); timeout = config.limits.mutationMs;
      args = ['verify', model(config.specification), '--main', main, '--init', config.init, '--step', config.step, '--invariant', config.invariant, '--backend', 'apalache', '--apalache-version', pin.apalache.version, '--server-endpoint', server(), '--max-steps', String(mutant.maxSteps), '--out-itf', output(`negative/${main}.itf.json`)];
    } else { assert.equal(row.kind, 'implementation-regression'); assert.equal(row.id, 'driver-regressions'); args = ['--test', '--test-reporter=tap', '--test-timeout=30000', path.join(context.repositoryRoot, 'test/edit-protocol-evidence.test.mjs')]; }
    assert.deepEqual(row.argv, row.kind === 'implementation-regression' ? args : [context.quintCli, ...args]); assert.equal(row.timeoutMs, timeout); assert.equal(row.bound, bound);
    assert.equal(row.cwd, row.kind === 'implementation-regression' ? context.repositoryRoot : context.evidenceDirectory);
  }
  return true;
}
export async function validateEditReleaseEvidence(directory, { release = true, requireProfile = 'fast' } = {}) {
  const checked = await validateEditProtocolEvidence(directory, { release }), reasons = [...checked.reasons];
  const result = { ...checked, kind: 'edit-protocol', reasons, status: 'not_run', stale: reasons.includes('stale'), source: null, fullProjectAcceptance: false,
    methods: [...new Set(checked.rows.map(row => row.kind))], scope: { profile: 'fixed', requestedProfile: requireProfile, deepProfileAvailable: false } };
  let report; try { report = await json(path.join(directory, 'report.json')); } catch { return result; }
  result.status = 'incomplete'; result.source = report?.source;
  if (requireProfile !== 'fast') reasons.push('unsupported_profile:edit-protocol-has-no-deep-profile');
  if (!report || !Array.isArray(report.results)) { reasons.push('invalid_report_shape'); return result; }
  const attempt = async (reason, work) => { try { await work(); } catch { reasons.push(reason); } };
  await attempt('wrong_execution_contract', () => editCommandContract(report));
  await attempt('source_or_build_digest_changed', async () => {
    assert.ok(validBuildSource(report.sourceStart) && validBuildSource(report.sourceEnd));
    assert.ok(sameSourceSnapshot(report.sourceStart, report.sourceEnd) && sameSourceSnapshot(report.sourceEnd, await sourceSnapshot()));
    assert.deepEqual(report.source, report.sourceStart.source);
  });
  await attempt('invalid_bound_files', async () => {
    const disk = new Set(await evidenceFiles(directory)); assert.ok(report.artifacts.every(row => safeRelative(row.path) && disk.has(row.path)));
  });
  await attempt('wrong_regression_roster', async () => {
    const row = report.results.find(row => row.id === 'driver-regressions'), log = await readFile(path.join(directory, row.log), 'utf8');
    const names = [...(await readFile('test/edit-protocol-evidence.test.mjs', 'utf8')).matchAll(/^test\('([^']+)'/gm)].map(match => match[1]);
    assert.equal(tapSummary(log).ok, true); assert.equal(parseTapFooter(log).tests, 8); assert.equal(parseTapFooter(log).plan, names.length);
    validateFlatTap(log, names);
  });
  for (const row of report.results || []) if (['implementation-replay', 'implementation-negative'].includes(row.kind)) await attempt(`invalid_durable_evidence:${row.id}`, async () => {
    const replays = await json(path.join(directory, row.data));
    assert.deepEqual(await json(path.join(directory, row.log)), replays.map(value => ({ sourceTrace: value.sourceTrace, classification: value.classification, complete: value.complete, ok: value.ok, steps: value.steps })));
    for (const replay of replays) {
      const source = report.results.find(value => ['model-witness', 'simulation'].includes(value.kind) && value.traces.includes(replay.sourceTrace));
      const config = editConfiguration(source.id.replace(/^(witnesses|simulation)-/, ''), report.config);
      const negative = row.kind === 'implementation-negative';
      for (const observation of negative ? replay.observations.slice(0, -1) : replay.observations) assert.ok(validMatchedEditDurable(observation, config));
      if (negative) { assert.notDeepEqual(replay.difference.actual, replay.difference.expected); assert.deepEqual(replay.observations.at(-1).actual, replay.difference.actual); assert.deepEqual(replay.counterexample.steps.at(-1).expected, replay.difference.expected); }
    }
  });
  result.scope = { ...result.scope, limits: report.config?.limits, exclusions: report.config?.scope?.exclusions };
  result.status = checked.ok && !reasons.length ? 'passed' : report.results?.some(row => row.status === 'failed') ? 'failed' : 'incomplete'; result.ok = result.status === 'passed'; return result;
}
