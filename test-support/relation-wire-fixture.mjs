// Local synthetic provider helper, not an independent prompt-following eval.
// Tests still author claims/qualifiers; this only selects request-scoped registry
// references so transport fixtures exercise the production v2 decoder.
import assert from 'node:assert/strict';

export function relationWireEnvelope(wire, relations = []) {
  return { contract_version: wire.contract_version, evidence_version: wire.evidence_version, relations };
}

export function relationWireRow(wire, proposal) {
  const { supports = [], ...row } = proposal;
  const relationSupports = supports.filter(support => support.role === 'relation');
  const spanFor = support => {
    const matches = wire.evidence.filter(span => span.segment_id === support.segment_id &&
      (span.quote === support.quote || span.quote.includes(support.quote) || support.quote.includes(span.quote)));
    return matches.find(span => span.quote === support.quote) ||
      matches.filter(span => span.quote.includes(support.quote)).sort((a, b) => a.quote.length - b.quote.length)[0] || matches[0];
  };
  const spans = relationSupports.map(support => {
    const span = spanFor(support);
    assert.ok(span, `Fixture relation quote has no registered evidence: ${JSON.stringify(support)}`);
    return span;
  });
  function mentionFor(itemId, role) {
    const references = supports.filter(support => support.role === role);
    const referencesFirst = references.length ? references : relationSupports;
    const matching = wire.mentions.filter(mention => mention.item_id === itemId);
    for (const support of referencesFirst) {
      const candidates = matching.filter(mention => mention.segment_id === support.segment_id && support.quote.includes(mention.quote));
      if (candidates.length) {
        const inSelected = candidates.find(mention => spans.some(span => span.segment_id === mention.segment_id &&
          mention.start >= span.start && mention.end <= span.end));
        return (references.length ? candidates[0] : inSelected || candidates[0]).id;
      }
    }
    const inSpan = matching.find(mention => spans.some(span => span.segment_id === mention.segment_id &&
      mention.start >= span.start && mention.end <= span.end));
    assert.ok(inSpan, `Fixture endpoint ${itemId} has no registered mention in the proposed evidence`);
    return inSpan.id;
  }
  return { ...row, evidence_ids: [...new Set(spans.map(span => span.id))],
    subject_mention_id: mentionFor(row.subject_item_id, 'subject_reference'),
    object_mention_id: mentionFor(row.object_item_id, 'object_reference') };
}
