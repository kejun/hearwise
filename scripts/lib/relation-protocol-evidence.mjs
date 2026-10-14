import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { normalizeProtocolTrace } from './protocol-replay.mjs';
import { properties } from '../../verification/relation-protocol/properties.mjs';

export const modelFiles = ['protocol.qnt', 'configurations.qnt', 'witnesses.qnt', 'config.json', 'tlc.json', 'toolchain.json', 'properties.mjs'];
export const modelRoot = path.resolve('verification/relation-protocol');
export async function protocolMetadata() {
  const contents = await Promise.all(modelFiles.map(async file => [file, await readFile(path.join(modelRoot, file), 'utf8')]));
  return { schemaVersion: 1, source: sourceVersion(), specificationVersion: '1.0', modelVersion: 1,
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release() },
    modelDigest: digest(JSON.stringify(contents)), lockDigest: digest(await readFile('package-lock.json')) };
}
export function protocolPlan(config) {
  const mains = [config.single.main, ...config.multiple.mains.map(row => row.main)];
  return [
    ...['protocol', 'configurations', 'witnesses'].map(name => ({ id: `typecheck-${name}`, kind: 'typecheck' })),
    ...mains.flatMap(main => [{ id: `tlc-${main}`, kind: 'finite-state-complete' }, { id: `bounded-${main}`, kind: 'bounded-model-check' }]),
    ...config.witnesses.mains.map(main => ({ id: `witnesses-${main}`, kind: 'model-witness' })),
    ...mains.map(main => ({ id: `simulation-${main}`, kind: 'simulation' })),
    ...config.mutants.map(row => ({ id: `negative-${row.main}`, kind: 'model-negative' })),
    { id: 'replay-witnesses', kind: 'implementation-replay' }, { id: 'replay-simulation', kind: 'implementation-replay' },
    { id: 'negative-replay', kind: 'implementation-negative' }, { id: 'implementation-regressions', kind: 'implementation-regression' }
  ];
}
export function protocolCoverage(config) {
  const plan = protocolPlan(config), common = plan.filter(row => !['model-negative', 'implementation-negative'].includes(row.kind)).map(row => row.id);
  const controls = { 'HW-04-02': ['negative-mutant_send_without_reserve', 'negative-replay'], 'HW-04-03': ['negative-mutant_fourth_request'],
    'HW-04-04': ['negative-mutant_retry_commit_failure'], 'HW-04-05': [] };
  return properties.map(property => ({ id: property.id, version: property.version, acceptance: property.acceptance, checks: [...common, ...controls[property.id]] }));
}
const validInterval = value => typeof value?.startedAt === 'string' && typeof value?.finishedAt === 'string' &&
  Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.finishedAt)) && Date.parse(value.finishedAt) >= Date.parse(value.startedAt);
