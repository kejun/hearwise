import { isDeepStrictEqual as equal } from 'node:util';
import { validateGenerationTrace } from './generation-protocol-replay.mjs';
import { parseKnowledgeV2 } from '../../knowledge.mjs';
import { buildRelationRequest } from '../../relations.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sessionOf = actor => actor === 1 ? 1 : 0;
const select = (row, fields) => Object.fromEntries(fields.map(field => [field, row[field]]));
const requestName = (protocol, actor, generation) => `Atlas Actor ${actor}${protocol === 'knowledge' ? ` Generation ${generation}` : ''}`;
const identity = ['index', 'listeningId', 'jobId', 'name', 'input', 'attempt'];
const json = value => JSON.parse(JSON.stringify(value));
const byId = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
function rowsMatch(actual, durable) {
  return Array.isArray(actual) && actual.length === durable.length && byId(durable).every((row, i) => equal(select(byId(actual)[i], Object.keys(row)), select(row, Object.keys(row))));
}
function publicQueriesMatch(query, durable, id, protocol) {
  const listening = durable.listenings.find(row => row.id === id);
  if (!listening) return query?.detail === null && query?.graph === null;
  const { detail, graph } = query, items = (durable.knowledge || durable.knowledge_items).filter(row => row.listening_id === id);
  const facts = durable.facts || durable.knowledge_facts, segments = durable.segments.filter(row => row.listening_id === id);
  if (!detail || !graph || !equal(select(detail.listening, Object.keys(listening)), select(listening, Object.keys(listening))) || graph.listeningId !== id ||
    graph.graphRevision !== listening.graph_revision || detail.graph_revision !== listening.graph_revision ||
    !rowsMatch(detail.segments, segments) || detail.segmentCount !== segments.length ||
    !rowsMatch(detail.knowledge, items) || !rowsMatch(graph.nodes, items)) return false;
  for (const nodes of [detail.knowledge, graph.nodes]) for (const node of nodes) {
    if (!rowsMatch(node.facts, facts.filter(row => row.item_id === node.id)) || !equal(node.aliases, []) || !equal(node.revisions, [])) return false;
    const mentions = durable.knowledge_mentions.filter(row => row.item_id === node.id), fields = ['item_id', 'segment_id', 'surface_text'];
    if (mentions.length !== 1 || !equal(node.mentions.map(row => select(row, fields)), mentions.map(row => select(row, fields))) ||
      mentions[0].surface_text !== node.canonical_name || !facts.some(row => row.item_id === node.id && row.segment_id === mentions[0].segment_id)) return false;
  }
  if (durable.knowledge_aliases.length || durable.knowledge_revisions.length) return false;
  const relations = (durable.relations || []).filter(row => row.listening_id === id);
  const assertions = (durable.relation_assertions || []).filter(row => relations.some(edge => edge.id === row.relation_id));
  const supports = (durable.relation_supports || []).filter(row => assertions.some(assertion => assertion.id === row.assertion_id));
  if (!rowsMatch(graph.relations, relations) || !rowsMatch(graph.assertions, assertions) || !rowsMatch(graph.supports, supports)) return false;
  for (const edge of graph.relations) if (!rowsMatch(edge.assertions, assertions.filter(row => row.relation_id === edge.id))) return false;
  for (const assertion of graph.assertions) if (!rowsMatch(assertion.supports, supports.filter(row => row.assertion_id === assertion.id))) return false;
  if (protocol === 'knowledge') {
    const jobs = durable.jobs.filter(row => row.listening_id === id), fields = ['id', 'listening_id', 'state', 'attempts', 'outcome', 'last_error'];
    if (!equal(byId(detail.jobs).map(row => select(row, fields)), byId(jobs).map(row => select(row, fields)))) return false;
  } else {
    const jobs = durable.relation_jobs.filter(row => row.listening_id === id);
    if (graph.status.requestCount !== jobs.reduce((sum, row) => sum + row.request_count, 0) ||
      graph.status.runningJobs !== jobs.filter(row => row.state === 'running').length) return false;
  }
  return equal(detail.graph.status, graph.status) && equal(detail.processing.relations, graph.status);
}

