import { createHash } from 'node:crypto';
import { findIdentitySpans, normalizeIdentity } from './identity-grounding.mjs';

export const RELATION_EVIDENCE_VERSION = 'relation-evidence-v1';
export const RELATION_EVIDENCE_LIMITS = Object.freeze({ segments: 12, candidates: 48, spans: 256, mentions: 512, spanChars: 2000, frameOccurrences: 16 });
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const validId = value => typeof value === 'string' && Boolean(value);
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const contains = (a, b) => a.start <= b.start && a.end >= b.end;

function exactOccurrences(text, quote, from, to) {
  const result = { spans: [], limited: false };
  if (typeof quote !== 'string' || !quote) return result;
  for (let at = text.indexOf(quote, from); at >= 0 && at + quote.length <= to; at = text.indexOf(quote, at + 1)) {
    if (result.spans.length >= RELATION_EVIDENCE_LIMITS.frameOccurrences) { result.limited = true; break; }
    result.spans.push({ start: at, end: at + quote.length, quote });
  }
  return result;
}

export function buildEvidenceRegistry(input, { clauses } = {}) {
  const limits = RELATION_EVIDENCE_LIMITS;
  let coverage_limited = Boolean(input?.coverage_limited);
  const diagnostics = { ambiguous_names: 0, ambiguous_occurrences: 0, invalid_source_mentions: 0 };
  const sources = new Map(), conflicts = new Set();
  for (const [scope, rows] of [['context', input?.context_segments || []], ['focus', input?.focus_segments || []]]) {
    for (const row of rows) {
      if (!validId(row?.id) || typeof row.text !== 'string') { coverage_limited = true; continue; }
      const source_revision = row.source_revision || hash(row.text);
      const previous = sources.get(row.id);
      if (previous && (previous.text !== row.text || previous.source_revision !== source_revision)) conflicts.add(row.id);
      sources.set(row.id, { ...row, source_revision, scope });
    }
  }
  if (conflicts.size) coverage_limited = true;
  const allSegments = [...sources.values()].filter(s => !conflicts.has(s.id)).sort((a, b) =>
    Number.isFinite(a.sequence_no) && Number.isFinite(b.sequence_no) && a.sequence_no !== b.sequence_no ? a.sequence_no - b.sequence_no : byId(a, b));
  if (allSegments.length > limits.segments) coverage_limited = true;
  // Keep new/focus evidence when a malformed oversized caller exceeds the cap.
  const keptIds = new Set([...allSegments.filter(s => s.scope === 'focus'), ...allSegments.filter(s => s.scope === 'context')].slice(0, limits.segments).map(s => s.id));
  const segments = allSegments.filter(s => keptIds.has(s.id));
  const candidates = [...(input?.candidates || input?.existing_candidates || [])].filter(c => validId(c?.id)).sort(byId);
  if (candidates.length > limits.candidates) coverage_limited = true;
  const keptCandidates = candidates.slice(0, limits.candidates), names = new Map();
  for (const candidate of keptCandidates) {
    const approved = [...new Set([candidate.canonical_name, ...(candidate.aliases || [])].filter(n => typeof n === 'string' && n.trim()))];
    for (const name of approved) {
      const normalized = normalizeIdentity(name);
      if (!normalized) continue;
      const value = names.get(normalized) || { name, owners: new Set() };
      value.owners.add(candidate.id); names.set(normalized, value);
    }
    // A knowledge mention is often the entire original sentence. Verify it as
    // source provenance, never promote it to an entity alias or identity match.
    for (const mention of candidate.mentions || []) {
      const source = sources.get(mention?.segment_id);
      if (!source) continue;
      if (typeof mention.surface_text !== 'string' || !mention.surface_text || !source.text.includes(mention.surface_text)) diagnostics.invalid_source_mentions++;
    }
  }
  diagnostics.ambiguous_names = [...names.values()].filter(n => n.owners.size > 1).length;
  const spans = [], mentions = [], seenMentions = new Set();
  for (const segment of segments) {
    let parsed;
    try { parsed = clauses ? clauses(segment.text) : [{ start: 0, end: segment.text.length }]; }
    catch { parsed = []; coverage_limited = true; }
    if (!Array.isArray(parsed)) { parsed = []; coverage_limited = true; }
    const seenSpans = new Set();
    for (const clause of parsed) {
      if (!Number.isInteger(clause?.start) || !Number.isInteger(clause?.end) || clause.start < 0 || clause.end <= clause.start || clause.end > segment.text.length) {
        coverage_limited = true; continue;
      }
      const prefix = exactOccurrences(segment.text, clause.prefix, 0, clause.start);
      const suffix = exactOccurrences(segment.text, clause.suffix, clause.end, segment.text.length);
      const prefix_spans = prefix.spans, suffix_spans = suffix.spans;
      const invalidFrame = Boolean((clause.prefix && !prefix_spans.length) || (clause.suffix && !suffix_spans.length));
      const limitedFrame = prefix.limited || suffix.limited;
      if (invalidFrame || limitedFrame) coverage_limited = true;
      const fragmented = clause.end - clause.start > limits.spanChars;
      for (let start = clause.start; start < clause.end;) {
        let end = Math.min(clause.end, start + limits.spanChars);
        if (end < clause.end && /[\uD800-\uDBFF]/u.test(segment.text[end - 1]) && /[\uDC00-\uDFFF]/u.test(segment.text[end])) end--;
        const quote = segment.text.slice(start, end);
        if (quote.trim()) {
          const id = `ev_${hash([RELATION_EVIDENCE_VERSION, segment.id, segment.source_revision, start, end]).slice(0, 24)}`;
          if (!seenSpans.has(id)) {
            seenSpans.add(id);
            if (spans.length < limits.spans) spans.push({ id, segment_id: segment.id, source_revision: segment.source_revision,
              scope: segment.scope, start, end, quote,
              ...(clause.prefix && prefix_spans.length ? { prefix: clause.prefix, prefix_spans } : {}),
              ...(clause.suffix && suffix_spans.length ? { suffix: clause.suffix, suffix_spans } : {}),
              ...(fragmented ? { fragmented: true, clause_start: clause.start, clause_end: clause.end } : {}),
              ...(fragmented || invalidFrame || limitedFrame ? { needs_review: true } : {}) });
            else coverage_limited = true;
          }
        }
        start = end;
      }
    }
    const occurrences = [];
    for (const [normalized, entry] of [...names].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      for (const found of findIdentitySpans(segment.text, entry.name)) {
        occurrences.push({ ...found, normalized, owners: [...entry.owners] });
      }
    }
    occurrences.sort((a, b) => a.start - b.start || b.end - a.end || (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0));
    const ambiguous = new Set(occurrences.filter(o => o.owners.length !== 1));
    let active = [];
    for (const occurrence of occurrences) {
      active = active.filter(other => other.end > occurrence.start);
      for (const other of active) {
        if (!overlap(other, occurrence) || !other.owners.some(id => occurrence.owners.some(owner => owner !== id))) continue;
        // A unique longer name is an anchor; its substring cannot independently
        // establish another entity. Partially overlapping names are ambiguous.
        if (!contains(occurrence, other) || contains(other, occurrence)) ambiguous.add(occurrence);
        if (!contains(other, occurrence) || contains(occurrence, other)) ambiguous.add(other);
      }
      active.push(occurrence);
    }
    for (const occurrence of occurrences) {
      if (ambiguous.has(occurrence)) { diagnostics.ambiguous_occurrences++; continue; }
      const item_id = occurrence.owners[0];
      const span_ids = spans.filter(s => s.segment_id === segment.id && contains(s, occurrence)).map(s => s.id);
      if (!span_ids.length) { coverage_limited = true; continue; }
      const id = `mention_${hash([RELATION_EVIDENCE_VERSION, item_id, segment.id, segment.source_revision, occurrence.start, occurrence.end]).slice(0, 24)}`;
      if (seenMentions.has(id)) continue;
      if (mentions.length >= limits.mentions) { coverage_limited = true; continue; }
      seenMentions.add(id);
      mentions.push({ id, item_id, segment_id: segment.id, source_revision: segment.source_revision,
        start: occurrence.start, end: occurrence.end, quote: occurrence.quote, span_ids });
    }
  }
  const version = `${RELATION_EVIDENCE_VERSION}:${hash({ format: RELATION_EVIDENCE_VERSION, contract: input?.contract_version || input?.prompt_version || null,
    segments: segments.map(s => [s.id, s.source_revision, s.scope, s.sequence_no, hash(s.text)]),
    candidates: keptCandidates.map(c => [c.id, c.listening_id || input?.listening_id, c.canonical_name, normalizeIdentity(c.canonical_name),
      [...new Set(c.aliases || [])].sort(), c.type, c.display_label, c.certainty || 'clear', c.identity_revision]),
    spans, mentions, coverage_limited }).slice(0, 32)}`;
  return { version, spans, mentions, coverage_limited, diagnostics };
}
