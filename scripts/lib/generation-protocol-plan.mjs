import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest } from './verification-evidence.mjs';
import { checkerConclusion } from './formal-protocol-evidence.mjs';
import { properties } from '../../verification/generation-protocol/properties.mjs';
import { validateFlatTap } from './release-tap-evidence.mjs';
import regressionNames from '../../verification/generation-protocol/regressions.json' with { type: 'json' };

export const generationRepositoryRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export const generationModelRoot = path.join(generationRepositoryRoot, 'verification/generation-protocol');
export const generationRegressionFiles = ['test/generation-admission.test.mjs', 'test/generation-commit-guard.test.mjs',
  'test/generation-isolation.test.mjs', 'test/generation-protocol-adapter.test.mjs', 'test/generation-protocol-evidence.test.mjs', 'test/generation-protocol-trace.test.mjs'];
export const generationRegressionCount = 35;
export const loadGenerationConfig = async () => JSON.parse(await readFile(path.join(generationModelRoot, 'config.json')));
export const loadGenerationTools = async () => JSON.parse(await readFile(path.join(generationModelRoot, 'toolchain.json')));
export async function generationMetadata() {
  const git = args => execFileSync('git', ['-C', generationRepositoryRoot, ...args], { encoding: 'utf8', timeout: 5000 }).trim();
  const config = await loadGenerationConfig();
  const modelFiles = [...config.modelSpecifications, 'config.json', 'tlc.json', 'toolchain.json', 'properties.mjs', 'regressions.json',
    '../relation-protocol/protocol.qnt', '../knowledge-protocol/protocol.qnt'];
  const inputs = await Promise.all(modelFiles.map(async file => [file, await readFile(path.join(generationModelRoot, file), 'utf8')]));
  const files = [...new Set([...git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean),
    'dist/server/index.js', 'public/vendor/cytoscape.js'])].sort();
  const sourceDigests = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(path.join(generationRepositoryRoot, file)))])));
  const { createTaskRuntime } = await import(pathToFileURL(path.join(generationRepositoryRoot, 'dist/server/index.js')).href);
  const runtime = createTaskRuntime({ enabled: false }); let runtimeBuild;
  try { runtimeBuild = structuredClone(runtime.diagnostics().build); } finally { await runtime.dispose(); }
  return { schemaVersion: 1, specificationVersion: '1.0', modelVersion: 1, source: { sha: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain', '--untracked-files=normal'])) },
    sourceDigests, runtimeBuild, modelDigest: digest(JSON.stringify(inputs)), lockDigest: digest(await readFile(path.join(generationRepositoryRoot, 'package-lock.json'))),
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version } };
}

export function generationPlan(config) {
  return [
    { id: 'model-regressions', kind: 'implementation-regression', count: config.modelSpecifications.length +
      Object.keys(config.witnesses.counts).length + Object.keys(config.guards.counts).length + Object.keys(config.directedMutants.counts).length + 2,
      names: [...config.modelSpecifications.map(file => `generation model typechecks: ${file}`),
        ...[config.witnesses, config.guards, config.directedMutants].flatMap(suite => Object.keys(suite.counts).map(main => `generation model regression: ${main}`)),
        'finite quotient erases only action labels, never guards or semantic state', 'full product budgets are imported unchanged and are not advertised as the concurrency Cartesian product'] },
    ...config.domains.flatMap(domain => [{ id: `tlc-${domain.main}`, kind: 'finite-state-complete', domain }, { id: `bounded-${domain.main}`, kind: 'bounded-model-check', domain }]),
    ...config.witnesses.mains.map(main => ({ id: `witness-${main}`, kind: 'model-witness', main, refined: false, count: config.witnesses.counts[main], names: config.witnesses.names[main] })),
    ...config.domains.filter(row => row.kind === 'generation-envelope').map(domain => ({ id: `simulation-${domain.main}`, kind: 'simulation', main: domain.traceMain, domain, refined: false, count: config.simulation.selectedTraces })),
    ...config.refinement.domains.flatMap(domain => [
      { id: `witness-${domain.witnessMain}`, kind: 'model-witness', main: domain.witnessMain, domain, refined: true, count: config.refinement.counts[domain.witnessMain], names: config.refinement.names[domain.witnessMain] },
      { id: `simulation-${domain.main}`, kind: 'simulation', main: domain.main, domain, refined: true, count: config.simulation.selectedTraces }
    ]),
    ...config.mutants.map(mutant => ({ id: `negative-${mutant.main}`, kind: 'model-negative', main: mutant.main, mutant, count: 1 })),
    { id: 'replay-witnesses', kind: 'implementation-replay', sourceKind: 'model-witness', count: config.refinement.expectedTestCount },
    { id: 'replay-simulation', kind: 'implementation-replay', sourceKind: 'simulation', count: config.refinement.expectedSimulationTraces },
    ...config.implementationControls.map(control => ({ id: `implementation-negative-${control.id}`, kind: 'implementation-negative', control, count: 1 })),
    { id: 'implementation-regressions', kind: 'implementation-regression', count: generationRegressionCount, names: regressionNames }
  ];
}
export function generationCoverage(config) {
  const common = generationPlan(config).filter(row => !['model-negative', 'implementation-negative'].includes(row.kind)).map(row => row.id);
  const controls = generationPlan(config).filter(row => ['model-negative', 'implementation-negative'].includes(row.kind)).map(row => row.id);
  return properties.map(property => ({ id: property.id, version: property.version, acceptance: property.acceptance,
    checks: [...common, ...(property.id === 'HW-04-17' ? controls : [])] }));
}
export function generationTraceConfig(entry) {
  const name = entry.main || entry.id, protocol = name.includes('knowledge') ? 'knowledge' : 'relation';
  return { protocol, actors: /multi|cap[12]/.test(name) ? 3 : 1, capacity: name.includes('cap2') ? 2 : 1,
    ...(entry.refined ? { refinement: 'fixed-ready-provider-permit-v1' } : {}) };
}

