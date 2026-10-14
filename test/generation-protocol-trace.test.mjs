import test from 'node:test';
import assert from 'node:assert/strict';
import { generationInitialProjection, normalizeGenerationTrace, replayGenerationTrace, validateGenerationTrace, generationProjectionFields, generationReplayRefinement } from '../scripts/lib/generation-protocol-replay.mjs';

import { fixedTrace } from '../test-support/generation-trace-fixture.mjs';

for (const protocol of ['relation', 'knowledge']) test(`${protocol} native Quint trace retains request identities and exact initial projection`, async t => {
  const trace = await fixedTrace(t, protocol);
  assert.equal(validateGenerationTrace(trace), true);
  assert.deepEqual(trace.initial, generationInitialProjection(trace.config));
  assert.deepEqual(trace.steps.map(step => step.action), ['reserve', 'send', 'response']);
  assert.equal(trace.steps.at(-1).expected.reserved[0], 1);
  assert.deepEqual(trace.steps.at(-1).expected.business[0], [0]);
  assert.equal(trace.steps.at(-1).expected.usage[0], protocol === 'relation' ? 'response_received' : 'none');
});

test('generation contract rejects malformed actor, session, request, response and projection domains', async t => {
  const trace = await fixedTrace(t, 'relation', 3, 2, 'oldPhysicalExceedsLocalCapacityTest');
  const changes = [
    value => { value.config.protocol = 'unknown'; }, value => { value.config.actors = 2; }, value => { value.config.capacity = 3; },
    value => { value.steps[0].actor = 3; }, value => { value.steps[1].actor = 6; }, value => { value.steps[4].actor = 2; },
    value => { value.steps[5].actor = 2; }, value => { value.steps[0].actor = 0.5; }, value => { value.steps[0].response = 'ok'; },
    value => { value.steps[0].unexpected = true; }, value => { value.steps[0].action = 'close_reopen'; },
    value => { value.steps[0].expected.generation[0] = 2; }, value => { value.steps[0].expected.activeOwner[0] = 2; },
    value => { value.steps[0].expected.reserved[0] = -1; }, value => { value.steps[0].expected.physical[0] = 'sent'; },
    value => { value.steps[0].expected.requestGeneration[1] = 0; }, value => { value.steps[0].expected.present[2] = true; },
    value => { value.steps[0].expected.calls[0] = 2; }, value => { value.steps[0].expected.callbackCount[0] = 2; },
    value => { value.steps[0].expected.business[0] = [2]; }, value => { value.steps[0].expected.business[0] = [0, 0]; },
    value => { value.steps[0].expected.business[0] = [1, 0]; }, value => { value.steps[0].expected.usage[0] = 'complete'; },
    value => { value.steps[0].expected.outcome[0] = 'partial'; }, value => { value.steps[0].expected.restartCount = 2; },
    value => { delete value.steps[0].expected.aborted[0]; }, value => { value.initial.reserved[0] = 1; },
    value => { value.steps[0].expected.extraGhost = {}; }
  ];
  for (const [index, change] of changes.entries()) { const bad = structuredClone(trace); change(bad); assert.equal(validateGenerationTrace(bad), false, `mutation ${index}`); }
  const response = { action: 'response', actor: 0, response: 'ok', expected: trace.steps[0].expected };
  for (const invalid of ['', 'empty', 'failure', 'auth', 1]) assert.equal(validateGenerationTrace({ ...trace, steps: [{ ...response, response: invalid }] }), false);
  assert.throws(() => normalizeGenerationTrace({ vars: ['a::lastAction', 'b::lastAction'], states: [{}] }, trace.config), /ambiguous/);
});

test('knowledge usage is not invented and invalid traces never allocate an adapter', async t => {
  const trace = await fixedTrace(t, 'knowledge');
  const bad = structuredClone(trace); bad.steps[0] = { action: 'usage', actor: 0, response: '', expected: bad.steps[0].expected };
  assert.equal(validateGenerationTrace(bad), false);
  let created = 0;
  const result = await replayGenerationTrace(bad, async () => { created++; throw new Error('must not allocate'); });
  assert.equal(created, 0); assert.equal(result.complete, false); assert.equal(result.classification, 'unreplayable');
});


test('native refinement permits are explicit environment stutters and cannot change lifecycle state', async t => {
  const trace = await fixedTrace(t, 'knowledge', 3, 2, 'oldPhysicalExceedsLocalCapacityTest', true);
  assert.equal(validateGenerationTrace(trace), true);
  const core = state => Object.fromEntries(generationProjectionFields.map(field => [field, state[field]]));
  let previous = trace.initial, permits = 0, admissions = 0;
  for (const step of trace.steps) {
    if (step.action === 'permit') {
      permits++; assert.equal(step.actor, -1); assert.deepEqual(core(step.expected), core(previous));
      assert.equal(step.expected.admissionPermit, true);
    }
    if (step.action === 'reserve') {
      admissions++; assert.equal(previous.admissionPermit, true); assert.equal(step.expected.admissionPermit, false);
    }
    assert.equal(step.expected.permitsIssued, permits); assert.equal(step.expected.admissionsObserved, admissions);
    previous = step.expected;
  }
  assert.equal(permits, admissions); assert.equal(admissions, 4);
  const last = trace.steps.at(-1).expected;
  assert.equal(Object.values(last.activeOwner).filter(owner => owner !== -1).length, 2);
  assert.equal(Object.values(last.physical).filter(value => value === 'inflight').length, 3);
  for (const change of [value => { value.initial = null; }, value => { value.steps[0].expected = null; }, value => { value.config.refinement = 'unknown'; }, value => { value.config.hiddenKey = true; },
    value => { value.steps[0].actor = 0; }, value => { delete value.steps[0].expected.creationRank[0]; },
    value => { value.steps[0].expected.admissionPermit = 'true'; }, value => { value.steps[0].expected.permitsIssued = 7; }]) {
    const broken = structuredClone(trace); change(broken); assert.equal(validateGenerationTrace(broken), false);
  }
});
