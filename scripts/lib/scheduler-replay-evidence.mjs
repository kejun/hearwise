import { isDeepStrictEqual } from 'node:util';
import { digest } from './verification-evidence.mjs';
import { validateSchedulerTrace } from './scheduler-protocol-replay.mjs';

const suffix = '\nexport { translations, pumpTranslations, translateSpeechPhrase, translating, interimTranslating, activeTranslations, keys, store, server, knowledgeScheduler, relationScheduler, taskRuntime };\n';
const guard = 'translations.length || interimTranslating >= 1 || translating + interimTranslating >= translations.concurrency';
const controls = { dateNow: 'controlled-monotonic-clock', abortSignalTimeout: 'controlled-platform-deadline', productionTimeoutMs: 15000, waitsRealWallTime: false };
const session = actor => actor === 2 ? 1 : 0;
const equal = isDeepStrictEqual;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sorted = values => [...values].sort((a, b) => a - b);

function serviceState(raw, config, serverSource, mutation, reasons) {
  const identities = config.identities || [0, 1, 2, 3], tokens = identities.map((_, index) => index);
  if (!raw || !raw.service || !Array.isArray(raw.ledger) || !Array.isArray(raw.completions) || !raw.phase || !integer(raw.clock)) { reasons.push('missing_service_observation'); return null; }
  const transformed = (mutation === 'none' ? serverSource : serverSource.replaceAll(guard, 'translations.length')) + suffix;
  if (raw.binding?.originalSha256 !== digest(serverSource) || raw.binding?.exportSuffix !== suffix || raw.binding?.transformedSha256 !== digest(transformed) || raw.binding?.mutation !== mutation || raw.binding?.appendOnly !== (mutation === 'none')) reasons.push('invalid_service_source_binding');
  if (!equal(raw.platformControls, controls)) reasons.push('invalid_platform_controls');
  if (!['final', 'interim', 'active', 'queueLength'].every(key => integer(raw.service[key])) || raw.service.concurrency !== 2) reasons.push('invalid_service_counters');
  const held = raw.ledger.filter(entry => !entry.ended), finals = held.filter(entry => entry.actor !== -1), interim = held.filter(entry => entry.actor === -1);
  for (const [index, entry] of raw.ledger.entries()) {
    if (entry.index !== index || ![-1, ...tokens].includes(entry.actor) || entry.kind !== (entry.actor === -1 ? 'interim' : 'final') || entry.requestModel !== 'qwen-mt-flash' || !/^[a-f0-9]{64}$/.test(entry.requestBodySha256) || !integer(entry.startedAt) || entry.startedAt > raw.clock || typeof entry.ended !== 'boolean' || entry.timeoutMs !== 15000) reasons.push('invalid_provider_ledger');
    if (entry.delivery != null && !['success', 'error', 'timeout', 'cancelled'].includes(entry.delivery)) reasons.push('invalid_delivery');
    if (entry.ended && (entry.delivery == null || (['success', 'error'].includes(entry.delivery) ? entry.httpStatus !== (entry.delivery === 'success' ? 200 : 500) : entry.aborted !== true))) reasons.push('unproven_provider_completion');
  }
  const completed = rows => rows.map(row => `${row.actor}:${row.outcome ?? row.delivery}`).sort();
  if (!equal(completed(raw.completions), completed(raw.ledger.filter(entry => entry.ended)))) reasons.push('completion_callback_ledger_mismatch');
  if (new Set(finals.map(entry => entry.actor)).size !== finals.length || raw.service.final !== finals.length || raw.service.active !== finals.length || raw.service.interim !== interim.length) reasons.push('provider_service_count_mismatch');
  if (mutation === 'none' && (finals.length + interim.length > 2 || interim.length > 1)) reasons.push('shared_admission_violation');
  const queued = tokens.filter(actor => raw.phase[actor] === 'queued'), queue = raw.queue, running = sorted(finals.map(entry => entry.actor));
  if (!Array.isArray(queue) || !equal(sorted(queue), queued) || !equal(raw.running, running) || raw.service.queueLength !== queue.length || !equal(Object.keys(raw.phase).sort(), tokens.map(String).sort())) {
    reasons.push('invalid_queue_or_runtime_projection'); return null;
  }
  if (!equal(raw.queueIds, queue.map(actor => `segment-${identities[actor]}`))) reasons.push('queue_order_observation_mismatch');
  const expectedPresence = Object.fromEntries([...new Set(identities)].map(identity => [identity, queue.some(actor => identities[actor] === identity)]));
  if (!equal(raw.queuePresence, expectedPresence) || new Set(queue.map(actor => identities[actor])).size !== queue.length) reasons.push('queue_identity_mismatch');
  if (tokens.some(actor => (raw.phase[actor] === 'running') !== running.includes(actor))) reasons.push('running_phase_mismatch');
  return { queue, running, phase: raw.phase, interim: interim.length, recentStarts: raw.recentStarts };
}

