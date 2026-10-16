import test from 'node:test';
import assert from 'node:assert/strict';
import { contractDigest } from '../scripts/lib/quality-contract.mjs';
import { semanticUnits } from '../scripts/lib/semantic-quality-capture.mjs';
import { assessSemanticReview, createSemanticReviewTemplate, semanticSevereErrorTypes } from '../scripts/lib/semantic-quality-review.mjs';
import { semanticBatchTrials } from '../scripts/lib/semantic-quality-batch-plan.mjs';
import { assessSemanticBatch } from '../scripts/lib/semantic-quality-batch-assessment.mjs';
import { semanticBatchPlanFixture, refreshSemanticBatchFixtureDigests } from '../test-support/semantic-batch-plan-fixture.mjs';

// Entirely in-memory, predetermined annotations. No collected evidence, model
// calls, authenticated reviewer, or actual quality acceptance is represented.
const frozenAt = '2020-01-01T00:00:00.000Z';
const options = { frozenAt, evidenceKind: 'offline-corpus-provider-output', infrastructurePassed: true };
function assessmentFor(sample, reviewers, { omit = [], extras = 0, severe = null, variantId = 'expected' } = {}) {
  const variant = sample.gold.variants.find(variant => variant.id === variantId), missing = new Set(omit);
  const gold = variant.units.filter(unit => !missing.has(unit.id));
  const entities = gold.filter(unit => unit.kind === 'entity');
  const entityIds = new Set(entities.map(unit => unit.id));
  const facts = gold.filter(unit => unit.kind === 'fact' && entityIds.has(unit.owner));
  const relations = gold.filter(unit => unit.kind === 'relation' && entityIds.has(unit.subject) && entityIds.has(unit.object));
  const tables = { segments: sample.segments.map((original_text, index) => ({ id: `source-${index}`, sequence_no: index + 1, original_text })),
    knowledge_items: entities.map(unit => ({ id: unit.id, canonical_name: unit.meaning })),
    knowledge_mentions: entities.map(unit => ({ item_id: unit.id, segment_id: 'source-0', surface_text: unit.meaning })), knowledge_aliases: [],
    knowledge_facts: facts.map(unit => ({ id: unit.id, item_id: unit.owner, segment_id: 'source-0', surface_text: unit.meaning, content: unit.meaning })),
    relations: relations.map(unit => ({ id: `edge-${unit.id}`, subject_item_id: unit.subject, object_item_id: unit.object, predicate: 'related' })),
    relation_assertions: relations.map(unit => ({ id: unit.id, relation_id: `edge-${unit.id}`, polarity: 'positive', modality: 'asserted', conditions: null })),
    relation_supports: relations.map(unit => ({ id: `support-${unit.id}`, assertion_id: unit.id, segment_id: 'source-0', quote: unit.meaning })) };
  for (let index = 0; index < extras; index++) tables.knowledge_facts.push({ ...tables.knowledge_facts[0], id: `extra-${index}` });
  const after = { integrity: ['ok'], foreignKeys: [], tables };
  const capture = { schemaVersion: 1, kind: 'offline-semantic-capture', mode: 'offline', evidenceKind: 'offline-corpus-provider-output',
    pipeline: 'knowledge-then-relation-cascade', qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false,
    complete: true, cleanup: true, liveCalls: 0, errors: [], calls: [], sample, sampleDigest: contractDigest(sample),
    startedAt: '2020-01-01T00:00:01.000Z', finishedAt: '2020-01-01T00:00:02.000Z', after, units: semanticUnits(after) };
  const review = createSemanticReviewTemplate(capture, { reviewers });
  review.reviewer = reviewers[0]; review.reviewedAt = '2020-01-01T00:00:03.000Z'; review.selectedVariantId = variantId;
  for (const row of review.rows) {
    row.goldId = row.output.value.id.startsWith('extra-') ? null : row.output.value.id;
    row.severe = Object.fromEntries(semanticSevereErrorTypes.map(type => [type, false]));
    row.reviewer = review.reviewer; row.reviewedAt = review.reviewedAt; row.notes = 'Predetermined synthetic annotation; not a real reviewer.';
  }
  if (severe) {
    const row = severe === 'duplicate' ? review.rows.find(row => row.goldId === null) : review.rows[0];
    assert.ok(row); row.severe[severe] = true;
    if (severe === 'duplicate') row.duplicateOf = review.rows.find(other => other.output.kind === row.output.kind && other.goldId !== null).outputId;
  }
  const matched = new Set(review.rows.map(row => row.goldId));
  review.missingGoldIds = variant.units.filter(unit => !matched.has(unit.id)).map(unit => unit.id);
  const result = assessSemanticReview(capture, review, { reviewers });
  assert.equal(result.contractValid, true, JSON.stringify(result));
  return result;
}
function rowsFor(plan, customize = () => ({})) {
  return semanticBatchTrials(plan).map(trial => ({ role: trial.role, sampleId: trial.sampleId, repetition: trial.repetition,
    trialId: trial.trialId, assessment: assessmentFor(trial.plan.sample, plan.reviewers, customize(trial)) }));
}
function lenient(plan) {
  for (const thresholds of Object.values(plan.assessment.thresholds)) Object.assign(thresholds,
    { precisionMin: 0, recallMin: 0, precisionRegressionMax: 1, recallRegressionMax: 1 });
  return refreshSemanticBatchFixtureDigests(plan);
}
function approved(plan) {
  plan.corpus.sourceKind = 'operator-supplied'; plan.corpus.acceptanceSplitFrozen = true; refreshSemanticBatchFixtureDigests(plan);
  for (const row of [plan.approvals.corpusRights, plan.approvals.acceptanceSplit, ...plan.approvals.gold, plan.approvals.rules])
    Object.assign(row, { approved: true, reviewedBy: 'Declared test operator', reviewedAt: '2019-12-31T23:59:59.000Z', reference: 'Synthetic declaration test' });
  return plan;
}
function boundary(result) { assert.equal(result.fullQualityAcceptance, false); assert.equal(result.releaseEligible, false); }

