// Offline annotation-contract rehearsal only. No human identity or model-quality
// acceptance is certified here, even when all synthetic matches are complete.
import { contractDigest } from './quality-contract.mjs';
import { semanticUnits } from './semantic-quality-capture.mjs';

export const semanticSevereErrorTypes = Object.freeze([
  'number', 'negation', 'condition', 'attribution', 'merge', 'duplicate', 'unsupported'
]);
const kinds = ['entity', 'fact', 'relation'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => contractDigest(a) === contractDigest(b);
const clone = value => JSON.parse(JSON.stringify(value));
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const keys = (value, expected) => object(value) && same(Object.keys(value).sort(), [...expected].sort());
const uniqueIds = rows => rows.every(row => text(row?.id)) && new Set(rows.map(row => row.id)).size === rows.length;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const qualityBoundary = Object.freeze({ qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false });

function validateReviewers(reviewers) {
  check(Array.isArray(reviewers) && reviewers.length > 0 && reviewers.every(text) &&
    new Set(reviewers).size === reviewers.length, 'REVIEWERS_REQUIRED');
}

function validateCapture(capture) {
  check(object(capture) && capture.schemaVersion === 1 && capture.kind === 'offline-semantic-capture' &&
    capture.mode === 'offline' && capture.evidenceKind === 'synthetic-provider-output' &&
    capture.pipeline === 'knowledge-then-relation-cascade' && capture.liveCalls === 0 &&
    capture.qualityStatus === 'not_run' && capture.qualityEvaluated === false &&
    (capture.fullQualityAcceptance === undefined || capture.fullQualityAcceptance === false), 'OFFLINE_CAPTURE_REQUIRED');
  check(capture.complete === true && capture.cleanup === true && !capture.errorCode &&
    Array.isArray(capture.errors) && capture.errors.length === 0, 'CAPTURE_INCOMPLETE');
  check(timestamp(capture.startedAt) && timestamp(capture.finishedAt) &&
    Date.parse(capture.startedAt) <= Date.parse(capture.finishedAt) && Date.parse(capture.finishedAt) <= Date.now(), 'CAPTURE_TIME_INVALID');
  check(Array.isArray(capture.calls) && capture.calls.every(call => {
    if (call?.mode !== 'offline') return false;
    try {
      const url = new URL(call.endpoint);
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port) &&
        !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
    } catch { return false; }
  }), 'OFFLINE_CALLS_REQUIRED');
  const sample = capture.sample;
  check(object(sample) && text(sample.id) && sample.kind === 'synthetic-contract-fixture' &&
    Array.isArray(sample.segments) && sample.segments.length > 0 && sample.segments.every(text), 'SYNTHETIC_SAMPLE_REQUIRED');
  check(capture.sampleDigest === contractDigest(sample), 'SAMPLE_DIGEST_MISMATCH');
  // This rehearsal cannot turn hand-authored fixture gold into human approval.
  check(sample.gold?.approved === false && Array.isArray(sample.gold.variants) &&
    sample.gold.variants.length > 0 && uniqueIds(sample.gold.variants), 'SYNTHETIC_GOLD_REQUIRED');
  for (const variant of sample.gold.variants) {
    check(Array.isArray(variant.units) && uniqueIds(variant.units), 'GOLD_IDS_INVALID');
    const entities = new Set(variant.units.filter(unit => unit.kind === 'entity').map(unit => unit.id));
    for (const unit of variant.units) {
      check(kinds.includes(unit.kind) && text(unit.meaning) && Array.isArray(unit.alternatives) && unit.alternatives.every(text) &&
        Array.isArray(unit.sourceIndexes) && unit.sourceIndexes.length > 0 && new Set(unit.sourceIndexes).size === unit.sourceIndexes.length &&
        unit.sourceIndexes.every(index => Number.isSafeInteger(index) && index >= 0 && index < sample.segments.length), 'GOLD_UNIT_INVALID');
      check(unit.kind !== 'fact' || entities.has(unit.owner), 'GOLD_OWNER_INVALID');
      check(unit.kind !== 'relation' || entities.has(unit.subject) && entities.has(unit.object), 'GOLD_ENDPOINT_INVALID');
    }
  }
  const snapshot = capture.after, tables = snapshot?.tables;
  check(object(tables) && ['segments', 'knowledge_items', 'knowledge_mentions', 'knowledge_aliases', 'knowledge_facts',
    'relations', 'relation_assertions', 'relation_supports'].every(name => Array.isArray(tables[name])) &&
    same(snapshot.integrity, ['ok']) && same(snapshot.foreignKeys, []), 'PERSISTED_SNAPSHOT_REQUIRED');
  check(uniqueIds(tables.segments) && tables.segments.every(row => Number.isSafeInteger(row.sequence_no)) &&
    new Set(tables.segments.map(row => row.sequence_no)).size === tables.segments.length &&
    same([...tables.segments].sort((a, b) => a.sequence_no - b.sequence_no).map(row => row.original_text), sample.segments), 'PERSISTED_SOURCES_MISMATCH');
  check(['knowledge_items', 'knowledge_facts', 'relations', 'relation_assertions'].every(name => uniqueIds(tables[name])), 'PERSISTED_IDS_INVALID');
  check(Array.isArray(capture.units) && uniqueIds(capture.units) && same(capture.units, semanticUnits(snapshot)), 'PERSISTED_UNITS_MISMATCH');
  const sources = new Map(tables.segments.map(row => [row.id, row.original_text]));
  const entities = new Set(tables.knowledge_items.map(row => row.id));
  for (const unit of capture.units) {
    check(kinds.includes(unit.kind) && unit.id === `${unit.kind}:${unit.value?.id}` && Array.isArray(unit.sources) &&
      unit.sources.length > 0 && unit.sources.every(row => sources.has(row.segment_id) && row.original === sources.get(row.segment_id)), 'PERSISTED_UNIT_INVALID');
    check(unit.kind !== 'fact' || entities.has(unit.value.item_id) && unit.owner?.id === unit.value.item_id, 'PERSISTED_OWNER_INVALID');
    check(unit.kind !== 'relation' || unit.relation?.id === unit.value.relation_id &&
      entities.has(unit.relation.subject_item_id) && entities.has(unit.relation.object_item_id), 'PERSISTED_ENDPOINT_INVALID');
  }
}

