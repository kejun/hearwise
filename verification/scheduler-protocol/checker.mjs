import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const translationTypes = { queue: 'list', window: 'list', running: 'set', phase: 'map', aged: 'set', started: 'set', excluded: 'set', interim: 'int', streak: 'int', speechTurn: 'bool', headIdentity: 'int', legalStart: 'bool', legalDrop: 'bool', recentStarts: 'list', lastAction: 'str', actor: 'int', argument: 'str' };
const knowledgeTypes = { phase: 'map', durable: 'map', running: 'set', intervalReady: 'map', graceReady: 'map', retryReady: 'map', cooldownReady: 'map', providerReady: 'map', keyAvailable: 'map', retried: 'set', continued: 'set', aborted: 'set', listenings: 'set', closed: 'bool', lastServed: 'int', translationWaiting: 'int', translationRunning: 'int', interim: 'int', recentStarts: 'list', started: 'set', legalAdmission: 'bool', lastAction: 'str', actor: 'int', argument: 'str' };

// Deliberately limited to the finite values emitted for these flat models.
// No eval, partial-map guessing, truncated-state repair, or unknown TLA syntax.
export function parseTlaValue(source) {
  let at = 0;
  const space = () => { while (/\s/.test(source[at] || '') && at < source.length) at++; };
  const take = token => { space(); if (!source.startsWith(token, at)) return false; at += token.length; return true; };
  const need = token => assert.ok(take(token), `Expected TLA token ${token}`);
  function value() {
    space();
    if (take('<<')) { const out = []; if (take('>>')) return out; do { out.push(value()); } while (take(',')); need('>>'); return out; }
    if (take('{')) { const out = []; if (!take('}')) { do { out.push(value()); } while (take(',')); need('}'); } assert.equal(new Set(out).size, out.length, 'Duplicate TLA set member'); return new Set(out); }
    if (take('(')) { const out = new Map(); do { const key = value(); assert.ok(Number.isSafeInteger(key), 'Non-integer map key'); need(':>'); assert.ok(!out.has(key), 'Duplicate TLA map key'); out.set(key, value()); } while (take('@@')); need(')'); return out; }
    if (take('TRUE')) return true;
    if (take('FALSE')) return false;
    space();
    if (source[at] === '"') { const match = source.slice(at).match(/^"(?:[^"\\]|\\.)*"/); assert.ok(match, 'Unterminated TLA string'); at += match[0].length; return JSON.parse(match[0]); }
    const integer = source.slice(at).match(/^-?\d+/); if (integer) { at += integer[0].length; const n = Number(integer[0]); assert.ok(Number.isSafeInteger(n), 'Unsafe TLA integer'); return n; }
    throw new Error(`Unsupported TLA value near ${source.slice(at, at + 32)}`);
  }
  const result = value(); space(); assert.equal(at, source.length, 'Trailing/unknown TLA value content'); return result;
}
function statesFrom(raw, knowledge) {
  const types = knowledge ? knowledgeTypes : translationTypes;
  const start = raw.indexOf('Error: The following behavior constitutes a counter-example:');
  const safetyStart = raw.indexOf('Error: The behavior up to this point is:');
  assert.ok(start >= 0 || safetyStart >= 0, 'Missing TLC behavior header');
  const behavior = raw.slice(start >= 0 ? start : safetyStart);
  const boundaries = [...behavior.matchAll(/^(?:State (\d+): ([^\n]*)|Back to state \d+:.*|Finished checking temporal.*|Finished in .*|[\d,]+ states generated.*|Trace exploration spec path:.*|Warning:.*|\[violation\].*|error:.*|CLI_EXIT=.*)$/gm)];
  const states = [];
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i]; if (!boundary[1] || boundary[2].startsWith('Stuttering')) continue;
    const index = Number(boundary[1]); assert.equal(index, states.length + 1, 'Non-contiguous/duplicate TLC states');
    const body = behavior.slice(boundary.index + boundary[0].length, boundaries[i + 1]?.index ?? behavior.length).trim();
    const assignments = [...body.matchAll(/^\/\\ ([A-Za-z0-9_]+) = /gm)];
    assert.ok(assignments.length, 'Empty/truncated TLC state');
    assert.equal(body.slice(0, assignments[0].index).trim(), '', 'Unknown text before TLC assignments');
    const values = {};
    assignments.forEach((assignment, n) => {
      const field = assignment[1].split('_').at(-1); assert.ok(Object.hasOwn(types, field), `Unknown model field ${field}`); assert.ok(!Object.hasOwn(values, field), 'Duplicate normalized model field');
      const value = parseTlaValue(body.slice(assignment.index + assignment[0].length, assignments[n + 1]?.index ?? body.length).trim());
      const kind = types[field];
      assert.ok(kind === 'list' ? Array.isArray(value) : kind === 'set' ? value instanceof Set : kind === 'map' ? value instanceof Map : kind === 'int' ? Number.isSafeInteger(value) : typeof value === (kind === 'bool' ? 'boolean' : 'string'), `Wrong field type: ${field}`);
      if (kind === 'set' || kind === 'list') assert.ok([...value].every(Number.isSafeInteger), 'Non-integer task collection');
      if (kind === 'map') {
        assert.ok([...value.keys()].every(key => Number.isSafeInteger(key) && key >= 0), 'Invalid model map domain');
        const phases = knowledge ? ['pending', 'running', 'complete', 'failed', 'cancelled'] : ['fresh', 'queued', 'running', 'settled', 'cancelled', 'dropped'];
        const allowed = field === 'phase' ? phases : field === 'durable' ? ['pending', 'running', 'complete', 'failed', 'deleted'] : null;
        assert.ok([...value.values()].every(item => allowed ? allowed.includes(item) : typeof item === 'boolean'), `Invalid map values: ${field}`);
      }
      values[field] = kind === 'set' ? [...value].sort((a, b) => a - b) : kind === 'map' ? Object.fromEntries(value) : value;
    });
    assert.deepEqual(Object.keys(values).sort(), Object.keys(types).sort(), 'Incomplete TLC state variables');
    states.push({ index, values });
  }
  assert.ok(states.length, 'Missing complete TLC states');
  return { states, behavior };
}
const session = job => job === 2 ? 1 : 0;
const busy = state => state.translationWaiting > 0 || state.translationRunning > 0 || state.interim > 0;
function knowledgeReady(state, job) {
  const id = session(job), key = 0; // Both temporal domains and readiness mutant use a shared key.
  return state.retryReady[job] && state.intervalReady[id] && state.cooldownReady[key] && state.providerReady[key] && (!busy(state) || state.graceReady[job]);
}
function enabled(state, action, knowledge) {
  if (!knowledge) {
    if (state.started.includes(0) || state.excluded.includes(0)) return false;
    if (action === 'clock') return state.queue.some(job => !state.aged.includes(job));
    if (action === 'finish') return state.running.length + state.interim > 0;
    return state.queue.length > 0 && state.running.length + state.interim < 2;
  }
  if (state.started.includes(2) || state.closed || !state.listenings.includes(1)) return false;
  if (action === 'finish') return state.running.length > 0;
  if (action === 'clock') return ['intervalReady', 'graceReady', 'retryReady', 'cooldownReady', 'providerReady'].some(field => Object.values(state[field]).some(value => !value));
  if (state.running.length >= (busy(state) ? 1 : 2)) return false;
  return state.listenings.some(id => {
    if (!state.keyAvailable[id] || state.running.some(job => session(job) === id)) return false;
    const pending = Object.keys(state.phase).map(Number).sort((a, b) => a - b).find(job => session(job) === id && state.phase[job] === 'pending');
    return pending != null && knowledgeReady(state, pending);
  });
}
function businessState(state) { return Object.fromEntries(Object.entries(state).filter(([key]) => !['lastAction', 'actor', 'argument'].includes(key))); }
function occurred(from, to, action, knowledge) {
  const label = to.lastAction;
  const matches = action === 'clock' ? label === 'advance_time' : action === 'pump' ? label === 'pump' : knowledge ? label === 'settle' : ['settle_final', 'settle_interim'].includes(label);
  if (!matches || !enabled(from, action, knowledge) || isDeepStrictEqual(businessState(from), businessState(to))) return false;
  if (action === 'clock') return knowledge
    ? ['intervalReady', 'graceReady', 'retryReady', 'cooldownReady', 'providerReady'].every(field => Object.values(to[field]).every(value => value === true)) && isDeepStrictEqual(from.phase, to.phase) && isDeepStrictEqual(from.running, to.running)
    : isDeepStrictEqual([...from.queue].sort((a, b) => a - b), to.aged) && isDeepStrictEqual(from.queue, to.queue) && isDeepStrictEqual(from.running, to.running);
  if (action === 'pump') return to.recentStarts.length > 0 && to.recentStarts.every(job => !from.running.includes(job) && to.running.includes(job) && to.started.includes(job) && (knowledge ? from.phase[job] === 'pending' : from.queue.includes(job)));
  if (!knowledge && label === 'settle_interim') return from.interim === 1 && to.interim === 0;
  return from.running.includes(to.actor) && !to.running.includes(to.actor) && (knowledge ? ['pending', 'complete', 'failed'].includes(to.phase[to.actor]) : to.phase[to.actor] === 'settled');
}
function checkSafetyMutation(check, states, knowledge) {
  const last = states.at(-1).values, before = states.at(-2)?.values;
  const mismatch = state => Object.keys(state.phase).some(job => (state.phase[job] === 'running') !== state.running.includes(Number(job)));
  let violated = false, property;
  switch (check.main) {
    case 'mutant_interim_admission': property = 'optionalSlotOrSharedAdmission'; violated = last.interim > 1 || last.running.length + last.interim > 2 || (last.lastAction === 'admit_interim' && before.queue.length > 0); break;
    case 'mutant_interim_total': property = 'sharedBudget'; violated = last.running.length + last.interim > 2; break;
    case 'mutant_final_cleanup': property = 'lifecycle'; violated = last.lastAction === 'settle_final' && last.phase[last.actor] === 'settled' && last.running.includes(last.actor); break;
    case 'mutant_interim_cleanup': property = 'interimReleased'; violated = last.lastAction === 'settle_interim' && last.interim !== 0; break;
    case 'mutant_knowledge_cleanup': property = 'runtimeLifecycle'; violated = mismatch(last) && ['settle', 'remove', 'close'].includes(last.lastAction); break;
    case 'mutant_knowledge_busy': property = 'busyDoesNotRevoke'; violated = last.lastAction === 'set_translation' && busy(last) && last.running.length < before.running.length && before.running.every(job => last.phase[job] === 'running'); break;
    case 'mutant_knowledge_readiness': property = 'readyBeforeAdmission'; violated = last.lastAction === 'pump' && last.recentStarts.some(job => !knowledgeReady(before, job)); break;
    default: throw new Error(`Unsupported safety mutant ${check.main}`);
  }
  assert.ok(before && violated, `No actual ${property} violation in decoded states`);
  return { property, state: states.at(-1).index, actor: last.actor, before, after: last, model: knowledge ? 'knowledge' : 'translation' };
}
function checkLasso(raw, check, states, knowledge) {
  const back = [...raw.matchAll(/^Back to state (\d+):/gm)], stay = [...raw.matchAll(/^State (\d+): Stuttering/gm)];
  assert.equal(back.length + stay.length, 1, 'Missing or ambiguous temporal cycle anchor');
  const anchor = back.length ? Number(back[0][1]) : Number(stay[0][1]) - 1;
  assert.ok(anchor >= 1 && anchor <= states.length, 'Loop anchor outside complete states');
  if (stay.length) assert.equal(Number(stay[0][1]), states.length + 1, 'Stuttering marker does not follow final state');
  assert.equal(check.target, knowledge ? 2 : 0, 'Unexpected temporal target');
  states.forEach(({ values: s }) => {
    assert.ok(!s.started.includes(check.target), 'Target already started in temporal counterexample');
    assert.ok(knowledge ? !s.closed && s.listenings.includes(1) && s.phase[2] === 'pending' && s.keyAvailable[1] && s.providerReady[0] : !s.excluded.includes(0) && s.phase[0] === 'queued' && s.queue.includes(0), 'Victim is not continuously eligible');
  });
  const cycle = states.slice(anchor - 1), edges = cycle.map((state, i) => [state.values, cycle[(i + 1) % cycle.length].values]);
  const missing = { NoClockProgress: 'clock', NoSchedulerProgress: 'pump', NoTerminationProgress: 'finish' }[check.temporal] ?? null;
  const fairness = Object.fromEntries(['clock', 'pump', 'finish'].map(action => {
    const continuouslyEnabled = cycle.every(({ values }) => enabled(values, action, knowledge));
    const occurs = edges.some(([from, to]) => occurred(from, to, action, knowledge));
    const satisfied = !continuouslyEnabled || occurs;
    assert.ok(action === missing ? !satisfied : satisfied, `Cycle does not justify ${action === missing ? 'omitted' : 'retained'} ${action} weak fairness`);
    return [action, { continuouslyEnabled, occurs, satisfied, required: action !== missing }];
  }));
  let selectorViolation = null;
  if (check.temporal === 'Progress') {
    assert.ok(check.main === 'mutant_translation_starvation' || check.main === 'mutant_knowledge_starvation', 'Unknown temporal mutation');
    const dispatchEdges = states.slice(1).map((state, i) => [states[i], state]);
    dispatchEdges.push([states.at(-1), states[anchor - 1]]);
    for (const [previous, next] of dispatchEdges) {
      const before = previous.values, after = next.values;
      if (isDeepStrictEqual(businessState(before), businessState(after)) || !after.recentStarts.length || !['pump', 'settle', 'settle_final', 'settle_interim'].includes(after.lastAction)) continue;
      const bad = knowledge ? before.lastServed === 0 && knowledgeReady(before, 2) && session(after.recentStarts[0]) === 0 : before.streak >= 3 && before.queue.includes(0) && (before.aged.includes(0) || after.argument === 'timeout') && after.recentStarts[0] !== 0;
      if (bad) { selectorViolation = { state: next.index, predecessor: previous.index, expected: check.target, dispatched: after.recentStarts, previousCursorOrStreak: knowledge ? before.lastServed : before.streak }; break; }
    }
    assert.ok(selectorViolation, 'No decoded broken-selector dispatch found');
  }
  return { kind: back.length ? 'back_edge' : 'stuttering', anchor, lastState: states.length, fairness, missingAssumption: missing, selectorViolation, states };
}

