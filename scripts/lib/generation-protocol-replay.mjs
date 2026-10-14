import { isDeepStrictEqual } from 'node:util';
import { normalizeITFStates, replayModelTrace } from './protocol-replay.mjs';

export const generationProjectionFields = Object.freeze(['generation', 'present', 'cancelled', 'activeOwner',
  'requestGeneration', 'aborted', 'physical', 'reserved', 'usage', 'business', 'outcome', 'calls', 'callbackCount', 'restartCount']);
export const generationEnvironmentFields = Object.freeze(['admissionPermit', 'lastServedSession', 'creationRank', 'nextCreationRank', 'permitsIssued', 'admissionsObserved']);
export const generationReplayRefinement = 'fixed-ready-provider-permit-v1';
const fields = config => [...generationProjectionFields, ...(config.refinement ? generationEnvironmentFields : [])];
const actions = new Set(['permit', 'reserve', 'send', 'cancel', 'new_generation', 'response', 'duplicate', 'usage', 'delete', 'restart', 'stutter']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && isDeepStrictEqual(Object.keys(value).sort(), keys.map(String).sort());
const bit = value => value === 0 || value === 1;
const boolean = value => typeof value === 'boolean';
const integers = count => Array.from({ length: count }, (_, index) => index);
const member = (value, values) => Number.isInteger(value) && values.includes(value);

export function validGenerationConfig(config) {
  return plain(config) && Object.keys(config).every(key => ['protocol', 'actors', 'capacity', 'refinement'].includes(key)) &&
    (config.refinement === undefined || config.refinement === generationReplayRefinement) && ['knowledge', 'relation'].includes(config.protocol) && [1, 3].includes(config.actors) &&
    [1, 2].includes(config.capacity) && (config.actors !== 1 || config.capacity === 1);
}
function validProjection(state, config) {
  if (!plain(state)) return false;
  const actors = integers(config.actors), sessions = config.actors === 1 ? [0] : [0, 1], requests = integers(config.actors * 2);
  const map = (field, keys, predicate) => exactKeys(state[field], keys) && keys.every(key => predicate(state[field][key], key));
  const environment = !config.refinement || (typeof state.admissionPermit === 'boolean' &&
    member(state.lastServedSession, [-1, ...sessions]) && map('creationRank', requests, rank => Number.isInteger(rank) && rank >= -1 && rank < requests.length) &&
    Number.isInteger(state.nextCreationRank) && state.nextCreationRank >= actors.length && state.nextCreationRank <= requests.length &&
    ['permitsIssued', 'admissionsObserved'].every(field => Number.isInteger(state[field]) && state[field] >= 0 && state[field] <= requests.length));
  return exactKeys(state, fields(config)) && environment && bit(state.restartCount) &&
    map('generation', actors, bit) && map('present', sessions, boolean) && map('cancelled', sessions, boolean) &&
    map('activeOwner', actors, (owner, actor) => member(owner, [-1, actor * 2, actor * 2 + 1])) &&
    map('requestGeneration', requests, (generation, request) => generation === request % 2) &&
    map('aborted', requests, boolean) && map('physical', requests, value => ['none', 'reserved', 'inflight', 'settled'].includes(value)) &&
    ['reserved', 'calls', 'callbackCount'].every(field => map(field, requests, bit)) &&
    map('usage', requests, value => (config.protocol === 'knowledge' ? ['none'] : ['none', 'response_received', 'late_response']).includes(value)) &&
    map('business', actors, (values, actor) => Array.isArray(values) && new Set(values).size === values.length &&
      values.every(value => member(value, [actor * 2, actor * 2 + 1])) && isDeepStrictEqual(values, [...values].sort((a, b) => a - b))) &&
    map('outcome', actors, value => ['none', 'ok', 'failed'].includes(value));
}
function validAction(step, config) {
  if (!exactKeys(step, ['action', 'actor', 'response', 'expected']) || !actions.has(step.action) || (step.action === 'permit' && !config.refinement)) return false;
  const actors = integers(config.actors), sessions = config.actors === 1 ? [0] : [0, 1], requests = integers(config.actors * 2);
  const domain = step.action === 'reserve' || (step.action === 'new_generation' && config.protocol === 'knowledge') ? actors :
    ['cancel', 'delete', 'new_generation'].includes(step.action) ? sessions :
    ['restart', 'stutter', 'permit'].includes(step.action) ? [-1] : requests;
  return member(step.actor, domain) && (step.action !== 'usage' || config.protocol === 'relation') &&
    (step.action === 'response' ? ['ok', 'failed'].includes(step.response) : step.response === '') && validProjection(step.expected, config);
}
export function generationInitialProjection(config) {
  if (!validGenerationConfig(config)) throw new Error('Invalid generation finite domain');
  const actors = integers(config.actors), sessions = config.actors === 1 ? [0] : [0, 1], requests = integers(config.actors * 2);
  const map = (keys, value) => Object.fromEntries(keys.map(key => [key, typeof value === 'function' ? value(key) : value]));
  return { generation: map(actors, 0), present: map(sessions, true), cancelled: map(sessions, false), activeOwner: map(actors, -1),
    requestGeneration: map(requests, request => request % 2), aborted: map(requests, false), physical: map(requests, 'none'),
    reserved: map(requests, 0), usage: map(requests, 'none'), business: map(actors, () => []), outcome: map(actors, 'none'),
    calls: map(requests, 0), callbackCount: map(requests, 0), restartCount: 0, ...(config.refinement ? {
      admissionPermit: false, lastServedSession: -1, creationRank: map(requests, request => request % 2 === 0 ? request / 2 : -1),
      nextCreationRank: actors.length, permitsIssued: 0, admissionsObserved: 0 } : {}) };
}

// Shape/domain validation does not assert Safety: intentionally broken model
// traces must still reach the separate model-violation/implementation checks.
export function validateGenerationTrace(trace) {
  return plain(trace) && trace.schemaVersion === 1 && trace.specificationVersion === '1.0' && trace.protocol === 'generation-isolation' &&
    validGenerationConfig(trace.config) && validProjection(trace.initial, trace.config) &&
    isDeepStrictEqual(trace.initial, generationInitialProjection(trace.config)) && Array.isArray(trace.steps) &&
    trace.steps.every(step => validAction(step, trace.config));
}
export function normalizeGenerationTrace(itf, config) {
  if (!validGenerationConfig(config)) throw new Error('Invalid generation finite domain');
  const states = normalizeITFStates(itf, ['lastAction', 'actor', 'response', ...fields(config), ...(config.refinement ? ['environmentAction'] : [])]);
  if (states[0].lastAction !== 'init' || states[0].actor !== -1 || states[0].response !== '') throw new Error('Invalid generation initialization');
  if (config.refinement && (states[0].environmentAction !== 'init' || states.slice(1).some(state =>
    !['core', 'permit'].includes(state.environmentAction) || (state.environmentAction === 'permit' && state.lastAction !== 'stutter')))) throw new Error('Invalid refinement environment action');
  const projection = state => Object.fromEntries(fields(config).map(field => [field, state[field]]));
  const trace = { schemaVersion: 1, specificationVersion: '1.0', protocol: 'generation-isolation', config: { ...config },
    initial: projection(states[0]), steps: states.slice(1).map(state => ({ action: config.refinement && state.environmentAction === 'permit' ? 'permit' : state.lastAction, actor: state.actor,
      response: state.response, expected: projection(state) })) };
  if (!validateGenerationTrace(trace)) throw new Error('Invalid generation trace contract or action domain');
  return trace;
}
export const replayGenerationTrace = (trace, createAdapter) => replayModelTrace(trace, createAdapter, { validateTrace: validateGenerationTrace });
