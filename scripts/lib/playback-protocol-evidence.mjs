import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { normalizeITFStates } from './protocol-replay.mjs';
import { formalPlan, validateFormalEvidence, checkerConclusion } from './formal-protocol-evidence.mjs';
import { tapMetrics } from './tap-summary.mjs';
import { normalizePlaybackTrace, auditPlaybackObservation, auditPlaybackReplay } from './playback-protocol-replay.mjs';
import { properties } from '../../verification/playback-protocol/properties.mjs';

export const playbackModelRoot = path.resolve('verification/playback-protocol');
export const playbackModelFiles = ['protocol.qnt', 'configurations.qnt', 'complete.qnt', 'mutants.qnt', 'witnesses.qnt', 'config.json', 'tlc.json', 'toolchain.json', 'properties.mjs'];
export const playbackBindingFiles = ['scripts/lib/playback-protocol-evidence.mjs', 'scripts/lib/playback-protocol-replay.mjs',
  'scripts/verify-playback-protocol.mjs', 'scripts/verify-playback-protocol-report.mjs', 'scripts/lib/formal-protocol-runner.mjs',
  'scripts/lib/formal-protocol-evidence.mjs', 'scripts/lib/protocol-replay.mjs', 'scripts/lib/tap-summary.mjs',
  'scripts/lib/process.mjs', 'test-support/lifecycle.mjs', 'test/playback-protocol-fixtures.mjs', 'scripts/lib/relation-protocol-tools.mjs', 'test-support/playback-protocol-adapter.mjs',
  'test-support/playback-controller-variant.mjs', 'public/speech-controller.js', 'public/speech-player.js', 'public/speech-output-processor.js',
  'public/speech-buffer.js', 'public/speech-protocol.js', 'speech-service.mjs', 'storage.mjs', 'qwen-tts.mjs'];
export const loadPlaybackConfig = async () => JSON.parse(await readFile(path.join(playbackModelRoot, 'config.json'), 'utf8'));
export async function playbackMetadata() {
  const config = await loadPlaybackConfig();
  const files = [...playbackModelFiles.map(file => path.join('verification/playback-protocol', file)), ...playbackBindingFiles, ...config.regression.files];
  const contents = await Promise.all(files.map(async file => [file, await readFile(file, 'utf8')]));
  return { schemaVersion: 1, source: sourceVersion(), specificationVersion: '1.0', modelVersion: 1,
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release() },
    modelDigest: digest(JSON.stringify(contents)), lockDigest: digest(await readFile('package-lock.json')) };
}
export function playbackTraceConfig(id) {
  if (id.includes('pair')) return { owners: 2, maxPcm: 1 };
  if (id.includes('aba')) return { owners: 3, maxPcm: 0 };
  if (id.includes('isolation_witnesses')) return { owners: 3, maxPcm: 2 };
  if (id.includes('isolation') || id.includes('old_callback') || id.includes('seek_unpaused')) return { owners: 3, maxPcm: 1 };
  return { owners: 1, maxPcm: 2 };
}
export function playbackCoverage(config) {
  const plan = formalPlan(config);
  const common = plan.filter(row => ['typecheck', 'model-witness', 'implementation-replay', 'implementation-regression'].includes(row.kind)).map(row => row.id);
  return properties.map(property => ({ id: property.id, version: property.version, acceptance: property.acceptance,
    checks: [...common, ...property.finiteChecks.flatMap(main => [`tlc-${main}`, `bounded-${main}`, `simulation-${main}`]),
      ...property.negative.map(name => name === 'negative-replay' ? name : `negative-${name}`)] }));
}
export function playbackMutationViolation(main, itf) {
  const trace = normalizePlaybackTrace(itf, playbackTraceConfig(main));
  const states = normalizeITFStates(itf, ['isolationViolation', 'pauseViolation', 'accepted', 'requested', 'received', 'frames']);
  const match = state => main === 'mutant_old_callback' ? state.isolationViolation === true : main === 'mutant_seek_unpaused' ? state.pauseViolation === true :
    main === 'mutant_accepted_loss' ? Object.keys(state.accepted).some(g => state.accepted[g] !== state.requested[g]) :
      main === 'mutant_wrong_frame' ? Object.keys(state.received).some(g => state.received[g] !== state.frames[g] * 2) : false;
  const firstViolationState = states.findIndex(match);
  return { ok: firstViolationState > 0, classification: 'model_violation', firstViolationState, traceLength: trace.steps.length };
}
export function expectedPlaybackCounterexample(replay) {
  const d = replay.difference, trace = replay.counterexample;
  if (!d || !trace || d.step !== 6 || trace.steps?.length !== 7 || trace.minimality !== 'first-divergence-prefix' ||
      trace.steps.at(-1).action !== 'late' || trace.steps.at(-1).actor !== 1 || trace.steps.at(-1).choice !== 'suspended' ||
      d.expected?.active !== 3 || d.actual?.active !== 3 || d.expected?.paused !== false || d.actual?.paused !== true ||
      d.expected?.epoch?.[1] !== 1 || d.expected?.epoch?.[3] !== 1 || replay.observations?.length !== 8) return false;
  return auditPlaybackReplay(replay, trace.config).length === 0 && replay.observations.every((observation, index) => observation.step === index - 1 &&
    auditPlaybackObservation(observation.durable, observation.actual, trace.config).length === 0 &&
    (index === 7 ? isDeepStrictEqual(observation.actual, d.actual) : isDeepStrictEqual(observation.actual, index ? trace.steps[index - 1].expected : trace.initial)));
}
export const playbackEvidenceDefinition = {
  loadConfig: loadPlaybackConfig,
  loadToolchain: async () => JSON.parse(await readFile(path.join(playbackModelRoot, 'toolchain.json'), 'utf8')),
  metadata: playbackMetadata, coverage: playbackCoverage, normalizeTrace: normalizePlaybackTrace,
  traceConfig: playbackTraceConfig, expectedMutationViolation: playbackMutationViolation,
  expectedImplementationCounterexample: expectedPlaybackCounterexample
};