export function checkerConclusion(kind, execution, log, bound) {
  if (!execution || execution.timedOut !== false || execution.interrupted !== false || execution.signal != null || !Number.isInteger(execution.code)) return { ok: false, complete: false };
  if (kind === 'model-negative') return { ok: execution.code !== 0 && /found a counterexample/i.test(log), complete: true };
  if (execution.code !== 0) return { ok: false, complete: true };
  if (kind === 'finite-state-complete') {
    const states = log.match(/([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue/);
    const depth = log.match(/depth of the complete state graph search is (\d+)/);
    return { ok: Boolean(/Model checking completed\. No error has been found\./.test(log) && states && Number(states[3].replaceAll(',', '')) === 0 && depth),
      complete: Boolean(states && Number(states[3].replaceAll(',', '')) === 0),
      metrics: states && depth ? { generatedStates: Number(states[1].replaceAll(',', '')), distinctStates: Number(states[2].replaceAll(',', '')), remainingStates: Number(states[3].replaceAll(',', '')), graphDepth: Number(depth[1]) } : null };
  }
  if (kind === 'bounded-model-check') return { ok: /The outcome is: NoError/.test(log) && /\[ok\] No violation found/.test(log) && new RegExp(`Step ${bound}:`).test(log), complete: true, metrics: { maximumDepth: bound } };
  if (kind === 'implementation-regression') {
    const metric = name => Number(log.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
    const tests = metric('tests'), passed = metric('pass');
    return { ok: /^TAP version 13$/m.test(log) && tests > 0 && passed === tests && ['fail', 'cancelled', 'skipped', 'todo'].every(name => metric(name) === 0), complete: true, metrics: { tests, passed } };
  }
  if (kind === 'simulation') return { ok: /\[ok\] No violation found/.test(log), complete: true };
  return { ok: true, complete: true };
}
export function expectedMutationViolation(main, itf) {
  const trace = normalizeProtocolTrace(itf, { actors: 1, capacity: 1 });
  const states = [trace.initial, ...trace.steps.map(step => step.expected)];
  const matches = state => main === 'mutant_send_without_reserve' ? state.calls[0] > state.counts[0] :
    main === 'mutant_retry_commit_failure' ? ['ok', 'empty', 'filtered'].includes(state.replies[0]) && state.phase[0] === 'retry_wait' :
    main === 'mutant_fourth_request' ? state.counts[0] >= 3 && state.phase[0] === 'retry_wait' : false;
  const step = states.findIndex(matches);
  return { ok: step >= 0, classification: 'model_violation', firstViolationState: step, traceLength: trace.steps.length };
}

// Recompute the gate from the current checked-in plan and raw artifacts. Cached
// report.ok, required lists, and counts cannot turn absent evidence into a pass.
export async function validateProtocolEvidence(directory, { release = false, requireProfile } = {}) {
  const config = JSON.parse(await readFile(path.join(modelRoot, 'config.json'), 'utf8'));
  const target = await protocolMetadata(), plan = protocolPlan(config), reasons = [];
  const pinned = JSON.parse(await readFile(path.join(modelRoot, 'toolchain.json'), 'utf8'));
  let report;
  try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); }
  catch { return { ok: false, reasons: ['missing_or_invalid_report'], rows: plan.map(row => ({ ...row, status: 'not_run' })), target }; }
  if (!report || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.results) || !Array.isArray(report.artifacts) ||
    [...report.results, ...report.artifacts].some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    return { ok: false, reasons: ['invalid_report_shape'], rows: plan.map(row => ({ ...row, status: 'incomplete' })), target };
  }
  const profile = Object.hasOwn(config.profiles, report.profile) ? config.profiles[report.profile] : null;
  if (!profile || (requireProfile && requireProfile !== report.profile)) reasons.push('invalid_profile');
  if (report.schemaVersion !== 1 || report.specificationVersion !== target.specificationVersion || report.modelVersion !== target.modelVersion) reasons.push('invalid_contract');
  if (report.source?.sha !== target.source.sha || report.modelDigest !== target.modelDigest || report.lockDigest !== target.lockDigest) reasons.push('stale');
  if (release && (report.source?.dirty !== false || target.source.dirty !== false)) reasons.push('uncommitted_source');
  if (report.complete !== true || report.execution?.complete !== true || report.execution?.code !== 0 || report.execution?.signal !== null || report.execution?.timedOut !== false || report.execution?.interrupted !== false) reasons.push('incomplete_execution');
  if (!validInterval(report)) reasons.push('invalid_timestamps');
  if (!['platform', 'arch', 'osRelease'].every(key => typeof report.environment?.[key] === 'string' && report.environment[key])) reasons.push('missing_environment');
  if (!isDeepStrictEqual(report.propertyCoverage, protocolCoverage(config))) reasons.push('invalid_property_coverage');
  if (!isDeepStrictEqual(report.domain, config)) reasons.push('invalid_domain');
  const javaMajor = typeof report.tools?.java === 'string' ? report.tools.java.match(/version\s+"(\d+)/)?.[1] : null;
  if (report.tools?.quint !== pinned.quint.version || report.tools?.apalache !== pinned.apalache.version ||
    report.tools?.tlc !== pinned.apalache.bundledTlcVersion || report.tools?.apalacheJarSha256 !== pinned.apalache.jarSha256 ||
    report.tools?.apalacheArchiveSha256 !== pinned.apalache.archiveSha256 || !javaMajor || Number(javaMajor) < pinned.java.minimumMajor ||
    !/^v24\./.test(report.tools?.node || '') || !report.tools?.sqlite) reasons.push('invalid_toolchain');
  const artifacts = new Map();
  for (const artifact of report.artifacts || []) {
    if (typeof artifact.path !== 'string' || path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes('..') || artifacts.has(artifact.path)) { reasons.push('invalid_artifact'); continue; }
    try {
      const bytes = await readFile(path.join(directory, artifact.path));
      if (digest(bytes) !== artifact.sha256) reasons.push('changed_artifact');
      else artifacts.set(artifact.path, bytes.toString('utf8'));
    } catch { reasons.push('missing_artifact'); }
  }
  const rows = [];
  for (const entry of plan) {
    const found = (report.results || []).filter(row => row.id === entry.id), row = { ...entry, status: 'incomplete', reasons: [] };
    if (found.length !== 1) row.reasons.push(found.length ? 'duplicate_result' : 'missing_result');
    else {
      const result = found[0];
      if (!validInterval(result)) row.reasons.push('invalid_timestamps');
      if (result.kind !== entry.kind || result.complete !== true || result.status !== 'passed') row.reasons.push('not_passed');
      const log = artifacts.get(result.log);
      if (log == null) row.reasons.push('missing_log');
      else if (!['implementation-replay', 'implementation-negative'].includes(entry.kind)) {
        const main = entry.id.replace(/^bounded-/, '');
        if (!checkerConclusion(entry.kind, result.execution, log, profile?.apalacheDepth[main]).ok) row.reasons.push('raw_check_not_passed');
      }
      if (['model-witness', 'simulation', 'model-negative'].includes(entry.kind)) {
        const expectedCount = entry.kind === 'model-witness' ? config.witnesses.counts[entry.id.slice('witnesses-'.length)] : entry.kind === 'simulation' ? config.simulation.selectedTraces : 1;
        if (!Array.isArray(result.traces) || result.traces.length !== expectedCount || new Set(result.traces).size !== expectedCount) row.reasons.push('missing_or_duplicate_trace');
        for (const file of Array.isArray(result.traces) ? result.traces : []) {
          try {
            const itf = JSON.parse(artifacts.get(file));
            normalizeProtocolTrace(itf, { actors: entry.id.includes('multi_') ? 3 : 1, capacity: entry.id.includes('cap2') ? 2 : 1 });
            if (entry.kind === 'model-negative' && !expectedMutationViolation(entry.id.slice('negative-'.length), itf).ok) row.reasons.push('wrong_counterexample');
          } catch { row.reasons.push('invalid_trace'); }
        }
      }
      if (['implementation-replay', 'implementation-negative'].includes(entry.kind)) {
        try {
          const replays = JSON.parse(artifacts.get(result.data));
          const expectedKind = entry.id === 'replay-witnesses' ? 'model-witness' : 'simulation';
          const sourceTraces = (report.results || []).filter(row => row.kind === expectedKind).flatMap(row => row.traces || []);
          const expectedTraces = entry.kind === 'implementation-negative' ? (report.results || []).filter(row => row.kind === 'model-witness').flatMap(row => row.traces || []).filter(file => file.includes('normalSuccessTest-')) : sourceTraces;
          const expectedCount = entry.id === 'replay-witnesses' ? config.witnesses.expectedTestCount : entry.id === 'replay-simulation' ? config.simulation.selectedTraces * (config.multiple.mains.length + 1) : 1;
          if (!isDeepStrictEqual(replays.map(replay => replay.sourceTrace).sort(), [...expectedTraces].sort()) || new Set(replays.map(replay => replay.sourceTrace)).size !== expectedCount) row.reasons.push('wrong_replay_sources');
          for (const replay of replays) {
            const raw = artifacts.get(replay.sourceTrace), source = (report.results || []).find(row => row.traces?.includes(replay.sourceTrace) && ['model-witness', 'simulation'].includes(row.kind));
            const trace = normalizeProtocolTrace(JSON.parse(raw), { actors: source.id.includes('multi_') ? 3 : 1, capacity: source.id.includes('cap2') ? 2 : 1 });
            if (digest(raw) !== replay.sourceTraceSha256 || digest(JSON.stringify(trace)) !== replay.semanticTraceSha256 || trace.steps.length !== replay.steps) row.reasons.push('wrong_replay_identity');
            if (entry.kind === 'implementation-replay') {
              const states = [trace.initial, ...trace.steps.map(step => step.expected)];
              if (replay.observations?.length !== states.length || replay.observations.some((observation, index) => observation.step !== index - 1 || !isDeepStrictEqual(observation.actual, states[index]) || !Array.isArray(observation.durableViolations) || observation.durableViolations.length)) row.reasons.push('wrong_replay_observations');
            } else if (replay.difference?.step !== 0 || replay.difference?.actual?.counts?.[0] !== 0 || replay.difference?.expected?.counts?.[0] !== 1 || replay.counterexample?.steps?.length !== 1) row.reasons.push('wrong_implementation_counterexample');
          }
          if (!Array.isArray(replays) || replays.length !== expectedCount || replays.some(replay => replay.complete !== true ||
            (entry.kind === 'implementation-replay' ? replay.ok !== true || replay.classification !== 'matched' : replay.ok !== false || replay.classification !== 'implementation_mismatch' || !replay.counterexample))) row.reasons.push('invalid_replay');
        } catch { row.reasons.push('missing_replay'); }
      }
      if (!row.reasons.length) row.status = 'passed';
    }
    rows.push(row);
  }
  return { ok: !reasons.length && rows.every(row => row.status === 'passed'), profile: report.profile, release, reasons, rows, target,
    fullProjectAcceptance: false, propertyRows: protocolCoverage(config).map(property => ({ ...property, status: !reasons.length && property.checks.every(id => rows.find(row => row.id === id)?.status === 'passed') ? 'passed' : 'incomplete' })), otherProfiles: Object.keys(config.profiles).filter(name => name !== report.profile).map(name => ({ profile: name, status: 'not_run_in_this_report' })) };
}
