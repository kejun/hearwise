import { isDeepStrictEqual } from 'node:util';
import { normalizeITFStates, replayModelTrace } from './protocol-replay.mjs';
import { deadline } from '../../test-support/lifecycle.mjs';
import { createPlaybackAdapter } from '../../test-support/playback-protocol-adapter.mjs';

export const playbackScalarFields = ['created', 'active', 'selectedRecord', 'paused', 'resuming'];
export const playbackMapDefaults = { record: '', position: 0, epoch: 0, unlocked: false, requested: 0, accepted: 0,
  emitted: 0, returned: 0, completed: 0, frames: 0, received: 0, consumed: 0, played: 0, closed: false,
  playerPaused: false, providerClosed: false, finished: false, settling: false, pending: false };
export const playbackProjectionFields = [...playbackScalarFields, ...Object.keys(playbackMapDefaults)];
export const playbackVariables = ['lastAction', 'actor', 'choice', ...playbackProjectionFields];
export const fixtureTexts = { A: ['甲。', '乙。'], B: ['丙。', '丁。'] };
const equal = isDeepStrictEqual;

export function normalizePlaybackTrace(itf, config) {
  const states = normalizeITFStates(itf, playbackVariables);
  if (states[0].lastAction !== 'init' || states[0].actor !== 0) throw new Error('Invalid playback initialization');
  const project = state => Object.fromEntries(playbackProjectionFields.map(key => [key, state[key]]));
  const trace = { schemaVersion: 1, specificationVersion: '1.0', config: { ...config, wireModulus: 2 },
    initial: project(states[0]), steps: states.slice(1).map(state => ({ action: state.lastAction, actor: state.actor, choice: state.choice, expected: project(state) })) };
  if (!validPlaybackTrace(trace)) throw new Error('Invalid playback trace domain');
  return trace;
}
export function validPlaybackTrace(trace) {
  if (trace?.schemaVersion !== 1 || trace.specificationVersion !== '1.0' || ![1, 2, 3].includes(trace.config?.owners) ||
    ![0, 1, 2].includes(trace.config?.maxPcm) || trace.config?.wireModulus !== 2 || !Array.isArray(trace.steps)) return false;
  const keys = Array.from({ length: trace.config.owners }, (_, i) => String(i + 1));
  const valid = state => state && Number.isInteger(state.created) && state.created >= 0 && state.created <= trace.config.owners &&
    Number.isInteger(state.active) && state.active >= 0 && state.active <= state.created && ['A', 'B'].includes(state.selectedRecord) &&
    typeof state.paused === 'boolean' && typeof state.resuming === 'boolean' && Object.entries(playbackMapDefaults).every(([field, initial]) =>
      state[field] && equal(Object.keys(state[field]).sort(), keys) && Object.values(state[field]).every(value => typeof value === typeof initial &&
        (typeof initial !== 'number' || Number.isSafeInteger(value) && value >= 0)));
  const actions = ['start', 'seek', 'unlock', 'stop', 'switchRecord', 'pause', 'resume', 'resumeComplete', 'pcm', 'complete', 'consume', 'settled', 'late', 'frame', 'stutter'];
  return valid(trace.initial) && trace.steps.every(step => valid(step.expected) && actions.includes(step.action) && Number.isInteger(step.actor) && typeof step.choice === 'string');
}

// This is a projection of observations of the real controller/player/service.
// There is no JavaScript transition function implementing the Quint state machine.
export function projectPlaybackObservation(observed, details, owners) {
  const state = { created: observed.generations.length, active: observed.active, selectedRecord: observed.selectedRecord,
    paused: observed.paused, resuming: observed.resuming };
  for (const [field, initial] of Object.entries(playbackMapDefaults)) state[field] = Object.fromEntries(Array.from({ length: owners }, (_, i) => [i + 1, initial]));
  for (const g of observed.generations) {
    const detail = details.find(row => row.id === g.id);
    Object.entries({ record: g.record, position: detail.positionAtCreation, epoch: g.epoch, unlocked: g.unlocked,
      requested: g.requested.length, accepted: g.accepted.length, emitted: g.emitted, returned: detail.requests.filter(row => row.completed).length,
      completed: g.completed, frames: g.sentFrames, received: g.receivedSamples, consumed: g.consumedSamples, played: g.played,
      closed: g.closed, playerPaused: g.paused, providerClosed: g.providerClosed, finished: g.finished, settling: g.settling,
      pending: detail.player.pendingResumes > 0 }).forEach(([field, value]) => { state[field][g.id] = value; });
  }
  return state;
}