test('complete frozen offline matrix can pass rules but never model-quality acceptance', () => {
  const plan = semanticBatchPlanFixture({ thresholds: 1 }), rows = rowsFor(plan);
  const result = assessSemanticBatch(plan, rows, options); boundary(result);
  assert.equal(result.complete, true); assert.equal(result.contractValid, true); assert.equal(result.ruleDecision, 'passed');
  assert.equal(result.qualityStatus, 'not_run'); assert.equal(result.qualityEvaluated, false); assert.equal(result.evidenceScope, 'offline-simulation');
  assert.equal(result.pairs.length, 4); assert.equal(result.trialCount, 8); assert.deepEqual(result.failures, []);
  assert.equal(result.micro.metrics.entity.candidate.truePositives, 6);
  assert.deepEqual(assessSemanticBatch(plan, [...rows].reverse(), options), result);
});

test('null thresholds are not_run rather than invented or incomplete', () => {
  const plan = semanticBatchPlanFixture(), result = assessSemanticBatch(plan, rowsFor(plan), options);
  assert.equal(result.complete, true); assert.equal(result.ruleDecision, 'not_run'); assert.ok(result.issues.includes('BATCH_THRESHOLDS_NOT_FROZEN'));
  assert.equal(result.qualityStatus, 'not_run'); boundary(result);
});

test('missing, duplicated, relabeled and incomplete reviews fail the exact matrix', () => {
  const plan = semanticBatchPlanFixture({ thresholds: 1 }), original = rowsFor(plan);
  for (const change of [
    rows => rows.pop(), rows => { rows[0] = structuredClone(rows[1]); },
    rows => { rows[0].role = 'candidate'; }, rows => { rows[0].sampleId = 'empty'; },
    rows => { rows[0].repetition = 10; }, rows => { rows[0].assessment.contractValid = false; },
    rows => { rows[0].assessment.complete = false; }, rows => { rows[0].assessment.sampleDigest = 'a'.repeat(64); },
    rows => { rows[0].assessment.metrics.entity.precision = 0.1; }, rows => { rows[0].assessment.reviewer = 'undeclared'; }
  ]) {
    const rows = structuredClone(original); change(rows); const result = assessSemanticBatch(plan, rows, options);
    assert.equal(result.ruleDecision, 'incomplete'); assert.equal(result.complete, false); assert.equal(result.qualityStatus, 'not_run'); boundary(result);
  }
});

test('same-pair gold variants cannot be chosen independently for a higher score', () => {
  const plan = semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 1, thresholds: 1 });
  plan.samples[0].gold.variants.push({ ...structuredClone(plan.samples[0].gold.variants[0]), id: 'alternate' });
  plan.assessment.criticalGoldIds.qualified.alternate = []; refreshSemanticBatchFixtureDigests(plan);
  const rows = rowsFor(plan, trial => trial.role === 'candidate' ? { variantId: 'alternate' } : {});
  const result = assessSemanticBatch(plan, rows, options);
  assert.equal(result.ruleDecision, 'incomplete'); assert.ok(result.issues.includes('BATCH_PAIR_VARIANT_MISMATCH'));
});

