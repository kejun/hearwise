import { isDeepStrictEqual } from 'node:util';
import { replayModelTrace } from './protocol-replay.mjs';

export const translationFields = ['queue', 'running', 'phase', 'interim', 'recentStarts'];
export const knowledgeFields = ['phase', 'durable', 'running', 'lastServed', 'recentStarts', 'translationWaiting', 'translationRunning', 'interim', 'closed', 'listenings', 'keyAvailable'];
const fields = config => config.kind === 'translation' ? translationFields : knowledgeFields;
export function decodeSchedulerITF(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeSchedulerITF);
  if (Object.keys(value).length !== 1) throw new Error('Ambiguous scheduler ITF value');
  if (Object.hasOwn(value, '#bigint')) {
    if (!/^-?\d+$/.test(value['#bigint']) || !Number.isSafeInteger(Number(value['#bigint']))) throw new Error('Unsafe ITF integer');
    return Number(value['#bigint']);
  }
  if (Object.hasOwn(value, '#set')) {
    const members = decodeSchedulerITF(value['#set']);
    if (!Array.isArray(members) || !members.every(Number.isSafeInteger) || new Set(members).size !== members.length) throw new Error('Invalid integer set');
    return members.sort((a, b) => a - b);
  }
  if (Object.hasOwn(value, '#map')) {
    if (!Array.isArray(value['#map'])) throw new Error('Invalid ITF map');
    const entries = value['#map'].map(pair => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Invalid ITF entry');
      const key = decodeSchedulerITF(pair[0]); if (!Number.isSafeInteger(key)) throw new Error('Invalid actor key');
      return [key, decodeSchedulerITF(pair[1])];
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Duplicate actor');
    return Object.fromEntries(entries);
  }
  throw new Error('Unsupported scheduler ITF value');
}
export function schedulerStates(itf) {
  if (!Array.isArray(itf?.vars) || !Array.isArray(itf?.states) || !itf.states.length) throw new Error('Missing ITF states');
  const names = itf.vars.map(name => name.split('::').at(-1));
  if (new Set(names).size !== names.length) throw new Error('Ambiguous model variables');
  return itf.states.map(state => Object.fromEntries(itf.vars.map((name, index) => {
    if (!Object.hasOwn(state, name)) throw new Error('Missing model variable');
    return [names[index], decodeSchedulerITF(state[name])];
  })));
}
export function normalizeSchedulerTrace(itf, config) {
  const states = schedulerStates(itf);
  const projection = state => Object.fromEntries(fields(config).map(field => [field, state[field]]));
  if (states[0].lastAction !== 'init' || states[0].actor !== -1) throw new Error('Invalid scheduler initialization');
  const trace = { schemaVersion: 1, specificationVersion: '1.0', protocol: 'scheduler', config, initial: projection(states[0]),
    steps: states.slice(1).map(state => ({ action: state.lastAction, actor: state.actor, argument: state.argument, expected: projection(state) })) };
  if (!validateSchedulerTrace(trace)) throw new Error('Invalid scheduler trace domain');
  return trace;
}
export function validateSchedulerTrace(trace) {
  if (trace?.schemaVersion !== 1 || trace.specificationVersion !== '1.0' || trace.protocol !== 'scheduler' || !['translation', 'knowledge'].includes(trace.config?.kind) || !Array.isArray(trace.steps)) return false;
  const config = trace.config;
  const allowed = config.kind === 'translation' ? ['kind', 'identities', 'background', 'initialQueue', 'capacity'] : ['kind', 'jobs', 'separateKeys', 'fairCycle'];
  if (Object.keys(config).some(key => !allowed.includes(key))) return false;
  if (config.kind === 'translation') {
    const identities = config.identities || [0, 1, 2, 3];
    if (!Array.isArray(identities) || ![3, 4].includes(identities.length) || identities.some(id => !Number.isInteger(id) || id < 0 || id >= identities.length)) return false;
    if (config.capacity != null && ![2, 4, 500].includes(config.capacity)) return false;
    for (const key of ['background', 'initialQueue']) if (config[key] != null && (!Array.isArray(config[key]) || config[key].some(actor => !Number.isInteger(actor) || actor < 0 || actor >= identities.length) || new Set(config[key]).size !== config[key].length)) return false;
  } else {
    if (config.jobs != null && ![[0], [0, 2], [0, 1, 2]].some(jobs => isDeepStrictEqual(jobs, config.jobs))) return false;
    if (['separateKeys', 'fairCycle'].some(key => config[key] != null && typeof config[key] !== 'boolean')) return false;
  }
  const tokens = config.kind === 'translation' ? (config.identities || [0, 1, 2, 3]).map((_, i) => i) : config.jobs || [0, 1, 2];
  const actorKeys = tokens.map(String).sort();
  const subset = value => Array.isArray(value) && value.every(actor => tokens.includes(actor)) && new Set(value).size === value.length;
  const valid = state => state && isDeepStrictEqual(Object.keys(state).sort(), [...fields(config)].sort()) &&
    isDeepStrictEqual(Object.keys(state.phase || {}).sort(), actorKeys) && subset(state.running) && subset(state.recentStarts) &&
    Number.isInteger(state.interim) && state.interim >= 0 && state.interim <= 1 &&
    (config.kind === 'translation' ? subset(state.queue) && tokens.every(actor => ['fresh', 'queued', 'running', 'settled', 'cancelled', 'dropped'].includes(state.phase[actor])) :
      isDeepStrictEqual(Object.keys(state.durable || {}).sort(), actorKeys) && [-1, 0, 1].includes(state.lastServed) &&
      [0, 1].includes(state.translationWaiting) && [0, 1, 2].includes(state.translationRunning) && typeof state.closed === 'boolean' &&
      Array.isArray(state.listenings) && state.listenings.every(id => [0, 1].includes(id)) && new Set(state.listenings).size === state.listenings.length &&
      isDeepStrictEqual(Object.keys(state.keyAvailable || {}).sort(), ['0', '1']) && [0, 1].every(id => typeof state.keyAvailable[id] === 'boolean') &&
      tokens.every(actor => ['pending', 'running', 'complete', 'failed', 'cancelled'].includes(state.phase[actor]) && ['pending', 'running', 'complete', 'failed', 'deleted'].includes(state.durable[actor])));
  const actions = config.kind === 'translation' ? ['enqueue', 'duplicate', 'pump', 'admit_interim', 'reject_interim', 'settle_final', 'settle_interim', 'cancel_queued', 'set_head', 'advance_time', 'recycle', 'stutter'] :
    ['pump', 'set_translation', 'advance_time', 'block_provider', 'set_key', 'settle', 'remove', 'close', 'recycle', 'stutter'];
  function validAction(step) {
    if (!step || !actions.includes(step.action) || !Number.isInteger(step.actor) || typeof step.argument !== 'string') return false;
    const { action, actor, argument } = step;
    if (config.kind === 'translation') {
      if (['enqueue', 'duplicate', 'cancel_queued', 'recycle'].includes(action)) return tokens.includes(actor) && argument === '';
      if (action === 'set_head') return (actor === -1 || (config.identities || tokens).includes(actor)) && argument === '';
      if (['settle_final', 'settle_interim'].includes(action)) return (action === 'settle_final' ? tokens.includes(actor) : actor === -1) && ['success', 'error', 'timeout', 'cancelled'].includes(argument);
      return actor === -1 && argument === (action === 'advance_time' ? 'starvation_threshold' : action === 'reject_interim' ? 'busy' : '');
    }
    if (action === 'set_translation') return [0, 1].includes(actor) && ['0,0', '0,1', '1,0', '1,1', '2,0'].includes(argument);
    if (action === 'settle') return tokens.includes(actor) && ['success', 'error', 'timeout', 'retry', 'continue', 'rate_limit'].includes(argument);
    if (action === 'set_key') return tokens.some(token => (token === 2 ? 1 : 0) === actor) && ['present', 'absent'].includes(argument);
    if (action === 'block_provider') return tokens.some(token => (config.separateKeys && token === 2 ? 1 : 0) === actor) && argument === '';
    if (action === 'remove') return [0, 1].includes(actor) && argument === '';
    if (action === 'recycle') return config.fairCycle === true && tokens.includes(actor) && [0, 1].includes(actor) && argument === '';
    return actor === -1 && argument === (action === 'advance_time' ? 'all_outstanding_deadlines' : '');
  }
  return valid(trace.initial) && trace.steps.every(step => validAction(step) && valid(step.expected));
}
export const replaySchedulerTrace = (trace, createAdapter) => replayModelTrace(trace, createAdapter, { validateTrace: validateSchedulerTrace });