// The evidence gate invokes this again from the attached raw evidence. A forged
// projection plus empty violation list does not pass without complete raw records.
export function auditPlaybackObservation(raw, actual, config) {
  const violations = [];
  const require = (condition, code) => { if (!condition) violations.push(code); };
  try {
    require(raw?.schemaVersion === 1, 'raw_schema');
    require(Array.isArray(raw?.generations) && Array.isArray(raw?.observed?.generations) && Array.isArray(raw?.requests), 'raw_arrays');
    require(raw.generations.length === raw.observed.generations.length && raw.generations.length <= config.owners, 'raw_generation_count');
    require(equal(raw.generations.map(g => g.id), raw.generations.map((_, i) => i + 1)), 'owner_ids');
    require(raw.observed.enabled === (raw.observed.active > 0), 'controller_enabled');
    require(equal(raw.controller, { enabled: raw.observed.enabled, paused: raw.observed.paused, resuming: raw.observed.resuming }), 'controller_snapshot');
    require(Object.keys(raw.records).sort().join(',') === 'A,B', 'record_count');
    for (const [name, texts] of Object.entries(fixtureTexts)) {
      const record = raw.records[name];
      require(typeof record.listeningId === 'string' && record.listeningId.length > 0 && typeof record.runId === 'string', `record_identity_${name}`);
      require(equal(record.rows.map(row => [row.sequence_no, row.original_text, row.translation_text, row.translation_state]),
        texts.map((text, i) => [i + 1, `Source ${name}${i + 1}.`, text, 'complete'])), `sqlite_text_${name}`);
      require(record.rows.every(row => row.listening_id === record.listeningId && row.run_id === record.runId), `sqlite_owner_${name}`);
      require(record.transcript.id === record.listeningId && record.transcript.active === 0 && record.transcript.total === 2 && record.transcript.maxSequence === 2, `sqlite_transcript_${name}`);
    }
    require(raw.records.A.listeningId !== raw.records.B.listeningId, 'distinct_records');
    const allRequests = [];
    for (const g of raw.generations) {
      const o = raw.observed.generations.find(row => row.id === g.id), p = g.player, record = raw.records[g.record];
      require(Boolean(o && record) && [1, 2].includes(g.positionAtCreation), `generation_shape_${g.id}`);
      require(Array.isArray(g.incoming) && Array.isArray(g.outgoing) && Array.isArray(g.requests), `generation_arrays_${g.id}`);
      const transcript = g.outgoing.filter(message => message.type === 'speech.transcript');
      require(transcript.length === (o.unlocked ? 1 : 0), `transcript_count_${g.id}`);
      if (transcript.length) require(transcript[0].listeningId === record.listeningId && transcript[0].runId === record.runId &&
        transcript[0].startPosition === g.positionAtCreation && transcript[0].epoch === o.epoch && [1, 2].includes(o.epoch), `transcript_owner_${g.id}`);
      const units = g.incoming.filter(message => message.type === 'speech.unit');
      const ends = g.incoming.filter(message => message.type === 'speech.unit-end');
      const available = fixtureTexts[g.record].slice(g.positionAtCreation - 1);
      require(g.requests.length <= available.length && equal(g.requests.map(row => row.text), available.slice(0, g.requests.length)), `requested_intervals_${g.id}`);
      require(equal(units.map(row => row.text), available.slice(0, units.length)) && units.length === g.requests.length, `accepted_intervals_${g.id}`);
      require(units.every((row, i) => row.unit === i + 1 && row.position === g.positionAtCreation + i && row.epoch === o.epoch), `accepted_unit_owner_${g.id}`);
      require(ends.every((row, i) => row.unit === i + 1 && row.samples === 2 && row.epoch === o.epoch), `completed_units_${g.id}`);
      require(g.requests.every(row => row.generation === g.id && typeof row.emitted === 'boolean' && typeof row.completed === 'boolean' && (!row.completed || row.emitted)), `request_owner_${g.id}`);
      require(g.requests.filter(row => row.emitted).length <= config.maxPcm, `pcm_domain_${g.id}`);
      require(equal(o.requested, g.requests.map(row => row.text)) && equal(o.accepted, units.map(row => row.text)) &&
        o.emitted === g.requests.filter(row => row.emitted).length && o.completed === ends.length, `raw_text_projection_${g.id}`);
      require(o.record === g.record && o.unlocked === p.nodeAttached && o.closed === p.closed && o.paused === p.paused &&
        o.sentFrames === g.sentFrames && o.providerClosed === g.providerClosed && o.finished === g.incoming.some(row => row.type === 'speech.finished') && o.settling === g.settling, `raw_lifecycle_projection_${g.id}`);
      require(o.receivedSamples === p.buffer.write && o.consumedSamples === p.buffer.consumedSamples && o.played === p.buffer.playedUnit &&
        o.bufferedSamples === p.buffer.write - p.buffer.consumedSamples && o.receivedSamples === 2 * g.sentFrames, `raw_audio_projection_${g.id}`);
      require(Number.isInteger(p.pendingResumes) && p.pendingResumes >= 0 && p.pendingResumes <= 1 &&
        ['running', 'suspended', 'closed'].includes(p.contextState), `native_context_${g.id}`);
      require(!p.closed || p.contextState === 'closed', `native_closed_${g.id}`);
      require(!o.finished || o.played === available.length && o.consumedSamples === 2 * available.length && o.providerClosed && o.settling, `finished_text_${g.id}`);
      allRequests.push(...g.requests);
    }
    require(equal(raw.requests, allRequests), 'all_requests');
    require(equal(projectPlaybackObservation(raw.observed, raw.generations, config.owners), actual), 'raw_projection_mismatch');
  } catch (error) { violations.push(`malformed_raw:${error.name}`); }
  return [...new Set(violations)];
}

