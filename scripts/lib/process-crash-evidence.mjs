import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual as equal } from 'node:util';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { normalizeITFStates } from './protocol-replay.mjs';
import { normalizeProcessTrace, validateProcessTrace } from './process-crash-replay.mjs';
import { formalPlan, validateFormalEvidence } from './formal-protocol-evidence.mjs';
import { properties } from '../../verification/process-crash/properties.mjs';
import processConfig from '../../verification/process-crash/config.json' with { type: 'json' };

export const processModelRoot = path.resolve('verification/process-crash');
export const processModelFiles = ['protocol.qnt', 'relation-protocol.qnt', 'knowledge-protocol.qnt', 'configurations.qnt',
  'witnesses.qnt', 'config.json', 'tlc.json', 'toolchain.json', 'properties.mjs'];
export async function processMetadata() {
  const contents = await Promise.all(processModelFiles.map(async file => [file, await readFile(path.join(processModelRoot, file), 'utf8')]));
  // Run timestamps belong to the runner. Metadata must be stable across a run.
  return { schemaVersion: 1, source: sourceVersion(), specificationVersion: '1.0', modelVersion: 1,
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version },
    modelDigest: digest(JSON.stringify(contents)), lockDigest: digest(await readFile('package-lock.json')) };
}
export function processTraceConfig(main) {
  if (main.includes('relation')) return { protocol: 'relation', actors: main.includes('multi_') ? 3 : 1, capacity: main.includes('cap2') ? 2 : 1 };
  if (main.includes('knowledge')) return { protocol: 'knowledge', parts: main.includes('two_parts') ? 2 : 1 };
  throw new Error(`Unknown process-crash main: ${main}`);
}
export function processCoverage(config) {
  const common = formalPlan(config).filter(row => !['model-negative', 'implementation-negative'].includes(row.kind)).map(row => row.id);
  const controls = { 'HW-04-10': ['negative-mutant_relation_reset_on_recovery', 'negative-mutant_knowledge_reset_on_recovery', 'negative-replay'],
    'HW-04-11': ['negative-mutant_knowledge_reapply_committed'], 'HW-04-12': [],
    'HW-04-13': [...config.mutants.map(row => `negative-${row.main}`), 'negative-replay'] };
  return properties.map(property => ({ id: property.id, version: property.version, acceptance: property.acceptance, checks: [...common, ...controls[property.id]] }));
}
export function processMutationViolation(main, itf) {
  const trace = normalizeProcessTrace(itf, processTraceConfig(main));
  const required = main === 'mutant_relation_reset_on_recovery' ? ['counts', 'reserved_ever'] :
    main === 'mutant_knowledge_reset_on_recovery' ? ['initial_requests', 'initial_ever', 'repair_reserved', 'repair_ever', 'protocol_retries', 'protocol_ever'] :
      ['accepted', 'apply_counts'];
  const states = normalizeITFStates(itf, ['lastAction', 'generation', ...required]);
  const matches = state => state.lastAction === 'recover' && state.generation === 1 && (
    main === 'mutant_relation_reset_on_recovery' ? Object.keys(state.counts).some(actor => state.counts[actor] < state.reserved_ever[actor]) :
      main === 'mutant_knowledge_reset_on_recovery' ? Object.keys(state.initial_requests).some(part => state.initial_requests[part] < state.initial_ever[part] ||
        state.repair_reserved[part] < state.repair_ever[part]) || state.protocol_retries < state.protocol_ever :
        main === 'mutant_knowledge_reapply_committed' && Object.keys(state.accepted).some(part => state.apply_counts[part] > state.accepted[part].length));
  const step = states.findIndex(matches);
  return { ok: step >= 0, classification: 'model_violation', firstViolationState: step, traceLength: trace.steps.length };
}
export const processEvidenceDefinition = {
  regressionSuite: 'process-crash',
  loadConfig: async () => JSON.parse(await readFile(path.join(processModelRoot, 'config.json'), 'utf8')),
  loadToolchain: async () => JSON.parse(await readFile(path.join(processModelRoot, 'toolchain.json'), 'utf8')),
  metadata: processMetadata, coverage: processCoverage, normalizeTrace: normalizeProcessTrace, traceConfig: processTraceConfig,
  expectedMutationViolation: processMutationViolation,
  expectedImplementationCounterexample: replay => replay.difference?.step === 2 && replay.difference?.expected?.counts?.[0] === 1 &&
    replay.difference?.actual?.counts?.[0] === 0 && replay.counterexample?.steps?.length === 3 &&
    equal(replay.counterexample.steps.map(step => step.action), ['admit', 'crash', 'recover'])
};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const interval = row => timestamp(row?.startedAt) && timestamp(row?.finishedAt) && Date.parse(row.finishedAt) >= Date.parse(row.startedAt);
const select = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
const ledgerIdentity = row => select(row, ['id', 'generation', 'actor', 'kind', 'receivedAt']);
const journalIdentity = row => select(row, ['job_id', 'attempt', 'started_at']);
const boundaryNames = ['reserved', 'inflight', 'received', 'committed'];
const providerResponses = { relation: processConfig.relation.responses, ...processConfig.knowledge.responses };
const validProviderResponse = call => call.response === null || providerResponses[call.kind]?.includes(call.response);