const repositoryPaths = root => /^[A-Za-z]:[\\/]/.test(root || '') ? path.win32 : path.posix;
export function validPlaybackRepositoryRoot(root) {
  if (typeof root !== 'string' || /[\r\n\0]/.test(root)) return false;
  const paths = repositoryPaths(root);
  return paths.isAbsolute(root) && paths.normalize(root) === root && !root.split(/[\\/]/).includes('..');
}
export function playbackCommandShape(result, config, profile, repositoryRoot = process.cwd()) {
  if (!validPlaybackRepositoryRoot(repositoryRoot)) return null;
  const paths = repositoryPaths(repositoryRoot), modelRoot = paths.join(repositoryRoot, 'verification', 'playback-protocol');
  const cli = paths.join(repositoryRoot, 'node_modules', '@informalsystems', 'quint', 'dist', 'src', 'cli.js');
  const main = result.id.replace(/^(?:tlc|bounded|witnesses|simulation|negative)-/, '');
  const common = { '--init': config.init, '--step': config.step, '--invariant': config.invariant };
  let command, file, flags = {};
  if (result.kind === 'typecheck') { command = 'typecheck'; file = `${result.id.slice('typecheck-'.length)}.qnt`; }
  if (result.kind === 'finite-state-complete') { command = 'verify'; file = config.completeSpecification;
    flags = { ...common, '--main': `${main}_complete`, '--backend': 'tlc', '--tlc-config': paths.join(modelRoot, 'tlc.json'), '--apalache-version': '0.62.1', '--verbosity': '3' }; }
  if (result.kind === 'bounded-model-check') { command = 'verify'; file = config.specification;
    flags = { ...common, '--main': main, '--backend': 'apalache', '--max-steps': String(config.profiles[profile]?.apalacheDepth[main]), '--apalache-version': '0.62.1', '--verbosity': '3' }; }
  if (result.kind === 'model-negative') { command = 'verify'; file = config.negativeSpecification;
    flags = { ...common, '--main': main, '--backend': 'apalache', '--max-steps': String(config.mutants.find(row => row.main === main)?.maxSteps), '--apalache-version': '0.62.1' }; }
  if (result.kind === 'model-witness') { command = 'test'; file = config.witnesses.specification;
    flags = { '--main': main, '--backend': 'typescript', '--seed': config.witnesses.seed, '--max-samples': String(config.witnesses.maxSamples) }; }
  if (result.kind === 'simulation') { command = 'run'; file = config.specification;
    flags = { ...common, '--main': main, '--backend': 'typescript', '--seed': config.simulation.seed,
      '--max-samples': String(config.simulation.samples), '--n-traces': String(config.simulation.selectedTraces), '--max-steps': String(config.simulation.maximumSteps), '--verbosity': '1' }; }
  return command ? { prefix: [cli, command, paths.join(modelRoot, file)], flags } : null;
}
function validCommand(result, config, profile, repositoryRoot) {
  const shape = playbackCommandShape(result, config, profile, repositoryRoot), argv = result.argv;
  if (!shape || !Array.isArray(argv) || !isDeepStrictEqual(argv.slice(0, 3), shape.prefix)) return false;
  if (!Object.entries(shape.flags).every(([key, value]) => argv.filter(arg => arg === key).length === 1 && argv[argv.indexOf(key) + 1] === value)) return false;
  const extras = ['--server-endpoint', '--out-itf'];
  const keys = argv.slice(3).filter((_, index) => index % 2 === 0);
  if (argv.slice(3).length % 2 || new Set(keys).size !== keys.length || keys.some(key => !Object.hasOwn(shape.flags, key) && !extras.includes(key))) return false;
  if (['finite-state-complete', 'bounded-model-check', 'model-negative'].includes(result.kind) &&
      !/^127\.0\.0\.1:\d+$/.test(argv[argv.indexOf('--server-endpoint') + 1])) return false;
  if (['model-witness', 'simulation', 'model-negative'].includes(result.kind) &&
      (argv.indexOf('--out-itf') < 0 || typeof argv[argv.indexOf('--out-itf') + 1] !== 'string' || !argv[argv.indexOf('--out-itf') + 1].endsWith('.itf.json'))) return false;
  return true;
}

