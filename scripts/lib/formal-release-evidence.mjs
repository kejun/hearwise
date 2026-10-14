import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { relationEvidenceDefinition } from './relation-protocol-evidence.mjs';
import { knowledgeEvidenceDefinition } from './knowledge-protocol-evidence.mjs';
import { validateFormalEvidence } from './formal-protocol-evidence.mjs';
import { validateDurableReplay } from './formal-durable-evidence.mjs';
import { tapSummary, parseTapFooter } from './tap-summary.mjs';

const definitions = { 'relation-protocol': relationEvidenceDefinition, 'knowledge-protocol': knowledgeEvidenceDefinition };
const regressions = { 'relation-protocol': { files: ['test/relation-protocol-replay.test.mjs'], count: 14 },
  'knowledge-protocol': { files: ['test/knowledge-protocol-replay.test.mjs', 'test/model-trace-driver.test.mjs'], count: 24 } };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export async function formalCommandContract(kind, report) {
  assert.ok(Object.hasOwn(definitions, kind));
  const config = await definitions[kind].loadConfig(), pinned = await definitions[kind].loadToolchain(), profile = report.profile;
  assert.ok(Object.hasOwn(config.profiles, profile)); assert.ok(!report.error);
  const context = report.executionContext;
  assert.ok(context && path.isAbsolute(context.repositoryRoot) && path.isAbsolute(context.evidenceDirectory));
  assert.equal(path.basename(context.evidenceDirectory).startsWith('run-'), true);
  assert.equal(context.quintCli, path.join(context.repositoryRoot, 'node_modules/@informalsystems/quint/dist/src/cli.js'));
  assert.equal(context.overallTimeoutMs, profile === 'deep' ? 1200000 : 480000); assert.equal(context.jvmArgs, '-Xmx2G');
  assert.equal(report.tools.node, process.version); assert.equal(report.tools.sqlite, process.versions.sqlite);
  const model = file => path.join(context.repositoryRoot, 'verification', kind, file);
  const output = file => path.join(context.evidenceDirectory, file);
  for (const row of report.results) {
    if (['implementation-replay', 'implementation-negative'].includes(row.kind)) continue;
    assert.ok(row.execution && !row.execution.error);
    assert.equal(row.execution.ok, row.kind !== 'model-negative');
    let expected, bound, timeout = 60000, expectedFailure = false;
    const endpoint = row.argv?.[row.argv.indexOf('--server-endpoint') + 1];
    const server = () => { assert.match(endpoint, /^127\.0\.0\.1:[1-9][0-9]{0,4}$/); assert.ok(Number(endpoint.split(':')[1]) <= 65535); return endpoint; };
    if (row.kind === 'typecheck') expected = ['typecheck', model(`${row.id.slice('typecheck-'.length)}.qnt`)];
    else if (['finite-state-complete', 'bounded-model-check'].includes(row.kind)) {
      const main = row.id.replace(/^(tlc|bounded)-/, '');
      expected = ['verify', model(config.specification), '--main', main, '--init', config.init, '--step', config.step, '--invariant', config.invariant, '--apalache-version', pinned.apalache.version, '--verbosity', '3'];
      if (row.kind === 'finite-state-complete') expected.push('--backend', 'tlc', '--tlc-config', model('tlc.json'), '--server-endpoint', server());
      else { bound = config.profiles[profile].apalacheDepth[main]; timeout = profile === 'deep' && main !== 'single' ? 900000 : 240000;
        expected.push('--backend', 'apalache', '--max-steps', String(bound), '--server-endpoint', server()); }
    } else if (row.kind === 'model-witness') {
      const main = row.id.slice('witnesses-'.length);
      expected = ['test', model(config.witnesses.specification), '--main', main, '--backend', 'typescript', '--seed', config.witnesses.seed,
        '--max-samples', String(config.witnesses.maxSamples), '--out-itf', output(`witnesses/${main}-{test}-{seq}.itf.json`)];
    } else if (row.kind === 'simulation') {
      const main = row.id.slice('simulation-'.length);
      expected = ['run', model(config.specification), '--main', main, '--init', config.init, '--step', config.step, '--invariant', config.invariant,
        '--backend', 'typescript', '--seed', config.simulation.seed, '--max-samples', String(config.simulation.samples), '--n-traces', String(config.simulation.selectedTraces),
        '--max-steps', String(config.simulation.maximumSteps), '--verbosity', '1', '--out-itf', output(`simulation/${main}-{seq}.itf.json`)];
      assert.deepEqual(row.metrics, config.simulation);
    } else if (row.kind === 'model-negative') {
      const main = row.id.slice('negative-'.length), mutant = config.mutants.find(item => item.main === main); assert.ok(mutant); expectedFailure = true;
      expected = ['verify', model(config.specification), '--main', main, '--init', config.init, '--step', config.step, '--invariant', config.invariant,
        '--backend', 'apalache', '--apalache-version', pinned.apalache.version, '--server-endpoint', server(), '--max-steps', String(mutant.maxSteps), '--out-itf', output(`negative/${main}.itf.json`)];
    } else if (row.kind === 'implementation-regression') expected = ['--test', '--test-reporter=tap', '--test-timeout=30000', ...regressions[kind].files.map(file => path.join(context.repositoryRoot, file))];
    else throw new Error('Unexpected formal command kind');
    assert.deepEqual(row.argv, row.kind === 'implementation-regression' ? expected : [context.quintCli, ...expected]);
    assert.equal(row.timeoutMs, timeout); assert.equal(row.bound, bound); assert.equal(row.expectedFailure, expectedFailure);
  }
  return true;
}
export async function validateFormalReleaseEvidence(kind, directory, { release = true, requireProfile = 'fast' } = {}) {
  if (!Object.hasOwn(definitions, kind)) throw new Error('Unknown formal evidence kind');
  const checked = await validateFormalEvidence(directory, definitions[kind], { release, requireProfile });
  const reasons = [...checked.reasons], result = { ...checked, kind, reasons, status: 'incomplete', stale: reasons.includes('stale'), methods: [], scope: {}, fullProjectAcceptance: false };
  let report;
  try { report = await json(path.join(directory, 'report.json')); } catch { result.status = 'not_run'; return result; }
  if (!report || !Array.isArray(report.results) || report.results.some(row => !row || typeof row !== 'object')) { reasons.push('invalid_report_shape'); return result; }
  result.source = report.source;
  const attempt = async (reason, operation) => { try { await operation(); } catch { reasons.push(reason); } };
  await attempt('wrong_execution_contract', () => formalCommandContract(kind, report));
  await attempt('wrong_regression_roster', async () => {
    const row = report.results.find(row => row.id === 'implementation-regressions');
    const log = await readFile(path.join(directory, row.log), 'utf8'), footer = parseTapFooter(log);
    assert.equal(tapSummary(log).ok, true); assert.equal(footer.tests, regressions[kind].count);
    const names = (await Promise.all(regressions[kind].files.map(async file => [...(await readFile(file, 'utf8')).matchAll(/^test\('([^']+)'/gm)].map(match => match[1])))).flat();
    assert.deepEqual([...log.matchAll(/^ok \d+ - (.+)$/gm)].map(match => match[1]), names); assert.equal(footer.plan, names.length);
  });
  for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) await attempt(`invalid_durable_evidence:${id}`, async () => {
    const row = report.results.find(row => row.id === id), replays = await json(path.join(directory, row.data));
    assert.ok(Array.isArray(replays) && replays.length);
    for (const replay of replays) validateDurableReplay(kind, replay, { negative: id === 'negative-replay' });
    assert.deepEqual(await json(path.join(directory, row.log)), replays.map(replay => ({ trace: replay.sourceTrace, classification: replay.classification, complete: replay.complete, ok: replay.ok, steps: replay.steps })));
  });
  result.methods = [...new Set(checked.rows.map(row => row.kind))];
  result.scope = { domain: report.domain, profile: report.profile, exclusions: report.domain?.exclusions,
    checks: report.results?.map(row => ({ id: row.id, kind: row.kind, metrics: row.metrics, bound: row.bound, timeoutMs: row.timeoutMs })),
    overallTimeoutMs: report.executionContext?.overallTimeoutMs, jvmArgs: report.executionContext?.jvmArgs };
  const incomplete = !report.complete || report.execution?.timedOut || report.execution?.interrupted || report.results?.some(row => row.complete !== true || row.execution?.timedOut || row.execution?.interrupted || row.execution?.signal);
  const failed = report.results?.some(row => row.status === 'failed');
  result.status = incomplete ? 'incomplete' : failed ? 'failed' : checked.ok && !reasons.length ? 'passed' : 'incomplete';
  result.ok = result.status === 'passed'; return result;
}