// Deliberately independent of adapter.project()/check(): derive the projection
// again from the recorded read-only SQLite rows and the external HTTP ledger.
export function projectProcessObservation(raw, config) {
  const common = { processState: raw.processState, generation: raw.generation };
  if (config.protocol === 'relation') return { ...common, ...Object.fromEntries(['phase', 'counts', 'calls', 'relations', 'outcome', 'replies', 'ready'].map(field => [field,
    Object.fromEntries(raw.durable.actors.map(row => [row.actor, field === 'counts' ? row.jobs.reduce((sum, job) => sum + job.request_count, 0) :
      field === 'calls' ? raw.ledger.filter(call => call.actor === row.actor).length : field === 'relations' ? row.relations.length :
        field === 'replies' ? raw.tasks[row.actor].reply : field === 'ready' ? !(row.jobs.at(-1)?.ready_at > raw.clock) : raw.tasks[row.actor][field]]))])) };
  const cp = raw.durable.checkpoint, map = fn => Object.fromEntries(cp.parts.map(part => [part.part_no, fn(part)]));
  const next = cp.parts.find(part => part.phase !== 'done');
  const due = Math.max(raw.schedulerReadyAt || 0, next?.ready_at || 0, (cp.progress.last_request_at || 0) + 2000, cp.progress.rate_limit_until || 0,
    cp.job.retry_at ? Date.parse(cp.job.retry_at) : 0);
  return { ...common, stage: raw.processState === 'up' ? raw.stage : 'down', outcome: cp.job.outcome || 'none',
    ready: raw.stage !== 'idle' || due <= raw.clock, extra_requests: cp.progress.extra_requests,
    protocol_retries: cp.progress.protocol_retries, cycle: cp.progress.cycle, phase: map(part => part.phase),
    initial_requests: map(part => part.initial_requests), repair_reserved: map(part => part.repair_reserved),
    extract_calls: map(part => raw.ledger.filter(row => row.actor === part.part_no && row.kind === 'extract').length),
    repair_calls: map(part => raw.ledger.filter(row => row.actor === part.part_no && row.kind === 'repair').length),
    initial_complete: map(part => Boolean(part.stats.initial_complete)), retry_kind: map(part => part.stats.retry_kind || 'none'),
    accepted: map(part => part.results.map(result => result.sourceIndex).sort((a, b) => a - b)),
    unresolved: map(part => part.unresolved.map(target => target.sourceIndex).sort((a, b) => a - b)),
    anchored: map(part => part.unresolved.filter(target => target.anchor).map(target => target.sourceIndex).sort((a, b) => a - b)),
    replies: map(part => raw.replies[part.part_no]) };
}
function validateRelation(raw, previous, config, expect, negative, action) {
  const rows = raw.durable.actors;
  expect(rows.length === config.actors && equal(rows.map(row => row.actor), Array.from({ length: config.actors }, (_, i) => i)), 'actor_domain');
  expect(Array.isArray(raw.tasks) && raw.tasks.length === config.actors, 'task_domain');
  for (const row of rows) {
    const before = previous?.durable.actors.find(value => value.actor === row.actor), task = raw.tasks[row.actor], job = row.jobs.at(-1);
    expect(Array.isArray(row.knowledge) && row.knowledge.length > 0 && Array.isArray(row.journal) && row.window?.id === row.windowId, 'relation_durable_shape');
    expect(integer(row.budget) && row.budget === row.jobs.reduce((sum, job) => sum + job.request_count, 0) && row.budget === row.journal.length && row.budget <= 3, 'relation_budget');
    expect(row.jobs.every(job => integer(job.request_count)) && new Set(row.journal.map(value => `${value.job_id}:${value.attempt}`)).size === row.journal.length &&
      row.journal.every(value => row.jobs.some(job => job.id === value.job_id) && Number.isSafeInteger(value.attempt) && value.attempt > 0), 'reservation_journal');
    expect(raw.ledger.filter(call => call.actor === row.actor).length <= row.budget, 'unreserved_provider_call');
    if (before) {
      expect(equal(select(row, ['actor', 'session', 'windowId', 'listeningId', 'nodes', 'names']), select(before, ['actor', 'session', 'windowId', 'listeningId', 'nodes', 'names'])), 'relation_identity_changed');
      expect(equal(row.knowledge, before.knowledge), 'baseline_knowledge_changed');
      if (!negative) expect(row.budget >= before.budget && before.journal.every((value, i) => row.journal[i] && equal(journalIdentity(value), journalIdentity(row.journal[i]))), 'reservation_history_lost');
      if (action === 'recover' && !negative) expect(row.budget === before.budget && equal(row.journal, before.journal), 'recovery_reservation_journal_changed');
      expect(before.relations.every(value => equal(value, row.relations.find(relation => relation.id === value.id))), 'committed_graph_changed');
    }
    for (const relation of row.relations) {
      expect(relation.predicate === 'released' && relation.version === 1 && relation.subject_item_id === row.nodes[0] && relation.object_item_id === row.nodes[1] &&
        relation.assertions.length === 1, 'invalid_relation_content');
      for (const assertion of relation.assertions) {
        expect(assertion.relation_id === relation.id && assertion.version === 1 && assertion.polarity === 'positive' && assertion.modality === 'asserted' &&
          assertion.supports.length > 0, 'missing_relation_assertion');
        expect(assertion.supports.every(support => support.assertion_id === assertion.id && support.window_id === row.windowId &&
          row.jobs.some(job => job.id === support.job_id) && typeof support.quote === 'string' && support.quote.includes(row.names[0]) &&
          support.quote.includes(row.names[1]) && typeof support.segment_id === 'string' && support.segment_id.length > 0), 'missing_relation_support');
      }
    }
    if (raw.processState === 'up' && ['reserved', 'inflight', 'received'].includes(task.phase)) expect(job?.state === 'running' && row.window.state === 'pending', 'relation_active_job');
    if (['committed', 'done'].includes(task.phase) && ['ok', 'empty'].includes(task.outcome)) expect(job?.state === 'complete' &&
      row.window.state === 'complete' && row.journal.at(-1)?.outcome === 'complete', 'relation_committed_job');
    if (task.phase === 'done' && task.outcome === 'failed') expect(job?.state === 'failed', 'relation_failed_job');
  }
}
function validateKnowledge(raw, previous, config, expect, action) {
  const saved = raw.durable, cp = saved.checkpoint, old = previous?.durable.checkpoint;
  expect(cp.parts.length === config.parts && equal(cp.parts.map(part => part.part_no), Array.from({ length: config.parts }, (_, i) => i)), 'part_domain');
  expect(equal(JSON.parse(cp.job.progress_json), cp.progress), 'progress_json_mismatch');
  expect(Array.isArray(saved.knowledge) && new Set(saved.knowledge.map(row => row.id)).size === saved.knowledge.length, 'knowledge_identity');
  expect(cp.progress.cycle === 1 && integer(cp.progress.extra_requests) && cp.progress.extra_requests <= 2 && integer(cp.progress.protocol_retries) && cp.progress.protocol_retries <= 1 &&
    cp.progress.extra_requests === cp.parts.reduce((sum, part) => sum + Math.max(0, part.initial_requests - 1), 0), 'knowledge_budget');
  if (old) {
    expect(cp.job.id === old.job.id && cp.job.listening_id === old.job.listening_id, 'knowledge_job_changed');
    expect(cp.progress.extra_requests >= old.progress.extra_requests && cp.progress.protocol_retries >= old.progress.protocol_retries, 'shared_budget_reset');
    expect(previous.durable.knowledge.every(item => equal(item, saved.knowledge.find(value => value.id === item.id))), 'accepted_content_changed');
    if (action === 'recover') expect(equal(cp.progress, old.progress), 'recovery_budget_or_deadline_changed');
  }
  if (raw.processState === 'up') {
    if (raw.stage === 'idle') expect(cp.job.state === 'pending', 'knowledge_idle_job');
    if (['reserved', 'inflight', 'received'].includes(raw.stage)) expect(cp.job.state === 'running', 'knowledge_active_job');
    if (raw.stage === 'committed') expect(cp.job.state === 'pending' && cp.job.outcome === null, 'knowledge_committed_job');
    if (raw.stage === 'done') expect(cp.job.state === (cp.job.outcome === 'invalid' ? 'failed' : 'complete'), 'knowledge_terminal_job');
  }
  for (const part of cp.parts) {
    const before = old?.parts.find(row => row.part_no === part.part_no);
    expect(part.job_id === cp.job.id && integer(part.initial_requests) && integer(part.repair_reserved) && part.repair_reserved <= 1 &&
      (part.stats.request_count || 0) === part.initial_requests + part.repair_reserved, 'part_reservation_stats');
    expect(new Set(part.results.map(row => row.sourceIndex)).size === part.results.length, 'duplicate_source_index');
    expect(raw.ledger.filter(row => row.actor === part.part_no && row.kind === 'extract').length <= part.initial_requests &&
      raw.ledger.filter(row => row.actor === part.part_no && row.kind === 'repair').length <= part.repair_reserved, 'unreserved_provider_call');
    if (before) {
      expect(equal(part.focus_refs, before.focus_refs) && part.initial_requests >= before.initial_requests && part.repair_reserved >= before.repair_reserved, 'part_reservation_history_lost');
      expect(before.results.every(result => equal(result, part.results.find(value => value.sourceIndex === result.sourceIndex))), 'accepted_checkpoint_lost');
      if (action === 'recover') {
        const interruptedRepair = before.phase === 'repair_inflight';
        const expectedStats = interruptedRepair ? { ...before.stats, repair_error: 'REPAIR_INTERRUPTED' } : before.stats;
        const expectedUnresolved = interruptedRepair ? before.unresolved.map(target => ({ ...target,
          issues: [...(target.issues || []), { code: 'REPAIR_INTERRUPTED', path: '', details: {} }] })) : before.unresolved;
        expect(equal(part.input_snapshot, before.input_snapshot) && equal(part.stats, expectedStats) &&
          equal(part.unresolved, expectedUnresolved), 'recovery_part_payload_changed');
        expect(part.initial_requests === before.initial_requests && part.repair_reserved === before.repair_reserved && equal(part.results, before.results) &&
          part.ready_at === before.ready_at && part.stats.retry_kind === before.stats.retry_kind && part.stats.initial_complete === before.stats.initial_complete, 'recovery_checkpoint_changed');
        if (before.phase === 'repair_inflight') expect(part.phase === 'done' && part.stats.repair_error === 'REPAIR_INTERRUPTED' &&
          part.unresolved.every(target => target.issues?.some(issue => issue.code === 'REPAIR_INTERRUPTED')), 'missing_repair_interrupted_diagnostic');
      }
    }
    for (const result of part.results) {
      const item = saved.knowledge.find(row => row.id === result.itemId);
      const initialReply = raw.ledger.findLast(row => row.actor === part.part_no && row.kind === 'extract' && ['ok', 'partial', 'rejected', 'unrepairable', 'empty'].includes(row.response))?.response;
      const name = `${initialReply === 'rejected' || result.sourceIndex === 1 ? 'Nova' : 'Atlas'} ${part.part_no}`;
      const segment = part.focus_refs[0]?.segment_id;
      expect(item?.canonical_name === name && item?.content_version === 1 && item?.facts.length === 1 && item?.facts[0]?.item_id === item?.id &&
        item?.facts[0]?.content === `原文正在讨论${name}。` && item?.facts[0]?.surface_text === name && item?.facts[0]?.segment_id === segment &&
        item?.mentions.some(mention => mention.item_id === item.id && mention.segment_id === segment && mention.surface_text === name), 'accepted_fact_or_source_lost');
    }
  }
}

