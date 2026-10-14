import { isDeepStrictEqual } from 'node:util';
import { normalizeITFStates, replayModelTrace, projectionFields as relationFields } from './protocol-replay.mjs';
import { knowledgeProjectionFields, knowledgeMapFields } from './knowledge-protocol-replay.mjs';

export const processProjectionFields = protocol => ['processState', 'generation', ...(protocol === 'relation' ? relationFields : knowledgeProjectionFields)];
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const actions = ['admit', 'send', 'response', 'commit', 'commit_fail', 'notify', 'notify_fail', 'reserve_fail', 'advance_time', 'settle', 'settle_exhausted', 'crash', 'recover', 'stutter'];
function validProjection(state, config) {
  const fields = processProjectionFields(config.protocol), count = config.protocol === 'relation' ? config.actors : config.parts;
  const keys = Array.from({ length: count }, (_, index) => String(index));
  const maps = config.protocol === 'relation' ? relationFields : knowledgeMapFields;
  if (!state || !isDeepStrictEqual(Object.keys(state).sort(), [...fields].sort()) ||
    !maps.every(field => state[field] && isDeepStrictEqual(Object.keys(state[field]).sort(), keys)) ||
    !['up', 'down'].includes(state.processState) || ![0, 1].includes(state.generation)) return false;
  if (config.protocol === 'relation') return keys.every(key =>
    ['idle', 'reserved', 'inflight', 'received', 'committed', 'retry_wait', 'done', 'waiting_nodes', 'reserve_failed'].includes(state.phase[key]) &&
    ['counts', 'calls', 'relations'].every(field => nonnegative(state[field][key])) && typeof state.ready[key] === 'boolean' &&
    ['none', 'ok', 'empty', 'failed', 'no_candidates', 'reserve_failed'].includes(state.outcome[key]) && typeof state.replies[key] === 'string');
  return ['idle', 'reserved', 'inflight', 'received', 'committed', 'done', 'down'].includes(state.stage) && typeof state.ready === 'boolean' &&
    ['none', 'ok', 'empty', 'partial', 'invalid'].includes(state.outcome) && ['extra_requests', 'protocol_retries', 'cycle'].every(field => nonnegative(state[field])) &&
    keys.every(key => ['extract_pending', 'extract_inflight', 'repair_pending', 'repair_inflight', 'done'].includes(state.phase[key]) &&
      ['initial_requests', 'repair_reserved', 'extract_calls', 'repair_calls'].every(field => nonnegative(state[field][key])) &&
      typeof state.initial_complete[key] === 'boolean' && typeof state.retry_kind[key] === 'string' && typeof state.replies[key] === 'string' &&
      ['accepted', 'unresolved', 'anchored'].every(field => Array.isArray(state[field][key]) && state[field][key].every(slot => [0, 1].includes(slot)) &&
        new Set(state[field][key]).size === state[field][key].length));
}
export function validateProcessTrace(trace) {
  const config = trace?.config, count = config?.protocol === 'relation' ? config.actors : config?.parts;
  return trace?.schemaVersion === 1 && trace.specificationVersion === '1.0' && trace.protocol === 'process-crash' &&
    (config?.protocol === 'relation' ? [1, 3].includes(config.actors) && [1, 2].includes(config.capacity) && ['valid', 'reserve_fail', 'no_candidates'].includes(config.mode) :
      config?.protocol === 'knowledge' && [1, 2].includes(config.parts)) && Array.isArray(trace.steps) && validProjection(trace.initial, config) &&
    trace.steps.every(step => actions.includes(step.action) && Number.isInteger(step.actor) && step.actor >= -1 && step.actor < count && validProjection(step.expected, config));
}
export function normalizeProcessTrace(itf, config) {
  const fields = processProjectionFields(config.protocol), states = normalizeITFStates(itf, ['lastAction', 'actor', 'response', ...fields]);
  if (states[0].lastAction !== 'init' || states[0].actor !== -1) throw new Error('Invalid process-crash trace initialization');
  if (config.protocol === 'relation' && states.some(state => state.mode !== states[0].mode)) throw new Error('Changing process-crash fixture mode');
  const projection = state => Object.fromEntries(fields.map(field => [field, state[field]]));
  const trace = { schemaVersion: 1, specificationVersion: '1.0', protocol: 'process-crash',
    config: { ...config, ...(config.protocol === 'relation' ? { mode: states[0].mode } : {}) }, initial: projection(states[0]),
    steps: states.slice(1).map(state => ({ action: state.lastAction, actor: state.actor, response: state.response, expected: projection(state) })) };
  if (!validateProcessTrace(trace)) throw new Error('Invalid process-crash trace contract or finite domain');
  return trace;
}
export const replayProcessTrace = (trace, createAdapter) => replayModelTrace(trace, createAdapter, { validateTrace: validateProcessTrace });
