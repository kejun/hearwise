// Failure-focused excerpts of a validated OFFLINE annotation. Original capture
// and SQLite remain authoritative; these excerpts are not release evidence.
import { contractDigest } from './quality-contract.mjs';
import { assessSemanticReview } from './semantic-quality-review.mjs';

const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
export function createSemanticFailureCases(capture, review, options) {
  const assessment = assessSemanticReview(capture, review, options);
  if (!assessment.contractValid) throw new Error('VALID_SEMANTIC_REVIEW_REQUIRED');
  const units = new Map(capture.units.map((unit, index) => [unit.id, { unit, ref: `output-${index + 1}` }]));
  const selected = capture.sample.gold.variants.find(variant => variant.id === review.selectedVariantId);
  const goldRefs = new Map(selected.units.map((unit, index) => [unit.id, `gold-${index + 1}`]));
  const segments = [...capture.after.tables.segments].sort((a, b) => a.sequence_no - b.sequence_no);
  const sourceIndexes = new Map(segments.map((segment, index) => [segment.id, index]));
  const included = new Set();
  function include(id) {
    if (included.has(id)) return units.get(id).ref;
    const entry = units.get(id);
    if (!entry) throw new Error('SEMANTIC_FAILURE_REFERENCE_MISSING');
    included.add(id);
    const unit = entry.unit;
    if (unit.kind === 'fact') include(`entity:${unit.value.item_id}`);
    if (unit.kind === 'relation') {
      include(`entity:${unit.relation.subject_item_id}`); include(`entity:${unit.relation.object_item_id}`);
      if (unit.value.correction_of) include(`relation:${unit.value.correction_of}`);
    }
    return entry.ref;
  }
  const cases = [];
  for (const row of review.rows) {
    const failures = assessment.failures.filter(failure => failure.outputId === row.outputId);
    if (!failures.length) continue;
    cases.push({ id: `case-${cases.length + 1}`, output: include(row.outputId),
      gold: row.goldId === null ? null : goldRefs.get(row.goldId),
      duplicateOf: row.duplicateOf === null ? null : include(row.duplicateOf),
      reasons: failures.map(failure => pick(failure, ['reason', 'types'])) });
  }
  // Retain every missing gold unit, including downstream relations when an
  // upstream entity is absent. Empty actual output never erases expectations.
  for (const failure of assessment.failures.filter(row => row.reason === 'missing_gold'))
    cases.push({ id: `case-${cases.length + 1}`, output: null, gold: goldRefs.get(failure.goldId),
      duplicateOf: null, reasons: [{ reason: failure.reason }] });
  const outputs = [...units.values()].filter(({ unit }) => included.has(unit.id)).map(({ unit, ref }) => {
    const row = { id: ref, kind: unit.kind,
      sources: unit.sources.map(source => ({ index: sourceIndexes.get(source.segment_id), quote: source.quote ?? source.surface_text })) };
    if (unit.kind === 'entity') Object.assign(row, { value: pick(unit.value,
      ['canonical_name', 'type', 'display_label', 'short_description', 'dialogue_summary', 'background_note', 'certainty']),
      aliases: unit.aliases.map(alias => alias.alias) });
    if (unit.kind === 'fact') Object.assign(row, { owner: units.get(`entity:${unit.value.item_id}`).ref,
      value: pick(unit.value, ['content', 'certainty']) });
    if (unit.kind === 'relation') Object.assign(row, { subject: units.get(`entity:${unit.relation.subject_item_id}`).ref,
      object: units.get(`entity:${unit.relation.object_item_id}`).ref, predicate: unit.relation.predicate,
      value: pick(unit.value, ['statement', 'polarity', 'modality', 'status', 'conditions', 'time_scope', 'attribution']),
      correctionOf: unit.value.correction_of ? units.get(`relation:${unit.value.correction_of}`).ref : null });
    return row;
  });
  const gold = selected.units.map(unit => ({ ...pick(unit, ['kind', 'meaning', 'alternatives', 'sourceIndexes']),
    id: goldRefs.get(unit.id), ...Object.fromEntries(['owner', 'subject', 'object'].filter(key => unit[key]).map(key => [key, goldRefs.get(unit[key])])) }));
  return { schemaVersion: 1, kind: 'offline-semantic-failure-cases', mode: 'offline', complete: true,
    qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false, releaseEligible: false, liveCalls: 0,
    evidenceKind: 'synthetic-review-diagnostics', offlineReviewStatus: assessment.offlineReviewStatus,
    bindings: { captureDigest: contractDigest(capture), reviewDigest: contractDigest(review), sampleDigest: capture.sampleDigest,
      assessmentDigest: contractDigest(assessment), sourceDigest: contractDigest(capture.sourceStart) },
    source: pick(capture.sourceStart || {}, ['sha', 'tree', 'dirty', 'node', 'sqlite', 'platform', 'arch']), models: capture.models,
    input: { segments: [...capture.sample.segments], ingestionBatchSize: capture.sample.ingestionBatchSize ?? capture.sample.segments.length },
    selectedVariant: selected.id, gold, metrics: assessment.metrics, cases, outputs,
    scope: 'Failure outputs plus owners, endpoints, corrections and duplicate targets; complete input and selected gold retained for context and recall. Not an automatically minimized replay.',
    privacy: 'Operational IDs, request payloads, endpoints, paths and reviewer labels/notes omitted. Semantic prose is retained; this is not an automatic content redactor.' };
}