export function validateProcessReplayEvidence(trace, replay, { negative = false } = {}) {
  const reasons = [], coverage = { crashes: 0, recoveries: 0, relation: [], knowledge: [], repair: [], globalTwoInflight: false, globalReservedCommitted: false };
  const fail = (condition, reason) => { if (!condition) reasons.push(reason); };
  try {
    fail(validateProcessTrace(trace), 'invalid_trace');
    fail(interval(replay), 'invalid_replay_timestamps');
    fail(replay.complete === true && (negative ? replay.ok === false && replay.classification === 'implementation_mismatch' : replay.ok === true && replay.classification === 'matched'), 'invalid_replay_classification');
    if (negative) fail(processEvidenceDefinition.expectedImplementationCounterexample(replay), 'wrong_implementation_counterexample');
    const states = [trace.initial, ...trace.steps.map(step => step.expected)], observations = replay.observations;
    fail(Array.isArray(observations) && observations.length === (negative ? 4 : states.length), 'missing_raw_observation');
    let previous;
    for (const [index, observation] of observations.entries()) {
      const raw = observation.durable, step = index - 1, action = step < 0 ? 'init' : trace.steps[step].action;
      const mutation = negative && step === 2, expected = structuredClone(states[index]);
      if (mutation) expected.counts[0] = 0;
      const expect = (condition, reason) => fail(condition, `${step}:${reason}`);
      expect(observation.step === step && equal(observation.actual, expected) && Array.isArray(observation.durableViolations) &&
        (!observation.durableViolations.length || mutation), 'cached_projection_mismatch');
      expect(raw && ['up', 'down'].includes(raw.processState) && integer(raw.generation) && integer(raw.crashes) && Number.isSafeInteger(raw.pid) && raw.pid > 0 && Number.isFinite(raw.clock), 'process_observation_shape');
      expect(equal(projectProcessObservation(raw, trace.config), expected), 'raw_projection_mismatch');
      const identity = raw.evidenceIdentity;
      expect(identity && ['databasePath', 'ledgerPath', 'providerUrl'].every(key => typeof identity[key] === 'string' && identity[key].length > 0) &&
        Number.isSafeInteger(identity.providerPid) && identity.providerPid > 0 && identity.providerPid !== raw.pid, 'missing_independent_resource_identity');
      expect(Array.isArray(raw.ledger) && Array.isArray(raw.exits) && Array.isArray(raw.history) && Array.isArray(raw.launches), 'process_history_shape');
      expect(raw.launches.length === raw.generation + 1 && raw.launches.every((launch, i) => launch.generation === i && Number.isSafeInteger(launch.pid) && launch.pid > 0 && timestamp(launch.startedAt)) &&
        new Set(raw.launches.map(launch => launch.pid)).size === raw.launches.length && raw.launches.at(-1)?.pid === raw.pid, 'fresh_pid_launch_history');
      expect([...raw.launches.map(row => row.startedAt), ...raw.exits.map(row => row.at), ...raw.ledger.map(row => row.receivedAt)].every(value =>
        timestamp(value) && Date.parse(value) >= Date.parse(replay.startedAt) && Date.parse(value) <= Date.parse(replay.finishedAt)), 'process_event_outside_replay');
      expect(raw.exits.length === raw.crashes && raw.crashes <= 1 && raw.exits.every(exit => exit.signal === 'SIGKILL' && exit.code === null && exit.reason === 'crash' && timestamp(exit.at) &&
        raw.launches[exit.generation]?.pid === exit.pid && Date.parse(exit.at) >= Date.parse(raw.launches[exit.generation].startedAt)), 'unconfirmed_sigkill_exit');
      expect(raw.ledger.every((call, i) => call.id === i + 1 && integer(call.generation) && call.generation <= raw.generation && integer(call.actor) &&
        call.actor < (trace.config.actors || trace.config.parts) && (trace.config.protocol === 'relation' ? call.kind === 'relation' : ['extract', 'repair'].includes(call.kind)) &&
        timestamp(call.receivedAt) && typeof call.closed === 'boolean' && validProviderResponse(call)), 'invalid_provider_ledger');
      if (!previous) {
        expect(action === 'init' && raw.processState === 'up' && raw.generation === 0 && raw.crashes === 0 && raw.ledger.length === 0 && raw.exits.length === 0 && raw.history.length === 0, 'invalid_process_initialization');
      } else {
        expect(equal(identity, previous.evidenceIdentity), 'database_or_provider_replaced');
        expect(raw.clock >= previous.clock && (action === 'advance_time' || raw.clock === previous.clock), 'unmodeled_clock_change');
        expect(equal(raw.launches.slice(0, previous.launches.length), previous.launches) && equal(raw.exits.slice(0, previous.exits.length), previous.exits) &&
          equal(raw.history.slice(0, previous.history.length), previous.history), 'rewritten_process_history');
        expect(raw.ledger.length === previous.ledger.length + (action === 'send' ? 1 : 0), 'provider_ledger_reset_or_extra_call');
        expect(previous.ledger.every((call, i) => raw.ledger[i] && equal(ledgerIdentity(call), ledgerIdentity(raw.ledger[i])) &&
          (call.response === raw.ledger[i].response || (call.response === null && !call.closed && action === 'response' && call.actor === trace.steps[step].actor &&
            call.generation === raw.generation && raw.ledger[i].response === trace.steps[step].response)) &&
          (!call.closed || raw.ledger[i].closed)), 'provider_ledger_rewritten');
        const changedResponses = previous.ledger.filter((call, i) => call.response !== raw.ledger[i]?.response);
        expect(changedResponses.length === (action === 'response' ? 1 : 0), 'provider_response_count_mismatch');
        if (action === 'send') expect(raw.ledger.at(-1)?.generation === raw.generation && raw.ledger.at(-1)?.actor === trace.steps[step].actor &&
          raw.ledger.at(-1)?.response === null, 'wrong_provider_request');
        const history = raw.history.at(-1);
        expect(raw.history.length === previous.history.length + (['commit', 'crash', 'recover'].includes(action) ? 1 : 0), 'missing_or_extra_process_event');
        if (action === 'crash') {
          coverage.crashes++;
          expect(previous.processState === 'up' && raw.processState === 'down' && raw.pid === previous.pid && raw.generation === previous.generation &&
            raw.crashes === previous.crashes + 1 && raw.exits.length === previous.exits.length + 1 && raw.launches.length === previous.launches.length, 'invalid_crash_transition');
          expect(history?.action === 'crash' && history.pid === previous.pid && history.generation === previous.generation && equal(history.exit, raw.exits.at(-1)) &&
            history.before?.processState === 'up' && history.before.pid === previous.pid && history.before.generation === previous.generation &&
            equal(history.before.evidenceIdentity, identity) && equal(history.before.durable, previous.durable) && equal(history.after, raw.durable) &&
            equal(history.before.durable, history.after), 'unconfirmed_crash_checkpoint');
          const phases = trace.config.protocol === 'relation' ? Object.values(states[index - 1].phase) : [states[index - 1].stage];
          expect(phases.some(phase => boundaryNames.includes(phase)), 'invalid_crash_boundary');
          coverage[trace.config.protocol].push(...phases.filter(phase => boundaryNames.includes(phase)));
          if (trace.config.protocol === 'knowledge') {
            const lastAdmission = trace.steps.slice(0, step).findLast(value => value.action === 'admit');
            if (lastAdmission?.expected.phase[lastAdmission.actor] === 'repair_inflight') coverage.repair.push(states[index - 1].stage);
          } else {
            coverage.globalTwoInflight ||= phases.filter(phase => phase === 'inflight').length >= 2;
            coverage.globalReservedCommitted ||= phases.includes('reserved') && phases.includes('committed');
          }
        } else if (action === 'recover') {
          coverage.recoveries++;
          expect(previous.processState === 'down' && raw.processState === 'up' && raw.pid !== previous.pid && raw.generation === previous.generation + 1 &&
            raw.crashes === previous.crashes && raw.launches.length === previous.launches.length + 1 && raw.exits.length === previous.exits.length &&
            previous.exits.at(-1)?.pid === previous.pid && Date.parse(raw.launches.at(-1).startedAt) >= Date.parse(previous.exits.at(-1).at), 'recovery_without_confirmed_exit');
          expect(history?.action === 'recover' && history.generation === raw.generation && history.pid === raw.pid && equal(history.before, previous.durable) && equal(history.after, raw.durable), 'unconfirmed_recovery_checkpoint');
        } else {
          expect(raw.processState === previous.processState && raw.generation === previous.generation && raw.pid === previous.pid && raw.crashes === previous.crashes &&
            raw.launches.length === previous.launches.length && raw.exits.length === previous.exits.length, 'unmodeled_process_change');
          if (action === 'commit') expect(history?.action === 'commit' && history.boundaryId === raw.boundary?.id, 'missing_commit_handshake_history');
        }
      }
      if (action === 'commit') expect(raw.boundary?.name === 'committed' && raw.boundary.pid === raw.pid && raw.boundary.generation === raw.generation &&
        raw.boundary.resultNotifications === 0 && equal(raw.boundary.durable, raw.durable), 'not_before_first_notification');
      if (action === 'notify_fail') {
        const failures = trace.config.protocol === 'relation' ? raw.tasks[trace.steps[step].actor]?.notificationFailures : raw.notificationFailures;
        expect(Number.isSafeInteger(failures) && failures > 0, 'notification_failure_not_injected');
      }
      if (trace.config.protocol === 'relation') validateRelation(raw, previous, trace.config, expect, mutation, action);
      else validateKnowledge(raw, previous, trace.config, expect, action);
      previous = raw;
    }
    if (negative) {
      fail(equal(replay.counterexample, { ...trace, steps: trace.steps.slice(0, 3), minimality: 'first-divergence-prefix' }), 'wrong_minimal_counterexample');
      fail(equal(replay.difference.expected, states[3]) && equal(replay.difference.actual, observations.at(-1).actual), 'unbound_first_difference');
    }
  } catch (error) { reasons.push(`invalid_raw_process_evidence:${error.message}`); }
  return { ok: !reasons.length, reasons: [...new Set(reasons)], coverage };
}