export async function validatePlaybackEvidence(directory, options = {}) {
  const summary = await validateFormalEvidence(directory, playbackEvidenceDefinition, options);
  let report;
  try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); }
  catch { return summary; }
  if (!Array.isArray(report.results) || !Array.isArray(report.artifacts)) return summary;
  const config = await loadPlaybackConfig(), repositoryRoot = report.execution?.repositoryRoot;
  if (!validPlaybackRepositoryRoot(repositoryRoot)) summary.reasons.push('invalid_repository_root');
  const root = validPlaybackRepositoryRoot(repositoryRoot) ? repositoryRoot : process.cwd(), paths = repositoryPaths(root);
  const fail = (id, reason) => { const row = summary.rows.find(entry => entry.id === id); if (row) { row.status = 'incomplete'; row.reasons ||= []; row.reasons.push(reason); } else summary.reasons.push(reason); };
  if (!isDeepStrictEqual(report.results.map(row => row.id).sort(), formalPlan(config).map(row => row.id).sort())) summary.reasons.push('wrong_exact_driver_plan');
  const verified = async file => {
    if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Invalid artifact path');
    const entry = report.artifacts.filter(row => row.path === file); if (entry.length !== 1) throw new Error('Missing artifact');
    const bytes = await readFile(path.join(directory, file)); if (digest(bytes) !== entry[0].sha256) throw new Error('Changed artifact'); return bytes.toString('utf8');
  };
  for (const result of report.results) {
    if (playbackCommandShape(result, config, report.profile, root) && !validCommand(result, config, report.profile, root)) fail(result.id, 'wrong_formal_command');
    if (['finite-state-complete', 'bounded-model-check'].includes(result.kind)) {
      try {
        const bound = config.profiles[report.profile]?.apalacheDepth[result.id.replace(/^bounded-/, '')];
        const checked = checkerConclusion(result.kind, result.execution, await verified(result.log), bound);
        if (!isDeepStrictEqual(result.metrics, checked.metrics) || (result.kind === 'bounded-model-check' && result.bound !== bound)) fail(result.id, 'wrong_checker_metrics');
      } catch { fail(result.id, 'missing_checker_metrics'); }
    }
    if (result.kind === 'implementation-regression') {
      try {
        const metrics = tapMetrics(await verified(result.log));
        if (!metrics.tapComplete || metrics.tests !== config.regression.expectedTests || metrics.passed !== config.regression.expectedTests ||
            metrics.failed || metrics.skipped || metrics.todo || metrics.cancelled || config.regression.expectedTests < 1) fail(result.id, 'wrong_strict_regression_count');
        const expected = ['--test', '--test-reporter=tap', '--test-timeout=30000', ...config.regression.files.map(file => paths.join(root, file))];
        if (!isDeepStrictEqual(result.argv, expected)) fail(result.id, 'wrong_regression_driver');
      } catch { fail(result.id, 'missing_regression_artifact'); }
    }
    if (result.kind === 'model-witness') {
      const main = result.id.replace(/^witnesses-/, '');
      const source = await readFile(path.join(playbackModelRoot, 'witnesses.qnt'), 'utf8');
      const module = [...source.matchAll(/module (\w+) \{([\s\S]*?)(?=\nmodule |$)/g)].find(row => row[1] === main);
      const expected = module ? [...module[2].matchAll(/\brun (\w+)\s*=/g)].map(row => row[1]).sort() : [];
      const found = (result.traces || []).map(file => path.basename(file).slice(main.length + 1).replace(/-\d+\.itf\.json$/, '')).sort();
      if (!isDeepStrictEqual(found, expected)) fail(result.id, 'wrong_named_witnesses');
    }
    if (['implementation-replay', 'implementation-negative'].includes(result.kind)) {
      try {
        const replays = JSON.parse(await verified(result.data));
        if (result.samples !== replays.length || result.steps !== replays.reduce((count, replay) => count + replay.steps, 0)) fail(result.id, 'wrong_replay_counts');
        for (const replay of replays) {
          const source = report.results.find(row => ['model-witness', 'simulation'].includes(row.kind) && row.traces?.includes(replay.sourceTrace));
          if (!source) throw new Error('Missing replay source');
          const trace = normalizePlaybackTrace(JSON.parse(await verified(replay.sourceTrace)), playbackTraceConfig(source.id));
          if (auditPlaybackReplay(replay, trace.config).length) fail(result.id, 'invalid_raw_playback_observations');
          if (result.kind === 'implementation-negative' && !expectedPlaybackCounterexample(replay)) fail(result.id, 'invalid_actual_owner_counterexample');
        }
      } catch { fail(result.id, 'missing_raw_playback_observations'); }
    }
  }
  summary.ok = !summary.reasons.length && summary.rows.every(row => row.status === 'passed');
  summary.propertyRows = playbackCoverage(config).map(property => ({ ...property, status: !summary.reasons.length && property.checks.every(id => summary.rows.find(row => row.id === id)?.status === 'passed') ? 'passed' : 'incomplete' }));
  return summary;
}
