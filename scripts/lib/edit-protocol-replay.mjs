import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { deadline } from '../../test-support/lifecycle.mjs';

export const editTraceContract = JSON.parse(readFileSync(new URL('../../verification/edit-protocol/trace-contract.json', import.meta.url), 'utf8'));
export const editProjectionFields = [...Object.keys(editTraceContract.scalars), ...editTraceContract.clientMaps];
const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const clone = value => structuredClone(value);

export function validateEditConfig(config) {
  const keys = Array.from({ length: config?.clients || 0 }, (_, index) => String(index));
  return [1, 2].includes(config?.clients) && sameKeys(config.codecs, keys) &&
    keys.every(key => ['v1', 'v11', 'v12'].includes(config.codecs[key])) &&
    typeof config.initialOverride === 'boolean' && typeof config.background === 'boolean';
}
export function validateEditProjection(value, config) {
  if (!validateEditConfig(config) || !sameKeys(value, editProjectionFields)) return false;
  const keys = Array.from({ length: config.clients }, (_, index) => String(index));
  if (!integer(value.revision, 0, config.clients + 1) || !integer(value.name, 0, 2) ||
      !integer(value.serverOwner, -1, config.clients - 1) || typeof value.override !== 'boolean' ||
      typeof value.backgroundDone !== 'boolean' || !editTraceContract.clientMaps.every(field => sameKeys(value[field], keys))) return false;
  for (const key of keys) {
    for (const field of ['loadedRevision', 'submittedRevision', 'commitBaseRevision']) if (!integer(value[field][key], -1, value.revision)) return false;
    for (const field of ['loadedName', 'draft', 'submittedName']) if (!integer(value[field][key], -1, 2)) return false;
    if (!integer(value.userSaves[key], 0, 1) || !integer(value.requests[key], 0, 2) || typeof value.commitBaseOverride[key] !== 'boolean') return false;
    for (const [field, choices] of Object.entries(editTraceContract.states)) if (!choices.includes(value[field][key])) return false;
  }
  return true;
}

export function decodeEditITF(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new Error('Unsafe ITF integer'); return value; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported edit ITF value');
  if (Object.hasOwn(value, '#bigint')) {
    if (!sameKeys(value, ['#bigint']) || typeof value['#bigint'] !== 'string' || !/^-?\d+$/.test(value['#bigint']) ||
        !Number.isSafeInteger(Number(value['#bigint']))) throw new Error('Invalid or unsafe ITF integer');
    return Number(value['#bigint']);
  }
  if (Object.hasOwn(value, '#map')) {
    if (!sameKeys(value, ['#map']) || !Array.isArray(value['#map'])) throw new Error('Malformed ITF map');
    const entries = value['#map'].map(pair => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Malformed ITF map pair');
      const key = decodeEditITF(pair[0]);
      if (!Number.isSafeInteger(key)) throw new Error('Edit client map key must be an integer');
      return [key, decodeEditITF(pair[1])];
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Duplicate ITF map key');
    return Object.fromEntries(entries);
  }
  if (Object.keys(value).some(key => key.startsWith('#') || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('Unsupported ITF record key');
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeEditITF(entry)]));
}

