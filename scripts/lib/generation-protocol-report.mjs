import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { digest } from './verification-evidence.mjs';
import { normalizeITFStates } from './protocol-replay.mjs';
import { normalizeGenerationTrace, validateGenerationTrace } from './generation-protocol-replay.mjs';
import { validateGenerationReplayEvidence } from './generation-protocol-evidence.mjs';
import { validateGenerationNegativeFrame } from './generation-negative-frame.mjs';
import { generationMetadata, generationPlan, generationCoverage, generationCommand, generationCommandConclusion,
  generationTraceConfig, loadGenerationConfig, loadGenerationTools } from './generation-protocol-plan.mjs';

const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const interval = value => time(value?.startedAt) && time(value?.finishedAt) && Date.parse(value.finishedAt) >= Date.parse(value.startedAt);
const within = (child, parent) => interval(child) && interval(parent) && Date.parse(child.startedAt) >= Date.parse(parent.startedAt) && Date.parse(child.finishedAt) <= Date.parse(parent.finishedAt);
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const safeArtifact = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');
const select = (value, fields) => Object.fromEntries(fields.map(field => [field, value[field]]));
export const generationReplaySummary = rows => rows.map(row => ({ sourceTrace: row.sourceTrace, steps: row.steps,
  ...(row.control ? { control: row.control.id, normal: { ok: row.normal.ok, complete: row.normal.complete, classification: row.normal.classification },
    broken: { ok: row.broken.ok, complete: row.broken.complete, classification: row.broken.classification, differenceStep: row.broken.difference?.step } } :
    { ok: row.ok, complete: row.complete, classification: row.classification }) }));