test('valid annotations with tolerated omissions need not have offlineReviewPassed', () => {
  const plan = lenient(semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 1 }));
  const rows = rowsFor(plan, trial => trial.role === 'candidate' ? { omit: ['atlas-fact'] } : {});
  assert.equal(rows[1].assessment.offlineReviewPassed, false); assert.equal(rows[1].assessment.contractValid, true);
  const result = assessSemanticBatch(plan, rows, options); assert.equal(result.ruleDecision, 'passed'); assert.equal(result.pairs[0].metrics.fact.candidate.recall, 2 / 3);
});

test('micro scores aggregate counts, and every individual pair must also pass', () => {
  const plan = lenient(semanticBatchPlanFixture({ sampleIds: ['qualified', 'independent'], repetitions: 1 }));
  plan.assessment.thresholds.fact.precisionMin = 0.6; refreshSemanticBatchFixtureDigests(plan);
  const rows = rowsFor(plan, trial => trial.role === 'candidate' && trial.sampleId === 'qualified' ? { extras: 3 } : {});
  const result = assessSemanticBatch(plan, rows, options);
  assert.equal(result.micro.metrics.fact.candidate.precision, 6 / 9);
  assert.notEqual(result.micro.metrics.fact.candidate.precision, (0.5 + 1) / 2);
  assert.equal(result.micro.failures.length, 0); assert.equal(result.ruleDecision, 'failed');
  assert.ok(result.failures.some(failure => failure.scope === 'pair' && failure.sampleId === 'qualified' && failure.reason === 'minimum_not_met'));
});

for (const type of semanticSevereErrorTypes) test(`candidate ${type} errors veto even lenient rates`, () => {
  const plan = lenient(semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 1 }));
  const rows = rowsFor(plan, trial => trial.role === 'candidate' ? { severe: type, extras: type === 'duplicate' ? 1 : 0 } : {});
  const result = assessSemanticBatch(plan, rows, options);
  assert.equal(result.ruleDecision, 'failed'); assert.ok(result.failures.some(failure => failure.reason === 'severe_error' && failure.type === type)); boundary(result);
});

test('a critical omission vetoes high aggregate scores and permissive recall tolerances', () => {
  const plan = lenient(semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 1 }));
  plan.assessment.criticalGoldIds.qualified.expected = ['conditional-plan']; refreshSemanticBatchFixtureDigests(plan);
  const rows = rowsFor(plan, trial => trial.role === 'candidate' ? { omit: ['conditional-plan'] } : {});
  const result = assessSemanticBatch(plan, rows, options);
  assert.equal(result.ruleDecision, 'failed'); assert.deepEqual(result.pairs[0].criticalMissingGoldIds, ['conditional-plan']);
  assert.ok(result.failures.some(failure => failure.reason === 'critical_gold_missing'));
});

test('empty gold and output retain null denominators; nonempty gold cannot become valid_empty', () => {
  const plan = semanticBatchPlanFixture({ sampleIds: ['empty'], repetitions: 1, thresholds: 1 });
  const result = assessSemanticBatch(plan, rowsFor(plan), options);
  assert.equal(result.ruleDecision, 'passed'); assert.equal(result.coverageComplete, false);
  for (const metric of Object.values(result.micro.metrics)) {
    assert.equal(metric.status, 'valid_empty'); assert.equal(metric.candidate.precision, null); assert.equal(metric.candidate.recallDenominator, null);
  }
  const nonempty = lenient(semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 1 }));
  const missing = nonempty.samples[0].gold.variants[0].units.map(unit => unit.id);
  const scored = assessSemanticBatch(nonempty, rowsFor(nonempty, trial => trial.role === 'candidate' ? { omit: missing } : {}), options);
  assert.equal(scored.ruleDecision, 'failed'); assert.equal(scored.pairs[0].metrics.relation.candidate.recall, 0);
  assert.equal(scored.pairs[0].metrics.relation.candidate.goldCount, 2);
  assert.ok(scored.failures.some(failure => failure.reason === 'metric_unavailable'));
});