export function validateProcessWitnessCoverage(entries) {
  const reasons = [], coverage = { crashes: 0, recoveries: 0, relation: new Set(), knowledge: new Set(), repair: new Set(), globalTwoInflight: false, globalReservedCommitted: false };
  const domains = new Map();
  for (const entry of entries) {
    const result = validateProcessReplayEvidence(entry.trace, entry.replay), current = result.coverage;
    if (!result.ok) reasons.push('invalid_witness_process_evidence');
    const config = entry.trace.config, key = config.protocol === 'relation' ? `relation-${config.actors}-${config.capacity}` : `knowledge-${config.parts}`;
    domains.set(key, (domains.get(key) || 0) + 1);
    const noCrash = entry.sourceTrace?.includes('-relationNoCrashSuccessTest-');
    if (current.crashes !== (noCrash ? 0 : 1) || current.recoveries !== current.crashes) reasons.push('missing_witness_crash_recovery');
    coverage.crashes += current.crashes; coverage.recoveries += current.recoveries;
    for (const field of ['relation', 'knowledge', 'repair']) for (const boundary of current[field]) coverage[field].add(boundary);
    coverage.globalTwoInflight ||= current.globalTwoInflight; coverage.globalReservedCommitted ||= current.globalReservedCommitted;
  }
  if (entries.length !== 29 || coverage.crashes !== 28 || coverage.recoveries !== 28) reasons.push('missing_28_real_crashes');
  for (const [key, count] of [['relation-1-1', 8], ['relation-3-1', 1], ['relation-3-2', 2], ['knowledge-1', 14], ['knowledge-2', 4]]) if (domains.get(key) !== count) reasons.push('missing_five_domain_witnesses');
  for (const field of ['relation', 'knowledge', 'repair']) if (boundaryNames.some(boundary => !coverage[field].has(boundary))) reasons.push(`missing_${field}_boundary_matrix`);
  if (!coverage.globalTwoInflight || !coverage.globalReservedCommitted) reasons.push('missing_global_crash_interleavings');
  return { ok: !reasons.length, reasons: [...new Set(reasons)], coverage: { ...coverage, ...Object.fromEntries(['relation', 'knowledge', 'repair'].map(field => [field, [...coverage[field]].sort()])) } };
}

