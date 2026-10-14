// Original synthetic prose and hand-authored outputs. These are test oracles,
// not a real model, reviewed acceptance corpus, or model quality score.
import assert from 'node:assert/strict';
import { relationWireEnvelope } from './relation-wire-fixture.mjs';

const qualified = 'Orion reported that Atlas did not acquire Nova for 15 dollars. If approved, Atlas plans to acquire Nova for 20 dollars. Orion is a separate publisher.';
const definitions = [
  ['qualified', qualified, ['Atlas','Nova','Orion']],
  ['independent', 'Atlas is a camera maker. Nova is a garden tool. Orion is a separate publisher.', ['Atlas','Nova','Orion']],
  ['empty', 'Good morning. Thank you for listening.', []]
];
const entity = name => ({ id: name.toLowerCase(), kind: 'entity', meaning: `${name} is a distinct named entity`, alternatives: [`${name} is independently mentioned`], sourceIndexes: [0] });
const factText = (name, id) => id === 'qualified' && name === 'Atlas' ? 'Atlas did not acquire Nova for 15 dollars; acquisition for 20 dollars is planned only if approved.' : `${name} is independently mentioned.`;
export function semanticFixtureSample(id = 'qualified') {
  const definition = definitions.find(row => row[0] === id); assert.ok(definition);
  const [name, text, names] = definition;
  const entities = names.map(entity), facts = names.map(value => ({ id: `${value.toLowerCase()}-fact`, kind: 'fact', owner: value.toLowerCase(), meaning: factText(value,name), alternatives: [], sourceIndexes: [0] }));
  const relations = name === 'qualified' ? [
    { id: 'denied-payment', kind: 'relation', subject: 'atlas', object: 'nova', meaning: 'Atlas did not acquire Nova for 15 dollars.', alternatives: [], sourceIndexes: [0] },
    { id: 'conditional-plan', kind: 'relation', subject: 'atlas', object: 'nova', meaning: 'Only if approved, Atlas plans a 20-dollar acquisition of Nova.', alternatives: [], sourceIndexes: [0] }
  ] : [];
  return { id: name, kind: 'synthetic-contract-fixture', split: 'acceptance', segments: [text], names,
    categories: name === 'qualified' ? ['numbers','negation','plan','condition','attribution'] : [name === 'empty' ? 'valid-empty' : 'independent-items'],
    gold: { approved: false, variants: [{ id: 'expected', units: [...entities,...facts,...relations] }] } };
}
export const semanticMutations = ['number','negation','condition','attribution','merge','duplicate','unsupported','upstream-omission'];
export function semanticFixtureResponse(mutation = 'none') {
  assert.ok(mutation === 'none' || semanticMutations.includes(mutation));
  return ({ kind, input, sample }) => {
    assert.notEqual(kind, 'repair', 'Well-formed semantic errors must not need a protocol repair');
    if (kind === 'knowledge') {
      let names = sample.names;
      if (mutation === 'merge') names = names.filter(name => name !== 'Nova');
      if (mutation === 'upstream-omission') names = names.filter(name => name === 'Atlas');
      const items = names.map(name => {
        const segment = input.focus_segments.find(row => row.text.includes(name)); assert.ok(segment);
        const existing = input.existing_candidates.find(row => row.canonical_name === name);
        return { action: existing ? mutation === 'duplicate' && name === 'Atlas' ? 'update' : 'repeat' : 'create', display_label: 'organization', canonical_name: name, role: '讨论对象', reason: '原文明确提及', existing_item_id: existing?.id ?? null,
          observed_candidate_id: null, correction_reason: null, aliases: mutation === 'merge' && name === 'Atlas' ? ['Nova'] : [], certainty: 'clear',
          short_description: mutation === 'merge' && name === 'Atlas' ? 'Atlas and Nova are the same organization.' : `${name} is an independent entity.`,
          new_information: mutation === 'duplicate' && existing && name === 'Atlas' ? 'Atlas made no acquisition of Nova for fifteen dollars; a twenty-dollar acquisition is conditional on approval.' : mutation === 'number' && name === 'Atlas' ? 'Atlas did not acquire Nova for 150 dollars.' : factText(name,sample.id),
          evidence: [{ segment_id: segment.id, quote: name }] };
      });
      return { items };
    }
    if (sample.id !== 'qualified' && mutation !== 'unsupported') return relationWireEnvelope(input);
    const candidate = name => input.candidates.find(row => row.canonical_name === name);
    const subject = candidate(mutation === 'attribution' ? 'Orion' : 'Atlas'), object = candidate('Nova');
    if (!subject || !object) return relationWireEnvelope(input);
    const evidence = input.evidence.find(row => row.quote.includes('Atlas') && row.quote.includes('Nova')) || input.evidence[0];
    assert.ok(evidence);
    const row = { subject_item_id: subject.id, object_item_id: object.id, predicate: mutation === 'unsupported' ? 'uses' : 'acquired',
      polarity: mutation === 'negation' || mutation === 'unsupported' ? 'positive' : 'negative', modality: 'asserted', status: 'active', evidence_ids: [evidence.id] };
    return relationWireEnvelope(input, mutation === 'unsupported' ? [row] : [row,
      { ...row, polarity: 'positive', modality: mutation === 'condition' ? 'asserted' : 'planned', conditions: mutation === 'condition' ? null : 'If approved' }]);
  };
}