export async function createAuditedPlaybackAdapter(config) {
  const real = await createPlaybackAdapter({ wireModulus: 2, ...(config.mutation && config.mutation !== 'none' ? { mutation: config.mutation } : {}) });
  const positions = new Map();
  let raw;
  const observe = () => {
    const observed = real.observe();
    const generations = real.generations.map(g => ({ id: g.id, record: g.record, positionAtCreation: positions.get(g.id),
      requests: g.requests.map(r => ({ generation: r.generation, text: r.text, emitted: r.emitted, completed: r.completed })),
      incoming: structuredClone(g.incoming), outgoing: structuredClone(g.outgoing), sentFrames: g.sentFrames,
      providerClosed: g.providerClosed, settling: g.settling,
      player: { closed: g.player.closed, paused: g.player.paused, nodeAttached: Boolean(g.player.node),
        pendingResumes: g.player.context.pending.length, contextState: g.player.context.state,
        buffer: { write: g.player.node?.processor.buffer.write || 0, consumedSamples: g.player.node?.processor.buffer.consumedSamples || 0,
          playedUnit: g.player.node?.processor.buffer.playedUnit || 0 } } }));
    const records = Object.fromEntries(Object.entries(real.records).map(([name, record]) => [name, { ...record,
      transcript: real.store.speechTranscript(record.listeningId),
      rows: real.store.db.prepare('SELECT listening_id, run_id, sequence_no, original_text, translation_text, translation_state FROM segments WHERE listening_id = ? ORDER BY sequence_no').all(record.listeningId) }]));
    raw = { schemaVersion: 1, observed, generations, records,
      controller: { enabled: real.controller.enabled, paused: real.controller.paused, resuming: Boolean(real.changes.at(-1)?.resuming) },
      requests: real.requests.map(r => ({ generation: r.generation, text: r.text, emitted: r.emitted, completed: r.completed })) };
    return raw;
  };
  const adapter = {
    async act({ action, actor, choice }) {
      if (action === 'stutter') return;
      if (action === 'start') {
        const match = /^([AB])-(paused|playing)-([12])$/.exec(choice); if (!match) throw new Error('Invalid start input');
        await real.start(match[1], { paused: match[2] === 'paused', position: Number(match[3]) });
      } else if (action === 'seek') await real.seek(Number(choice));
      else if (action === 'switchRecord') await real.switchRecord(choice);
      else if (action === 'frame') {
        const current = real.generations[actor - 1].player;
        const headers = { 'wrong-epoch': { epoch: 999 }, reordered: { unit: current.unit, frame: current.frame + 1 },
          interleaved: { unit: current.unit + 1, frame: current.frame }, malformed: { unit: current.unit, frame: current.frame, declaredSamples: 3 },
          duplicate: { unit: 1, frame: 0 } };
        if (!headers[choice]) throw new Error('Invalid frame input');
        await real.frame(actor, headers[choice]);
      } else if (action === 'late') await real.late(actor, choice);
      else if (['stop', 'pause', 'resume'].includes(action)) await real[action]();
      else if (['unlock', 'resumeComplete', 'pcm', 'complete', 'consume', 'settled'].includes(action)) await real[action](actor);
      else throw new Error(`Unsupported playback action: ${action}`);
      for (const g of real.generations) if (!positions.has(g.id)) positions.set(g.id, real.changes.at(-1).position);
    },
    project() { const value = observe(); return projectPlaybackObservation(value.observed, value.generations, config.owners); },
    observe,
    check() { return auditPlaybackObservation(raw, projectPlaybackObservation(raw.observed, raw.generations, config.owners), config); },
    close: () => real.close()
  };
  const act = adapter.act;
  adapter.act = async step => {
    config.throwIfStopped?.();
    await deadline(() => act(step), 3000, `playback action ${step.action}`);
    config.throwIfStopped?.();
  };
  return adapter;
}
export const replayPlaybackTrace = (trace, create = createAuditedPlaybackAdapter) => replayModelTrace(trace, create, { validateTrace: validPlaybackTrace });
