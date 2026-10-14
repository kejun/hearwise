// Original synthetic prose and hand-authored outputs. These are test oracles,
// not a real model, reviewed acceptance corpus, or model quality score.
import assert from 'node:assert/strict';
import { relationWireEnvelope } from './relation-wire-fixture.mjs';

const qualified = 'Orion reported that Atlas did not pay Nova 15 dollars. If approved, Atlas plans to pay Nova 20 dollars. Orion is a separate publisher.';
const definitions = [
  ['qualified', qualified, ['Atlas','Nova','Orion']],
  ['independent', 'Atlas is a camera maker. Nova is a garden tool. Orion is a separate publisher.', ['Atlas','Nova','Orion']],
  ['empty', 'Good morning. Thank you for listening.', []]
];
const entity = name => ({ id: name.toLowerCase(), kind: 'entity', meaning: `${name} is a distinct named entity`, alternatives: [`${name} is independently mentioned`], sourceIndexes: [0] });
const factText = (name, id) => id === 'qualified' && name === 'Atlas' ? 'Atlas did not pay Nova 15 dollars; payment of 20 dollars is planned only if approved.' : `${name} is independently mentioned.`;
export function semanticFixtureSample(id = 'qualified') {
  const definition = definitions.find(row => row[0] === id); assert.ok(definition);
  const [name, text, names] = definition;
  const entities = names.map(entity), facts = names.map(value => ({ id: `${value.toLowerCase()}-fact`, kind: 'fact', owner: value.toLowerCase(), meaning: factText(value,name), alternatives: [], sourceIndexes: [0] }));
  const relations = name === 'qualified' ? [
    { id: 'denied-payment', kind: 'relation', subject: 'atlas', object: 'nova', meaning: 'Atlas did not pay Nova 15 dollars.', alternatives: [], sourceIndexes: [0] },
    { id: 'conditional-plan', kind: 'relation', subject: 'atlas', object: 'nova', meaning: 'Only if approved, Atlas plans a 20-dollar payment to Nova.', alternatives: [], sourceIndexes: [0] }
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
        return { action: 'create', display_label: 'organization', canonical_name: name, role: '讨论对象', reason: '原文明确提及', existing_item_id: null,
          observed_candidate_id: null, correction_reason: null, aliases: mutation === 'merge' && name === 'Atlas' ? ['Nova'] : [], certainty: 'clear',
          short_description: mutation === 'merge' && name === 'Atlas' ? 'Atlas and Nova are the same organization.' : `${name} is an independent entity.`,
          new_information: mutation === 'number' && name === 'Atlas' ? 'Atlas did not pay Nova 150 dollars.' : factText(name,sample.id),
          evidence: [{ segment_id: segment.id, quote: name }] };
      });
      if (mutation === 'duplicate' && items.length) items.push({ ...items[0], new_information: 'Atlas did not pay fifteen dollars to Nova; a twenty-dollar payment remains conditional on approval.' });
      return { items };
    }
    if (sample.id !== 'qualified' && mutation !== 'unsupported') return relationWireEnvelope(input);
    const candidate = name => input.candidates.find(row => row.canonical_name === name);
    const subject = candidate(mutation === 'attribution' ? 'Orion' : 'Atlas'), object = candidate('Nova');
    if (!subject || !object) return relationWireEnvelope(input);
    const evidence = input.evidence.find(row => row.quote.includes('Atlas') && row.quote.includes('Nova')) || input.evidence[0];
    assert.ok(evidence);
    const row = { subject_item_id: subject.id, object_item_id: object.id, predicate: mutation === 'unsupported' ? 'acquired' : 'paid',
      polarity: mutation === 'negation' || mutation === 'unsupported' ? 'positive' : 'negative', modality: 'asserted', status: 'active', evidence_ids: [evidence.id] };
    return relationWireEnvelope(input, mutation === 'unsupported' ? [row] : [row,
      { ...row, polarity: 'positive', modality: mutation === 'condition' ? 'asserted' : 'planned', conditions: mutation === 'condition' ? null : 'If approved' }]);
  };
}
