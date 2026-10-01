import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelationRequest } from '../relations.mjs';

function propose(text, fields = {}) {
  const input = { listening_id: 'synthetic', focus_segments: [{ id: 'source', text }], context_segments: [],
    candidates: [{ id: 'atlas', canonical_name: 'Atlas', type: 'other', display_label: 'organization' },
      { id: 'nova', canonical_name: 'Nova', type: 'other', display_label: 'product' }] };
  const request = buildRelationRequest(input), wire = JSON.parse(request.body.messages[1].content);
  const [subject, object] = wire.candidates;
  return request.parse(JSON.stringify({ contract_version: wire.contract_version, evidence_version: wire.evidence_version,
    relations: [{ subject_item_id: subject.id, object_item_id: object.id, predicate: 'released', polarity: 'positive', modality: 'asserted', status: 'active',
      conditions: null, time_scope: null, attribution: null, correction_of: null, evidence_ids: [wire.evidence[0].id],
      subject_mention_id: wire.mentions.find(m => m.item_id === subject.id).id,
      object_mention_id: wire.mentions.find(m => m.item_id === object.id).id, ...fields }] }));
}

for (const text of ["Atlas's friend launched Nova.", "Atlas launched Nova's rival.", 'Atlas 的朋友推出了 Nova。', 'Atlas announced that a company launched Nova.']) {
  test(`indirect lexical syntax is never a confirmed fact: ${text}`, () => {
    const parsed = propose(text);
    assert.ok(parsed.relations.every(row => row.status === 'needs_review'), JSON.stringify(parsed));
  });
}

test('unknown language qualifiers are retained for review, not rejected by a hidden English/Chinese vocabulary', () => {
  const result = propose('Según Mira, Atlas envió Nova ayer.', { attribution: 'Según Mira', time_scope: 'ayer' });
  assert.equal(result.relations.length, 1, JSON.stringify(result.rejected));
  assert.equal(result.relations[0].status, 'needs_review');
  assert.equal(result.relations[0].attribution, 'Según Mira');
  assert.equal(result.relations[0].time_scope, 'ayer');
});
