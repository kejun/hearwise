import { isDeepStrictEqual as same } from 'node:util';
import { readFileSync } from 'node:fs';
import { decodeEditITF } from './edit-protocol-replay.mjs';
import { validMatchedNameDurable } from './name-protocol-durable.mjs';
import { deadline } from '../../test-support/lifecycle.mjs';
import { nameDeadlineAt, nameRemainingMs } from './name-protocol-budget.mjs';

export const nameTraceContract = JSON.parse(readFileSync(new URL('../../verification/name-protocol/trace-contract.json', import.meta.url), 'utf8'));
export const nameProjectionFields = [...Object.keys(nameTraceContract.scalars), ...nameTraceContract.attemptMaps, ...nameTraceContract.operationMaps];
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...names].sort());
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
export const validateNameConfig = config => ['independent', 'reuse'].includes(config?.mode) && (config.attempts === undefined || config.attempts === 2);
function initialProjection() {
  const value = { revision: 0, name: 0, sourceName: 0, associatedName: 0, evidenceName: 0, changes: 0,
    sourceVersion: 0, associatedVersion: 0, evidenceVersion: 0, anchorValid: true, background: 'none',
    stalePreserved: true, scopePreserved: true, identitiesPreserved: true };
  for (const field of [...nameTraceContract.attemptMaps, ...nameTraceContract.operationMaps]) value[field] = Object.fromEntries([0, 1].map(actor => [actor,
    field === 'phase' ? 'unused' : field === 'operationId' ? actor : ['requests', 'commits'].includes(field) ? 0 :
      field === 'commitBaseAnchorValid' ? true : ['rawName', 'receiptRawName'].includes(field) ? '' :
        ['txResult', 'reply', 'receipt'].includes(field) ? 'none' : -1]));
  return value;
}

export function validateNameProjection(value, config) {
  if (!validateNameConfig(config) || !keys(value, nameProjectionFields)) return false;
  for (const field of ['revision', 'changes', 'sourceVersion', 'associatedVersion', 'evidenceVersion']) if (!integer(value[field], 0, field === 'revision' ? 3 : 2)) return false;
  for (const field of ['name', 'sourceName', 'associatedName', 'evidenceName']) if (!integer(value[field], 0, 2)) return false;
  for (const field of ['anchorValid', 'stalePreserved', 'scopePreserved', 'identitiesPreserved']) if (typeof value[field] !== 'boolean') return false;
  if (!['none', 'revision', 'anchor'].includes(value.background)) return false;
  if (![...nameTraceContract.attemptMaps, ...nameTraceContract.operationMaps].every(field => keys(value[field], ['0', '1']))) return false;
  for (const actor of [0, 1]) {
    for (const field of ['submittedRevision', 'commitBaseRevision', 'loadedRevision', 'receiptInputRevision', 'receiptCommitRevision'])
      if (!integer(value[field][actor], -1, value.revision)) return false;
    for (const field of ['submittedName', 'loadedName']) if (!integer(value[field][actor], -1, 2)) return false;
    for (const field of ['requests', 'operationId', 'commits']) if (!integer(value[field][actor], 0, 1)) return false;
    if (!integer(value.receiptOwner[actor], -1, 1) || typeof value.commitBaseAnchorValid[actor] !== 'boolean') return false;
    for (const field of ['rawName', 'receiptRawName']) if (!['', 'Deebo', 'Tibo', 'Mira', ' Deebo ', ' Tibo ', ' Mira '].includes(value[field][actor])) return false;
    for (const field of ['phase', 'txResult', 'reply', 'receipt']) if (!nameTraceContract.mapSemantics[field].includes(value[field][actor])) return false;
  }
  return true;
}
export function normalizeNameTrace(itf, config) {
  if (!validateNameConfig(config) || !Array.isArray(itf?.vars) || !itf.vars.every(name => typeof name === 'string') || !Array.isArray(itf.states) || !itf.states.length)
    throw new Error('Missing name ITF/configuration');
  const names = itf.vars.map(name => name.split('::').at(-1));
  if (!same([...names].sort(), [...nameTraceContract.itfVariables].sort())) throw new Error('Missing or ambiguous name ITF variables');
  const states = itf.states.map(raw => {
    const decoded = Object.fromEntries(itf.vars.map((name, index) => {
      if (!Object.hasOwn(raw, name)) throw new Error(`Missing name ITF state variable ${name}`);
      return [names[index], decodeEditITF(raw[name])];
    }));
    if (!validateNameProjection(decoded.state, config)) throw new Error('Invalid name projection');
    return { action: decoded.lastAction, actor: decoded.actor, argument: decoded.argument, expected: decoded.state };
  });
  const first = states[0];
  if (first.action !== 'init' || first.actor !== -1 || first.argument !== '' || first.expected.revision !== 0 ||
      !same(first.expected, initialProjection())) throw new Error('Invalid name initialization');
  const trace = { schemaVersion: 1, specificationVersion: '1.0', domain: 'name-protocol', config: structuredClone(config), initial: first.expected, steps: states.slice(1) };
  if (!validateNameTrace(trace)) throw new Error('Invalid name action or trace');
  return trace;
}
export function validateNameTrace(trace) {
  return trace?.schemaVersion === 1 && trace.specificationVersion === '1.0' && trace.domain === 'name-protocol' && validateNameConfig(trace.config) &&
    validateNameProjection(trace.initial, trace.config) && same(trace.initial, initialProjection()) && Array.isArray(trace.steps) && trace.steps.every(step =>
      nameTraceContract.actions[step.action]?.includes(step.argument) &&
      (['background_change', 'stutter'].includes(step.action) ? step.actor === -1 : integer(step.actor, 0, 1)) && validateNameProjection(step.expected, trace.config));
}

