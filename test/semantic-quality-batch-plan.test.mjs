import test from 'node:test';
import assert from 'node:assert/strict';
import { contractDigest } from '../scripts/lib/quality-contract.mjs';
import { validateSemanticBatchPlan, semanticBatchTrials, semanticBatchBudget, validateBatchApprovals } from '../scripts/lib/semantic-quality-batch-plan.mjs';
import { semanticCorpusBudget } from '../scripts/lib/semantic-quality-corpus-plan.mjs';
import { semanticBatchPlanFixture, refreshSemanticBatchFixtureDigests } from '../test-support/semantic-batch-plan-fixture.mjs';

const frozenAt = '2020-01-01T00:00:01.000Z';
function approved(plan) {
  plan.corpus.sourceKind = 'operator-supplied'; plan.corpus.acceptanceSplitFrozen = true;
  refreshSemanticBatchFixtureDigests(plan);
  for (const row of [plan.approvals.corpusRights, plan.approvals.acceptanceSplit, ...plan.approvals.gold, plan.approvals.rules])
    Object.assign(row, { approved: true, reviewedBy: 'Declared fixture operator', reviewedAt: '2020-01-01T00:00:00.000Z', reference: 'Synthetic approval contract test only' });
  return plan;
}
function rejects(change, code) {
  const plan = semanticBatchPlanFixture(); change(plan);
  assert.throws(() => validateSemanticBatchPlan(plan), error => error.code === code);
}
function frozen(value) {
  if (value && typeof value === 'object') { assert.equal(Object.isFrozen(value), true); for (const item of Object.values(value)) frozen(item); }
}

test('batch plan is detached, canonical and frozen without preview timestamps or approval claims', () => {
  const input = semanticBatchPlanFixture(), plan = validateSemanticBatchPlan(input);
  assert.deepEqual(plan, input); assert.notEqual(plan, input); frozen(plan);
  assert.equal(Object.hasOwn(plan, 'frozenAt'), false);
  assert.ok(plan.samples.every(sample => sample.gold.approved === false));
  input.samples[0].segments[0] = 'Changed'; input.assessment.thresholds.entity.precisionMin = 1;
  assert.notEqual(input.samples[0].segments[0], plan.samples[0].segments[0]);
  assert.equal(plan.assessment.thresholds.entity.precisionMin, null);
  const reversed = Object.fromEntries(Object.entries(semanticBatchPlanFixture()).reverse());
  assert.equal(JSON.stringify(validateSemanticBatchPlan(reversed)), JSON.stringify(plan));
});

test('roster has the exact baseline then candidate sample/repetition matrix and safe directories', () => {
  const trials = semanticBatchTrials(semanticBatchPlanFixture());
  assert.equal(trials.length, 8); frozen(trials);
  assert.deepEqual(trials.map(row => row.trialId), ['baseline:qualified:0', 'baseline:qualified:1', 'baseline:empty:0', 'baseline:empty:1',
    'candidate:qualified:0', 'candidate:qualified:1', 'candidate:empty:0', 'candidate:empty:1']);
  assert.deepEqual(trials.map(row => row.directory), ['baseline/trial-0000', 'baseline/trial-0001', 'baseline/trial-0002', 'baseline/trial-0003',
    'candidate/trial-0000', 'candidate/trial-0001', 'candidate/trial-0002', 'candidate/trial-0003']);
  trials.forEach((row, index) => { assert.equal(row.index, index); assert.equal(row.roleIndex, index % 4); assert.equal(row.plan.sample.id, row.sampleId); });
});

test('one shared ceiling sums heterogeneous per-trial bounds without multiplying the ceiling', () => {
  const plan = semanticBatchPlanFixture(); plan.samples[1].segments = ['x'.repeat(6000)]; refreshSemanticBatchFixtureDigests(plan);
  const budget = semanticBatchBudget(plan), trials = semanticBatchTrials(plan);
  assert.equal(budget.ceilingMicros, plan.budget.ceilingMicros);
  assert.deepEqual(budget.maxTrialAttempts, { knowledge: 8, relation: 3 });
  assert.deepEqual(budget.maxAttempts, { knowledge: 48, relation: 24 });
  for (const trial of trials) assert.deepEqual(budget.trialLimits[trial.trialId], semanticCorpusBudget(trial.plan).maxAttempts);
  assert.equal(Object.keys(budget.trialLimits).length, 8); frozen(budget);
});

