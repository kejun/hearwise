import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkTlcOutput, parseTlaValue } from '../verification/scheduler-protocol/checker.mjs';
const config = JSON.parse(readFileSync(new URL('../verification/scheduler-protocol/config.json', import.meta.url)));
const check = id => config.checks.find(item => item.id === id);
const fixture = name => readFileSync(new URL(`../verification/scheduler-protocol/fixtures/${name}.log`, import.meta.url), 'utf8');
const execution = exitCode => ({ exitCode, signal: null, timedOut: false });
const pass = temporal => `TLC2 Version fixture\n${temporal ? 'Checking temporal properties for the complete state space with 2 total distinct states\nFinished checking temporal properties in 00s\n' : ''}Model checking completed. No error has been found.\n4 states generated, 2 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 2.\n`;
const interim = fixture('interim-total'), clock = fixture('missing-clock'), scheduler = fixture('missing-scheduler'), knowledge = fixture('knowledge-starvation');
test('TLA finite values are parsed without eval, preserving lists, sets and maps', () => {
  assert.deepEqual(parseTlaValue('<<2, 1>>'), [2, 1]);
  assert.deepEqual(parseTlaValue('{1, 2}'), new Set([1, 2]));
  assert.deepEqual(parseTlaValue('(0 :> "pending" @@ 2 :> TRUE)'), new Map([[0, 'pending'], [2, true]]));
  assert.equal(parseTlaValue('"a\\nquoted"'), 'a\nquoted');
});
for (const [name, value] of [['unknown syntax', '[x |-> 1]'], ['duplicate set', '{1,1}'], ['duplicate map', '(0 :> 1 @@ 0 :> 2)'], ['unsafe integer', '999999999999999999999'], ['trailing payload', 'TRUE junk'], ['truncated list', '<<1,2>']]) test(`Reject ${name}`, () => assert.throws(() => parseTlaValue(value)));
test('Complete safety graph is independently recognized', () => assert.equal(checkTlcOutput(pass(false), execution(0), check('translation-small-safety')).status, 'complete'));
test('Complete temporal graph needs its completed temporal sweep', () => assert.equal(checkTlcOutput(pass(true), execution(0), check('translation-fairness')).temporalComplete, true));
for (const [name, change] of [['nonzero exit', e => ({ ...e, exitCode: 1 })], ['timeout', e => ({ ...e, timedOut: true })], ['signal', e => ({ ...e, signal: 'SIGTERM' })], ['missing execution fields', () => ({ exitCode: 0 })]]) test(`Reject pass with ${name}`, () => assert.throws(() => checkTlcOutput(pass(true), change(execution(0)), check('translation-fairness'))));
for (const [name, raw] of [['queued states', pass(false).replace('0 states left', '1 states left')], ['no complete graph', pass(false).replace('Model checking completed. No error has been found.', '')], ['backend failure', pass(false) + 'error: key not found: $C$54\n'], ['two runs', pass(false) + pass(false)]]) test(`Reject ${name}`, () => assert.throws(() => checkTlcOutput(raw, execution(0), check('translation-small-safety'))));
test('A partial temporal sweep cannot pass', () => assert.throws(() => checkTlcOutput(pass(true).replace('complete state space', 'current state space'), execution(0), check('translation-fairness'))));
test('Safety mutant requires decoded shared-budget violation', () => {
  const result = checkTlcOutput(interim, execution(1), check('mutant-interim-total'));
  assert.equal(result.violation.property, 'sharedBudget'); assert.ok(result.violation.after.running.length + result.violation.after.interim > 2);
});
test('Counterexample text without an actual violated budget is rejected', () => assert.throws(() => checkTlcOutput(interim.replace(/_interim = 1/g, '_interim = 0'), execution(1), check('mutant-interim-total'))));
test('Unknown safety mutation is rejected rather than accepted by exit code', () => assert.throws(() => checkTlcOutput(interim, execution(1), { ...check('mutant-interim-total'), main: 'unknown' })));
test('Missing final state field is rejected', () => { const offset = interim.lastIndexOf('/\\ '); assert.throws(() => checkTlcOutput(interim.slice(0, offset) + interim.slice(offset).replace(/^\/\\ [^\n]+\n/, ''), execution(1), check('mutant-interim-total'))); });
test('Non-contiguous state numbering is rejected', () => assert.throws(() => checkTlcOutput(interim.replace('State 2:', 'State 9:'), execution(1), check('mutant-interim-total'))));
test('Normalized duplicate state variables are rejected', () => { const line = interim.match(/^\/\\ .*_interim = .*$/m)[0]; assert.throws(() => checkTlcOutput(interim.replace(line, line + '\n' + line), execution(1), check('mutant-interim-total'))); });
test('Missing-clock lasso proves precisely the omitted fairness premise fails', () => {
  const { lasso } = checkTlcOutput(clock, execution(1), check('translation-missing-clock'));
  assert.equal(lasso.kind, 'back_edge'); assert.equal(lasso.fairness.clock.satisfied, false); assert.equal(lasso.fairness.pump.satisfied, true); assert.equal(lasso.fairness.finish.satisfied, true);
});
test('Stuttering counterexample has a real preceding state anchor', () => assert.equal(checkTlcOutput(scheduler, execution(1), check('translation-missing-scheduler')).lasso.kind, 'stuttering'));
test('Knowledge selector violation is decoded under retained fairness', () => {
  const { lasso } = checkTlcOutput(knowledge, execution(1), check('knowledge-starvation-mutant'));
  assert.equal(lasso.selectorViolation.expected, 2); assert.ok(lasso.selectorViolation.dispatched.every(job => job !== 2));
  assert.ok(Object.values(lasso.fairness).every(item => item.satisfied));
});
test('Current knowledge lasso also contains a wrong dispatch on its closing edge', () => {
  const { lasso } = checkTlcOutput(knowledge, execution(1), check('knowledge-starvation-mutant'));
  const before = lasso.states.at(-1).values, after = lasso.states.find(state => state.index === lasso.anchor).values;
  assert.equal(before.phase[2], 'pending'); assert.equal(before.lastServed, 0);
  assert.equal(before.intervalReady[1], true); assert.equal(before.graceReady[2], true); assert.equal(before.retryReady[2], true);
  assert.equal(before.cooldownReady[0], true); assert.equal(before.providerReady[0], true); assert.equal(before.keyAvailable[1], true);
  assert.deepEqual(after.recentStarts, [1]); assert.equal(after.phase[2], 'pending'); assert.equal(after.phase[1], 'running');
});
test('Nonexistent lasso anchor is rejected', () => assert.throws(() => checkTlcOutput(clock.replace(/Back to state \d+:/, 'Back to state 999:'), execution(1), check('translation-missing-clock'))));
test('Missing lasso anchor is rejected', () => assert.throws(() => checkTlcOutput(clock.replace(/^Back to state .*$/m, ''), execution(1), check('translation-missing-clock'))));
test('Already-started victim is rejected', () => assert.throws(() => checkTlcOutput(clock.replace(/_started = \{[^}]*\}/, '_started = {0}'), execution(1), check('translation-missing-clock'))));
test('Cancelled or evicted victim is rejected', () => assert.throws(() => checkTlcOutput(clock.replace(/_excluded = \{[^}]*\}/, '_excluded = {0}'), execution(1), check('translation-missing-clock'))));
test('Retained termination fairness cannot disappear from the cycle', () => assert.throws(() => checkTlcOutput(clock.replace(/_lastAction = "settle_final"/g, '_lastAction = "stutter"'), execution(1), check('translation-missing-clock'))));
test('NoClock counterexample cannot be relabelled as fully fair Progress', () => assert.throws(() => checkTlcOutput(clock, execution(1), { ...check('translation-starvation-mutant'), main: 'mutant_translation_starvation' })));
test('Wrong temporal target is rejected', () => assert.throws(() => checkTlcOutput(clock, execution(1), { ...check('translation-missing-clock'), target: 1 })));
test('Counterexample without TLC execution cannot pass', () => assert.throws(() => checkTlcOutput(clock.replace(/^TLC2 Version.*$/m, ''), execution(1), check('translation-missing-clock'))));
test('Unknown phase value in a parsed map is rejected', () => assert.throws(() => checkTlcOutput(interim.replace(':> "fresh"', ':> "invented"'), execution(1), check('mutant-interim-total'))));
test('Readiness map cannot substitute a string for a boolean', () => assert.throws(() => checkTlcOutput(knowledge.replace(/(_intervalReady = \(0 :> )FALSE/, '$1"false"'), execution(1), check('knowledge-starvation-mutant'))));