export function normalizeEditTrace(itf, config) {
  if (!validateEditConfig(config) || !Array.isArray(itf?.vars) || !Array.isArray(itf?.states) || !itf.states.length ||
      itf.vars.some(name => typeof name !== 'string')) throw new Error('Missing edit ITF/configuration');
  const names = itf.vars.map(name => name.split('::').at(-1));
  if (new Set(names).size !== names.length || !isDeepStrictEqual([...names].sort(), [...editTraceContract.itfVariables].sort()))
    throw new Error('Missing or ambiguous edit ITF variables');
  const states = itf.states.map(raw => {
    const decoded = Object.fromEntries(itf.vars.map((name, index) => {
      if (!Object.hasOwn(raw, name)) throw new Error(`Missing ITF state variable ${name}`);
      return [names[index], decodeEditITF(raw[name])];
    }));
    if (!validateEditProjection(decoded.state, config)) throw new Error('Invalid edit projection');
    return { action: decoded.lastAction, actor: decoded.actor, argument: decoded.argument, expected: decoded.state };
  });
  const first = states[0];
  if (first.action !== 'init' || first.actor !== -1 || first.argument !== '' || first.expected.revision !== 0 ||
      first.expected.override !== config.initialOverride || first.expected.backgroundDone !== false) throw new Error('Invalid edit initialization');
  const normalized = { schemaVersion: 1, specificationVersion: '1.0', domain: 'edit-protocol',
    config: clone(config), initial: first.expected, steps: states.slice(1) };
  if (!validateEditTrace(normalized)) throw new Error('Invalid edit action or trace');
  return normalized;
}
export function validateEditTrace(trace) {
  return trace?.schemaVersion === 1 && trace.specificationVersion === '1.0' && trace.domain === 'edit-protocol' &&
    validateEditConfig(trace.config) && validateEditProjection(trace.initial, trace.config) && Array.isArray(trace.steps) &&
    trace.steps.every(step => editTraceContract.actions[step.action]?.includes(step.argument) &&
      (['background_change', 'stutter'].includes(step.action) ? step.actor === -1 : integer(step.actor, 0, trace.config.clients - 1)) &&
      validateEditProjection(step.expected, trace.config));
}

// Only observed implementation state is compared. Expected state is exclusively
// from Quint. The adapter owns actual HTTP/SQLite actions and bounded cleanup.
export async function replayEditTrace(trace, createAdapter, { stepTimeoutMs = 15000, cleanupTimeoutMs = 5000 } = {}) {
  const result = { startedAt: new Date().toISOString(), finishedAt: null, complete: false, ok: false,
    classification: 'unreplayable', observations: [] };
  let adapter, currentStep = -1;
  try {
    if (!validateEditTrace(trace)) throw new Error('Invalid edit replay contract');
    adapter = await deadline(() => createAdapter(trace.config), stepTimeoutMs, 'edit adapter startup');
    const compare = async expected => {
      const actual = clone(await adapter.project()), durable = clone(await adapter.observe());
      const durableViolations = clone(await adapter.check?.() || []);
      result.observations.push({ step: currentStep, actual, durable, durableViolations });
      if (!isDeepStrictEqual(actual, expected) || !Array.isArray(durableViolations) || durableViolations.length) {
        result.classification = 'implementation_mismatch';
        result.difference = { step: currentStep, expected: clone(expected), actual, durableViolations };
        result.counterexample = { ...clone(trace), steps: clone(trace.steps.slice(0, currentStep + 1)), minimality: 'first-divergence-prefix' };
        return false;
      }
      return true;
    };
    if (!await compare(trace.initial)) { result.complete = true; return result; }
    for (const [index, step] of trace.steps.entries()) {
      currentStep = index;
      await deadline(() => adapter.act(step), stepTimeoutMs, `edit action ${index}: ${step.action}`);
      if (!await compare(step.expected)) { result.complete = true; return result; }
    }
    result.complete = true; result.ok = true; result.classification = 'matched';
  } catch (error) { result.error = { step: currentStep, name: error.name, message: error.message }; }
  finally {
    try { if (adapter) await deadline(() => adapter.close(), cleanupTimeoutMs, 'edit adapter cleanup'); }
    catch (error) { result.complete = false; result.ok = false; result.classification = 'unreplayable'; result.cleanupError = error.message; }
    result.finishedAt = new Date().toISOString();
  }
  return result;
}
export function expectedEditMutationViolation(main, itf, config) {
  const trace = normalizeEditTrace(itf, config), states = [trace.initial, ...trace.steps.map(step => step.expected)];
  const keys = Object.keys(config.codecs);
  const failed = state => main === 'mutant_bypass_revision' ? keys.some(key => state.txResult[key] === 'committed' &&
    (state.submittedRevision[key] !== state.commitBaseRevision[key] || config.codecs[key] === 'v11' && state.commitBaseOverride[key])) :
    main === 'mutant_auto_revision_resend' ? keys.some(key => state.requests[key] > state.userSaves[key]) : false;
  const firstViolationState = states.findIndex(failed);
  return { ok: firstViolationState >= 0, classification: 'model_violation', firstViolationState, traceLength: trace.steps.length };
}