function translationHistory(raw, previous, step, config, phases, queue, reasons) {
  const identities = config.identities || [0, 1, 2, 3];
  if (previous && raw.clock < previous.clock) reasons.push('clock_regressed');
  if (!previous) {
    if (raw.completions.length) reasons.push('initial_completion_callbacks');
    if (raw.ledger.length) reasons.push('initial_provider_calls');
  } else {
    if (raw.ledger.length < previous.ledger.length) reasons.push('provider_ledger_truncated');
    const mutable = new Set(['ended', 'delivery', 'httpStatus', 'aborted']);
    const changed = [];
    for (const [index, before] of previous.ledger.entries()) {
      const after = raw.ledger[index];
      if (!after) continue;
      const frozen = row => Object.fromEntries(Object.entries(row).filter(([key]) => !mutable.has(key)));
      if (!equal(frozen(before), frozen(after))) reasons.push('provider_ledger_rewritten');
      if (before.ended && !equal(before, after)) reasons.push('terminal_provider_entry_changed');
      if (!before.ended && after.ended) changed.push(after);
    }
    if (!equal(raw.completions.slice(0, previous.completions.length), previous.completions)) reasons.push('completion_callback_history_rewritten');
    const callbacks = raw.completions.slice(previous.completions.length);
    if (callbacks.length !== changed.length || callbacks.some((callback, index) => callback.actor !== changed[index].actor || callback.outcome !== changed[index].delivery)) reasons.push('completion_callback_ledger_mismatch');
    if (step.action.startsWith('settle_')) {
      const actor = step.action === 'settle_interim' ? -1 : step.actor;
      if (changed.length !== 1 || changed[0].actor !== actor || changed[0].delivery !== step.argument) reasons.push('wrong_settlement_response');
      if (step.argument === 'timeout' && raw.clock !== previous.clock + 15000) reasons.push('wrong_timeout_clock');
    } else if (changed.length) reasons.push('uncommanded_settlement');
    if (step.action === 'enqueue') {
      if (raw.lastResult?.accepted !== true) reasons.push('enqueue_not_accepted');
      phases[step.actor] = 'queued';
      queue.push(step.actor);
    } else if (step.action === 'duplicate') {
      if (raw.lastResult?.accepted !== false || !Object.entries(phases).some(([actor, phase]) => phase === 'queued' && identities[actor] === identities[step.actor])) reasons.push('wrong_waiting_dedup');
    } else if (step.action === 'cancel_queued') {
      if (phases[step.actor] !== 'queued') reasons.push('cancellation_not_queued');
      phases[step.actor] = 'cancelled';
      const at = queue.indexOf(step.actor);
      if (at < 0) reasons.push('cancellation_missing_queue_order'); else queue.splice(at, 1);
    } else if (step.action === 'recycle') {
      if (phases[step.actor] !== 'settled') reasons.push('recycle_before_settlement');
      phases[step.actor] = 'fresh';
    }
    for (const ended of changed) if (ended.actor !== -1) phases[ended.actor] = 'settled';
  }
  const starts = raw.ledger.slice(previous?.ledger.length || 0);
  for (const entry of starts) if (entry.actor !== -1) {
    if (phases[entry.actor] !== 'queued') reasons.push('dispatch_without_queue_identity');
    phases[entry.actor] = 'running';
    const at = queue.indexOf(entry.actor);
    if (at < 0) reasons.push('dispatch_missing_queue_order'); else queue.splice(at, 1);
  }
  if (!equal(raw.recentStarts, starts.filter(entry => entry.actor !== -1).map(entry => entry.actor))) reasons.push('wrong_dispatch_order');
  if (!equal(raw.phase, phases)) reasons.push('lifecycle_not_reconstructed');
  if (!equal(raw.queue, queue)) reasons.push('queue_order_not_reconstructed');
}

