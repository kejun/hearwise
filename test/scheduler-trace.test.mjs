import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSchedulerITF, validateSchedulerTrace } from '../scripts/lib/scheduler-protocol-replay.mjs';

const state = { phase: { 0: 'pending', 1: 'pending', 2: 'pending' }, durable: { 0: 'pending', 1: 'pending', 2: 'pending' },
  running: [], lastServed: -1, recentStarts: [], translationWaiting: 0, translationRunning: 0, interim: 0,
  closed: false, listenings: [0, 1], keyAvailable: { 0: true, 1: true } };
const trace = () => ({ schemaVersion: 1, specificationVersion: '1.0', protocol: 'scheduler', config: { kind: 'knowledge' }, initial: structuredClone(state),
  steps: [{ action: 'pump', actor: -1, argument: '', expected: structuredClone(state) }] });

test('scheduler ITF preserves list order but normalizes only integer sets', () => {
  assert.deepEqual(decodeSchedulerITF([{ '#bigint': '2' }, { '#bigint': '1' }]), [2, 1]);
  assert.deepEqual(decodeSchedulerITF({ '#set': [{ '#bigint': '2' }, { '#bigint': '1' }] }), [1, 2]);
  for (const invalid of [{ '#set': [1, 1] }, { '#set': ['1'] }, { '#bigint': '9007199254740993' }, { '#map': [[0, 1], [0, 2]] }, { '#bigint': '1', extra: true }]) assert.throws(() => decodeSchedulerITF(invalid));
});

for (const [label, patch] of [
  ['arbitrary actor', t => { t.steps[0].actor = 99; }],
  ['arbitrary argument', t => { t.steps[0].argument = 'anything'; }],
  ['invalid settle response', t => { Object.assign(t.steps[0], { action: 'settle', actor: 0, argument: 'auth' }); }],
  ['unknown job', t => { Object.assign(t.steps[0], { action: 'settle', actor: 3, argument: 'success' }); }],
  ['invalid translation budget input', t => { Object.assign(t.steps[0], { action: 'set_translation', actor: 0, argument: '2,1' }); }],
  ['invalid key response', t => { Object.assign(t.steps[0], { action: 'set_key', actor: 0, argument: 'yes' }); }],
  ['invalid key actor', t => { Object.assign(t.steps[0], { action: 'set_key', actor: 2, argument: 'present' }); }],
  ['provider key outside shared domain', t => { Object.assign(t.steps[0], { action: 'block_provider', actor: 1 }); }],
  ['key without configured session job', t => { t.config.jobs = [0]; for (const s of [t.initial, t.steps[0].expected]) { s.phase = { 0: 'pending' }; s.durable = { 0: 'pending' }; } Object.assign(t.steps[0], { action: 'set_key', actor: 1, argument: 'present' }); }],
  ['abstract recycle outside fairness domain', t => { Object.assign(t.steps[0], { action: 'recycle', actor: 0 }); }],
  ['duplicate configured jobs', t => { t.config.jobs = [0, 0]; }],
  ['domain expansion', t => { t.config.jobs = [0, 1, 2, 3]; }],
  ['fixture-only mutation in trace', t => { t.config.mutation = 'leak_cleanup'; }],
  ['untyped fairness option', t => { t.config.fairCycle = 'true'; }],
  ['unknown projection', t => { t.initial.extra = true; }],
  ['duplicate running actor', t => { t.initial.running = [0, 0]; }],
  ['missing durable actor', t => { delete t.initial.durable[1]; }]
]) test(`scheduler trace rejects ${label}`, () => { const t = trace(); assert.equal(validateSchedulerTrace(t), true); patch(t); assert.equal(validateSchedulerTrace(t), false); });