export function generationCommand(entry, config, profile, { repositoryRoot, evidenceRoot, port }) {
  const model = path.join(repositoryRoot, 'verification/generation-protocol'), traceDirectory = path.join(evidenceRoot, 'traces', entry.id);
  const cwd = entry.kind === 'implementation-regression' ? repositoryRoot : path.join(evidenceRoot, 'work', entry.id);
  if (entry.kind === 'implementation-regression') return { cwd, timeoutMs: 180000, argv: ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=30000',
    ...(entry.id === 'model-regressions' ? [path.join(model, 'model.test.mjs')] : generationRegressionFiles.map(file => path.join(repositoryRoot, file)))] };
  const argv = [path.join(repositoryRoot, 'node_modules/@informalsystems/quint/dist/src/cli.js')];
  if (['finite-state-complete', 'bounded-model-check', 'model-negative'].includes(entry.kind)) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid formal server port');
    const negative = entry.kind === 'model-negative', tlc = entry.kind === 'finite-state-complete';
    const main = negative ? entry.main : entry.domain.finiteMain, specification = negative ? entry.mutant.specification : entry.domain.finiteSpecification;
    const bound = negative ? entry.mutant.maxSteps : config.profiles[profile].apalacheDepth[entry.domain.main];
    argv.push('verify', path.join(model, specification), '--main', main, '--init', config.init, '--step', config.step, '--invariant', config.invariant,
      '--backend', tlc ? 'tlc' : 'apalache', '--apalache-version', '0.62.1', '--server-endpoint', `127.0.0.1:${port}`, '--verbosity', '3');
    if (tlc) argv.push('--tlc-config', path.join(model, 'tlc.json'));
    else argv.push('--max-steps', String(bound), '--out-itf', path.join(traceDirectory, `${entry.id}.itf.json`));
    return { argv, cwd, bound: tlc ? null : bound, traceDirectory,
      timeoutMs: negative ? 120000 : config.profiles[profile].timeoutMs[tlc ? 'tlc' : 'bmc'] };
  }
  if (entry.kind === 'model-witness') argv.push('test', path.join(model, entry.refined ? config.refinement.witnessSpecification : config.witnesses.specification),
    '--main', entry.main, '--backend', 'typescript', '--seed', config.witnesses.seed, '--max-samples', String(config.witnesses.maxSamples), '--out-itf', path.join(traceDirectory, `${entry.main}-{test}-{seq}.itf.json`));
  else if (entry.kind === 'simulation') argv.push('run', path.join(model, entry.refined ? config.refinement.specification : config.specification), '--main', entry.main,
    '--init', config.init, '--step', config.step, '--invariant', config.invariant, '--backend', 'typescript', '--seed', config.simulation.seed,
    '--max-samples', String(config.simulation.samples), '--n-traces', String(config.simulation.selectedTraces), '--max-steps', String(config.simulation.maximumSteps),
    '--verbosity', '1', '--out-itf', path.join(traceDirectory, `${entry.main}-{seq}.itf.json`));
  else throw new Error(`Not a command stage: ${entry.id}`);
  return { argv, cwd, traceDirectory, timeoutMs: 120000 };
}
export function generationCommandConclusion(entry, execution, log, bound) {
  const result = checkerConclusion(entry.kind, execution, log, bound);
  if (entry.kind === 'implementation-regression') {
    result.ok &&= result.metrics?.tests === entry.count;
    try { validateFlatTap(log, entry.names); } catch { result.ok = false; result.complete = false; }
  }
  if (entry.kind === 'model-witness') result.ok &&= new RegExp(`\\b${entry.count} passing\\b`).test(log) && !/\b[1-9]\d* failing\b/.test(log) &&
    JSON.stringify([...log.matchAll(/^\s+ok (\w+) passed 1 test\(s\)\r?$/gm)].map(match => match[1])) === JSON.stringify(entry.names);
  return result;
}