/** Returns unfilled decisions. A human must select ONE complete gold variant,
 * annotate every output and account for every unselected gold unit. */
export function createSemanticReviewTemplate(capture, { reviewers } = {}) {
  validateReviewers(reviewers); validateCapture(capture);
  return {
    schemaVersion: 1, kind: 'offline-semantic-review', mode: 'offline', evidenceKind: 'synthetic-review-contract',
    ...qualityBoundary, captureDigest: contractDigest(capture), sampleDigest: capture.sampleDigest,
    reviewers: clone(reviewers), sample: clone(capture.sample),
    reviewer: null, reviewedAt: null, selectedVariantId: null,
    rows: capture.units.map(output => ({ outputId: output.id, output: clone(output), goldId: null,
      severe: Object.fromEntries(semanticSevereErrorTypes.map(type => [type, null])), duplicateOf: null,
      notes: '', reviewer: null, reviewedAt: null })),
    missingGoldIds: null
  };
}

function scoreKind(kind, outputs, gold, rows) {
  const outputCount = outputs.filter(row => row.kind === kind).length;
  const goldCount = gold.filter(row => row.kind === kind).length;
  const truePositives = rows.filter(row => row.output.kind === kind && row.goldId !== null).length;
  return { status: outputCount === 0 && goldCount === 0 ? 'valid_empty' : 'scored',
    outputCount, goldCount, truePositives, falsePositives: outputCount - truePositives, falseNegatives: goldCount - truePositives,
    precision: outputCount === 0 ? null : truePositives / outputCount,
    recall: goldCount === 0 ? null : truePositives / goldCount,
    precisionDenominator: outputCount === 0 ? null : outputCount, recallDenominator: goldCount === 0 ? null : goldCount };
}

/** Checks annotation integrity, then counts the reviewer's ID matches. Digests
 * check displayed evidence integrity ONLY; no prose comparison scores meaning.
 * Offline success never grants real-corpus, provider, release or quality pass. */
