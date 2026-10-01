// Semantics are model decisions in v3, not a local English/Chinese dictionary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelationRequest } from '../relations.mjs';

test('model review status and foreign-language qualifiers survive source-integrity checks', () => {
  const request = buildRelationRequest({ listening_id: 'local', focus_segments: [{ id: 's', text: 'Según Mira, Atlas envió Nova ayer.' }],
    candidates: [{ id: 'a', canonical_name: 'Atlas' }, { id: 'b', canonical_name: 'Nova' }] });
  const wire = JSON.parse(request.body.messages[1].content);
  const result = request.parse(JSON.stringify({ contract_version: wire.contract_version, evidence_version: wire.evidence_version,
    relations: [{ subject_item_id: 'n0', object_item_id: 'n1', predicate: 'released', polarity: 'positive', modality: 'asserted',
      status: 'needs_review', attribution: 'Según Mira', time_scope: 'ayer', evidence_ids: ['e0'] }] }));
  assert.deepEqual(result.rejected, []); assert.equal(result.relations[0].status, 'needs_review');
  assert.equal(result.relations[0].attribution, 'Según Mira'); assert.equal(result.relations[0].time_scope, 'ayer');
});