test('sample, repeat, matrix and time limits reject oversized or nonliteral contracts', () => {
  rejects(plan => { plan.samples = []; }, 'BATCH_SAMPLES_INVALID');
  rejects(plan => { plan.samples = Array(5).fill(plan.samples[0]); }, 'BATCH_SAMPLES_INVALID');
  rejects(plan => { plan.repetitions = 4; }, 'BATCH_TRIAL_LIMIT');
  rejects(plan => { plan.repetitions = -0; }, 'BATCH_TRIAL_LIMIT');
  rejects(plan => { plan.samples = Array(3).fill(plan.samples[0]); plan.repetitions = 3; }, 'BATCH_TRIAL_LIMIT');
  rejects(plan => { plan.batchTimeoutMs = 300001; }, 'BATCH_TIMEOUT_INVALID');
  rejects(plan => { plan.limits.totalTimeoutMs = 15001; }, 'BATCH_TRIAL_TIMEOUT_INVALID');
  rejects(plan => { plan.batchTimeoutMs = 1000; }, 'BATCH_TRIAL_TIMEOUT_INVALID');
  rejects(plan => { plan.samples[1].id = plan.samples[0].id; }, 'BATCH_SAMPLE_IDS_INVALID');
  rejects(plan => { plan.frozenAt = frozenAt; }, 'BATCH_PLAN_KEYS_INVALID');
});

test('all schema layers reject extra fields, accessors, sparse arrays and approval laundering', () => {
  rejects(plan => { plan.samples[0].gold.approved = true; }, 'UNAPPROVED_CORPUS_GOLD_REQUIRED');
  rejects(plan => { plan.assessment.thresholds.entity.other = 1; }, 'BATCH_THRESHOLDS_INVALID');
  rejects(plan => { plan.corpus.other = true; }, 'BATCH_CORPUS_KEYS_INVALID');
  rejects(plan => { plan.approvals.rules.approved = true; }, 'BATCH_APPROVER_INVALID');
  rejects(plan => { plan.approvals.rules.reviewedBy = 'name'; }, 'BATCH_UNAPPROVED_FIELDS_INVALID');
  rejects(plan => { delete plan.samples[0]; }, 'BATCH_SAMPLES_INVALID');
  let accessed = false;
  rejects(plan => { Object.defineProperty(plan.samples, '0', { enumerable: true, get() { accessed = true; throw new Error('Getter invoked'); } }); }, 'BATCH_SAMPLES_INVALID');
  assert.equal(accessed, false);
  rejects(plan => { Object.defineProperty(plan.assessment, 'method', { enumerable: true, get() { accessed = true; throw new Error('Getter invoked'); } }); }, 'BATCH_ASSESSMENT_KEYS_INVALID');
  assert.equal(accessed, false);
});

test('unknown thresholds stay null and finite higher-is-better directions are immutable', () => {
  const plan = validateSemanticBatchPlan(semanticBatchPlanFixture());
  for (const thresholds of Object.values(plan.assessment.thresholds)) assert.ok(Object.values(thresholds).every(value => value === null));
  for (const value of [NaN, Infinity, -1, 1.1, '0.9', -0]) rejects(plan => { plan.assessment.thresholds.fact.precisionMin = value; }, 'BATCH_THRESHOLDS_INVALID');
  rejects(plan => { plan.assessment.directions.recall = 'lower-is-better'; }, 'BATCH_DIRECTIONS_INVALID');
  rejects(plan => { plan.assessment.severeErrorMax = 1; }, 'BATCH_SEVERE_POLICY_INVALID');
  rejects(plan => { plan.assessment.severeErrorTypes.pop(); }, 'BATCH_SEVERE_POLICY_INVALID');
  rejects(plan => { plan.assessment.matchingPolicy = 'best-score-variant'; }, 'BATCH_ASSESSMENT_POLICY_INVALID');
});

test('critical IDs cover each sample variant explicitly and cannot reference missing units', () => {
  const plan = semanticBatchPlanFixture(); plan.assessment.criticalGoldIds.qualified.expected = ['conditional-plan'];
  assert.deepEqual(validateSemanticBatchPlan(plan).assessment.criticalGoldIds.qualified.expected, ['conditional-plan']);
  rejects(plan => { delete plan.assessment.criticalGoldIds.empty; }, 'BATCH_CRITICAL_GOLD_INVALID');
  rejects(plan => { plan.assessment.criticalGoldIds.qualified.expected = ['unknown']; }, 'BATCH_CRITICAL_GOLD_INVALID');
  rejects(plan => { plan.assessment.criticalGoldIds.qualified.expected = ['atlas', 'atlas']; }, 'BATCH_CRITICAL_GOLD_INVALID');
  rejects(plan => { plan.assessment.criticalGoldIds.empty.expected = ['atlas']; }, 'BATCH_CRITICAL_GOLD_INVALID');
});

