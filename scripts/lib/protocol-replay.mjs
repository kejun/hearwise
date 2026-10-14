import { isDeepStrictEqual } from 'node:util';

export const projectionFields = ['phase', 'counts', 'calls', 'relations', 'outcome', 'replies', 'ready'];
const requiredVariables = ['lastAction', 'actor', 'response', 'mode', ...projectionFields];

export function decodeITF(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Object.hasOwn(value, '#bigint')) {
    if (!/^-?\d+$/.test(value['#bigint']) || !Number.isSafeInteger(Number(value['#bigint']))) throw new Error('ITF integer is outside the supported safe-integer domain');
    return Number(value['#bigint']);
  }
  if (Object.hasOwn(value, '#set')) {
    if (!Array.isArray(value['#set'])) throw new Error('Malformed ITF set');
    const members = value['#set'].map(decodeITF);
    if (!members.every(Number.isSafeInteger)) throw new Error('Only integer ITF set members are supported');
    if (new Set(members).size !== members.length) throw new Error('Duplicate ITF set member');
    return members.sort((a, b) => a - b);
  }
  if (Object.hasOwn(value, '#map')) {
    if (!Array.isArray(value['#map'])) throw new Error('Malformed ITF map');
    const entries = value['#map'].map(pair => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Malformed ITF map entry');
      const key = decodeITF(pair[0]);
      if (!Number.isSafeInteger(key)) throw new Error('Protocol map keys must be actor integers');
      return [key, decodeITF(pair[1])];
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Duplicate ITF map key');
    return Object.fromEntries(entries);
  }
  throw new Error('Unsupported ITF value');
}

// Quint module imports namespace variables; reject ambiguous suffixes instead
// of silently taking one model's state for another model.
export function normalizeITFStates(itf, requiredVariables) {
  if (!Array.isArray(itf?.vars) || !Array.isArray(itf?.states) || !itf.states.length) throw new Error('Missing ITF variables or initial state');
  const names = itf.vars.map(name => name.split('::').at(-1));
  if (new Set(names).size !== names.length || requiredVariables.some(name => !names.includes(name))) throw new Error('Missing or ambiguous model state variables');
  return itf.states.map(state => Object.fromEntries(itf.vars.map((name, index) => {
    if (!Object.hasOwn(state, name)) throw new Error(`Missing trace state variable: ${name}`);
    return [names[index], decodeITF(state[name])];
  })));
}

export function normalizeProtocolTrace(itf, config) {
  const states = normalizeITFStates(itf, requiredVariables).map(normalized => ({
    action: normalized.lastAction, actor: normalized.actor, response: normalized.response, mode: normalized.mode,
    expected: Object.fromEntries(projectionFields.map(field => [field, normalized[field]]))
  }));
  if (states[0].action !== 'init' || states[0].actor !== -1 || states.some(state => state.mode !== states[0].mode)) throw new Error('Invalid protocol initialization or changing fixture mode');
  return { schemaVersion: 1, specificationVersion: '1.0', config: { ...config, mode: states[0].mode }, initial: states[0].expected, steps: states.slice(1) };
}

function validateProjection(state, actors) {
  const keys = Array.from({ length: actors }, (_, index) => String(index));
  return projectionFields.every(field => state?.[field] && isDeepStrictEqual(Object.keys(state[field]).sort(), keys));
}

// A generic trace protocol: domain adapters own preparation, actions, business
// projections and cleanup. Expected state comes from Quint, never this driver.
export function replayProtocolTrace(trace, createAdapter) {
  return replayModelTrace(trace, createAdapter, { validateTrace: value => value?.schemaVersion === 1 && value.specificationVersion === '1.0' &&
    [1, 3].includes(value.config?.actors) && [1, 2].includes(value.config?.capacity) && Array.isArray(value.steps) &&
    validateProjection(value.initial, value.config.actors) && value.steps.every(step => validateProjection(step.expected, value.config.actors)) });
}

// Each domain supplies its own trace contract; relation and knowledge projections
// share execution, first-divergence capture and bounded adapter cleanup semantics.
export async function replayModelTrace(trace, createAdapter, { validateTrace } = {}) {
  const startedAt = new Date().toISOString(), observations = [];
  let adapter, currentStep = -1;
  const result = { startedAt, finishedAt: null, complete: false, ok: false, classification: 'unreplayable', observations };
  try {
    if (typeof validateTrace !== 'function' || !validateTrace(trace)) throw new Error('Invalid or unsupported replay trace contract');
    adapter = await createAdapter(trace.config);
    const compare = expected => {
      const actual = adapter.project(), durable = adapter.observe();
      const durableViolations = adapter.check?.() || [];
      observations.push({ step: currentStep, actual, durable, durableViolations });
      if (!isDeepStrictEqual(actual, expected) || durableViolations.length) {
        result.classification = 'implementation_mismatch';
        result.difference = { step: currentStep, expected, actual, durableViolations };
        // First divergent state: shortest failing prefix of this model trace.
        result.counterexample = { ...trace, steps: trace.steps.slice(0, currentStep + 1), minimality: 'first-divergence-prefix' };
        return false;
      }
      return true;
    };
    if (!compare(trace.initial)) { result.complete = true; return result; }
    for (const [index, step] of trace.steps.entries()) {
      currentStep = index;
      await adapter.act(step);
      if (!compare(step.expected)) { result.complete = true; return result; }
    }
    result.complete = true; result.ok = true; result.classification = 'matched';
  } catch (error) {
    result.error = { step: currentStep, name: error.name, message: error.message };
  } finally {
    try { await adapter?.close(); }
    catch (error) { result.complete = false; result.ok = false; result.classification = 'unreplayable'; result.cleanupError = error.message; }
    result.finishedAt = new Date().toISOString();
  }
  return result;
}
