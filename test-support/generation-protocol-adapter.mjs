import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { loadRelationCommitGuardVariant } from './generation-commit-variant.mjs';
import { createGenerationFixture } from './generation-isolation-fixture.mjs';
import { generationInitialProjection, generationReplayRefinement, validGenerationConfig } from '../scripts/lib/generation-protocol-replay.mjs';

const sessionOf = actor => actor === 1 ? 1 : 0;
const actorName = (protocol, actor, generation) => `Atlas Actor ${actor}${protocol === 'knowledge' ? ` Generation ${generation}` : ''}`;

// Identity mappings describe concrete fixture creation and observed admissions.
// They are not copied from expected model states. Every budget/content/outcome
// below is read from SQLite or the actual workflow's completion observation.
export function projectGenerationObservation({ config, bindings, raw }) {
  const result = generationInitialProjection(config), { protocol } = config;
  const calls = new Map(bindings.requests.filter(request => request.callIndex !== null).map(request => [request.id, raw.calls[request.callIndex]]));
  for (const session of bindings.sessions) {
    const exists = raw.durable.listenings.some(row => row.id === session.id);
    result.present[session.index] = exists;
    if (protocol === 'relation') {
      const round = raw.durable.relation_rounds.filter(row => row.listening_id === session.id).sort((a, b) => b.epoch - a.epoch)[0];
      result.cancelled[session.index] = !exists || round?.state === 'cancelled';
    }
  }
  for (const actor of bindings.actors) {
    const present = result.present[actor.session];
    result.generation[actor.index] = actor.generation;
    const admitted = bindings.requests.filter(request => request.actor === actor.index && request.callIndex !== null);
    const latest = admitted.at(-1), call = latest && calls.get(latest.id);
    const execution = call && raw.executions.find(value => value.jobId === call.jobId);
    if (execution && !execution.settled) result.activeOwner[actor.index] = latest.id;
    if (present && execution?.result?.kind === 'terminal') result.outcome[actor.index] = execution.result.outcome === 'ok' ? 'ok' : 'failed';
  }
  for (const request of bindings.requests) {
    const call = calls.get(request.id); if (!call) continue;
    const exists = result.present[sessionOf(request.actor)];
    const execution = raw.executions.find(value => value.jobId === call.jobId);
    const abort = raw.ledger.find(entry => entry.event === 'provider_abort_observed' && entry.index === call.index);
    result.aborted[request.id] = Boolean(abort && (protocol === 'relation' || abort.reason !== 'superseded'));
    result.physical[request.id] = call.transportSettled ? 'settled' : call.sent ? 'inflight' : 'reserved';
    result.calls[request.id] = call.sent ? 1 : 0;
    result.callbackCount[request.id] = execution?.result?.kind === 'terminal' ? 1 : 0;
    if (protocol === 'knowledge') {
      const job = raw.durable.jobs.find(row => row.id === call.jobId);
      result.reserved[request.id] = job?.parts.reduce((sum, part) => sum + part.initial_requests, 0) || 0;
      const accepted = job?.parts.some(part => part.results.some(value => value.itemId && raw.durable.knowledge.some(item => item.id === value.itemId)));
      if (exists && accepted) result.business[request.actor].push(request.id);
    } else {
      const journal = raw.durable.relation_requests.find(row => row.job_id === call.jobId && row.attempt === call.attempt);
      result.reserved[request.id] = journal ? 1 : 0;
      if (journal && journal.usage_json !== null) result.usage[request.id] = journal.outcome === 'late_response' ? 'late_response' : 'response_received';
      if (exists && raw.durable.relation_supports.some(row => row.job_id === call.jobId && row.state === 'active')) result.business[request.actor].push(request.id);
    }
  }
  result.restartCount = raw.ledger.filter(row => row.event === 'restart_http').length;
  if (config.refinement) {
    result.admissionPermit = raw.admission.permit;
    result.permitsIssued = raw.ledger.filter(row => row.event === 'admission_permit').length;
    const admissions = raw.ledger.filter(row => row.event === 'admission_consumed'); result.admissionsObserved = admissions.length;
    const lastRestart = raw.ledger.findLast(row => row.event === 'scheduler_reopened')?.sequence ?? -1;
    const lastAdmission = admissions.findLast(row => row.sequence > lastRestart);
    result.lastServedSession = lastAdmission ? bindings.sessions.find(session => session.id === lastAdmission.listeningId).index : -1;
    if (protocol === 'knowledge') {
      for (const request of bindings.requests) result.creationRank[request.id] = request.creationRank;
      result.nextCreationRank = bindings.requests.filter(request => request.jobId !== null).length;
    }
  }
  return result;
}