export function assessSemanticReview(capture, review, { reviewers } = {}) {
  const base = { schemaVersion: 1, kind: 'offline-semantic-review-assessment', mode: 'offline',
    evidenceKind: 'synthetic-review-contract', ...qualityBoundary, releaseEligible: false,
    boundary: 'Synthetic offline annotation contract only; reviewer names are declarations, not authenticated human approval.' };
  try {
    const template = createSemanticReviewTemplate(capture, { reviewers });
    check(keys(review, Object.keys(template)), 'REVIEW_FIELDS_INVALID');
    for (const key of ['schemaVersion', 'kind', 'mode', 'evidenceKind', ...Object.keys(qualityBoundary)])
      check(review[key] === template[key], 'OFFLINE_REVIEW_REQUIRED');
    check(review.captureDigest === template.captureDigest && review.sampleDigest === template.sampleDigest, 'REVIEW_DIGEST_MISMATCH');
    check(same(review.reviewers, reviewers), 'REVIEWERS_CHANGED');
    check(same(review.sample, capture.sample), 'DISPLAYED_SAMPLE_CHANGED');
    check(reviewers.includes(review.reviewer), 'REVIEWER_INVALID');
    check(timestamp(review.reviewedAt) && Date.parse(review.reviewedAt) >= Date.parse(capture.finishedAt) &&
      Date.parse(review.reviewedAt) <= Date.now(), 'REVIEW_TIME_INVALID');
    const selected = capture.sample.gold.variants.find(row => row.id === review.selectedVariantId);
    check(Boolean(selected), 'GOLD_VARIANT_REQUIRED');
    check(Array.isArray(review.rows) && review.rows.length === capture.units.length, 'OUTPUT_COVERAGE_INVALID');
    const outputs = new Map(capture.units.map(row => [row.id, row])), gold = new Map(selected.units.map(row => [row.id, row]));
    const seenOutputs = new Set(), matchedGold = new Set(), failures = [];
    for (const row of review.rows) {
      check(keys(row, ['outputId', 'output', 'goldId', 'severe', 'duplicateOf', 'notes', 'reviewer', 'reviewedAt']), 'ROW_FIELDS_INVALID');
      check(outputs.has(row.outputId) && !seenOutputs.has(row.outputId), 'OUTPUT_ID_INVALID'); seenOutputs.add(row.outputId);
      check(same(row.output, outputs.get(row.outputId)), 'DISPLAYED_OUTPUT_CHANGED');
      check(row.reviewer === review.reviewer && row.reviewedAt === review.reviewedAt, 'ROW_REVIEWER_TIME_MISMATCH');
      check(keys(row.severe, semanticSevereErrorTypes) && Object.values(row.severe).every(value => typeof value === 'boolean'), 'SEVERE_FLAGS_INVALID');
      check(typeof row.notes === 'string', 'NOTES_INVALID');
      check(row.goldId === null || text(row.goldId) && gold.has(row.goldId) &&
        gold.get(row.goldId).kind === row.output.kind && !matchedGold.has(row.goldId), 'GOLD_MATCH_INVALID');
      if (row.goldId !== null) matchedGold.add(row.goldId);
      if (row.severe.duplicate) {
        check(row.goldId === null && text(row.duplicateOf) && row.duplicateOf !== row.outputId &&
          outputs.has(row.duplicateOf) && outputs.get(row.duplicateOf).kind === row.output.kind, 'DUPLICATE_REFERENCE_INVALID');
      } else check(row.duplicateOf === null, 'UNFLAGGED_DUPLICATE_REFERENCE');
      const severe = semanticSevereErrorTypes.filter(type => row.severe[type]);
      check((!severe.length && row.goldId !== null) || text(row.notes), 'DECISION_NOTES_REQUIRED');
      if (severe.length) failures.push({ reason: 'severe_error', outputId: row.outputId, types: severe });
      if (row.goldId === null) failures.push({ reason: 'unmatched_output', outputId: row.outputId });
    }
    // Missing units use the full chosen variant. An upstream entity omission
    // must not remove downstream relation gold from the recall denominator.
    const missing = selected.units.filter(row => !matchedGold.has(row.id)).map(row => row.id);
    check(Array.isArray(review.missingGoldIds) && review.missingGoldIds.every(text) &&
      new Set(review.missingGoldIds).size === review.missingGoldIds.length &&
      same([...review.missingGoldIds].sort(), [...missing].sort()), 'MISSING_GOLD_IDS_INCONSISTENT');
    for (const goldId of missing) failures.push({ reason: 'missing_gold', goldId, kind: gold.get(goldId).kind });
    const metrics = Object.fromEntries(kinds.map(kind => [kind, scoreKind(kind, capture.units, selected.units, review.rows)]));
    return { ...base, complete: true, contractValid: true, offlineReviewStatus: failures.length ? 'failed' : 'passed',
      offlineReviewPassed: failures.length === 0, issues: [], failures, metrics,
      captureDigest: template.captureDigest, sampleDigest: template.sampleDigest, reviewDigest: contractDigest(review),
      selectedVariantId: selected.id, reviewer: review.reviewer, reviewedAt: review.reviewedAt };
  } catch (error) {
    return { ...base, complete: false, contractValid: false, offlineReviewStatus: 'incomplete', offlineReviewPassed: false,
      issues: [error.code || 'INVALID_SEMANTIC_REVIEW'], failures: [], metrics: null };
  }
}
