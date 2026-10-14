import { isDeepStrictEqual } from 'node:util';
import { normalizeITFStates, replayModelTrace } from './protocol-replay.mjs';

export const knowledgeScalarFields = ['stage', 'outcome', 'ready', 'extra_requests', 'protocol_retries', 'cycle'];
export const knowledgeMapFields = ['phase', 'initial_requests', 'repair_reserved', 'extract_calls', 'repair_calls',
  'initial_complete', 'retry_kind', 'accepted', 'unresolved', 'anchored', 'replies'];
export const knowledgeProjectionFields = [...knowledgeScalarFields, ...knowledgeMapFields];
const actions = ['admit', 'send', 'response', 'commit', 'commit_fail', 'commit_notify_failure', 'reserve_fail', 'advance_time', 'stutter'];
const phases = ['extract_pending', 'extract_inflight', 'repair_pending', 'repair_inflight', 'done'];
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const slots = value => Array.isArray(value) && value.every(slot => [0, 1].includes(slot)) && new Set(value).size === value.length;

export function normalizeKnowledgeTrace(itf, config) {
  const states = normalizeITFStates(itf, ['lastAction', 'actor', 'response', ...knowledgeProjectionFields]);
  if (states[0].lastAction !== 'init' || states[0].actor !== -1) throw new Error('Invalid knowledge trace initialization');
  const projection = state => Object.fromEntries(knowledgeProjectionFields.map(field => [field, state[field]]));
  const trace = { schemaVersion: 1, specificationVersion: '1.0', protocol: 'knowledge', config,
    initial: projection(states[0]), steps: states.slice(1).map(state => ({ action: state.lastAction, actor: state.actor,
      response: state.response, expected: projection(state) })) };
  if (!validateKnowledgeTrace(trace)) throw new Error('Invalid knowledge trace contract or part domain');
  return trace;
}
function validProjection(state, parts) {
  const keys = Array.from({ length: parts }, (_, index) => String(index));
  if (!state || !isDeepStrictEqual(Object.keys(state).sort(), [...knowledgeProjectionFields].sort()) ||
    !knowledgeMapFields.every(field => state[field] && isDeepStrictEqual(Object.keys(state[field]).sort(), keys))) return false;
  return ['idle', 'reserved', 'inflight', 'received', 'done'].includes(state.stage) &&
    ['none', 'ok', 'empty', 'partial', 'invalid'].includes(state.outcome) && typeof state.ready === 'boolean' &&
    nonnegative(state.extra_requests) && nonnegative(state.protocol_retries) && state.cycle === 1 &&
    keys.every(key => phases.includes(state.phase[key]) && ['none', 'protocol', 'transient'].includes(state.retry_kind[key]) &&
      ['initial_requests', 'repair_reserved', 'extract_calls', 'repair_calls'].every(field => nonnegative(state[field][key])) &&
      typeof state.initial_complete[key] === 'boolean' && typeof state.replies[key] === 'string' &&
      ['accepted', 'unresolved', 'anchored'].every(field => slots(state[field][key])));
}
export function validateKnowledgeTrace(trace) {
  return trace?.schemaVersion === 1 && trace.specificationVersion === '1.0' && trace.protocol === 'knowledge' &&
    [1, 2].includes(trace.config?.parts) && Array.isArray(trace.steps) && validProjection(trace.initial, trace.config.parts) &&
    trace.steps.every(step => actions.includes(step.action) && Number.isInteger(step.actor) && step.actor >= -1 && step.actor < trace.config.parts &&
      validProjection(step.expected, trace.config.parts));
}
export function replayKnowledgeTrace(trace, createAdapter) {
  return replayModelTrace(trace, createAdapter, { validateTrace: validateKnowledgeTrace });
}
