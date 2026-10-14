import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { checkerConclusion } from './relation-protocol-evidence.mjs';
import { normalizeEditTrace, expectedEditMutationViolation } from './edit-protocol-replay.mjs';
import { properties } from '../../verification/edit-protocol/properties.mjs';

export const editModelRoot = path.resolve('verification/edit-protocol');
export const editModelFiles = ['protocol.qnt', 'configurations.qnt', 'witnesses.qnt', 'config.json', 'tlc.json', 'trace-contract.json', 'properties.mjs'];
export const editConfig = () => readFile(path.join(editModelRoot, 'config.json'), 'utf8').then(JSON.parse);
export const editTraceConfig = row => ({ clients: row.clients, codecs: row.codecs, initialOverride: row.initialOverride, background: row.background });
export function editConfiguration(main, config) {
  const alias = { current_witnesses: 'two_current', legacy_witnesses: 'two_legacy', override_witnesses: 'v11_override' }[main] || main;
  if (main.startsWith('mutant_')) return { clients: 1, codecs: { 0: 'v1' }, initialOverride: false, background: true };
  const row = config.configurations.find(entry => entry.main === alias);
  if (!row) throw new Error(`Unknown edit configuration ${main}`);
  return editTraceConfig(row);
}
export async function editProtocolMetadata() {
  const files = [...editModelFiles.map(file => path.join(editModelRoot, file)), path.resolve('verification/relation-protocol/toolchain.json')];
  const contents = await Promise.all(files.map(async file => [path.relative(process.cwd(), file), await readFile(file, 'utf8')]));
  return { schemaVersion: 1, domain: 'edit-protocol', specificationVersion: '1.0', modelVersion: 1,
    source: sourceVersion(), modelDigest: digest(JSON.stringify(contents)), lockDigest: digest(await readFile('package-lock.json')),
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release() } };
}
export function editProtocolPlan(config) {
  return [
    ...['protocol', 'configurations', 'witnesses'].map(name => ({ id: `typecheck-${name}`, kind: 'typecheck' })),
    ...config.configurations.flatMap(row => [{ id: `tlc-${row.main}`, kind: 'finite-state-complete' }, { id: `bounded-${row.main}`, kind: 'bounded-model-check' }]),
    ...config.witnesses.mains.map(main => ({ id: `witnesses-${main}`, kind: 'model-witness' })),
    ...config.configurations.map(row => ({ id: `simulation-${row.main}`, kind: 'simulation' })),
    ...config.mutants.map(row => ({ id: `negative-${row.main}`, kind: 'model-negative' })),
    { id: 'replay-witnesses', kind: 'implementation-replay' }, { id: 'replay-simulation', kind: 'implementation-replay' },
    { id: 'negative-replay-bypass_revision', kind: 'implementation-negative' },
    { id: 'negative-replay-auto_revision_resend', kind: 'implementation-negative' },
    { id: 'driver-regressions', kind: 'implementation-regression' }
  ];
}
export function editProtocolCoverage(config) {
  const all = editProtocolPlan(config).map(row => row.id);
  return properties.map(property => ({ id: property.id, version: property.version, checks: all,
    scope: 'Declared formal domain plus actual HTTP/SQLite replay; browser evidence is separate', additionalRequiredEvidence: property.additionalRequiredEvidence }));
}
const validInterval = row => typeof row?.startedAt === 'string' && typeof row?.finishedAt === 'string' &&
  Number.isFinite(Date.parse(row.startedAt)) && Number.isFinite(Date.parse(row.finishedAt)) && Date.parse(row.finishedAt) >= Date.parse(row.startedAt);
const execComplete = execution => execution?.timedOut === false && execution?.interrupted === false &&
  execution?.signal === null && Number.isInteger(execution?.code);
export { checkerConclusion };
// Bind this stage to the checked-in suite size without weakening the shared
// parser or its execution-exit, signal, interruption and timeout requirements.
export function editStageConclusion(id, kind, execution, log, config, bound) {
  const conclusion = checkerConclusion(kind, execution, log, bound);
  if (id !== 'driver-regressions') return conclusion;
  const expectedTestCount = config.driverRegressions?.expectedTestCount;
  const countMatches = Number.isSafeInteger(expectedTestCount) && expectedTestCount > 0 &&
    conclusion.metrics?.tests === expectedTestCount;
  return { ...conclusion, ok: conclusion.ok && countMatches, complete: conclusion.complete && countMatches,
    metrics: { ...conclusion.metrics, expectedTestCount } };
}