export function generationHeaderReasons(report, target, config, pinned, { release = false, requireProfile } = {}) {
  report ??= {};
  const reasons = [], add = (condition, reason) => { if (!condition) reasons.push(reason); };
  add(report?.schemaVersion === 1 && report.specificationVersion === '1.0' && report.modelVersion === 1, 'invalid_contract');
  add(equal(report?.source, target.source) && equal(report?.sourceDigests, target.sourceDigests) && report?.modelDigest === target.modelDigest && report?.lockDigest === target.lockDigest, 'stale_source');
  add(!release || report?.source?.dirty === false && target.source.dirty === false, 'uncommitted_source');
  add(equal(report?.runtimeBuild, target.runtimeBuild) && report?.runtimeBuild?.git_sha === report?.source?.sha &&
    report?.runtimeBuild?.build_dirty === report?.source?.dirty && report?.runtimeBuild?.instrumentation_version === 3 && sha(report?.sourceDigests?.['dist/server/index.js']), 'invalid_runtime_build');
  add(Object.hasOwn(config.profiles, report?.profile || '') && (!requireProfile || report.profile === requireProfile), 'invalid_profile');
  add(equal(report?.domain, config) && equal(report?.propertyCoverage, generationCoverage(config)), 'invalid_domain_or_properties');
  add(report?.overallTimeoutMs === config.profiles[report?.profile]?.overallTimeoutMs, 'invalid_overall_deadline');
  add(interval(report), 'invalid_timestamps');
  add(Date.parse(report.finishedAt) - Date.parse(report.startedAt) <= report.overallTimeoutMs + 15000, 'worker_deadline_exceeded');
  add(['platform', 'arch', 'osRelease'].every(key => typeof report?.environment?.[key] === 'string' && report.environment[key]), 'missing_environment');
  const e = report?.execution;
  add(report?.complete === true && e?.complete === true && e.code === 0 && e.signal === null && e.timedOut === false && e.interrupted === false, 'incomplete_execution');
  add(Number.isSafeInteger(e?.pid) && e.pid > 0 && path.isAbsolute(e?.repositoryRoot || '') && path.isAbsolute(e?.evidenceRoot || ''), 'invalid_execution_origin');
  const supervisor = report?.supervisor, se = supervisor?.execution;
  add(within(report, supervisor) && se?.code === 0 && se.signal === null && se.timedOut === false && se.interrupted === false &&
    supervisor?.timeoutMs === report.overallTimeoutMs + 15000 && supervisor?.cwd === e?.repositoryRoot &&
    equal(supervisor?.argv, [path.join(e?.repositoryRoot || '', 'scripts/verify-generation-protocol.mjs'), '--worker', e?.evidenceRoot, report.profile]), 'invalid_supervisor');
  add(Number.isFinite(se?.durationMs) && se.durationMs >= 0 && se.durationMs <= supervisor.timeoutMs + 5000 &&
    se.durationMs <= Date.parse(supervisor.finishedAt) - Date.parse(supervisor.startedAt) + 1 &&
    Date.parse(supervisor.finishedAt) - Date.parse(supervisor.startedAt) <= supervisor.timeoutMs + 6000, 'supervisor_deadline_exceeded');
  const tools = report?.tools, java = tools?.java?.match(/version\s+"(\d+)/)?.[1];
  add(tools?.quint === pinned.quint.version && tools?.apalache === pinned.apalache.version && tools?.tlc === pinned.apalache.bundledTlcVersion &&
    tools?.apalacheJarSha256 === pinned.apalache.jarSha256 && tools?.apalacheArchiveSha256 === pinned.apalache.archiveSha256 && Number(java) >= pinned.java.minimumMajor &&
    /^v24\./.test(tools?.node || '') && typeof tools?.sqlite === 'string', 'invalid_toolchain');
  return reasons;
}

export function generationModelViolation(entry, itf) {
  const trace = normalizeGenerationTrace(itf, generationTraceConfig(entry));
  const states = normalizeITFStates(itf, ['calls', 'reserved', 'business', 'outcome', 'authorizedBusiness', 'authorizedOutcome']);
  const firstViolationState = states.findIndex(state => entry.mutant.expectedViolation === 'budgetBeforeSend' ?
    Object.keys(state.calls).some(key => state.calls[key] > state.reserved[key]) :
    !equal(state.business, state.authorizedBusiness) || !equal(state.outcome, state.authorizedOutcome));
  return { ok: validateGenerationTrace(trace) && firstViolationState > 0, firstViolationState, expectedViolation: entry.mutant.expectedViolation };
}

// A negative run must have an independently valid normal run of the same native
// ITF. The prefix before its first difference is checked by the normal raw gate.
export async function validateGenerationControl(trace, control, data, { repositoryRoot, sourceDigests } = {}) {
  const reasons = [], add = (condition, reason) => { if (!condition) reasons.push(reason); };
  try {
    // Compare precisely the persisted JSON contract: SQLite prototypes and
    // undefined optional callback fields are not part of the recorded bytes.
    data = JSON.parse(JSON.stringify(data));
    add(equal(data?.control, control), 'wrong_control');
    add(validateGenerationReplayEvidence(trace, data.normal).ok, 'normal_control_failed');
    const broken = data.broken, difference = broken?.difference, index = difference?.step;
    add(broken?.complete === true && broken.ok === false && broken.classification === 'implementation_mismatch' && interval(broken), 'missing_actual_mismatch');
    add(Number.isInteger(index) && index >= 0 && index < trace.steps.length && broken.observations.length === index + 2, 'wrong_mismatch_prefix');
    add(equal(broken.counterexample?.steps, trace.steps.slice(0, index + 1)) && equal(broken.counterexample?.initial, trace.initial), 'wrong_counterexample');
    const before = structuredClone(broken); before.ok = true; before.classification = 'matched'; before.observations.pop();
    for (const observation of before.observations) { add(observation.durable.mutation === control.mutation, 'wrong_fixture_mutation'); observation.durable.mutation = 'none'; }
    add(validateGenerationReplayEvidence({ ...trace, steps: trace.steps.slice(0, index) }, before).ok, 'invalid_counterexample_prefix');
    const last = broken.observations.at(-1), durable = last.durable, raw = durable.raw;
    add(durable.mutation === control.mutation && equal(difference.expected, trace.steps[index].expected) && equal(difference.actual, last.actual), 'wrong_first_difference');
    if (control.mutation === 'skip_reservation') {
      add(index === 1 && trace.steps[index].action === 'reserve' && difference.expected.reserved[0] === 1 && difference.actual.reserved[0] === 0 &&
        raw.calls.length === 1 && raw.calls[0].status === 'reserved' && raw.calls[0].sent === false && raw.executions.length === 1 && !raw.executions[0].settled, 'reservation_control_not_observed');
      add(control.protocol === 'relation' ? raw.durable.relation_requests.length === 0 && raw.durable.relation_jobs[0].request_count === 0 :
        raw.durable.jobs[0].parts[0].initial_requests === 0 && raw.durable.jobs[0].parts[0].repair_reserved === 0, 'reservation_still_persisted');
    } else if (control.mutation === 'corrupt_accepted_fact') {
      add(trace.steps[index].action === 'response' && difference.durableViolations?.includes('accepted_fact_changed') && equal(difference.actual.business, difference.expected.business) &&
        raw.durable.facts.length === 1 && raw.durable.facts[0].content === 'Corrupted accepted fact', 'content_control_not_observed');
    } else if (control.mutation === 'omit_transaction_guard') {
      add(durable.boundaryTrials.length === 1, 'missing_transaction_trial');
      const trial = durable.boundaryTrials[0], metadata = trial.metadata;
      const original = await readFile(new URL('../../relation-storage.mjs', import.meta.url), 'utf8');
      const anchor = "if (!window || !['running', 'pending'].includes(job.state) || round?.state !== 'active' || window.relation_epoch !== job.epoch || inputFor(this, window).input.input_fingerprint !== job.input_fingerprint) {";
      const replacement = 'if (false) { // Isolated negative control: omitted stale-context transaction guard.';
      const variant = original.replace(anchor, replacement), imports = [];
      const moduleSource = variant.replace(/from '(\.\/[^']+)'/g, (_match, relative) => {
        const absolute = new URL(relative, `file://${repositoryRoot}/relation-storage.mjs`).href; imports.push({ relative, absolute }); return `from '${absolute}'`;
      });
      add(original.split(anchor).length === 2 && equal(metadata, { path: 'relation-storage.mjs', originalSha256: digest(original), variantSha256: digest(variant),
        anchor, replacement, replacedCount: 1, boundary: 'direct-old-context-transaction-call', moduleSha256: digest(moduleSource), imports }) &&
        metadata.originalSha256 === sourceDigests?.['relation-storage.mjs'], 'invalid_source_variant');
      add(trial.normal?.stale === true && trial.inputRestored === true && equal(trial.before.durable, trial.restored.durable), 'different_transaction_inputs');
      const normal = structuredClone(broken); normal.ok = true; normal.classification = 'matched';
      for (const observation of normal.observations) { observation.durable.mutation = 'none'; observation.durable.boundaryTrials = []; }
      Object.assign(normal.observations.at(-1), { actual: trace.steps[index].expected, durableViolations: [] });
      normal.observations.at(-1).durable.raw = trial.before;
      add(validateGenerationReplayEvidence({ ...trace, steps: trace.steps.slice(0, index + 1) }, normal).ok, 'invalid_normal_transaction_boundary');
      const old = raw.calls[0], current = raw.calls[1], currentJob = raw.durable.relation_jobs.find(row => row.id === current.jobId);
      add(old.aborted && current.sent && !current.aborted && currentJob.state === 'running' && currentJob.request_count === 1 &&
        difference.actual.activeOwner[0] === 1 && difference.actual.reserved[1] === 1 && equal(difference.actual.business[0], [0]) && equal(difference.expected.business[0], []) &&
        trial.jobId === old.jobId && equal(trial.payload, old.responseValue) && trial.variant.accepted === 1 &&
        equal(trial.variantAfter.durable, raw.durable) && raw.durable.relation_supports.some(row => row.job_id === old.jobId && row.state === 'active'), 'stale_write_not_observed');
    } else add(false, 'unknown_control');
    add(await validateGenerationNegativeFrame(trace, broken, control), 'invalid_mutated_final_frame');
  } catch (error) { add(false, `malformed_control:${error.name}`); }
  return { ok: reasons.length === 0, reasons };
}