export async function createGenerationProtocolAdapter(config, { mutation = 'none' } = {}) {
  assert.ok(['none', 'skip_reservation', 'omit_transaction_guard', 'corrupt_accepted_fact'].includes(mutation));
  assert.ok(mutation !== 'omit_transaction_guard' || config.protocol === 'relation');
  assert.equal(validGenerationConfig(config), true); assert.equal(config.refinement, generationReplayRefinement);
  const h = await createGenerationFixture({ protocol: config.protocol, capacity: config.capacity, controlledAdmission: true });
  if (mutation === 'skip_reservation') {
    if (config.protocol === 'relation') h.store.beginRelationRequest = jobId => h.store.getRelationJob(jobId);
    else {
      const save = h.store.saveKnowledgeCheckpoint.bind(h.store);
      h.store.saveKnowledgeCheckpoint = (id, patch, accepted) => {
        if (patch.state === 'running' && patch.part?.phase === 'extract_inflight') {
          const previous = h.store.knowledgeCheckpoint(id).parts.find(part => part.part_no === patch.part.part_no);
          patch = { ...patch, part: { ...patch.part, initial_requests: previous.initial_requests } };
        }
        return save(id, patch, accepted);
      };
    }
  }
  const boundaryTrials = [];
  const bindings = { sessions: [], actors: [], requests: [] };
  const capture = () => ({ config: { ...config }, bindings: structuredClone(bindings), raw: h.snapshot(), mutation, boundaryTrials: structuredClone(boundaryTrials) });
  const refreshRelationGeneration = () => {
    if (config.protocol !== 'relation') return;
    const raw = h.snapshot();
    for (const actor of bindings.actors) {
      const rounds = raw.durable.relation_rounds.filter(round => round.listening_id === bindings.sessions[actor.session].id);
      if (rounds.length) actor.generation = Math.max(...rounds.map(round => round.epoch)) - 1;
    }
  };
  try {
    for (let index = 0; index < (config.actors === 1 ? 1 : 2); index++) bindings.sessions.push({ index, id: h.addListening() });
    for (let index = 0; index < config.actors; index++) {
      const session = sessionOf(index), name = actorName(config.protocol, index, 0);
      const task = h.addTask(bindings.sessions[session].id, name);
      bindings.actors.push({ index, session, name, generation: 0 });
      for (const generation of [0, 1]) bindings.requests.push({ id: index * 2 + generation, actor: index, generation,
        name: actorName(config.protocol, index, generation), jobId: config.protocol === 'knowledge' && generation === 0 ? task : null,
        creationRank: generation === 0 ? index : -1, callIndex: null });
    }
    for (const session of bindings.sessions) h.enable(session.id);
    await h.settle(); refreshRelationGeneration();
  } catch (error) { await h.close(); throw error; }
  return {
    project: () => projectGenerationObservation(capture()), observe: capture,
    check() {
      const observed = capture(), failures = [], projection = projectGenerationObservation(observed);
      if (observed.raw.durable.foreignKeys.length) failures.push('foreign_key_violation');
      if (config.protocol === 'knowledge') for (const request of bindings.requests) {
        const call = observed.raw.calls[request.callIndex], job = observed.raw.durable.jobs.find(row => row.id === request.jobId);
        if (!job || !call) continue;
        for (const part of job.parts) for (const accepted of part.results) if (accepted.itemId) {
          const item = observed.raw.durable.knowledge.find(row => row.id === accepted.itemId);
          const facts = observed.raw.durable.facts.filter(row => row.item_id === accepted.itemId);
          if (item?.canonical_name !== request.name || item?.content_version !== 1) failures.push('accepted_identity_changed');
          if (facts.length !== 1 || facts[0]?.content !== `${request.name}发布了新产品。` || facts[0]?.segment_id !== call.input.focus_segments[0].id ||
            facts[0]?.surface_text !== request.name || facts[0]?.certainty !== 'clear') failures.push('accepted_fact_changed');
        }
        const execution = observed.raw.executions.find(row => row.jobId === job.id);
        if (!execution?.settled && job.state !== 'running') failures.push('active_job_state');
        if (execution?.result?.kind === 'terminal' && (job.state !== (execution.result.outcome === 'invalid' ? 'failed' : 'complete') ||
          job.outcome !== execution.result.outcome || job.parts.some(part => part.phase !== 'done'))) failures.push('terminal_job_state');
      }
      if (Object.values(projection.activeOwner).filter(owner => owner !== -1).length > config.capacity) failures.push('capacity_exceeded');
      if (config.protocol === 'knowledge' && observed.raw.runtime.activeCount !== Object.values(projection.activeOwner).filter(owner => owner !== -1).length) failures.push('runtime_owner_mismatch');
      return failures;
    },
    async act({ action, actor, response }) {
      const request = bindings.requests.find(value => value.id === actor);
      if (action === 'permit') h.permitAdmission();
      else if (action === 'reserve') {
        const count = h.calls.length; await h.admit(); assert.equal(h.calls.length, count + 1);
        const call = h.calls.at(-1), actual = bindings.actors.find(value => actorName(config.protocol, value.index, value.generation) === call.name);
        assert.ok(actual, 'Provider input must map to an existing concrete actor');
        const owner = bindings.requests.find(value => value.actor === actual.index && value.generation === actual.generation);
        assert.equal(owner.callIndex, null, 'One request per lifecycle envelope');
        if (config.protocol === 'knowledge') assert.equal(owner.jobId, call.jobId);
        owner.callIndex = call.index; owner.jobId = call.jobId;
      } else if (action === 'send') await h.send(request.callIndex);
      else if (action === 'response') {
        await h.respond(request.callIndex, response === 'failed' ? 'failure' : 'ok');
        if (mutation === 'corrupt_accepted_fact' && config.protocol === 'knowledge' && response === 'ok') h.store.db.prepare("UPDATE knowledge_facts SET content='Corrupted accepted fact'").run();
        const call = h.calls[request.callIndex];
        if (mutation === 'omit_transaction_guard' && response === 'ok' && call.signal.aborted) {
          const before = h.snapshot(), normal = h.store.commitRelationJob(call.jobId, call.responseValue), normalAfter = h.snapshot();
          await h.reportUsage(call.index, 11); const restored = h.snapshot();
          assert.equal(isDeepStrictEqual(restored.durable, before.durable), true, 'actual repeated usage must restore the identical transaction input');
          const variant = await loadRelationCommitGuardVariant(), outcome = variant.commit.call(h.store, call.jobId, call.responseValue);
          boundaryTrials.push({ jobId: call.jobId, payload: structuredClone(call.responseValue), before, normal, normalAfter,
            restored, inputRestored: true, variant: outcome, variantAfter: h.snapshot(), metadata: variant.metadata });
        }
      }
      else if (action === 'duplicate') await h.respond(request.callIndex, 'ok');
      else if (action === 'usage') await h.reportUsage(request.callIndex, 7);
      else if (action === 'cancel') await h.cancel(bindings.sessions[actor].id);
      else if (action === 'delete') await h.delete(bindings.sessions[actor].id);
      else if (action === 'new_generation') {
        if (config.protocol === 'relation') { h.enable(bindings.sessions[actor].id); await h.settle(); refreshRelationGeneration(); }
        else {
          const current = bindings.actors[actor], next = bindings.requests.find(value => value.actor === actor && value.generation === 1);
          next.creationRank = bindings.requests.filter(value => value.jobId !== null).length;
          next.jobId = h.addTask(bindings.sessions[current.session].id, next.name); current.generation = 1;
          h.enable(bindings.sessions[current.session].id); await h.settle();
        }
      } else if (action === 'restart') await h.restartQueries(bindings.sessions.map(session => session.id));
      else if (action === 'stutter') await h.settle();
      else throw new Error(`Unsupported generation action: ${action}`);
    },
    close: () => h.close()
  };
}
