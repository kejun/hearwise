// Synthetic provider adapter. Proposals are authored by tests; this binds only
// request-scoped node/evidence IDs and does not simulate semantic reasoning.
import assert from 'node:assert/strict';

export function relationWireEnvelope(wire, relations = []) {
  return { contract_version: wire.contract_version, evidence_version: wire.evidence_version, relations };
}

export function relationWireRow(wire, proposal) {
  const { supports = [], ...row } = proposal;
  const spans = supports.map(support => {
    const matches = wire.evidence.filter(span => span.segment_id === support.segment_id &&
      (span.quote === support.quote || span.quote.includes(support.quote) || support.quote.includes(span.quote)));
    const span = matches.find(span => span.quote === support.quote) || matches[0];
    assert.ok(span, `Fixture quote has no registered evidence: ${JSON.stringify(support)}`);
    return span;
  });
  return { ...row, evidence_ids: [...new Set(spans.map(span => span.id))] };
}

export function relationSource(wire, segmentId) {
  return wire.evidence.filter(span => span.segment_id === segmentId).map(span => span.quote).join('');
}