// Expected projections come exclusively from the supplied Quint ITF. Independent
// raw-table validation is mandatory even when adapter.check() claims no errors.
export async function replayNameTrace(trace, createAdapter, { startupTimeoutMs = 15000, stepTimeoutMs = 15000, cleanupTimeoutMs = 5000,
  timeoutMs = 60000, deadlineAt: parentDeadline } = {}) {
  const deadlineAt = nameDeadlineAt(timeoutMs, parentDeadline ?? process.env.HEARWISE_NAME_DEADLINE_AT);
  const result = { startedAt: new Date().toISOString(), finishedAt: null, complete: false, ok: false, cleanupComplete: false,
    classification: 'driver_cannot_replay', observations: [], budget: { deadlineAt, startupTimeoutMs, stepTimeoutMs, cleanupTimeoutMs, timeoutMs } };
  let adapter, startup, startupRejected = false, currentStep = -1;
  const operation = (fn, limit, label) => deadline(fn, nameRemainingMs(deadlineAt, limit, cleanupTimeoutMs), label);
  try {
    if (!validateNameTrace(trace)) throw new Error('Invalid name replay contract');
    // Capture the eventual resource even if its caller times out before the
    // asynchronous factory returns. The finally block still owns that resource.
    const startupBudget = nameRemainingMs(deadlineAt, startupTimeoutMs, cleanupTimeoutMs);
    startup = Promise.resolve().then(() => createAdapter(trace.config)).catch(error => { startupRejected = true; throw error; });
    adapter = await deadline(() => startup, startupBudget, 'name adapter startup');
    const compare = expected => operation(async () => {
      const observation = { step: currentStep, actual: structuredClone(await adapter.project()), durable: structuredClone(await adapter.observe()),
        durableViolations: structuredClone(await adapter.check?.() || []) };
      const durableValid = validMatchedNameDurable(observation, trace.config, result.observations.at(-1));
      result.observations.push(observation);
      if (!same(observation.actual, expected) || !durableValid || !Array.isArray(observation.durableViolations) || observation.durableViolations.length) {
        result.classification = 'implementation_mismatch';
        result.difference = { step: currentStep, expected: structuredClone(expected), actual: observation.actual, durableValid, durableViolations: observation.durableViolations };
        result.counterexample = { ...structuredClone(trace), steps: structuredClone(trace.steps.slice(0, currentStep + 1)), minimality: 'first-divergence-prefix' };
        return false;
      }
      return true;
    }, stepTimeoutMs, `name projection ${currentStep}`);
    if (!await compare(trace.initial)) { result.complete = true; return result; }
    for (const [index, step] of trace.steps.entries()) {
      currentStep = index;
      await operation(() => adapter.act(step), stepTimeoutMs, `name action ${index}: ${step.action}`);
      if (!await compare(step.expected)) { result.complete = true; return result; }
    }
    result.complete = true; result.ok = true; result.classification = 'matched';
  } catch (error) { result.error = { step: currentStep, name: error.name, message: error.message }; }
  finally {
    try {
      if (!adapter && startup && !startupRejected) {
        try { adapter = await deadline(() => startup, nameRemainingMs(deadlineAt, cleanupTimeoutMs), 'name late adapter acquisition'); }
        catch (error) {
          // The result remains explicitly unclean. If the resource arrives
          // after the deadline, close it rather than abandoning its server.
          void startup.then(late => deadline(() => late.close(), cleanupTimeoutMs, 'name overdue adapter cleanup')).catch(() => {});
          throw error;
        }
      }
      if (adapter) {
        // Even synchronous startup can exhaust the clock before timers fire.
        // Always initiate close for an acquired resource, including this path.
        const closing = Promise.resolve().then(() => adapter.close());
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          void deadline(() => closing, cleanupTimeoutMs, 'name overdue acquired adapter cleanup').catch(() => {});
          throw new Error('Name cleanup deadline exhausted after acquisition');
        }
        await deadline(() => closing, Math.min(remaining, cleanupTimeoutMs), 'name adapter cleanup'); result.cleanupComplete = true;
      }
    }
    catch (error) { result.complete = false; result.ok = false; result.classification = 'driver_cannot_replay'; result.cleanupError = error.message; }
    result.finishedAt = new Date().toISOString();
  }
  return result;
}
export function expectedNameMutationViolation(main, itf, config) {
  const trace = normalizeNameTrace(itf, config), states = [trace.initial, ...trace.steps.map(step => step.expected)];
  const fails = state => main === 'mutant_fingerprint' ? [0, 1].some(a => state.txResult[a] === 'duplicate' &&
    (state.rawName[a] !== state.receiptRawName[state.operationId[a]] || state.submittedRevision[a] !== state.receiptInputRevision[state.operationId[a]])) :
    main === 'mutant_rollback' ? [state.sourceVersion, state.associatedVersion, state.evidenceVersion].some(value => value !== state.changes) :
    main === 'mutant_receipt' ? [0, 1].some(op => (state.receipt[op] === 'succeeded') !== (state.commits[op] === 1)) :
    main === 'mutant_revision' ? [0, 1].some(a => state.txResult[a] === 'committed' && state.submittedRevision[a] !== state.commitBaseRevision[a]) :
    main === 'mutant_anchor' ? [0, 1].some(a => state.txResult[a] === 'committed' && !state.commitBaseAnchorValid[a]) : false;
  const firstViolationState = states.findIndex(fails);
  return { ok: firstViolationState >= 0, classification: 'model_property_violation', firstViolationState, traceLength: trace.steps.length };
}