function knowledgeState(raw, previous, step, config, serverSource, reasons, reconstructed) {
  const tokens = config.jobs || [0, 1, 2], keys = tokens.map(String).sort();
  if (!raw || !raw.identity || !raw.jobs || !Array.isArray(raw.calls) || !Array.isArray(raw.admissions) || !Array.isArray(raw.listenings) || !raw.keyAvailable || !integer(raw.clock) || typeof raw.closed !== 'boolean') { reasons.push('missing_knowledge_observation'); return null; }
  if (!equal(Object.keys(raw.jobs).sort(), keys) || !equal(Object.keys(raw.identity.jobs || {}).sort(), keys) || raw.identity.sessions?.length !== 2) reasons.push('invalid_knowledge_domain');
  if (previous && (!equal(previous.identity, raw.identity) || raw.clock < previous.clock)) reasons.push('knowledge_identity_or_clock_changed');
  serviceState(raw.translation, { kind: 'translation', background: [] }, serverSource, 'none', reasons);
  if (previous && (!equal(raw.calls.slice(0, previous.calls.length).map(({ ended, cancelled, response, signalAborted, ...call }) => call), previous.calls.map(({ ended, cancelled, response, signalAborted, ...call }) => call)) || !equal(raw.admissions.slice(0, previous.admissions.length), previous.admissions))) reasons.push('knowledge_history_rewritten');
  if (!previous && (raw.calls.length || raw.admissions.length)) reasons.push('initial_knowledge_execution');
  if (previous) {
    if (raw.calls.length < previous.calls.length || raw.admissions.length < previous.admissions.length) reasons.push('knowledge_history_truncated');
    const changed = [];
    for (const [index, before] of previous.calls.entries()) {
      const after = raw.calls[index];
      if (!after) continue;
      if (before.ended && !equal(before, after)) reasons.push('terminal_executor_call_changed');
      if (!before.ended && after.ended) changed.push(after);
      else if (!equal(before, after)) reasons.push('executor_call_rewritten');
    }
    if (step.action === 'settle') {
      if (changed.length !== 1 || changed[0].actor !== step.actor || changed[0].response !== step.argument || changed[0].cancelled) reasons.push('wrong_executor_response');
    } else if (['remove', 'close'].includes(step.action)) {
      const expected = previous.calls.filter(call => !call.ended && (step.action === 'close' || session(call.actor) === step.actor));
      if (!equal(changed.map(call => call.actor).sort(), expected.map(call => call.actor).sort()) || changed.some(call => !call.cancelled || !call.signalAborted)) reasons.push('unproven_runtime_cancellation');
    } else if (changed.length) reasons.push('uncommanded_executor_settlement');
    const expectedKeys = { ...previous.keyAvailable };
    if (step.action === 'set_key') expectedKeys[step.actor] = step.argument === 'present';
    if (step.action === 'remove') expectedKeys[step.actor] = false;
    if (!equal(raw.keyAvailable, expectedKeys)) reasons.push('key_availability_rewritten');
    if (!equal(raw.listenings, step.action === 'remove' ? previous.listenings.filter(id => id !== step.actor) : previous.listenings)) reasons.push('listening_domain_rewritten');
    if (raw.closed !== (previous.closed || step.action === 'close')) reasons.push('closed_state_rewritten');
  }
  // Rebuild cooldowns from commanded blocks and actual 429 settlement. Expired
  // provider deadlines disappear through the actual readyAt API.
  reconstructed.provider = reconstructed.provider.map(until => until <= raw.clock ? 0 : until);
  const cool = (key, duration) => { for (let id = 0; id < 2; id++) if ((config.separateKeys ? id : 0) === key) reconstructed.provider[id] = Math.max(reconstructed.provider[id], raw.clock + duration); };
  if (step?.action === 'block_provider') cool(step.actor, 7000);
  if (step?.action === 'settle' && step.argument === 'rate_limit') cool(config.separateKeys ? session(step.actor) : 0, 2000);
  if (!equal(raw.deadlines?.provider, reconstructed.provider)) reasons.push('provider_deadline_not_reconstructed');
  const running = sorted(raw.calls.filter(call => !call.ended).map(call => call.actor));
  if (new Set(running).size !== running.length || new Set(running.map(session)).size !== running.length || running.length > 2) reasons.push('knowledge_running_overlap');
  const phase = {}, durable = {};
  for (const actor of tokens) {
    const checkpoint = raw.jobs[actor], calls = raw.calls.filter(call => call.actor === actor), admissions = raw.admissions.filter(admission => admission.actor === actor);
    durable[actor] = checkpoint?.job.state || 'deleted';
    phase[actor] = !checkpoint || (raw.closed && calls.at(-1)?.cancelled && durable[actor] === 'running') ? 'cancelled' : durable[actor];
    if (checkpoint && (!Array.isArray(checkpoint.parts) || checkpoint.parts.length !== 1 || checkpoint.parts[0].job_id !== checkpoint.job.id || checkpoint.parts[0].part_no !== 0 || !['extract_pending', 'done'].includes(checkpoint.parts[0].phase) || !integer(checkpoint.parts[0].ready_at) || !Array.isArray(checkpoint.parts[0].focus_refs) || checkpoint.parts[0].focus_refs.length !== 1 || !Array.isArray(checkpoint.parts[0].results) || checkpoint.parts[0].results.length || !Array.isArray(checkpoint.parts[0].unresolved) || checkpoint.parts[0].unresolved.length)) reasons.push('invalid_persisted_checkpoint');
    if (checkpoint && ((checkpoint.job.state === 'complete') !== (checkpoint.parts[0]?.phase === 'done'))) reasons.push('persisted_checkpoint_phase_mismatch');
    if (checkpoint) {
      const part = checkpoint.parts[0], before = previous?.jobs[actor]?.parts[0];
      const continuation = step?.action === 'settle' && step.actor === actor && ['continue', 'retry'].includes(step.argument);
      const success = step?.action === 'settle' && step.actor === actor && step.argument === 'success';
      const expectedReadyAt = continuation ? raw.clock + 2000 : success || !previous ? 0 : before?.ready_at;
      if (part?.ready_at !== expectedReadyAt || checkpoint.job.retry_at !== null) reasons.push('persisted_deadline_not_reconstructed');
    }
    if (checkpoint && previous?.jobs[actor] && !equal(checkpoint.parts[0]?.focus_refs, previous.jobs[actor].parts[0]?.focus_refs)) reasons.push('persisted_checkpoint_source_rewritten');
    if (checkpoint && (checkpoint.job.id !== raw.identity.jobs[actor] || checkpoint.job.listening_id !== raw.identity.sessions[session(actor)] || checkpoint.job.attempts !== admissions.length)) reasons.push('durable_job_identity_or_attempts');
    if ((phase[actor] === 'running') !== running.includes(actor)) reasons.push('knowledge_runtime_durable_mismatch');
  }
  for (const call of raw.calls) if (!tokens.includes(call.actor) || call.session !== session(call.actor) || !integer(call.startedAt) || call.startedAt > raw.clock || !Number.isInteger(call.attempt) || call.attempt < 1 || typeof call.ended !== 'boolean' || typeof call.cancelled !== 'boolean' || (call.cancelled && (!call.ended || !call.signalAborted))) reasons.push('invalid_executor_call');
  if (raw.calls.length !== raw.admissions.length) reasons.push('executor_admission_count_mismatch');
  for (const [index, admission] of raw.admissions.entries()) {
    const call = raw.calls[index];
    if (!call || call.actor !== admission.actor || call.startedAt !== admission.at || call.attempt !== raw.admissions.slice(0, index + 1).filter(row => row.actor === admission.actor).length) reasons.push('executor_admission_identity_mismatch');
    const checkpoint = admission.checkpointBefore, priorStart = raw.admissions.slice(0, index).findLast(row => session(row.actor) === session(admission.actor))?.at ?? null;
    if (!checkpoint || checkpoint.job.id !== raw.identity.jobs[admission.actor] || checkpoint.job.state !== 'pending' || checkpoint.job.attempts !== call?.attempt - 1 || checkpoint.parts?.length !== 1 || admission.createdAt !== Date.parse(checkpoint.job.created_at) || admission.retryAt !== (checkpoint.job.retry_at ? Date.parse(checkpoint.job.retry_at) : 0) || admission.readyAt !== checkpoint.parts[0]?.ready_at) reasons.push('admission_source_deadline_mismatch');
    if (admission.previousStart !== priorStart) reasons.push('previous_start_not_reconstructed');
    if (index >= (previous?.admissions.length || 0)) {
      if (!equal(checkpoint, previous?.jobs[admission.actor])) reasons.push('preadmission_checkpoint_not_observed');
      const active = raw.calls.slice(0, index).filter(prior => !prior.ended).map(prior => prior.actor);
      if (!equal(admission.runningBefore, active)) reasons.push('running_before_not_reconstructed');
      if (!equal(admission.translation, raw.translation.service)) reasons.push('admission_translation_not_observed');
      if (admission.providerReadyAt !== reconstructed.provider[session(admission.actor)]) reasons.push('admission_provider_deadline_mismatch');
    }
    const busy = Boolean(admission.translation?.queueLength || admission.translation?.final || admission.translation?.interim);
    if (!tokens.includes(admission.actor) || !Array.isArray(admission.runningBefore) || admission.runningBefore.length >= (busy ? 1 : 2) || admission.runningBefore.some(actor => session(actor) === session(admission.actor))) { reasons.push('knowledge_admission_budget'); continue; }
    const times = [admission.at, admission.createdAt, admission.readyAt, admission.retryAt, admission.providerReadyAt];
    if (!times.every(integer) || (admission.previousStart != null && !integer(admission.previousStart))) reasons.push('invalid_admission_deadline');
    const due = Math.max(admission.readyAt, admission.retryAt, admission.providerReadyAt, admission.previousStart == null ? 0 : admission.previousStart + 2000, busy ? admission.createdAt + 1500 : 0);
    if (admission.at < due || admission.at > raw.clock) reasons.push('knowledge_early_admission');
  }
  const added = raw.admissions.slice(previous?.admissions.length || 0);
  if (step?.action === 'set_translation' && added.length) reasons.push('translation_change_revoked_or_admitted_work');
  const final = raw.admissions.at(-1);
  return { phase, durable, running, lastServed: final ? session(final.actor) : -1, recentStarts: added.map(admission => admission.actor),
    translationWaiting: raw.translation.service.queueLength, translationRunning: raw.translation.service.final, interim: raw.translation.service.interim,
    closed: raw.closed, listenings: raw.listenings, keyAvailable: raw.keyAvailable };
}