// Deliberate, predetermined annotation inputs for exercising the review reader.
// This function is NOT a semantic judge and MUST NOT annotate real model output.
export const semanticFixtureReviewers = ['synthetic contract oracle (not a human reviewer)'];
export async function semanticFixtureReview(capture, mutation = 'none') {
  const { createSemanticReviewTemplate, semanticSevereErrorTypes } = await import('../scripts/lib/semantic-quality-review.mjs');
  const review = createSemanticReviewTemplate(capture, { reviewers: semanticFixtureReviewers });
  review.reviewer = semanticFixtureReviewers[0]; review.reviewedAt = new Date().toISOString(); review.selectedVariantId = 'expected';
  for (const row of review.rows) {
    const output = row.output;
    const name = output.kind === 'entity' ? output.value.canonical_name : output.kind === 'fact' ? output.owner.canonical_name : null;
    row.goldId = output.kind === 'entity' ? name.toLowerCase() : output.kind === 'fact' ? `${name.toLowerCase()}-fact`
      : output.value.modality === 'planned' || output.value.polarity === 'positive' && mutation !== 'negation' ? 'conditional-plan' : 'denied-payment';
    row.severe = Object.fromEntries(semanticSevereErrorTypes.map(type => [type, false]));
    row.reviewer = review.reviewer; row.reviewedAt = review.reviewedAt;
    row.notes = 'Predetermined synthetic annotation input; this is not human approval or automatic semantic scoring.';
    if (mutation === 'number' && output.kind === 'fact' && name === 'Atlas') row.severe.number = true;
    if (mutation === 'negation' && output.kind === 'relation' && output.value.modality === 'asserted') row.severe.negation = true;
    if (mutation === 'condition' && output.kind === 'relation' && output.value.polarity === 'positive') row.severe.condition = true;
    if (mutation === 'attribution' && output.kind === 'relation') row.severe.attribution = true;
    if (mutation === 'merge' && output.kind === 'entity' && name === 'Atlas') row.severe.merge = true;
    if (mutation === 'unsupported' && output.kind === 'relation') { row.goldId = null; row.severe.unsupported = true; }
    if (mutation === 'duplicate' && output.kind === 'fact' && output.value.content.includes('fifteen')) {
      row.goldId = null; row.severe.duplicate = true;
      row.duplicateOf = capture.units.find(other => other.kind === 'fact' && other.value.item_id === output.value.item_id && other.id !== output.id).id;
    }
  }
  const matched = new Set(review.rows.map(row => row.goldId));
  review.missingGoldIds = capture.sample.gold.variants[0].units.filter(unit => !matched.has(unit.id)).map(unit => unit.id);
  return review;
}