export async function validateProcessEvidence(directory, options) {
  const summary = await validateFormalEvidence(directory, processEvidenceDefinition, options);
  const reject = (id, reason) => {
    const row = summary.rows.find(row => row.id === id);
    if (row) { row.status = 'incomplete'; row.reasons ||= []; row.reasons.push(reason); }
    else summary.reasons.push(reason);
  };
  try {
    const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
    if (report.environment?.node !== report.tools?.node || !/^v24\./.test(report.environment?.node || '')) summary.reasons.push('missing_node_environment');
    const artifacts = new Map();
    for (const file of report.artifacts || []) {
      if (typeof file.path !== 'string' || path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) continue;
      const raw = await readFile(path.join(directory, file.path), 'utf8');
      if (digest(raw) === file.sha256) artifacts.set(file.path, raw);
    }
    const witnessEntries = [];
    for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) {
      const row = report.results.find(row => row.id === id);
      try {
        const replays = JSON.parse(artifacts.get(row.data));
        for (const replay of replays) {
          const source = report.results.find(row => ['model-witness', 'simulation'].includes(row.kind) && row.traces?.includes(replay.sourceTrace));
          const trace = normalizeProcessTrace(JSON.parse(artifacts.get(replay.sourceTrace)), processTraceConfig(source.id));
          const result = validateProcessReplayEvidence(trace, replay, { negative: id === 'negative-replay' });
          for (const reason of result.reasons) reject(id, `process:${replay.sourceTrace}:${reason}`);
          if (id === 'replay-witnesses') witnessEntries.push({ trace, replay, sourceTrace: replay.sourceTrace });
        }
      } catch { reject(id, 'missing_or_invalid_raw_process_replay'); }
    }
    const matrix = validateProcessWitnessCoverage(witnessEntries);
    for (const reason of matrix.reasons) reject('replay-witnesses', reason);
    summary.processCoverage = matrix.coverage;
    // Counts alone cannot let a copied witness replace one of the fixed paths.
    const source = await readFile(path.join(processModelRoot, 'witnesses.qnt'), 'utf8');
    for (const [, main, body] of source.matchAll(/module (\w+) \{([\s\S]*?)(?=\nmodule |$)/g)) {
      for (const [, name] of body.matchAll(/\brun (\w+)\s*=/g)) if (witnessEntries.filter(entry => path.basename(entry.sourceTrace).startsWith(`${main}-${name}-`)).length !== 1) reject('replay-witnesses', `missing_named_witness:${main}:${name}`);
    }
  } catch { summary.reasons.push('missing_or_invalid_process_report'); }
  summary.ok = !summary.reasons.length && summary.rows.every(row => row.status === 'passed');
  summary.propertyRows = processCoverage(await processEvidenceDefinition.loadConfig()).map(property => ({ ...property,
    status: !summary.reasons.length && property.checks.every(id => summary.rows.find(row => row.id === id)?.status === 'passed') ? 'passed' : 'incomplete' }));
  return summary;
}
