import { normalizeITFStates, replayModelTrace } from './protocol-replay.mjs';

export const importProjectionFields = ['lastHTTPStatus', 'lastHTTPCode', 'businessIds', 'clientGeneration', 'clientMode',
  'clientCurrentCount', 'clientAddedCount', 'clientSkippedCount'];
export const importTraceVariables = ['lastAction', 'actor', 'requestedMode', 'requestedGeneration', 'fault', ...importProjectionFields];
const actions = new Set(['upload', 'preview', 'commit', 'expire', 'same_write', 'other_write', 'restart', 'cleanup', 'stutter']);
export function normalizeImportTrace(itf, config) {
  const states = normalizeITFStates(itf, importTraceVariables).map(state => ({
    action: state.lastAction, actor: state.actor, requestedMode: state.requestedMode,
    requestedGeneration: state.requestedGeneration, fault: state.fault,
    expected: Object.fromEntries(importProjectionFields.map(field => [field, state[field]]))
  }));
  if (states[0].action !== 'init' || states[0].actor !== -1) throw new Error('Invalid import trace initialization');
  const trace = { schemaVersion: 1, specificationVersion: '1.0', config, initial: states[0].expected, steps: states.slice(1) };
  if (!validateImportTrace(trace)) throw new Error('Import trace violates the configured contract');
  return trace;
}
function validProjection(state, tokens) {
  const keys = Array.from({ length: tokens }, (_, token) => String(token));
  return state && [0, 200, 400, 409, 410, 500].includes(state.lastHTTPStatus) && typeof state.lastHTTPCode === 'string' &&
    Array.isArray(state.businessIds) && state.businessIds.length > 0 && new Set(state.businessIds).size === state.businessIds.length &&
    state.businessIds.every(id => Number.isInteger(id) && id >= 0 && id <= tokens) &&
    importProjectionFields.filter(field => field.startsWith('client')).every(field => {
      const value = state[field];
      return value && Object.keys(value).sort().join(',') === keys.join(',') && Object.values(value).every(item =>
        field === 'clientMode' ? ['', 'append', 'replace'].includes(item) : Number.isInteger(item) && item >= 0 && item <= (field === 'clientGeneration' ? 2 : field === 'clientCurrentCount' ? tokens + 1 : 1));
    });
}
export function validateImportTrace(trace) {
  return trace?.schemaVersion === 1 && trace.specificationVersion === '1.0' && [1, 2].includes(trace.config?.tokens) &&
    Array.isArray(trace.steps) && validProjection(trace.initial, trace.config.tokens) && trace.steps.every(step =>
      actions.has(step.action) && Number.isInteger(step.actor) &&
      (['upload', 'preview', 'commit', 'expire', 'cleanup'].includes(step.action) ? step.actor >= 0 && step.actor < trace.config.tokens : step.actor === -1) &&
      ['', 'append', 'replace', 'invalid'].includes(step.requestedMode) && Number.isInteger(step.requestedGeneration) &&
      step.requestedGeneration >= 0 && step.requestedGeneration <= 2 && typeof step.fault === 'boolean' && (!step.fault || step.action === 'commit') && validProjection(step.expected, trace.config.tokens));
}
export const replayImportTrace = (trace, createAdapter) => replayModelTrace(trace, createAdapter, { validateTrace: validateImportTrace });