test('repeat variation retains each repetition and lower performance cannot be averaged away', () => {
  const plan = lenient(semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 2 }));
  plan.assessment.thresholds.fact.recallMin = 0.8; refreshSemanticBatchFixtureDigests(plan);
  const rows = rowsFor(plan, trial => trial.role === 'candidate' && trial.repetition === 1 ? { omit: ['atlas-fact'] } : {});
  const result = assessSemanticBatch(plan, rows, options);
  assert.equal(result.micro.metrics.fact.candidate.recall, 5 / 6); assert.equal(result.ruleDecision, 'failed');
  const variation = result.repeatVariation.find(row => row.role === 'candidate');
  assert.deepEqual(variation.metrics.fact.recall.values, [1, 2 / 3]);
  assert.equal(variation.metrics.fact.recall.range, 1 - 2 / 3);
});

test('only actual evidence with all pre-freeze declarations and complete human inputs can expose bounded quality status', () => {
  const plan = approved(semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 1, thresholds: 1 }));
  const rows = rowsFor(plan), realOptions = { ...options, evidenceKind: 'actual-upstream' };
  const result = assessSemanticBatch(plan, rows, realOptions);
  assert.equal(result.qualityStatus, 'passed'); assert.equal(result.qualityEvaluated, true); assert.equal(result.evidenceScope, 'finite-operator-corpus'); boundary(result);
  for (const altered of [{ ...realOptions, infrastructurePassed: false }, { ...realOptions, frozenAt: '2020-01-01T00:00:04.000Z' },
    { ...realOptions, evidenceKind: 'test-transport' }]) assert.equal(assessSemanticBatch(plan, rows, altered).qualityStatus, 'not_run');
  plan.approvals.rules.reviewedAt = '2020-01-01T00:00:01.000Z';
  assert.equal(assessSemanticBatch(plan, rows, realOptions).qualityStatus, 'not_run');
  plan.approvals.rules.reviewedAt = '2019-12-31T23:59:59.000Z'; plan.approvals.rules.rulesDigest = 'a'.repeat(64);
  assert.equal(assessSemanticBatch(plan, rows, realOptions).qualityStatus, 'not_run');
});

test('eligible bounded quality failure remains a failure; zero-kind gold coverage stays not_run', () => {
  const plan = approved(semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 1, thresholds: 1 }));
  const failed = assessSemanticBatch(plan, rowsFor(plan, trial => trial.role === 'candidate' ? { severe: 'number' } : {}), { ...options, evidenceKind: 'actual-upstream' });
  assert.equal(failed.qualityStatus, 'failed'); assert.equal(failed.qualityEvaluated, true); boundary(failed);
  const empty = approved(semanticBatchPlanFixture({ sampleIds: ['empty'], repetitions: 1, thresholds: 1 }));
  const result = assessSemanticBatch(empty, rowsFor(empty), { ...options, evidenceKind: 'actual-upstream' });
  assert.equal(result.ruleDecision, 'passed'); assert.equal(result.qualityStatus, 'not_run'); assert.ok(result.issues.includes('BATCH_GOLD_KIND_COVERAGE_MISSING'));
});


test('regression tolerances independently veto otherwise adequate candidate minima', () => {
  const plan = lenient(semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 1 }));
  plan.assessment.thresholds.fact.recallMin = 0.5;
  plan.assessment.thresholds.fact.recallRegressionMax = 0.25; refreshSemanticBatchFixtureDigests(plan);
  const rows = rowsFor(plan, trial => trial.role === 'candidate' ? { omit: ['atlas-fact'] } : {});
  const result = assessSemanticBatch(plan, rows, options);
  assert.equal(result.ruleDecision, 'failed');
  assert.ok(result.failures.some(failure => failure.reason === 'regression_exceeded' && failure.measure === 'recall'));
  assert.ok(!result.failures.some(failure => failure.reason === 'minimum_not_met'));
  plan.assessment.thresholds.fact.recallRegressionMax = 1 / 3;
  assert.equal(assessSemanticBatch(plan, rows, options).ruleDecision, 'passed');
});

test('baseline severe annotations do not falsely veto an improved clean candidate', () => {
  const plan = semanticBatchPlanFixture({ sampleIds: ['qualified'], repetitions: 1, thresholds: 1 });
  const rows = rowsFor(plan, trial => trial.role === 'baseline' ? { severe: 'number' } : {});
  assert.equal(rows[0].assessment.offlineReviewPassed, false);
  assert.equal(assessSemanticBatch(plan, rows, options).ruleDecision, 'passed');
});