function responseMatches(call, protocol) {
  if (call.response === null) return call.responseWire === null && call.responseValue === null && call.responseError === null;
  if (call.response === 'failure') return call.responseWire === null && call.responseValue === null &&
    equal(call.responseError, { name: 'Error', message: 'Synthetic provider configuration failure', status: 418, ...(protocol === 'relation' ? { usage: { total_tokens: 11 } } : {}) });
  if (!['ok', 'empty'].includes(call.response) || typeof call.responseWire !== 'string' || call.responseError !== null) return false;
  const wire = JSON.parse(call.responseWire);
  if (protocol === 'knowledge') {
    if (!equal(wire, { items: call.response === 'empty' ? [] : [{ action: 'create', type: 'other', display_label: 'organization', canonical_name: call.name,
      role: '主体', reason: '原文讨论的公司', existing_item_id: null, observed_candidate_id: null, aliases: [], correction_reason: null,
      short_description: `${call.name}是原文讨论的公司。`, new_information: `${call.name}发布了新产品。`, certainty: 'clear',
      evidence: [{ segment_id: call.input.focus_segments[0].id, quote: call.name }] }] })) return false;
    return equal(call.responseValue, json(parseKnowledgeV2(call.responseWire, call.input)));
  }
  const request = buildRelationRequest(call.input), input = JSON.parse(request.body.messages[1].content);
  const evidence = input.evidence.find(row => row.scope === 'focus' && row.quote.includes(call.name) && row.quote.includes(call.name.replace('Atlas', 'Nova')));
  const relations = call.response === 'empty' ? [] : [{ subject_item_id: input.candidates.find(row => row.canonical_name === call.name).id,
    object_item_id: input.candidates.find(row => row.canonical_name === call.name.replace('Atlas', 'Nova')).id,
    predicate: 'released', polarity: 'positive', modality: 'asserted', status: 'active', evidence_ids: [evidence.id] }];
  return equal(wire, { contract_version: input.contract_version, evidence_version: input.evidence_version, relations }) &&
    equal(call.responseValue, json({ ...request.parse(call.responseWire), usage: { total_tokens: 11 } }));
}