export function validateSchedulerReplayEvidence(trace, replay, { serverSource, mutation = 'none' } = {}) {
  const reasons = [];
  if (!validateSchedulerTrace(trace) || typeof serverSource !== 'string' || !['none', 'interim_queue_only'].includes(mutation)) return { ok: false, reasons: ['invalid_replay_contract'] };
  const states = [trace.initial, ...trace.steps.map(step => step.expected)];
  if (replay.complete !== true || !Array.isArray(replay.observations) || (mutation === 'none' ? replay.ok !== true || replay.classification !== 'matched' || replay.observations.length !== states.length : replay.ok !== false || replay.classification !== 'implementation_mismatch')) reasons.push('incomplete_or_wrong_replay');
  let previous;
  const reconstructed = { provider: [0, 0] };
  const queue = [...(trace.config.initialQueue || [])];
  const identities = trace.config.identities || [0, 1, 2, 3];
  const phases = Object.fromEntries(identities.map((_, actor) => [actor, (trace.config.initialQueue || []).includes(actor) ? 'queued' : 'fresh']));
  for (const [index, observation] of (replay.observations || []).entries()) {
    const step = index ? trace.steps[index - 1] : null, raw = observation.durable;
    if (observation.step !== index - 1) reasons.push('wrong_observation_index');
    let projection;
    try {
      if (trace.config.kind === 'translation') {
        projection = serviceState(raw, trace.config, serverSource, mutation, reasons);
        if (projection) translationHistory(raw, previous, step, trace.config, phases, queue, reasons);
      } else projection = knowledgeState(raw, previous, step, trace.config, serverSource, reasons, reconstructed);
    } catch { reasons.push('invalid_raw_observation_shape'); }
    if (!projection || !equal(observation.actual, projection)) reasons.push('projection_not_reconstructed');
    if ((mutation === 'none' || index < 4) && (!equal(projection, states[index]) || !Array.isArray(observation.durableViolations) || observation.durableViolations.length)) reasons.push('model_projection_mismatch');
    previous = raw;
  }
  if (mutation !== 'none') {
    if (!equal(replay.counterexample, { ...trace, steps: trace.steps.slice(0, 4), minimality: 'first-divergence-prefix' })) reasons.push('wrong_counterexample_prefix');
    const last = replay.observations?.at(-1), difference = replay.difference;
    if (trace.config.kind !== 'translation' || !difference || difference.step !== 3 || replay.counterexample?.steps?.length !== 4 || replay.observations.length !== 5 || last?.durable.service.final !== 2 || last?.durable.service.interim !== 1 || last?.durable.ledger.length !== 3 || !equal(difference.actual, last?.actual) || !equal(difference.expected, states[4])) reasons.push('wrong_implementation_counterexample');
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}
