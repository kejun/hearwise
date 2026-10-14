import test from 'node:test';
import assert from 'node:assert/strict';
import { contractDigest } from '../scripts/lib/quality-contract.mjs';
import { semanticUnits } from '../scripts/lib/semantic-quality-capture.mjs';
import { createSemanticReviewTemplate, assessSemanticReview, semanticSevereErrorTypes } from '../scripts/lib/semantic-quality-review.mjs';
import { semanticFixtureSample } from '../test-support/semantic-quality-fixture.mjs';

// Pure, in-memory contract fixtures. These are NOT collection artifacts, actual
// human reviews, approved gold, or real model quality passes. Nothing is saved.
const reviewers = ['fixture-reviewer (not a person)'];
const reviewedAt = '2020-01-01T00:00:02.000Z';
const options = { reviewers };
const fixtureMatches = {
  'entity:item-atlas': 'atlas', 'entity:item-nova': 'nova', 'entity:item-orion': 'orion',
  'fact:fact-atlas': 'atlas-fact', 'fact:fact-nova': 'nova-fact', 'fact:fact-orion': 'orion-fact',
  'relation:assert-denied': 'denied-payment', 'relation:assert-planned': 'conditional-plan'
};
function fixtureCapture(id = 'qualified') {
  const sample = semanticFixtureSample(id);
  const segments = sample.segments.map((original_text, index) => ({ id: `segment-${index}`, sequence_no: index + 1, original_text }));
  const items = sample.names.map(name => ({ id: `item-${name.toLowerCase()}`, canonical_name: name, short_description: `${name}: independent entity` }));
  const tables = {
    segments, knowledge_items: items,
    knowledge_mentions: items.map(item => ({ item_id: item.id, segment_id: 'segment-0', surface_text: item.canonical_name })),
    knowledge_aliases: [],
    knowledge_facts: items.map(item => ({ id: `fact-${item.canonical_name.toLowerCase()}`, item_id: item.id, segment_id: 'segment-0',
      surface_text: item.canonical_name, content: item.canonical_name === 'Atlas' && id === 'qualified'
        ? 'No fifteen-dollar purchase occurred; a twenty-dollar purchase requires approval.' : `${item.canonical_name} appears independently.` })),
    relations: id === 'qualified' ? [{ id: 'edge-acquired', subject_item_id: 'item-atlas', object_item_id: 'item-nova', predicate: 'acquired' }] : [],
    relation_assertions: id === 'qualified' ? [
      { id: 'assert-denied', relation_id: 'edge-acquired', polarity: 'negative', modality: 'asserted', conditions: null },
      { id: 'assert-planned', relation_id: 'edge-acquired', polarity: 'positive', modality: 'planned', conditions: 'If approved' }
    ] : [],
    relation_supports: id === 'qualified' ? ['denied', 'planned'].map(name => ({ id: `support-${name}`, assertion_id: `assert-${name}`,
      segment_id: 'segment-0', quote: sample.segments[0] })) : []
  };
  const after = { integrity: ['ok'], foreignKeys: [], tables };
  return { schemaVersion: 1, kind: 'offline-semantic-capture', mode: 'offline', evidenceKind: 'synthetic-provider-output',
    pipeline: 'knowledge-then-relation-cascade', qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false,
    complete: true, cleanup: true, liveCalls: 0, errors: [], calls: [], sample, sampleDigest: contractDigest(sample),
    startedAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:00:01.000Z', after, units: structuredClone(semanticUnits(after)) };
}
function refresh(capture) {
  capture.sampleDigest = contractDigest(capture.sample); capture.units = structuredClone(semanticUnits(capture.after)); return capture;
}
function fixtureReview(capture, matches = fixtureMatches, variantId = 'expected') {
  const review = createSemanticReviewTemplate(capture, options);
  review.reviewer = reviewers[0]; review.reviewedAt = reviewedAt; review.selectedVariantId = variantId;
  for (const row of review.rows) {
    row.goldId = matches[row.outputId] ?? null;
    row.severe = Object.fromEntries(semanticSevereErrorTypes.map(type => [type, false]));
    row.notes = 'Synthetic annotation test data; no human approval.';
    row.reviewer = review.reviewer; row.reviewedAt = review.reviewedAt;
  }
  const matched = new Set(review.rows.map(row => row.goldId));
  review.missingGoldIds = capture.sample.gold.variants.find(row => row.id === variantId).units.filter(row => !matched.has(row.id)).map(row => row.id);
  return review;
}
function assertOffline(result) {
  assert.equal(result.qualityStatus, 'not_run'); assert.equal(result.qualityEvaluated, false);
  assert.equal(result.fullQualityAcceptance, false); assert.equal(result.releaseEligible, false);
}
function assess(capture, review = fixtureReview(capture)) {
  const result = assessSemanticReview(capture, review, options); assertOffline(result); return result;
}
function rejected(capture, review, code) {
  const result = assess(capture, review);
  assert.equal(result.complete, false); assert.equal(result.contractValid, false); assert.equal(result.offlineReviewPassed, false);
  assert.equal(result.metrics, null); assert.ok(result.issues.includes(code), JSON.stringify(result));
}

test('template binds full raw units, aliases, owners, sources and all gold variants without filling decisions', () => {
  const capture = fixtureCapture(), template = createSemanticReviewTemplate(capture, options);
  assert.equal(template.captureDigest, contractDigest(capture)); assert.equal(template.sampleDigest, capture.sampleDigest);
  assert.deepEqual(template.sample, capture.sample); assert.equal(template.sample.gold.approved, false);
  assert.deepEqual(template.rows.map(row => row.output), capture.units);
  assert.equal(template.reviewer, null); assert.equal(template.reviewedAt, null); assert.equal(template.selectedVariantId, null);
  assert.equal(template.missingGoldIds, null);
  assert.ok(template.rows.every(row => row.goldId === null && row.duplicateOf === null && Object.values(row.severe).every(flag => flag === null)));
  template.sample.segments[0] = 'changed'; template.rows[0].output.value.canonical_name = 'changed';
  assert.notEqual(template.sample.segments[0], capture.sample.segments[0]);
  assert.notEqual(template.rows[0].output.value.canonical_name, capture.units[0].value.canonical_name);
});

test('positive reference shape counts explicit manual ID matches, never exact prose similarity', () => {
  const capture = fixtureCapture(), review = fixtureReview(capture), result = assess(capture, review);
  assert.notEqual(review.rows.find(row => row.outputId === 'fact:fact-atlas').output.value.content,
    capture.sample.gold.variants[0].units.find(row => row.id === 'atlas-fact').meaning);
  assert.equal(result.complete, true); assert.equal(result.contractValid, true); assert.equal(result.offlineReviewPassed, true);
  assert.equal(result.offlineReviewStatus, 'passed'); assert.deepEqual(result.failures, []);
  assert.equal(result.reviewDigest, contractDigest(review));
  for (const [kind, count] of [['entity', 3], ['fact', 3], ['relation', 2]]) {
    assert.deepEqual(result.metrics[kind], { status: 'scored', outputCount: count, goldCount: count, truePositives: count,
      falsePositives: 0, falseNegatives: 0, precision: 1, recall: 1, precisionDenominator: count, recallDenominator: count });
  }
});

test('an untouched template is incomplete rather than assumed reviewed', () => {
  const capture = fixtureCapture(); rejected(capture, createSemanticReviewTemplate(capture, options), 'REVIEWER_INVALID');
});

test('both-empty categories have valid_empty status and null rates/denominators', () => {
  const capture = fixtureCapture('empty'), result = assess(capture);
  assert.equal(result.contractValid, true); assert.equal(result.offlineReviewPassed, true);
  for (const metric of Object.values(result.metrics)) assert.deepEqual(metric, { status: 'valid_empty', outputCount: 0, goldCount: 0,
    truePositives: 0, falsePositives: 0, falseNegatives: 0, precision: null, recall: null, precisionDenominator: null, recallDenominator: null });
});

test('independent items keep relation valid_empty without hiding entity/fact denominators', () => {
  const result = assess(fixtureCapture('independent'));
  assert.equal(result.offlineReviewPassed, true); assert.equal(result.metrics.relation.status, 'valid_empty');
  assert.equal(result.metrics.entity.goldCount, 3); assert.equal(result.metrics.fact.goldCount, 3);
});

test('nonempty gold with no outputs scores recall zero for every category', () => {
  const capture = fixtureCapture();
  for (const key of Object.keys(capture.after.tables)) if (key !== 'segments') capture.after.tables[key] = [];
  refresh(capture);
  const result = assess(capture);
  assert.equal(result.contractValid, true); assert.equal(result.offlineReviewPassed, false);
  for (const metric of Object.values(result.metrics)) {
    assert.equal(metric.status, 'scored'); assert.equal(metric.recall, 0); assert.equal(metric.precision, null);
    assert.equal(metric.precisionDenominator, null); assert.ok(metric.recallDenominator > 0);
  }
  assert.equal(result.failures.filter(row => row.reason === 'missing_gold').length, 8);
});

test('upstream entity omission cannot remove full relation gold or turn its recall into N/A', () => {
  const capture = fixtureCapture(), tables = capture.after.tables;
  tables.knowledge_items = tables.knowledge_items.filter(row => row.id === 'item-atlas');
  tables.knowledge_mentions = tables.knowledge_mentions.filter(row => row.item_id === 'item-atlas');
  tables.knowledge_facts = tables.knowledge_facts.filter(row => row.item_id === 'item-atlas');
  tables.relations = []; tables.relation_assertions = []; tables.relation_supports = []; refresh(capture);
  const result = assess(capture);
  assert.equal(result.contractValid, true); assert.equal(result.offlineReviewPassed, false);
  assert.equal(result.metrics.entity.recall, 1 / 3); assert.equal(result.metrics.fact.recall, 1 / 3);
  assert.equal(result.metrics.relation.goldCount, 2); assert.equal(result.metrics.relation.recall, 0);
  assert.equal(result.metrics.relation.recallDenominator, 2); assert.equal(result.metrics.relation.status, 'scored');
});

test('nonempty output against an empty gold variant is scored, never valid_empty', () => {
  const capture = fixtureCapture(); capture.sample.gold.variants[0].units = []; refresh(capture);
  const result = assess(capture, fixtureReview(capture, {}));
  assert.equal(result.contractValid, true); assert.equal(result.offlineReviewPassed, false);
  for (const metric of Object.values(result.metrics)) {
    assert.equal(metric.status, 'scored'); assert.equal(metric.precision, 0); assert.equal(metric.recall, null);
    assert.equal(metric.recallDenominator, null); assert.ok(metric.precisionDenominator > 0);
  }
});

for (const type of semanticSevereErrorTypes.filter(type => type !== 'duplicate')) test(`${type} severe flag independently vetoes otherwise perfect matches`, () => {
  const capture = fixtureCapture(), review = fixtureReview(capture); review.rows[0].severe[type] = true;
  const result = assess(capture, review);
  assert.equal(result.contractValid, true); assert.equal(result.offlineReviewPassed, false); assert.equal(result.offlineReviewStatus, 'failed');
  assert.ok(Object.values(result.metrics).every(metric => metric.precision === 1 && metric.recall === 1));
  assert.deepEqual(result.failures, [{ reason: 'severe_error', outputId: review.rows[0].outputId, types: [type] }]);
});

function duplicateFixture() {
  const capture = fixtureCapture();
  capture.after.tables.knowledge_facts.push({ ...capture.after.tables.knowledge_facts[0], id: 'fact-atlas-repeat',
    content: 'A paraphrase can still duplicate the same fact.' }); refresh(capture);
  const review = fixtureReview(capture), duplicate = review.rows.find(row => row.outputId === 'fact:fact-atlas-repeat');
  duplicate.severe.duplicate = true; duplicate.duplicateOf = 'fact:fact-atlas';
  return { capture, review, duplicate };
}

test('duplicate paraphrase needs a different actual output ID and contributes a false positive', () => {
  const { capture, review } = duplicateFixture(), result = assess(capture, review);
  assert.equal(result.contractValid, true); assert.equal(result.offlineReviewPassed, false);
  assert.equal(result.metrics.fact.outputCount, 4); assert.equal(result.metrics.fact.truePositives, 3);
  assert.equal(result.metrics.fact.precision, 3 / 4); assert.equal(result.metrics.fact.recall, 1);
  assert.ok(result.failures.some(row => row.reason === 'severe_error' && row.types.includes('duplicate')));
});
for (const [name, change] of [
  ['missing reference', row => { row.duplicateOf = null; }],
  ['unknown reference', row => { row.duplicateOf = 'fact:unknown'; }],
  ['self reference', row => { row.duplicateOf = row.outputId; }],
  ['other kind', row => { row.duplicateOf = 'entity:item-atlas'; }],
  ['matched duplicate', row => { row.goldId = 'atlas-fact'; }]
]) test(`reject duplicate ${name}`, () => {
  const { capture, review, duplicate } = duplicateFixture(); change(duplicate);
  rejected(capture, review, name === 'matched duplicate' ? 'GOLD_MATCH_INVALID' : 'DUPLICATE_REFERENCE_INVALID');
});

test('only one complete variant can be selected; gold cannot be pooled across variants', () => {
  const capture = fixtureCapture(), other = structuredClone(capture.sample.gold.variants[0]); other.id = 'alternate';
  for (const unit of other.units) {
    unit.id = `other-${unit.id}`;
    for (const key of ['owner', 'subject', 'object']) if (unit[key]) unit[key] = `other-${unit[key]}`;
  }
  capture.sample.gold.variants.push(other); refresh(capture);
  const otherMatches = Object.fromEntries(Object.entries(fixtureMatches).map(([key, value]) => [key, `other-${value}`]));
  const review = fixtureReview(capture, otherMatches, 'alternate');
  assert.equal(assess(capture, review).offlineReviewPassed, true);
  review.rows[0].goldId = 'atlas'; rejected(capture, review, 'GOLD_MATCH_INVALID');
});

for (const [name, mutate, code] of [
  ['unknown reviewer', r => { r.reviewer = 'someone else'; }, 'REVIEWER_INVALID'],
  ['changed reviewer roster', r => { r.reviewers.push('someone else'); }, 'REVIEWERS_CHANGED'],
  ['row reviewer differs', r => { r.rows[0].reviewer = 'someone else'; }, 'ROW_REVIEWER_TIME_MISMATCH'],
  ['row timestamp differs', r => { r.rows[0].reviewedAt = '2020-01-01T00:00:03.000Z'; }, 'ROW_REVIEWER_TIME_MISMATCH'],
  ['review before capture', r => { r.reviewedAt = '2019-01-01T00:00:00.000Z'; }, 'REVIEW_TIME_INVALID'],
  ['review in future', r => { r.reviewedAt = '2999-01-01T00:00:00.000Z'; }, 'REVIEW_TIME_INVALID'],
  ['impossible calendar time', r => { r.reviewedAt = '2020-02-31T00:00:00.000Z'; }, 'REVIEW_TIME_INVALID'],
  ['missing reviewer time', r => { r.reviewedAt = null; }, 'REVIEW_TIME_INVALID'],
  ['missing variant', r => { r.selectedVariantId = null; }, 'GOLD_VARIANT_REQUIRED'],
  ['unknown variant', r => { r.selectedVariantId = 'unknown'; }, 'GOLD_VARIANT_REQUIRED'],
  ['omitted output', r => { r.rows.pop(); }, 'OUTPUT_COVERAGE_INVALID'],
  ['added output', r => { r.rows.push(structuredClone(r.rows[0])); }, 'OUTPUT_COVERAGE_INVALID'],
  ['repeated output ID', r => { r.rows[1] = structuredClone(r.rows[0]); }, 'OUTPUT_ID_INVALID'],
  ['unknown output ID', r => { r.rows[0].outputId = 'entity:unknown'; }, 'OUTPUT_ID_INVALID'],
  ['changed raw output', r => { r.rows[0].output.value.canonical_name = 'forged'; }, 'DISPLAYED_OUTPUT_CHANGED'],
  ['hidden output aliases', r => { delete r.rows[0].output.aliases; }, 'DISPLAYED_OUTPUT_CHANGED'],
  ['changed owner', r => { r.rows[3].output.owner.canonical_name = 'forged'; }, 'DISPLAYED_OUTPUT_CHANGED'],
  ['changed source quotation', r => { r.rows[0].output.sources[0].surface_text = 'forged'; }, 'DISPLAYED_OUTPUT_CHANGED'],
  ['missing source', r => { r.rows[0].output.sources = []; }, 'DISPLAYED_OUTPUT_CHANGED'],
  ['changed sample source', r => { r.sample.segments[0] = 'forged'; }, 'DISPLAYED_SAMPLE_CHANGED'],
  ['hidden gold', r => { r.sample.gold.variants[0].units.pop(); }, 'DISPLAYED_SAMPLE_CHANGED'],
  ['changed gold meaning', r => { r.sample.gold.variants[0].units[0].meaning = 'forged'; }, 'DISPLAYED_SAMPLE_CHANGED'],
  ['changed gold alternatives', r => { r.sample.gold.variants[0].units[0].alternatives = []; }, 'DISPLAYED_SAMPLE_CHANGED'],
  ['unknown gold ID', r => { r.rows[0].goldId = 'unknown'; }, 'GOLD_MATCH_INVALID'],
  ['repeated gold ID', r => { r.rows[1].goldId = r.rows[0].goldId; }, 'GOLD_MATCH_INVALID'],
  ['wrong gold kind', r => { r.rows[0].goldId = 'atlas-fact'; }, 'GOLD_MATCH_INVALID'],
  ['missing severe flag', r => { delete r.rows[0].severe.number; }, 'SEVERE_FLAGS_INVALID'],
  ['extra severe flag', r => { r.rows[0].severe.omission = false; }, 'SEVERE_FLAGS_INVALID'],
  ['unfilled severe flag', r => { r.rows[0].severe.number = null; }, 'SEVERE_FLAGS_INVALID'],
  ['non-boolean severe flag', r => { r.rows[0].severe.number = 0; }, 'SEVERE_FLAGS_INVALID'],
  ['severe flag without notes', r => { r.rows[0].severe.number = true; r.rows[0].notes = ''; }, 'DECISION_NOTES_REQUIRED'],
  ['unmatched output without notes', r => { r.rows[0].goldId = null; r.rows[0].notes = ''; }, 'DECISION_NOTES_REQUIRED'],
  ['unflagged duplicate reference', r => { r.rows[0].duplicateOf = 'entity:item-nova'; }, 'UNFLAGGED_DUPLICATE_REFERENCE'],
  ['unknown missing gold', r => { r.missingGoldIds = ['unknown']; }, 'MISSING_GOLD_IDS_INCONSISTENT'],
  ['matched gold listed missing', r => { r.missingGoldIds = ['atlas']; }, 'MISSING_GOLD_IDS_INCONSISTENT'],
  ['unmatched gold omitted', r => { r.rows[0].goldId = null; }, 'MISSING_GOLD_IDS_INCONSISTENT'],
  ['repeated missing ID', r => { r.rows[0].goldId = null; r.missingGoldIds = ['atlas', 'atlas']; }, 'MISSING_GOLD_IDS_INCONSISTENT'],
  ['missing ID list unfilled', r => { r.missingGoldIds = null; }, 'MISSING_GOLD_IDS_INCONSISTENT'],
  ['manual top-level counts', r => { r.truePositives = 999; }, 'REVIEW_FIELDS_INVALID'],
  ['manual row counts', r => { r.rows[0].score = 1; }, 'ROW_FIELDS_INVALID'],
  ['sample digest changed', r => { r.sampleDigest = '0'.repeat(64); }, 'REVIEW_DIGEST_MISMATCH'],
  ['capture digest changed', r => { r.captureDigest = '0'.repeat(64); }, 'REVIEW_DIGEST_MISMATCH'],
  ['review mode relabeled', r => { r.mode = 'live'; }, 'OFFLINE_REVIEW_REQUIRED'],
  ['review evidence relabeled', r => { r.evidenceKind = 'human-review'; }, 'OFFLINE_REVIEW_REQUIRED'],
  ['review kind relabeled', r => { r.kind = 'quality-assessment'; }, 'OFFLINE_REVIEW_REQUIRED'],
  ['review quality status relabeled', r => { r.qualityStatus = 'passed'; }, 'OFFLINE_REVIEW_REQUIRED'],
  ['review evaluated relabeled', r => { r.qualityEvaluated = true; }, 'OFFLINE_REVIEW_REQUIRED'],
  ['review acceptance relabeled', r => { r.fullQualityAcceptance = true; }, 'OFFLINE_REVIEW_REQUIRED']
]) test(`reject ${name}`, () => {
  const capture = fixtureCapture(), review = fixtureReview(capture); mutate(review); rejected(capture, review, code);
});

for (const [name, mutate, code] of [
  ['capture mode relabeled', c => { c.mode = 'live'; }, 'OFFLINE_CAPTURE_REQUIRED'],
  ['capture evidence relabeled', c => { c.evidenceKind = 'real-provider-output'; }, 'OFFLINE_CAPTURE_REQUIRED'],
  ['capture kind relabeled', c => { c.kind = 'real-semantic-capture'; }, 'OFFLINE_CAPTURE_REQUIRED'],
  ['capture quality relabeled', c => { c.qualityStatus = 'passed'; }, 'OFFLINE_CAPTURE_REQUIRED'],
  ['capture evaluated relabeled', c => { c.qualityEvaluated = true; }, 'OFFLINE_CAPTURE_REQUIRED'],
  ['capture acceptance relabeled', c => { c.fullQualityAcceptance = true; }, 'OFFLINE_CAPTURE_REQUIRED'],
  ['nonzero live calls', c => { c.liveCalls = 1; }, 'OFFLINE_CAPTURE_REQUIRED'],
  ['non-offline call', c => { c.calls = [{ mode: 'live', endpoint: 'https://example.invalid' }]; }, 'OFFLINE_CALLS_REQUIRED'],
  ['non-loopback call', c => { c.calls = [{ mode: 'offline', endpoint: 'http://example.invalid:5000' }]; }, 'OFFLINE_CALLS_REQUIRED'],
  ['capture incomplete', c => { c.complete = false; }, 'CAPTURE_INCOMPLETE'],
  ['cleanup incomplete', c => { c.cleanup = false; }, 'CAPTURE_INCOMPLETE'],
  ['capture error', c => { c.errors = ['error']; }, 'CAPTURE_INCOMPLETE'],
  ['capture time reversed', c => { c.startedAt = reviewedAt; }, 'CAPTURE_TIME_INVALID'],
  ['sample relabeled', c => { c.sample.kind = 'real-recording'; }, 'SYNTHETIC_SAMPLE_REQUIRED'],
  ['gold approved relabeled', c => { c.sample.gold.approved = true; c.sampleDigest = contractDigest(c.sample); }, 'SYNTHETIC_GOLD_REQUIRED'],
  ['sample changed without digest', c => { c.sample.segments[0] = 'forged'; }, 'SAMPLE_DIGEST_MISMATCH'],
  ['duplicate gold variant', c => { c.sample.gold.variants.push(structuredClone(c.sample.gold.variants[0])); c.sampleDigest = contractDigest(c.sample); }, 'SYNTHETIC_GOLD_REQUIRED'],
  ['duplicate gold unit', c => { c.sample.gold.variants[0].units.push(structuredClone(c.sample.gold.variants[0].units[0])); c.sampleDigest = contractDigest(c.sample); }, 'GOLD_IDS_INVALID'],
  ['invalid gold source index', c => { c.sample.gold.variants[0].units[0].sourceIndexes = [99]; c.sampleDigest = contractDigest(c.sample); }, 'GOLD_UNIT_INVALID'],
  ['unknown gold owner', c => { c.sample.gold.variants[0].units[3].owner = 'unknown'; c.sampleDigest = contractDigest(c.sample); }, 'GOLD_OWNER_INVALID'],
  ['unknown gold endpoint', c => { c.sample.gold.variants[0].units[6].subject = 'unknown'; c.sampleDigest = contractDigest(c.sample); }, 'GOLD_ENDPOINT_INVALID'],
  ['missing snapshot', c => { delete c.after; }, 'PERSISTED_SNAPSHOT_REQUIRED'],
  ['broken database integrity', c => { c.after.integrity = ['not ok']; }, 'PERSISTED_SNAPSHOT_REQUIRED'],
  ['changed persisted source', c => { c.after.tables.segments[0].original_text = 'forged'; }, 'PERSISTED_SOURCES_MISMATCH'],
  ['changed persisted source sequence', c => { c.after.tables.segments[0].sequence_no = null; }, 'PERSISTED_SOURCES_MISMATCH'],
  ['duplicate persisted entity ID', c => { c.after.tables.knowledge_items.push(structuredClone(c.after.tables.knowledge_items[0])); }, 'PERSISTED_IDS_INVALID'],
  ['invented output unit', c => { c.units[0].value.canonical_name = 'forged'; }, 'PERSISTED_UNITS_MISMATCH'],
  ['hidden persisted output unit', c => { c.units.pop(); }, 'PERSISTED_UNITS_MISMATCH'],
  ['missing persisted source reference', c => { c.after.tables.knowledge_mentions = []; refresh(c); }, 'PERSISTED_UNIT_INVALID'],
  ['unknown persisted fact owner', c => { c.after.tables.knowledge_facts[0].item_id = 'unknown'; refresh(c); }, 'PERSISTED_OWNER_INVALID'],
  ['unknown persisted relation endpoint', c => { c.after.tables.relations[0].object_item_id = 'unknown'; refresh(c); }, 'PERSISTED_ENDPOINT_INVALID']
]) test(`reject ${name} even if review capture digest is refreshed`, () => {
  const capture = fixtureCapture(), review = fixtureReview(capture); mutate(capture); review.captureDigest = contractDigest(capture);
  rejected(capture, review, code);
});

test('changes outside displayed units remain bound to the capture digest', () => {
  const capture = fixtureCapture(), review = fixtureReview(capture); capture.extraEvidence = 'changed';
  rejected(capture, review, 'REVIEW_DIGEST_MISMATCH');
});

test('missing IDs are a set and review row order does not score semantic similarity', () => {
  const capture = fixtureCapture(), review = fixtureReview(capture);
  review.rows[0].goldId = null; review.rows[1].goldId = null; review.missingGoldIds = ['nova', 'atlas']; review.rows.reverse();
  const result = assess(capture, review); assert.equal(result.contractValid, true);
  assert.equal(result.metrics.entity.precision, 1 / 3); assert.equal(result.metrics.entity.recall, 1 / 3);
});

test('reviewer roster must be explicit, nonempty and unique', () => {
  const capture = fixtureCapture();
  for (const roster of [undefined, [], [''], ['one', 'one']]) {
    assert.throws(() => createSemanticReviewTemplate(capture, { reviewers: roster }), /REVIEWERS_REQUIRED/);
    const result = assessSemanticReview(capture, {}, { reviewers: roster }); assertOffline(result);
    assert.deepEqual(result.issues, ['REVIEWERS_REQUIRED']);
  }
});

test('malformed inputs fail closed without promoting quality or throwing from assessment', () => {
  const capture = fixtureCapture(), review = fixtureReview(capture);
  for (const malformed of [null, undefined, false, '', [], {}]) {
    const badCapture = assessSemanticReview(malformed, review, options);
    assertOffline(badCapture); assert.equal(badCapture.complete, false); assert.equal(badCapture.metrics, null);
    const badReview = assessSemanticReview(capture, malformed, options);
    assertOffline(badReview); assert.equal(badReview.complete, false); assert.equal(badReview.metrics, null);
  }
});

test('all relabeled quality claims fail closed together, including fully refreshed review digests', () => {
  const capture = fixtureCapture(), review = fixtureReview(capture);
  for (const value of [capture, review]) {
    value.kind = 'real-quality-report'; value.mode = 'live'; value.evidenceKind = 'real-provider-output';
    value.qualityStatus = 'passed'; value.qualityEvaluated = true; value.fullQualityAcceptance = true;
  }
  capture.sample.kind = 'real-recording'; capture.sample.gold.approved = true;
  capture.sampleDigest = contractDigest(capture.sample); review.sample = structuredClone(capture.sample);
  review.sampleDigest = capture.sampleDigest; review.captureDigest = contractDigest(capture);
  rejected(capture, review, 'OFFLINE_CAPTURE_REQUIRED');
});