// Re-evaluate actual SQLite rows, provider/permit observations and immutable
// identities against the independent ITF states. Adapter projections and an
// empty adapter.check() array are never accepted as the only evidence.
export function validateGenerationReplayEvidence(trace, replay) {
  const reasons = [], expect = (condition, reason) => { if (!condition && !reasons.includes(reason)) reasons.push(reason); };
  try {
    expect(validateGenerationTrace(trace), 'invalid_trace');
    expect(replay?.complete === true && replay.ok === true && replay.classification === 'matched', 'incomplete_replay');
    expect(time(replay?.startedAt) && time(replay?.finishedAt) && Date.parse(replay.finishedAt) >= Date.parse(replay.startedAt), 'invalid_execution_interval');
    expect(Array.isArray(replay.observations) && replay.observations.length === trace.steps.length + 1, 'observation_roster');
    const { protocol, actors, capacity } = trace.config;
    let previous; const knownSegments = new Map();
    for (const [index, observation] of replay.observations.entries()) {
      const step = index ? trace.steps[index - 1] : null, expected = step?.expected || trace.initial;
      const { config, bindings, raw, mutation, boundaryTrials } = observation.durable;
      expect(observation.step === index - 1 && equal(observation.actual, expected) && equal(observation.durableViolations, []), 'projection_mismatch');
      expect(equal(config, trace.config) && mutation === 'none' && equal(boundaryTrials, []), 'unexpected_fixture_configuration');
      expect(bindings.sessions.length === (actors === 1 ? 1 : 2) && bindings.actors.length === actors && bindings.requests.length === actors * 2, 'identity_roster');
      expect(new Set(bindings.sessions.map(row => row.id)).size === bindings.sessions.length && bindings.sessions.every((row, i) => row.index === i && typeof row.id === 'string'), 'session_identity');
      expect(bindings.actors.every((row, i) => row.index === i && row.session === sessionOf(i) && row.name === requestName(protocol, i, 0)), 'actor_identity');
      expect(bindings.requests.every((row, i) => row.id === i && row.actor === Math.floor(i / 2) && row.generation === i % 2 && row.name === requestName(protocol, row.actor, row.generation)), 'request_identity');
      expect(raw.admission.controlled === true && raw.admission.permit === expected.admissionPermit && integer(raw.clock), 'admission_environment');
      expect(integer(raw.hostPid) && raw.hostPid > 0, 'host_process_identity');
      expect(typeof raw.database.file === 'string' && integer(raw.database.device) && integer(raw.database.inode) && raw.database.storeGeneration === expected.restartCount + 1, 'database_identity');
      expect(Array.isArray(raw.durable.foreignKeys) && raw.durable.foreignKeys.length === 0, 'foreign_key_violation');
      for (const segment of raw.durable.segments) {
        expect(!knownSegments.has(segment.id) || equal(knownSegments.get(segment.id), segment), 'source_segment_rewritten');
        knownSegments.set(segment.id, segment);
      }
      expect(Array.isArray(raw.calls) && Array.isArray(raw.executions) && Array.isArray(raw.ledger), 'raw_roster');
      expect(raw.calls.length === bindings.requests.filter(row => row.callIndex !== null).length && raw.executions.length === raw.calls.length, 'call_execution_roster');
      expect(raw.ledger.every((row, i) => row.sequence === i), 'ledger_sequence');
      for (const call of raw.calls) {
        const executions = raw.executions.filter(row => row.jobId === call.jobId);
        expect(executions.length === 1 && executions[0].listeningId === call.listeningId && typeof executions[0].settled === 'boolean' &&
          (protocol === 'knowledge' ? executions[0].attempt === 1 : !Object.hasOwn(executions[0], 'attempt')), 'execution_owner_identity');
        for (const event of ['provider_reserved', 'provider_started']) {
          const rows = raw.ledger.filter(row => row.event === event && row.index === call.index);
          expect(rows.length === (event === 'provider_reserved' ? 1 : Number(call.sent)) && rows.every(row => row.jobId === call.jobId && row.listeningId === call.listeningId), 'provider_ledger_identity');
        }
        const deliveries = raw.ledger.filter(row => row.event === 'provider_delivery' && row.index === call.index);
        expect(deliveries.length === call.deliveries && deliveries.every((row, i) => row.delivery === i + 1 && row.response === (i ? 'ok' : call.response)), 'provider_ledger_delivery');
      }
      for (const row of raw.ledger.filter(row => ['provider_reserved', 'provider_started', 'provider_delivery', 'provider_abort_observed', 'provider_usage'].includes(row.event)))
        expect(integer(row.index) && row.index < raw.calls.length, 'provider_ledger_actor');
      if (protocol === 'knowledge') for (const job of raw.durable.jobs) expect(
        equal(JSON.parse(job.progress_json), job.progress) && job.progress.cycle === 1 && job.progress.extra_requests === 0 && job.progress.protocol_retries === 0 &&
        [0, 1].includes(job.attempts) && job.parts.length === 1 && job.parts.every(part => part.repair_reserved === 0 && [0, 1].includes(part.initial_requests)), 'knowledge_envelope_budget');
      for (const row of raw.ledger.filter(row => row.event === 'admission_readiness')) expect(integer(row.clock) &&
        typeof row.permit === 'boolean' && row.readyAt === row.clock + (row.permit ? 0 : 60000), 'provider_readiness');
      const permits = raw.ledger.filter(row => row.event === 'admission_permit'), admissions = raw.ledger.filter(row => row.event === 'admission_consumed');
      expect(permits.length === expected.permitsIssued && admissions.length === expected.admissionsObserved &&
        permits.length - admissions.length === Number(raw.admission.permit), 'permit_accounting');
      expect(admissions.length === raw.calls.length, 'admission_call_accounting');
      for (const call of raw.calls) expect(admissions.filter(row => row.jobId === call.jobId && row.listeningId === call.listeningId).length === 1, 'missing_actual_admission');
      const restarted = raw.ledger.filter(row => row.event === 'restart_http'); expect(restarted.length === expected.restartCount, 'restart_observation');
      for (const row of restarted) expect(integer(row.pid) && row.pid > 0 && integer(row.parentPid) && row.parentPid > 0 && row.pid !== row.parentPid && row.parentPid === raw.hostPid && row.exit?.pid === row.pid &&
        time(row.startedAt) && time(row.finishedAt) && Date.parse(row.finishedAt) >= Date.parse(row.startedAt) && Date.parse(row.startedAt) >= Date.parse(replay.startedAt) && Date.parse(row.finishedAt) <= Date.parse(replay.finishedAt) &&
        (row.exit?.code === 0 && row.exit.signal === null || row.exit?.code === null && row.exit.signal === 'SIGTERM') &&
        Object.keys(row.queries).length === bindings.sessions.length, 'restart_public_queries');
      expect(new Set(restarted.map(row => row.pid)).size === restarted.length, 'restart_pid_reused');
      const lastRestart = raw.ledger.findLast(row => row.event === 'scheduler_reopened')?.sequence ?? -1;
      const lastAdmission = admissions.findLast(row => row.sequence > lastRestart);
      expect(expected.lastServedSession === (lastAdmission ? bindings.sessions.find(row => row.id === lastAdmission.listeningId)?.index : -1), 'round_robin_observation');
      if (previous) {
        expect(raw.hostPid === previous.raw.hostPid, 'host_process_changed');
        expect(equal(raw.ledger.slice(0, previous.raw.ledger.length), previous.raw.ledger), 'rewritten_ledger');
        expect(equal(select(raw.database, ['file', 'device', 'inode']), select(previous.raw.database, ['file', 'device', 'inode'])), 'database_replaced');
        expect(raw.clock === previous.raw.clock + (step.action === 'permit' ? 6000 : 0), 'virtual_clock_changed');
        expect(equal(bindings.sessions, previous.bindings.sessions), 'session_identity_changed');
        const added = raw.ledger.slice(previous.raw.ledger.length);
        const actionRequest = bindings.requests.find(row => row.id === step.actor);
        const actionCall = step.action === 'reserve' ? raw.calls.at(-1) : raw.calls[actionRequest?.callIndex];
        for (const [event, action] of [['provider_reserved', 'reserve'], ['provider_started', 'send']]) {
          const rows = added.filter(row => row.event === event);
          expect(rows.length === Number(step.action === action) && rows.every(row => row.index === actionCall.index && row.jobId === actionCall.jobId && row.listeningId === actionCall.listeningId), 'provider_action_binding');
        }
        const delivered = added.filter(row => row.event === 'provider_delivery');
        expect(delivered.length === Number(['response', 'duplicate'].includes(step.action)) && delivered.every(row => row.index === actionCall.index &&
          row.response === (step.response === 'failed' ? 'failure' : 'ok') && row.delivery === previous.raw.calls[row.index].deliveries + 1), 'delivery_action_binding');
        const usage = added.filter(row => row.event === 'provider_usage');
        expect(usage.length === Number(step.action === 'usage') && usage.every(row => row.index === actionCall.index && row.totalTokens === 7), 'usage_action_binding');
        expect(added.filter(row => row.event === 'restart_http').length === Number(step.action === 'restart'), 'restart_action_binding');
        if (step.action === 'restart') {
          const closed = added.filter(row => row.event === 'local_resources_closed');
          expect(closed.length === 1 && closed[0].activeExecutions === 0 && closed[0].timers === 0 &&
            closed[0].storeGeneration === previous.raw.database.storeGeneration && (protocol !== 'knowledge' || closed[0].activeCount === 0), 'restart_resource_cleanup');
          const server = added.find(row => row.event === 'restart_http');
          for (const session of bindings.sessions) {
            const response = server.queries[session.id], present = expected.present[session.index];
            expect(response?.detail.status === (present ? 200 : 404) && response?.graph.status === (present ? 200 : 404), 'restart_http_status');
            if (present) expect(publicQueriesMatch({ detail: response.detail.body, graph: response.graph.body }, raw.durable, session.id, protocol), 'restart_http_content');
            else expect(response.detail.body.error === '收听记录不存在' && response.graph.body.error === '收听记录不存在', 'restart_deleted_body');
          }
        }
        expect(added.filter(row => row.event === 'admission_permit').length === Number(step.action === 'permit') &&
          added.filter(row => row.event === 'admission_consumed').length === Number(step.action === 'reserve'), 'action_permit_binding');
        expect(raw.calls.length === previous.raw.calls.length + Number(step.action === 'reserve'), 'unexpected_physical_request');
        const target = bindings.requests.find(row => row.id === step.actor);
        const priorCall = target && previous.raw.calls[target.callIndex];
        const late = step.action === 'response' && priorCall?.aborted;
        if (late || ['duplicate', 'usage'].includes(step.action)) {
          const fields = Object.keys(raw.durable).filter(key => key !== 'relation_requests');
          expect(equal(select(raw.durable, fields), select(previous.raw.durable, fields)), 'late_callback_changed_persistence');
          if (protocol === 'relation') {
            const oldJournal = previous.raw.durable.relation_requests, journal = raw.durable.relation_requests;
            expect(journal.length === oldJournal.length, 'late_callback_changed_budget');
            for (const old of oldJournal) {
              const next = journal.find(row => row.job_id === old.job_id && row.attempt === old.attempt);
              if (step.action !== 'duplicate' && old.job_id === priorCall?.jobId && old.attempt === priorCall?.attempt)
                expect(equal(json(next), { ...old, usage_json: JSON.stringify({ total_tokens: step.action === 'usage' ? 7 : 11 }), outcome: priorCall.aborted ? 'late_response' : 'response_received' }), 'late_usage_wrong_attempt');
              else expect(equal(next, old), 'late_usage_changed_other_attempt');
            }
          }
        }
        for (const call of previous.raw.calls) {
          const next = raw.calls[call.index]; expect(equal(select(next, identity), select(call, identity)), 'rewritten_provider_identity');
          const beforeExecution = previous.raw.executions.find(row => row.jobId === call.jobId), afterExecution = raw.executions.find(row => row.jobId === call.jobId);
          expect(equal(select(beforeExecution, ['jobId', 'listeningId', 'attempt']), select(afterExecution, ['jobId', 'listeningId', 'attempt'])), 'execution_identity_changed');
          const request = bindings.requests.find(row => row.callIndex === call.index), targeted = step.actor === request.id;
          const delivery = targeted && ['response', 'duplicate'].includes(step.action);
          expect(next.deliveries === call.deliveries + Number(delivery), 'provider_delivery_count');
          expect(next.response === (delivery && call.response === null ? (step.response === 'failed' ? 'failure' : 'ok') : call.response), 'provider_response_binding');
          expect(next.sent === (call.sent || step.action === 'send' && targeted), 'provider_send_binding');
          expect(next.transportSettled === (call.transportSettled || delivery), 'provider_completion_binding');
          if (call.response !== null) expect(equal(select(next, ['responseWire', 'responseValue', 'responseError']), select(call, ['responseWire', 'responseValue', 'responseError'])), 'rewritten_response_payload');
        }
      } else expect(raw.calls.length === 0 && raw.executions.length === 0 && expected.restartCount === 0, 'initial_observation');
      let localOwners = 0;
      const actualBusiness = Object.fromEntries(bindings.actors.map(actor => [actor.index, []]));
      for (const session of bindings.sessions) {
        const exists = raw.durable.listenings.some(row => row.id === session.id), query = raw.queries[session.id];
        expect(exists === expected.present[session.index], 'listening_presence');
        expect(query && (exists ? query.detail !== null && query.graph !== null : query.detail === null && query.graph === null), 'public_query_presence');
        expect(publicQueriesMatch(query, raw.durable, session.id, protocol), 'public_query_content');
        if (protocol === 'relation') {
          const round = raw.durable.relation_rounds.filter(row => row.listening_id === session.id).sort((a, b) => b.epoch - a.epoch)[0];
          expect(expected.cancelled[session.index] === (!exists || round?.state === 'cancelled'), 'relation_cancellation_state');
        } else expect(expected.cancelled[session.index] === false, 'knowledge_cancellation_state');
      }
      for (const actor of bindings.actors) {
        expect(actor.generation === expected.generation[actor.index], 'generation_identity');
        const actorRequests = bindings.requests.filter(row => row.actor === actor.index);
        if (protocol === 'knowledge') expect(actor.generation === Number(actorRequests[1].jobId !== null), 'knowledge_successor_identity');
        else {
          const rounds = raw.durable.relation_rounds.filter(row => row.listening_id === bindings.sessions[actor.session].id);
          if (rounds.length) expect(actor.generation === Math.max(...rounds.map(row => row.epoch)) - 1, 'relation_epoch_identity');
        }
        const latest = actorRequests.filter(row => row.callIndex !== null).at(-1), latestCall = latest && raw.calls[latest.callIndex];
        const execution = latestCall && raw.executions.find(row => row.jobId === latestCall.jobId);
        const owner = execution && !execution.settled ? latest.id : -1;
        if (owner !== -1) localOwners++;
        expect(expected.activeOwner[actor.index] === owner, 'logical_owner');
        const outcome = expected.present[actor.session] && execution?.result?.kind === 'terminal' ? (execution.result.outcome === 'ok' ? 'ok' : 'failed') : 'none';
        expect(expected.outcome[actor.index] === outcome, 'workflow_outcome');
      }
      expect(localOwners <= capacity && (protocol !== 'knowledge' || raw.runtime.activeCount === localOwners), 'actual_local_capacity');
      for (const request of bindings.requests) {
        expect(expected.requestGeneration[request.id] === request.generation, 'request_generation');
        if (protocol === 'knowledge') expect(expected.creationRank[request.id] === request.creationRank, 'creation_order');
        if (request.callIndex === null) {
          expect(expected.physical[request.id] === 'none' && expected.reserved[request.id] === 0 && expected.calls[request.id] === 0 && expected.callbackCount[request.id] === 0, 'unadmitted_request'); continue;
        }
        const call = raw.calls[request.callIndex], execution = raw.executions.find(row => row.jobId === call.jobId);
        expect(call.index === request.callIndex && call.jobId === request.jobId && call.name === request.name &&
          call.listeningId === bindings.sessions[sessionOf(request.actor)].id, 'provider_actor_binding');
        expect(Array.isArray(call.input.focus_segments) && call.input.focus_segments.length === (protocol === 'knowledge' ? 1 : 6) &&
          call.input.focus_segments.every(segment => segment.text === (protocol === 'knowledge' ? `${call.name} released a new product.` : `${call.name} launched ${call.name.replace('Atlas', 'Nova')}.`)), 'provider_input_binding');
        expect(call.input.focus_segments.every(segment => { const source = knownSegments.get(segment.id); return source?.listening_id === call.listeningId && source.original_text === segment.text; }), 'persistent_provider_source');
        expect(responseMatches(call, protocol), 'provider_response_payload');
        expect(['reserved', 'pending', 'settled'].includes(call.status) && call.status === (call.transportSettled ? 'settled' : call.sent ? 'pending' : 'reserved'), 'provider_transport_state');
        expect(expected.physical[request.id] === (call.transportSettled ? 'settled' : call.sent ? 'inflight' : 'reserved') && expected.calls[request.id] === Number(call.sent), 'physical_projection');
        const abort = raw.ledger.find(row => row.event === 'provider_abort_observed' && row.index === call.index);
        expect(call.aborted === Boolean(abort), 'actual_abort_signal');
        expect(expected.aborted[request.id] === Boolean(abort && (protocol === 'relation' || abort.reason !== 'superseded')), 'abort_projection');
        expect(expected.callbackCount[request.id] === Number(execution?.result?.kind === 'terminal'), 'business_callback_count');
        if (protocol === 'knowledge') {
          const job = raw.durable.jobs.find(row => row.id === call.jobId);
          expect(expected.reserved[request.id] === (job?.parts.reduce((sum, part) => sum + part.initial_requests, 0) || 0) && expected.usage[request.id] === 'none', 'knowledge_reservation');
          if (!job) continue;
          expect(job.parts.length === 1 && equal(JSON.parse(job.progress_json), job.progress) && job.listening_id === call.listeningId, 'knowledge_checkpoint');
          if (!execution.settled) expect(job.state === 'running', 'knowledge_active_state');
          if (execution.result?.kind === 'terminal') expect(job.state === (execution.result.outcome === 'invalid' ? 'failed' : 'complete') && job.outcome === execution.result.outcome && job.parts.every(part => part.phase === 'done'), 'knowledge_terminal_state');
          let accepted = false;
          for (const part of job.parts) for (const entry of part.results) if (entry.itemId) {
            const item = raw.durable.knowledge.find(row => row.id === entry.itemId), facts = raw.durable.facts.filter(row => row.item_id === entry.itemId);
            expect(item?.canonical_name === request.name && item?.content_version === 1, 'accepted_identity');
            expect(facts.length === 1 && facts[0].content === `${request.name}发布了新产品。` && facts[0].surface_text === request.name &&
              facts[0].segment_id === call.input.focus_segments[0].id && facts[0].certainty === 'clear', 'accepted_fact');
            accepted ||= Boolean(item);
          }
          if (accepted) actualBusiness[request.actor].push(request.id);
        } else {
          const job = raw.durable.relation_jobs.find(row => row.id === call.jobId);
          const journal = raw.durable.relation_requests.find(row => row.job_id === call.jobId && row.attempt === call.attempt);
          expect(expected.reserved[request.id] === Number(Boolean(journal)), 'relation_reservation');
          expect(expected.usage[request.id] === (journal && journal.usage_json !== null ? journal.outcome === 'late_response' ? 'late_response' : 'response_received' : 'none'), 'usage_attribution');
          if (!job) continue;
          expect(equal(JSON.parse(job.input_json), call.input), 'persistent_relation_input');
          expect(job.listening_id === call.listeningId && job.epoch === request.generation + 1 && job.request_count === 1 && call.attempt === 1, 'relation_job_identity');
          if (!execution.settled) expect(job.state === 'running', 'relation_active_state');
          if (execution.result?.kind === 'terminal') expect(job.state === (execution.result.outcome === 'failed' ? 'failed' : 'complete'), 'relation_terminal_state');
          const supports = raw.durable.relation_supports.filter(row => row.job_id === call.jobId && row.state === 'active');
          if (supports.length) actualBusiness[request.actor].push(request.id);
          for (const support of supports) {
            expect(support.window_id === job.window_id && call.input.focus_segments.some(segment => segment.id === support.segment_id && segment.text === support.quote) &&
              support.quote.includes(call.name) && support.quote.includes(call.name.replace('Atlas', 'Nova')), 'relation_support');
            const assertion = raw.durable.relation_assertions.find(row => row.id === support.assertion_id), edge = raw.durable.relations.find(row => row.id === assertion?.relation_id);
            const subject = raw.durable.knowledge_items.find(row => row.id === edge?.subject_item_id), object = raw.durable.knowledge_items.find(row => row.id === edge?.object_item_id);
            expect(assertion?.version === 1 && assertion.polarity === 'positive' && assertion.modality === 'asserted' && edge?.predicate === 'released' &&
              subject?.canonical_name === call.name && object?.canonical_name === call.name.replace('Atlas', 'Nova'), 'relation_content');
          }
        }
      }
      expect(equal(actualBusiness, expected.business), 'persistent_business_projection');
      const acceptedCount = Object.values(actualBusiness).reduce((sum, values) => sum + values.length, 0);
      expect((protocol === 'knowledge' ? raw.durable.knowledge.length : raw.durable.relations.length) === acceptedCount, 'unexpected_business_rows');
      if (protocol === 'knowledge') expect(expected.nextCreationRank === bindings.requests.filter(row => row.jobId !== null).length, 'successor_creation_order');
      previous = observation.durable;
    }
  } catch (error) { expect(false, `malformed_evidence:${error.name}`); }
  return { ok: reasons.length === 0, reasons };
}