test('approval checking requires real corpus/split declarations and actual collection freeze time', () => {
  const missing = validateBatchApprovals(semanticBatchPlanFixture(), frozenAt);
  assert.equal(missing.complete, false); assert.equal(missing.status, 'not_run');
  assert.ok(missing.issues.includes('operator_corpus_required'));
  assert.ok(missing.issues.includes('acceptance_split_not_frozen'));
  const plan = approved(semanticBatchPlanFixture());
  assert.equal(validateBatchApprovals(plan, frozenAt).complete, true);
  assert.equal(validateBatchApprovals(plan, undefined).complete, false);
  plan.approvals.gold[0].reviewedAt = '2020-01-01T00:00:02.000Z';
  assert.ok(validateBatchApprovals(plan, frozenAt).issues.includes('gold:qualified:approval_after_freeze'));
});

test('approval digests bind exact sample, gold and assessment without changing inner gold marker', () => {
  for (const [change, issue] of [
    [plan => { plan.samples[0].segments[0] += ' changed'; }, 'gold:qualified:digest_mismatch'],
    [plan => { plan.samples[0].gold.variants[0].units[0].meaning += ' changed'; }, 'gold:qualified:digest_mismatch'],
    [plan => { plan.assessment.thresholds.entity.precisionMin = 0.9; }, 'rules:digest_mismatch']
  ]) {
    const plan = approved(semanticBatchPlanFixture()); change(plan);
    const result = validateBatchApprovals(plan, frozenAt); assert.equal(result.complete, false); assert.ok(result.issues.includes(issue));
    assert.equal(plan.samples[0].gold.approved, false);
  }
  const plan = approved(semanticBatchPlanFixture());
  assert.equal(plan.approvals.rules.rulesDigest, contractDigest(plan.assessment));
  plan.approvals.gold[1] = structuredClone(plan.approvals.gold[0]);
  assert.throws(() => validateSemanticBatchPlan(plan), /BATCH_GOLD_APPROVALS_INVALID/);
});

test('batch arithmetic rejects overflow even when one trial fits safely', () => {
  const plan = semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 1 });
  plan.budget.attemptMicros = { knowledge: 1000000000000000, relation: 1000000000000000 };
  assert.throws(() => validateSemanticBatchPlan(plan), /BATCH_BUDGET_OVERFLOW/);
});

test('sample plans are shared only inside one call and remain deeply frozen', () => {
  const input = semanticBatchPlanFixture(), first = semanticBatchTrials(input);
  assert.equal(first[0].plan, first[1].plan); assert.equal(first[0].plan, first[4].plan);
  assert.notEqual(first[0].plan, first[2].plan); frozen(first);
  input.samples[0].segments[0] += ' Later caller change.';
  const second = semanticBatchTrials(input);
  assert.notEqual(first[0].plan, second[0].plan);
  assert.notEqual(first[0].plan.sample.segments[0], second[0].plan.sample.segments[0]);
  assert.equal(second[0].plan.sample.segments[0], input.samples[0].segments[0]);
});

test('budget and roster revalidate every call, including accessors added after successful use', () => {
  for (const operation of [semanticBatchTrials, semanticBatchBudget]) {
    const input = semanticBatchPlanFixture(); operation(input);
    let accessed = false;
    Object.defineProperty(input.samples[0], 'segments', { enumerable: true, get() { accessed = true; throw new Error('Getter invoked'); } });
    assert.throws(() => operation(input), /CORPUS_SAMPLE_KEYS_INVALID/); assert.equal(accessed, false);
  }
  const input = semanticBatchPlanFixture(), first = semanticBatchBudget(input);
  input.samples[0].segments = ['x'.repeat(6000)];
  const second = semanticBatchBudget(input);
  assert.deepEqual(first.maxAttempts, { knowledge: 32, relation: 24 });
  assert.deepEqual(second.maxAttempts, { knowledge: 48, relation: 24 });
  assert.equal(second.trialLimits['baseline:qualified:0'].knowledge, 8);
});