export async function validateGenerationEvidence(directory, options = {}) {
  const config = await loadGenerationConfig(), pinned = await loadGenerationTools(), target = await generationMetadata(), plan = generationPlan(config);
  let report;
  try { report = JSON.parse(await readFile(path.join(directory, 'report.json'))); }
  catch { return { ok: false, reasons: ['missing_report'], rows: plan.map(row => ({ id: row.id, kind: row.kind, status: 'not_run' })), target }; }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { ok: false, reasons: ['invalid_report'], rows: [], target };
  const reasons = generationHeaderReasons(report, target, config, pinned, options), artifacts = new Map(), rows = [];
  if (!Array.isArray(report.results) || !Array.isArray(report.artifacts)) return { ok: false, reasons: [...reasons, 'invalid_report'], rows: [], target };
  for (const artifact of report.artifacts) {
    if (!safeArtifact(artifact?.path) || !sha(artifact.sha256) || artifacts.has(artifact.path)) { reasons.push('invalid_artifact'); continue; }
    try { const bytes = await readFile(path.join(directory, artifact.path)); if (digest(bytes) !== artifact.sha256) reasons.push('changed_artifact'); else artifacts.set(artifact.path, bytes.toString('utf8')); }
    catch { reasons.push('missing_artifact'); }
  }
  const supervisorLog = artifacts.get(report.supervisor?.log);
  if (typeof supervisorLog !== 'string' || supervisorLog.split('\n').filter(line => line === `Generation worker PID ${report.execution?.pid}`).length !== 1) reasons.push('missing_supervisor_identity');
  if (report.results.length !== plan.length || report.results.some(row => !plan.some(entry => entry.id === row?.id))) reasons.push('unexpected_result_roster');
  const sourceEntries = plan.filter(row => ['model-witness', 'simulation'].includes(row.kind) && row.refined);
  let previousFinishedAt = report.startedAt;
  for (const entry of plan) {
    const errors = [], add = (condition, reason) => { if (!condition) errors.push(reason); };
    try {
      const matches = report.results.filter(row => row.id === entry.id); add(matches.length === 1, 'missing_or_duplicate_result');
      const result = matches[0];
      add(result?.kind === entry.kind && result.complete === true && result.status === 'passed' && within(result, report), 'incomplete_result');
      add(Date.parse(result.startedAt) >= Date.parse(previousFinishedAt), 'out_of_order_result'); previousFinishedAt = result.finishedAt;
      const log = artifacts.get(result.log); add(typeof log === 'string', 'missing_log');
      if (!['implementation-replay', 'implementation-negative'].includes(entry.kind)) {
        const command = generationCommand(entry, config, report.profile, { repositoryRoot: report.execution.repositoryRoot, evidenceRoot: report.execution.evidenceRoot, port: result.port });
        add(equal(select(result, Object.keys(command)), command), 'wrong_command');
        const conclusion = generationCommandConclusion(entry, result.execution, log, command.bound);
        add(conclusion.ok && conclusion.complete && equal(result.metrics, conclusion.metrics || null), 'raw_command_not_passed');
        add(Number.isFinite(result.execution.durationMs) && result.execution.durationMs >= 0 &&
          result.execution.durationMs <= command.timeoutMs + 2500 && result.execution.durationMs <= Date.parse(result.finishedAt) - Date.parse(result.startedAt) + 1 &&
          Date.parse(result.finishedAt) - Date.parse(result.startedAt) <= command.timeoutMs + 6500, 'invalid_process_duration');
        if (['model-witness', 'simulation', 'model-negative'].includes(entry.kind)) {
          add(Array.isArray(result.traces) && result.traces.length === entry.count && new Set(result.traces).size === entry.count, 'wrong_trace_count');
          if (entry.kind === 'model-witness') add(equal(result.traces.map(file => path.basename(file)).sort(),
            entry.names.map((name, index) => `${entry.main}-${name}-${index}.itf.json`).sort()), 'wrong_witness_roster');
          for (const file of result.traces) {
            add(safeArtifact(file) && file.startsWith(`traces/${entry.id}/`) && artifacts.has(file), 'missing_native_trace');
            const itf = JSON.parse(artifacts.get(file)); normalizeGenerationTrace(itf, generationTraceConfig(entry));
            if (entry.kind === 'model-negative') add(generationModelViolation(entry, itf).ok, 'wrong_model_counterexample');
            else add(itf['#meta']?.format === 'ITF' && itf['#meta']?.source === command.argv[2] &&
              itf['#meta']?.status === (entry.kind === 'simulation' ? 'ok' : 'passed') && Number.isFinite(itf['#meta']?.timestamp) &&
              itf['#meta'].timestamp >= Date.parse(result.startedAt) && itf['#meta'].timestamp <= Date.parse(result.finishedAt), 'wrong_native_trace_origin');
          }
        }
      } else {
        const selected = entry.kind === 'implementation-negative' ? sourceEntries.filter(row => row.kind === 'model-witness' && generationTraceConfig(row).protocol === entry.control.protocol && generationTraceConfig(row).actors === 1) :
          sourceEntries.filter(row => row.kind === entry.sourceKind);
        const expected = selected.flatMap(source => report.results.find(row => row.id === source.id)?.traces || []).filter(file => !entry.control || file.includes(`${entry.control.witness}-`));
        const replays = JSON.parse(artifacts.get(result.data));
        add(equal(JSON.parse(log), generationReplaySummary(replays)), 'invalid_replay_log');
        add(replays.length === entry.count && equal(replays.map(row => row.sourceTrace).sort(), [...expected].sort()), 'wrong_replay_sources');
        for (const replay of replays) {
          const source = selected.find(row => report.results.find(result => result.id === row.id)?.traces?.includes(replay.sourceTrace));
          const raw = artifacts.get(replay.sourceTrace), trace = normalizeGenerationTrace(JSON.parse(raw), generationTraceConfig(source));
          add(digest(raw) === replay.sourceTraceSha256 && digest(JSON.stringify(trace)) === replay.semanticTraceSha256 && replay.steps === trace.steps.length, 'wrong_replay_identity');
          if (entry.kind === 'implementation-replay') {
            add(within(replay, result) && replay.observations.every(row => row.durable.raw.hostPid === report.execution.pid) && validateGenerationReplayEvidence(trace, replay).ok, 'invalid_actual_replay');
          } else add(within(replay.normal, result) && within(replay.broken, result) &&
            [replay.normal, replay.broken].every(run => run.observations.every(row => row.durable.raw.hostPid === report.execution.pid)) &&
            (await validateGenerationControl(trace, entry.control, replay, { repositoryRoot: report.execution.repositoryRoot, sourceDigests: report.sourceDigests })).ok, 'invalid_actual_control');
        }
      }
    } catch (error) { errors.push(`malformed_result:${error.name}`); }
    rows.push({ id: entry.id, kind: entry.kind, status: errors.length ? 'incomplete' : 'passed', reasons: errors });
  }
  return { ok: reasons.length === 0 && rows.every(row => row.status === 'passed'), reasons: [...new Set(reasons)], rows, target,
    propertyCoverage: generationCoverage(config), boundary: 'Finite safety plus declared fixed-ready real replay; M1 requires separate current-target profiles.' };
}