// Every pass is recomputed from the checked-in plan, source identity and raw
// logs/traces/observations. Missing, stale, interrupted and edited evidence fails.
export async function validateEditProtocolEvidence(directory, { release = false } = {}) {
  const config = await editConfig(), target = await editProtocolMetadata(), plan = editProtocolPlan(config);
  const reasons = [], rows = plan.map(entry => ({ ...entry, status: 'not_run', reasons: [] }));
  let report;
  try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); }
  catch { return { ok: false, reasons: ['missing_or_invalid_report'], rows, target, fullProjectAcceptance: false }; }
  if (!report || !Array.isArray(report.results) || !Array.isArray(report.artifacts) ||
      [...report.results, ...report.artifacts].some(value => !value || typeof value !== 'object' || Array.isArray(value))) return { ok: false, reasons: ['invalid_report_shape'], rows, target, fullProjectAcceptance: false };
  const pin = JSON.parse(await readFile('verification/relation-protocol/toolchain.json', 'utf8'));
  if (report.schemaVersion !== 1 || report.domain !== 'edit-protocol' || report.specificationVersion !== target.specificationVersion || report.modelVersion !== target.modelVersion) reasons.push('invalid_contract');
  if (report.source?.sha !== target.source.sha || report.modelDigest !== target.modelDigest || report.lockDigest !== target.lockDigest) reasons.push('stale');
  if (release && (report.source?.dirty !== false || target.source.dirty !== false)) reasons.push('uncommitted_source');
  if (report.complete !== true || report.execution?.complete !== true || !execComplete(report.execution) || report.execution.code !== 0) reasons.push('incomplete_execution');
  if (!validInterval(report) || !isDeepStrictEqual(report.environment, target.environment)) reasons.push('invalid_environment_or_timestamps');
  if (!isDeepStrictEqual(report.config, config) || !isDeepStrictEqual(report.propertyCoverage, editProtocolCoverage(config))) reasons.push('invalid_domain_or_coverage');
  const javaMajor = Number(report.tools?.java?.match?.(/version\s+"(\d+)/)?.[1]);
  if (report.tools?.quint !== pin.quint.version || report.tools?.apalache !== pin.apalache.version || report.tools?.tlc !== pin.apalache.bundledTlcVersion ||
      report.tools?.apalacheJarSha256 !== pin.apalache.jarSha256 || report.tools?.apalacheArchiveSha256 !== pin.apalache.archiveSha256 ||
      !(javaMajor >= pin.java.minimumMajor) || !/^v24\./.test(report.tools?.node || '') || !report.tools?.sqlite) reasons.push('invalid_toolchain');
  const artifacts = new Map();
  for (const artifact of report.artifacts) {
    if (!artifact || typeof artifact.path !== 'string' || path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes('..') || artifacts.has(artifact.path)) { reasons.push('invalid_artifact'); continue; }
    try {
      const bytes = await readFile(path.join(directory, artifact.path));
      if (digest(bytes) !== artifact.sha256) reasons.push('changed_artifact');
      artifacts.set(artifact.path, bytes.toString('utf8'));
    } catch { reasons.push('missing_artifact'); }
  }
  if (report.results.length !== plan.length || report.results.some(result => !result || !plan.some(entry => entry.id === result.id))) reasons.push('wrong_plan');
  for (const row of rows) {
    const candidates = report.results.filter(result => result?.id === row.id);
    if (candidates.length !== 1) { row.reasons.push(candidates.length ? 'duplicate_result' : 'missing_result'); continue; }
    const result = candidates[0]; row.status = 'incomplete';
    if (result.kind !== row.kind || result.status !== 'passed' || result.complete !== true || !validInterval(result)) row.reasons.push('incomplete_or_failed_result');
    const log = artifacts.get(result.log);
    if (log == null) row.reasons.push('missing_log');
    const main = row.id.replace(/^(tlc|bounded|simulation|witnesses|negative)-/, '');
    if (!['implementation-replay', 'implementation-negative'].includes(row.kind) && log != null) {
      const bound = config.configurations.find(item => item.main === main)?.apalacheDepth;
      if (!editStageConclusion(row.id, row.kind, result.execution, log, config, bound).ok) row.reasons.push('raw_check_not_passed');
      if (row.kind === 'bounded-model-check' && result.bound !== bound) row.reasons.push('wrong_bound');
      if (row.kind === 'simulation' && !isDeepStrictEqual(result.parameters, config.simulation)) row.reasons.push('wrong_simulation_parameters');
    }
    if (['model-witness', 'simulation', 'model-negative'].includes(row.kind)) {
      const count = row.kind === 'model-witness' ? config.witnesses.counts[main] : row.kind === 'simulation' ? config.simulation.selectedTraces : 1;
      if (!Array.isArray(result.traces) || result.traces.length !== count || new Set(result.traces).size !== count) row.reasons.push('missing_or_duplicate_trace');
      if (row.kind === 'model-witness' && !new RegExp(`\\b${count} passing\\b`).test(log || '')) row.reasons.push('wrong_witness_count');
      for (const file of result.traces || []) {
        try {
          const itf = JSON.parse(artifacts.get(file)); normalizeEditTrace(itf, editConfiguration(main, config));
          if (row.kind === 'model-negative' && !expectedEditMutationViolation(main, itf, editConfiguration(main, config)).ok) row.reasons.push('wrong_counterexample');
        } catch { row.reasons.push('invalid_trace'); }
      }
    }
    if (['implementation-replay', 'implementation-negative'].includes(row.kind)) {
      try {
        const replays = JSON.parse(artifacts.get(result.data));
        const sourceKind = row.id === 'replay-simulation' ? 'simulation' : 'model-witness';
        let sources = report.results.filter(entry => entry?.kind === sourceKind).flatMap(entry => entry.traces || []);
        if (row.kind === 'implementation-negative') sources = sources.filter(file => file.includes('current_witnesses-backgroundConflictTest-'));
        const count = row.kind === 'implementation-negative' ? 1 : row.id === 'replay-witnesses' ? config.witnesses.expectedTestCount : config.configurations.length * config.simulation.selectedTraces;
        if (!Array.isArray(replays) || replays.length !== count || new Set(replays.map(entry => entry.sourceTrace)).size !== count ||
            !isDeepStrictEqual(replays.map(entry => entry.sourceTrace).sort(), [...sources].sort())) throw new Error('Wrong replay source list');
        for (const replay of replays) {
          const source = report.results.find(entry => ['model-witness', 'simulation'].includes(entry.kind) && entry.traces?.includes(replay.sourceTrace));
          const raw = artifacts.get(replay.sourceTrace), sourceMain = source.id.replace(/^(witnesses|simulation)-/, '');
          const trace = normalizeEditTrace(JSON.parse(raw), editConfiguration(sourceMain, config));
          if (digest(raw) !== replay.sourceTraceSha256 || digest(JSON.stringify(trace)) !== replay.semanticTraceSha256 || trace.steps.length !== replay.steps || !validInterval(replay)) row.reasons.push('wrong_replay_identity');
          if (row.kind === 'implementation-replay') {
            const states = [trace.initial, ...trace.steps.map(step => step.expected)];
            if (replay.complete !== true || replay.ok !== true || replay.classification !== 'matched' || replay.observations?.length !== states.length ||
                replay.observations.some((observation, index) => observation.step !== index - 1 || !isDeepStrictEqual(observation.actual, states[index]) ||
                  !observation.durable || !Array.isArray(observation.durableViolations) || observation.durableViolations.length)) row.reasons.push('wrong_replay_observations');
          } else {
            const expectedAction = row.id.endsWith('bypass_revision') ? 'transaction' : 'refresh_stale';
            const index = replay.difference?.step, actual = replay.difference?.actual;
            if (replay.complete !== true || replay.ok !== false || replay.classification !== 'implementation_mismatch' || !Number.isInteger(index) ||
                trace.steps[index]?.action !== expectedAction || replay.counterexample?.steps?.length !== index + 1 ||
                !isDeepStrictEqual(replay.difference?.expected, trace.steps[index]?.expected) ||
                (row.id.endsWith('bypass_revision') ? actual?.txResult?.[0] !== 'committed' || actual?.submittedRevision?.[0] === actual?.commitBaseRevision?.[0] :
                  !(actual?.requests?.[0] > actual?.userSaves?.[0]))) row.reasons.push('wrong_implementation_counterexample');
          }
        }
      } catch { row.reasons.push('missing_or_invalid_replay'); }
    }
    if (!row.reasons.length) row.status = 'passed';
  }
  return { ok: !reasons.length && rows.every(row => row.status === 'passed'), reasons, rows, target, release,
    propertyRows: editProtocolCoverage(config).map(property => ({ ...property,
      status: !reasons.length && property.checks.every(id => rows.find(row => row.id === id)?.status === 'passed') ? 'passed_for_declared_scope' : 'incomplete' })),
    fullProjectAcceptance: false, browserAcceptance: 'requires_separate_actual_browser_evidence' };
}
