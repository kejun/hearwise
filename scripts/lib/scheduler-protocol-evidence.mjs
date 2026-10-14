import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { isDeepStrictEqual as equal } from 'node:util';
import { digest } from './verification-evidence.mjs';
import { tapMetrics } from './tap-summary.mjs';
import { normalizeSchedulerTrace } from './scheduler-protocol-replay.mjs';
import { validateSchedulerReplayEvidence } from './scheduler-replay-evidence.mjs';
import { checkTlcOutput } from '../../verification/scheduler-protocol/checker.mjs';
import { properties } from '../../verification/scheduler-protocol/properties.mjs';

export const schedulerRepositoryRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
export const schedulerRoot = path.join(schedulerRepositoryRoot, 'verification/scheduler-protocol');
export const loadSchedulerConfig = async () => JSON.parse(await readFile(path.join(schedulerRoot, 'config.json'), 'utf8'));
// Freeze the expected roster and complete test count. Changing a regression suite
// requires updating its declared count after running that file independently.
export const schedulerRegressionCounts = Object.freeze({
  'test/scheduler-service.test.mjs': 16,
  'test/scheduler-knowledge.test.mjs': 10,
  'test/scheduler-boundaries.test.mjs': 5,
  'test/scheduler-trace.test.mjs': 18,
  'test/scheduler-replay-evidence.test.mjs': 40,
  'test/scheduler-model-checker.test.mjs': 38,
  'test/scheduler-protocol-evidence.test.mjs': 42
});
export const schedulerRegressionFiles = Object.freeze(Object.keys(schedulerRegressionCounts));
export const schedulerRegressionTestCount = Object.values(schedulerRegressionCounts).reduce((sum, count) => sum + count, 0);
export function schedulerCommandCwd(entry, directory) {
  return entry.kind === 'implementation-regression' ? schedulerRepositoryRoot : path.join(directory, 'work', entry.id);
}
export async function schedulerFiles(folder = schedulerRoot, prefix = '') {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await schedulerFiles(path.join(folder, entry.name), `${prefix}${entry.name}/`));
    else if (entry.isFile()) files.push(`${prefix}${entry.name}`);
    else throw new Error('Unsupported scheduler input file type');
  }
  return files.sort();
}
// The runtime is generated and ignored by Git, but is executed by both real
// scheduler adapters. Source maps and browser vendor output are not executed here.
export const schedulerRequiredRuntimeInputs = Object.freeze(['dist/server/index.js']);
export async function schedulerSourceDigests(repositoryRoot = schedulerRepositoryRoot, requiredInputs = schedulerRequiredRuntimeInputs) {
  const listed = execFileSync('git', ['-C', repositoryRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', timeout: 5000 }).split('\0').filter(Boolean);
  const files = [...new Set([...listed, ...requiredInputs])].sort(), sources = {};
  for (const file of files) {
    const absolute = path.join(repositoryRoot, file);
    let info;
    try { info = await lstat(absolute); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`Missing scheduler source input: ${file}`); throw error; }
    if (info.isFile()) sources[file] = digest(await readFile(absolute));
    else if (requiredInputs.includes(file)) throw new Error(`Scheduler source input is not a regular file: ${file}`);
  }
  return sources;
}
export async function schedulerMetadata() {
  const files = await schedulerFiles();
  const sources = await Promise.all(files.map(async file => [file, await readFile(path.join(schedulerRoot, file), 'utf8')]));
  const { createTaskRuntime } = await import(pathToFileURL(path.join(schedulerRepositoryRoot, 'dist/server/index.js')).href);
  const runtime = createTaskRuntime({ enabled: false });
  let runtimeBuild;
  try { runtimeBuild = structuredClone(runtime.diagnostics().build); }
  finally { await runtime.dispose(); }
  return { runtimeBuild, schemaVersion: 1, specificationVersion: '1.0', modelVersion: 1, source: { sha: execFileSync('git', ['-C', schedulerRepositoryRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim(), dirty: Boolean(execFileSync('git', ['-C', schedulerRepositoryRoot, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', timeout: 5000 }).trim()) },
    sourceDigests: await schedulerSourceDigests(),
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release() },
    modelDigest: digest(JSON.stringify(sources)), lockDigest: digest(await readFile(path.join(schedulerRepositoryRoot, 'package-lock.json'))),
    serverSha256: digest(await readFile(path.join(schedulerRepositoryRoot, 'server.mjs'))) };
}
export function schedulerPlan(config, modelFiles) {
  return [
    ...modelFiles.filter(file => file.endsWith('.qnt')).sort().map(file => ({ id: `typecheck-${file.slice(0, -4)}`, kind: 'typecheck', specification: file })),
    ...config.checks.map(check => ({ ...check, kind: check.kind === 'temporal' ? 'temporal-model-check' : 'finite-model-check', checkKind: check.kind })),
    ...config.witnesses.roster.map(row => ({ id: `witnesses-${row.main}`, kind: 'model-witness', ...row })),
    { id: 'simulation', kind: 'simulation' }, { id: 'replay-witnesses', kind: 'implementation-replay' },
    { id: 'replay-simulation', kind: 'implementation-replay' }, { id: 'negative-replay', kind: 'implementation-negative' },
    { id: 'implementation-regressions', kind: 'implementation-regression' }
  ];
}
export function schedulerCoverage(config, plan) {
  const common = plan.filter(row => ['typecheck', 'implementation-replay', 'implementation-regression'].includes(row.kind)).map(row => row.id);
  return properties.map(property => ({ id: property.id, version: property.version, acceptance: property.acceptance,
    checks: [...new Set([...common, ...property.checks, ...config.witnesses.roster.filter(row => row.tests.some(test => property.deterministicWitnesses.includes(test))).map(row => `witnesses-${row.main}`), ...(property.id === 'HW-03-02' ? ['negative-replay'] : [])])] }));
}
const interval = row => typeof row?.startedAt === 'string' && typeof row?.finishedAt === 'string' && Number.isFinite(Date.parse(row.startedAt)) && Number.isFinite(Date.parse(row.finishedAt)) && Date.parse(row.startedAt) <= Date.parse(row.finishedAt);
const absoluteDirectory = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
const isolatedCwd = (cwd, id) => absoluteDirectory(cwd) && path.basename(cwd) === id && path.basename(path.dirname(cwd)) === 'work';
const exited = execution => execution && execution.timedOut === false && execution.interrupted === false && execution.signal === null && Number.isInteger(execution.code);
export function schedulerHeaderReasons(report, target, config, coverage, release = false) {
  const reasons = [];
  if (report?.schemaVersion !== target.schemaVersion || report.specificationVersion !== target.specificationVersion || report.modelVersion !== target.modelVersion) reasons.push('invalid_contract');
  for (const key of ['modelDigest', 'lockDigest', 'serverSha256']) if (report?.[key] !== target[key]) reasons.push('stale');
  if (!report?.sourceDigests || !target.sourceDigests || !Object.keys(target.sourceDigests).length || !equal(report.sourceDigests, target.sourceDigests)) reasons.push('stale');
  if (report?.source?.sha !== target.source.sha) reasons.push('stale');
  const validBuild = build => build && /^[a-f0-9]{40}$/.test(build.git_sha) && typeof build.build_dirty === 'boolean' && build.instrumentation_version === 3;
  if (!validBuild(report?.runtimeBuild) || !validBuild(target.runtimeBuild) || !equal(report.runtimeBuild, target.runtimeBuild)) reasons.push('invalid_runtime_build');
  if (release && (report?.runtimeBuild?.git_sha !== report?.source?.sha || target.runtimeBuild?.git_sha !== target.source.sha || report?.runtimeBuild?.build_dirty !== false || target.runtimeBuild?.build_dirty !== false)) reasons.push('stale_or_uncommitted_runtime_build');
  if (release && (report?.source?.dirty !== false || target.source.dirty !== false)) reasons.push('uncommitted_source');
  if (report?.complete !== true || report.execution?.complete !== true || !exited(report.execution) || report.execution.code !== 0) reasons.push('incomplete_execution');
  if (!absoluteDirectory(report?.execution?.repositoryRoot)) reasons.push('missing_execution_origin');
  if (!interval(report)) reasons.push('invalid_timestamps');
  if (!['platform', 'arch', 'osRelease'].every(key => typeof report?.environment?.[key] === 'string' && report.environment[key])) reasons.push('missing_environment');
  if (!equal(report?.domain, config)) reasons.push('invalid_domain');
  if (!equal(report?.propertyCoverage, coverage)) reasons.push('invalid_property_coverage');
  if (!['fast', 'deep'].includes(report?.profile)) reasons.push('invalid_profile');
  return [...new Set(reasons)];
}
export function schedulerCommandConclusion(entry, execution, log, config, profile) {
  if (!exited(execution)) return { ok: false, complete: false, metrics: null };
  if (['finite-model-check', 'temporal-model-check'].includes(entry.kind)) {
    try { const conclusion = checkTlcOutput(log, { exitCode: execution.code, signal: execution.signal, timedOut: execution.timedOut }, config.checks.find(check => check.id === entry.id)); return { ok: true, complete: true, metrics: conclusion }; }
    catch (error) { return { ok: false, complete: execution.code !== 0, metrics: null, error: error.message }; }
  }
  if (entry.kind === 'implementation-regression') {
    const metrics = tapMetrics(log);
    return { ok: execution.code === 0 && metrics.tapComplete && metrics.failed === 0 && metrics.tests === schedulerRegressionTestCount, complete: metrics.tapComplete, metrics };
  }
  if (entry.kind === 'model-witness') {
    const count = Number(log.match(/(?:^|\n)\s*(\d+) passing\b/)?.[1]);
    return { ok: execution.code === 0 && count === entry.count && !/\d+ failing\b/.test(log), complete: execution.code === 0, metrics: { tests: count } };
  }
  if (entry.kind === 'simulation') return { ok: execution.code === 0 && /\[ok\] No violation found/.test(log), complete: execution.code === 0, metrics: config.profiles[profile].simulation };
  return { ok: execution.code === 0, complete: execution.code === 0, metrics: null };
}
function exactOptions(argv, options) {
  const expected = new Map(options);
  if (argv.length !== 3 + expected.size * 2) return false;
  for (let index = 3; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!expected.has(key)) return false;
    const requirement = expected.get(key);
    if (typeof requirement === 'function' ? !requirement(value) : value !== requirement) return false;
    expected.delete(key);
  }
  return expected.size === 0;
}
const serverEndpoint = value => /^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value) && Number(value.split(':')[1]) <= 65535;
export function schedulerCommandBound(entry, argv, config, profile, cwd, repositoryRoot = schedulerRepositoryRoot) {
  if (!absoluteDirectory(repositoryRoot) || !Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false;
  if (entry.kind === 'implementation-regression') return cwd === repositoryRoot && equal(argv, ['--test', '--test-reporter=tap', '--test-timeout=30000', ...schedulerRegressionFiles.map(file => path.join(repositoryRoot, file))]);
  if (!isolatedCwd(cwd, entry.id) || argv[0] !== path.join(repositoryRoot, 'node_modules/@informalsystems/quint/dist/src/cli.js')) return false;
  const modelRoot = path.join(repositoryRoot, 'verification/scheduler-protocol'), evidenceRoot = path.dirname(path.dirname(cwd));
  if (entry.kind === 'typecheck') return equal(argv.slice(1), ['typecheck', path.join(modelRoot, entry.specification)]);
  if (entry.kind === 'model-witness') return argv[1] === 'test' && argv[2] === path.join(modelRoot, config.witnesses.specification) && exactOptions(argv, [
    ['--main', entry.main], ['--backend', 'typescript'], ['--seed', config.witnesses.seed], ['--max-samples', String(config.witnesses.maxSamples)],
    ['--out-itf', path.join(evidenceRoot, 'witnesses', entry.main, `${entry.main}-{test}-{seq}.itf.json`)]
  ]);
  if (entry.kind === 'simulation') {
    const simulation = config.simulation, sample = config.profiles[profile].simulation;
    return argv[1] === 'run' && argv[2] === path.join(modelRoot, simulation.specification) && exactOptions(argv, [
      ['--main', simulation.main], ['--init', simulation.init], ['--step', simulation.step], ['--invariant', simulation.invariant], ['--backend', 'typescript'],
      ['--seed', sample.seed], ['--max-samples', String(sample.samples)], ['--max-steps', String(sample.maxSteps)], ['--n-traces', String(sample.selectedTraces)],
      ['--verbosity', '1'], ['--out-itf', path.join(evidenceRoot, 'simulation', `${simulation.main}-{seq}.itf.json`)]
    ]);
  }
  return argv[1] === 'verify' && argv[2] === path.join(modelRoot, entry.specification) && exactOptions(argv, [
    ['--main', entry.main], ['--init', entry.init], ['--step', entry.step], [entry.temporal ? '--temporal' : '--invariant', entry.temporal || entry.invariant],
    ['--backend', 'tlc'], ['--apalache-version', '0.62.1'], ['--tlc-config', path.join(modelRoot, 'tlc.json')], ['--server-endpoint', serverEndpoint], ['--verbosity', '3']
  ]);
}
export const schedulerDiagnosticContract = Object.freeze({ specification: 'configurations.qnt', main: 'translation_small', init: 'Init', step: 'Step', invariant: 'Safety', backend: 'apalache', bound: 4, toolVersion: '0.62.1', required: false });
function diagnosticCommandBound(argv, cwd, repositoryRoot) {
  return absoluteDirectory(repositoryRoot) && isolatedCwd(cwd, 'apalache-diagnostic') && Array.isArray(argv) && argv.every(value => typeof value === 'string') &&
    argv[0] === path.join(repositoryRoot, 'node_modules/@informalsystems/quint/dist/src/cli.js') && argv[1] === 'verify' && argv[2] === path.join(repositoryRoot, 'verification/scheduler-protocol/configurations.qnt') && exactOptions(argv, [
      ['--main', 'translation_small'], ['--init', 'Init'], ['--step', 'Step'], ['--invariant', 'Safety'], ['--backend', 'apalache'], ['--max-steps', '4'],
      ['--apalache-version', '0.62.1'], ['--server-endpoint', serverEndpoint], ['--verbosity', '3']
    ]);
}
function rawBoundedProof(log) {
  const prefix = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2},\\d{3} \\[[^\\]\\r\\n]+\\] ';
  const match = (level, logger, message) => log.match(new RegExp(`${prefix}${level} +${logger} - ${message}\\r?$`, 'm'));
  if (!match('INFO', 'a\\.f\\.a\\.t\\.Tool\\$', '# APALACHE version: 0\\.62\\.1 \\| build: [^\\r\\n]+')) return false;
  let previous = -1;
  for (let step = 0; step <= 4; step++) {
    const found = match('INFO', 'a\\.f\\.a\\.t\\.b\\.t\\.TransitionExecutorImpl', `Step ${step}: picking a transition out of [1-9][0-9]* transition\\(s\\)`);
    if (!found || found.index <= previous) return false;
    previous = found.index;
  }
  const outcome = match('INFO', 'a\\.f\\.a\\.t\\.b\\.p\\.BoundedCheckerPassImpl', 'The outcome is: NoError');
  const complete = match('DEBUG', 'a\\.f\\.a\\.i\\.p\\.PassChainExecutor', 'PASS #[0-9]+: BoundedChecker \\[OK\\]');
  return Boolean(outcome && outcome.index > previous && complete && complete.index > outcome.index &&
    !/\bERROR\b|The outcome is: (?!NoError\b)|\[FAIL(?:ED)?\]|key not found: \$C\$/.test(log));
}
export function schedulerDiagnosticStatus(execution, logs) {
  if (execution?.timedOut === true) return 'incomplete_timeout';
  if (execution?.interrupted === true || execution?.signal != null) return 'incomplete_interrupted';
  if (logs.some(log => /key not found: \$C\$/.test(log))) return 'incomplete_backend_error';
  return exited(execution) && execution.code === 0 && !logs.some(log => /\bERROR\b|The outcome is: (?!NoError\b)|\[FAIL(?:ED)?\]/.test(log)) && logs.some(rawBoundedProof) ? 'bounded_passed' : 'incomplete_tool_failure';
}
export function validateSchedulerDiagnostic(diagnostic, { target, artifacts, repositoryRoot = schedulerRepositoryRoot }) {
  if (!diagnostic) return { ok: false, reasons: ['missing_bounded_diagnostic'], status: 'not_run', passed: false, required: false };
  const reasons = [];
  if (!Object.entries(schedulerDiagnosticContract).every(([key, value]) => diagnostic[key] === value) || diagnostic.modelDigest !== target.modelDigest || diagnostic.sourceSha !== target.source.sha || !interval(diagnostic)) reasons.push('wrong_bounded_diagnostic_binding');
  if (!diagnosticCommandBound(diagnostic.argv, diagnostic.cwd, repositoryRoot)) reasons.push('wrong_bounded_diagnostic_command');
  const execution = diagnostic.execution;
  if (!execution || typeof execution.timedOut !== 'boolean' || typeof execution.interrupted !== 'boolean' || !(execution.code === null || Number.isInteger(execution.code)) || !(execution.signal === null || typeof execution.signal === 'string' && execution.signal.length > 0)) reasons.push('invalid_bounded_diagnostic_execution');
  const logsValid = Array.isArray(diagnostic.logs) && diagnostic.logs.length > 0 && new Set(diagnostic.logs).size === diagnostic.logs.length && diagnostic.logs.every(file => typeof file === 'string' && typeof artifacts.get(file) === 'string');
  if (!logsValid) reasons.push('missing_bounded_diagnostic_log');
  const status = schedulerDiagnosticStatus(execution, logsValid ? diagnostic.logs.map(file => artifacts.get(file)) : []);
  if (diagnostic.status !== status) reasons.push('wrong_bounded_diagnostic');
  return { ok: reasons.length === 0, reasons, status: reasons.length ? 'incomplete_invalid_evidence' : status, passed: reasons.length === 0 && status === 'bounded_passed', required: false };
}
export async function validateSchedulerEvidence(directory, { release = false, requireProfile } = {}) {
  const config = await loadSchedulerConfig(), files = await schedulerFiles(), plan = schedulerPlan(config, files), coverage = schedulerCoverage(config, plan), target = await schedulerMetadata();
  let report;
  try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); }
  catch { return { ok: false, reasons: ['missing_or_invalid_report'], rows: plan.map(row => ({ id: row.id, status: 'not_run' })), target }; }
  if (!report || !Array.isArray(report.results) || !Array.isArray(report.artifacts)) return { ok: false, reasons: ['invalid_report_shape'], rows: [], target };
  const reasons = schedulerHeaderReasons(report, target, config, coverage, release);
  const effectiveProfile = ['fast', 'deep'].includes(report.profile) ? report.profile : 'fast';
  if (requireProfile && report.profile !== requireProfile) reasons.push('wrong_profile');
  const toolchain = JSON.parse(await readFile(path.join(schedulerRoot, 'toolchain.json'), 'utf8'));
  const javaMajor = Number(report.tools?.java?.match(/version\s+"(\d+)/)?.[1]);
  if (report.tools?.quint !== toolchain.quint.version || report.tools?.apalache !== toolchain.apalache.version || report.tools?.tlc !== toolchain.apalache.bundledTlcVersion || report.tools?.apalacheJarSha256 !== toolchain.apalache.jarSha256 || report.tools?.apalacheArchiveSha256 !== toolchain.apalache.archiveSha256 || !(javaMajor >= toolchain.java.minimumMajor) || !/^v24\./.test(report.tools?.node || '') || !report.tools?.sqlite) reasons.push('invalid_toolchain');
  const artifacts = new Map();
  for (const artifact of report.artifacts) {
    if (!artifact || typeof artifact.path !== 'string' || path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes('..') || artifacts.has(artifact.path)) { reasons.push('invalid_artifact'); continue; }
    try { const text = await readFile(path.join(directory, artifact.path), 'utf8'); if (digest(text) !== artifact.sha256) reasons.push('changed_artifact'); else artifacts.set(artifact.path, text); }
    catch { reasons.push('missing_artifact'); }
  }
  const serverSource = await readFile(path.join(schedulerRepositoryRoot, 'server.mjs'), 'utf8'), rows = [], sources = new Map();
  for (const entry of plan) {
    const found = report.results.filter(row => row?.id === entry.id), failures = [];
    if (found.length !== 1) failures.push('missing_or_duplicate_result');
    else {
      const result = found[0], log = artifacts.get(result.log);
      if (result.kind !== entry.kind || result.status !== 'passed' || result.complete !== true || !interval(result)) failures.push('incomplete_result');
      if (log == null) failures.push('missing_log');
      if (!['implementation-replay', 'implementation-negative'].includes(entry.kind)) {
        if (!schedulerCommandBound(entry, result.argv, config, effectiveProfile, result.cwd, report.execution?.repositoryRoot)) failures.push('wrong_command');
        const conclusion = schedulerCommandConclusion(entry, result.execution, log || '', config, effectiveProfile);
        if (!conclusion.ok || !equal(result.metrics, conclusion.metrics)) failures.push('raw_check_not_passed');
      }
      if (['model-witness', 'simulation'].includes(entry.kind)) {
        const count = entry.kind === 'model-witness' ? entry.count : config.profiles[report.profile]?.simulation.selectedTraces;
        if (!Array.isArray(result.traces) || result.traces.length !== count || new Set(result.traces).size !== count) failures.push('missing_or_duplicate_trace');
        const names = [];
        for (const file of result.traces || []) {
          try {
            const raw = artifacts.get(file), traceConfig = entry.kind === 'model-witness' ? entry.traceConfig : config.simulation.traceConfig;
            const trace = normalizeSchedulerTrace(JSON.parse(raw), traceConfig);
            if (entry.kind === 'model-witness') { const match = path.basename(file).match(new RegExp(`^${entry.main}-(.+)-[0-9]+\\.itf\\.json$`)); if (!match) throw new Error('Wrong witness filename'); names.push(match[1]); }
            sources.set(file, { raw, trace, kind: entry.kind });
          } catch { failures.push('invalid_trace'); }
        }
        if (entry.kind === 'model-witness' && !equal(names.sort(), [...entry.tests].sort())) failures.push('wrong_witness_roster');
      }
      if (['implementation-replay', 'implementation-negative'].includes(entry.kind)) {
        try {
          const replays = JSON.parse(artifacts.get(result.data));
          const expected = [...sources].filter(([file, source]) => entry.kind === 'implementation-negative' ? source.kind === 'model-witness' && file.includes('-activeFinalsRejectInterimTest-') : source.kind === (entry.id === 'replay-witnesses' ? 'model-witness' : 'simulation')).map(([file]) => file).sort();
          if (!Array.isArray(replays) || !expected.length || !equal(replays.map(row => row.sourceTrace).sort(), expected)) throw new Error('Replay source mismatch');
          for (const replay of replays) {
            const source = sources.get(replay.sourceTrace);
            if (replay.sourceTraceSha256 !== digest(source.raw) || replay.semanticTraceSha256 !== digest(JSON.stringify(source.trace)) || replay.steps !== source.trace.steps.length || !interval(replay)) failures.push('wrong_replay_binding');
            const gate = validateSchedulerReplayEvidence(source.trace, replay, { serverSource, mutation: entry.kind === 'implementation-negative' ? 'interim_queue_only' : 'none' });
            if (!gate.ok) failures.push(...gate.reasons);
          }
        } catch { failures.push('missing_or_invalid_replay'); }
      }
    }
    rows.push({ id: entry.id, kind: entry.kind, status: failures.length ? 'incomplete' : 'passed', reasons: [...new Set(failures)] });
  }
  if (report.results.length !== plan.length) reasons.push('unexpected_result_roster');
  const diagnostic = report.diagnostics?.apalache;
  const diagnosticGate = validateSchedulerDiagnostic(diagnostic, { target, artifacts, repositoryRoot: report.execution?.repositoryRoot });
  reasons.push(...diagnosticGate.reasons);
  return { ok: !reasons.length && rows.every(row => row.status === 'passed'), complete: report.complete, profile: report.profile, reasons: [...new Set(reasons)], rows,
    propertyRows: coverage.map(property => ({ ...property, status: !reasons.length && property.checks.every(id => rows.find(row => row.id === id)?.status === 'passed') ? 'passed' : 'incomplete' })),
    boundedDiagnostic: diagnosticGate.status, otherProfiles: ['fast', 'deep'].filter(profile => profile !== report.profile).map(profile => ({ profile, status: 'not_run_in_this_report' })), fullProjectAcceptance: false, target };
}