export function checkTlcOutput(raw, execution, check) {
  assert.equal(typeof raw, 'string');
  assert.equal(execution?.timedOut, false, 'Timed out checker is not evidence');
  assert.equal(execution?.signal, null, 'Signaled checker is not evidence');
  assert.equal(execution?.exitCode, check.expected === 'pass' ? 0 : 1, 'Unexpected Quint exit status');
  assert.equal((raw.match(/^TLC2 Version /gm) || []).length, 1, 'Missing/combined TLC execution');
  assert.doesNotMatch(raw, /Connection dropped|key not found:|OutOfMemoryError|Invalid strict JSON/);
  const countRows = [...raw.matchAll(/^([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue\./gm)];
  const lastCounts = countRows.at(-1); assert.ok(lastCounts, 'Missing final state statistics');
  const metrics = { generated: Number(lastCounts[1].replaceAll(',', '')), distinct: Number(lastCounts[2].replaceAll(',', '')), queued: Number(lastCounts[3].replaceAll(',', '')), depth: Number(raw.match(/The depth of the complete state graph search is (\d+)\./)?.[1]) };
  assert.ok(metrics.generated >= metrics.distinct && metrics.distinct > 0 && Number.isInteger(metrics.depth) && metrics.depth > 0, 'Invalid graph metrics');
  if (check.expected === 'pass') {
    assert.equal((raw.match(/Model checking completed\. No error has been found\./g) || []).length, 1, 'Missing/combined checker completion');
    assert.equal(metrics.queued, 0, 'Incomplete reachable graph');
    assert.doesNotMatch(raw, /^Error:|^error:|\[violation\]/m);
    if (check.kind === 'temporal') {
      const complete = raw.indexOf('Checking temporal properties for the complete state space');
      assert.ok(complete >= 0 && raw.indexOf('Finished checking temporal properties', complete) > complete, 'Missing complete-state temporal completion');
    }
    return { status: 'complete', metrics, temporalComplete: check.kind === 'temporal' };
  }
  assert.equal(check.expected, 'counterexample');
  assert.match(raw, check.kind === 'temporal' ? /Error: Temporal propert(?:y|ies).*violated\./ : /Error: Invariant .* is violated\./);
  const knowledge = check.specification.startsWith('knowledge');
  const { states } = statesFrom(raw, knowledge);
  if (check.kind === 'temporal') return { status: 'counterexample', metrics, lasso: checkLasso(raw, check, states, knowledge), violation: { property: check.temporal, target: check.target } };
  return { status: 'counterexample', metrics, violation: checkSafetyMutation(check, states, knowledge), states };
}
