import assert from 'node:assert/strict';

// The caller supplies an independently specified normalized string. Never call
// the production splitter to manufacture its own expected text. UTF-16 offsets
// identify exact retained slices; only whitespace gaps may be omitted.
export function speechIntervalLedger(normalized, units, { graphemeSafe = false } = {}) {
  assert.equal(typeof normalized, 'string'); assert.ok(Array.isArray(units));
  const accepted = [], omitted = []; let cursor = 0;
  const boundaries = graphemeSafe ? new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized)].map(row => row.index).concat(normalized.length)) : null;
  for (const [index, text] of units.entries()) {
    assert.equal(typeof text, 'string'); assert.ok(text.trim(), 'An accepted unit cannot contain only whitespace');
    const start = normalized.indexOf(text, cursor), end = start + text.length;
    assert.ok(start >= cursor, 'Each unit must be an exact, ordered normalized-text interval');
    assert.match(normalized.slice(cursor, start), /^\s*$/u, 'No lexical character may disappear before an accepted interval');
    if (start > cursor) omitted.push({ start: cursor, end: start, text: normalized.slice(cursor, start), reason: 'boundary-whitespace' });
    if (boundaries) { assert.ok(boundaries.has(start), 'Do not split a grapheme at the start'); assert.ok(boundaries.has(end), 'Do not split a grapheme at the end'); }
    accepted.push({ unit: index + 1, start, end, text }); cursor = end;
  }
  assert.match(normalized.slice(cursor), /^\s*$/u, 'No lexical tail may be omitted');
  if (cursor < normalized.length) omitted.push({ start: cursor, end: normalized.length, text: normalized.slice(cursor), reason: 'boundary-whitespace' });
  const spans = [...accepted, ...omitted].sort((left, right) => left.start - right.start);
  assert.equal(spans.map(span => span.text).join(''), normalized, 'Every normalized code unit is accounted for once');
  return { normalized, coordinate: 'UTF-16 code units', accepted, omitted };
}
