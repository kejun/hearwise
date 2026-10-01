import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIdentity, findIdentitySpans } from '../identity-grounding.mjs';
import { buildEvidenceRegistry, RELATION_EVIDENCE_VERSION, RELATION_EVIDENCE_LIMITS } from '../relation-evidence.mjs';

const candidate = (id, canonical_name, extra = {}) => ({ id, canonical_name, listening_id: 'listening', aliases: [], certainty: 'clear', ...extra });
const fixture = (text = 'Atlas launched Nova.', extra = {}) => ({ listening_id: 'listening', contract_version: 'relations-v2',
  focus_segments: [{ id: 'focus', sequence_no: 2, text }], context_segments: [],
  candidates: [candidate('atlas', 'Atlas'), candidate('nova', 'Nova')], ...extra });
const sentences = text => [...text.matchAll(/[^.!?。！？]+[.!?。！？]?/gu)].map(m => ({ start: m.index, end: m.index + m[0].length, text: m[0] }));
const registry = input => buildEvidenceRegistry(input, { clauses: sentences });

test('identity normalization unifies approved case, width, spacing, quotes and dash variants', () => {
  assert.equal(normalizeIdentity('  ＡＴＬＡＳ\t “Nova”\n O’Neil — X  '), 'atlas "nova" o\'neil - x');
  assert.equal(normalizeIdentity(null), '');
  const source = '😀 ＡＴＬＡＳ\t\n  Labs and O’Neil–Works.';
  for (const name of ['atlas labs', "O'Neil-Works"]) {
    const result = findIdentitySpans(source, name);
    assert.equal(result.length, 1);
    assert.equal(source.slice(result[0].start, result[0].end), result[0].quote);
    assert.equal(normalizeIdentity(result[0].quote), normalizeIdentity(name));
  }
  assert.equal(findIdentitySpans(source, 'atlas labs')[0].start, 3, 'UTF-16 includes the emoji surrogate pair');
});

test('all original occurrences retain UTF-16 offsets and no invented spelling is admitted', () => {
  const text = 'Atlas, ATLAS, atlas; Αtlas; At1as.';
  assert.deepEqual(findIdentitySpans(text, 'Atlas').map(s => [s.start, s.end, s.quote]), [[0, 5, 'Atlas'], [7, 12, 'ATLAS'], [14, 19, 'atlas']]);
  assert.deepEqual(findIdentitySpans(text, 'Atlass'), []);
  assert.deepEqual(findIdentitySpans('Strasse', 'Straße'), []);
  assert.equal(findIdentitySpans('ος', 'ΟΣ').length, 1, 'final sigma and ordinary sigma are case variants');
  assert.deepEqual(findIdentitySpans('a', ''), []);
});

test('identity word boundaries avoid Ann in Anna and allow ordinary CJK adjacency', () => {
  const text = 'Anna Ann Ann2 Ann_ McAnn Ann, (ANN).';
  assert.deepEqual(findIdentitySpans(text, 'Ann').map(s => s.quote), ['Ann', 'Ann', 'ANN']);
  assert.equal(findIdentitySpans('中文Atlas推出Nova产品', 'Atlas').length, 1);
  assert.equal(findIdentitySpans('周杰伦发布作品', '周杰伦').length, 1);
  assert.equal(findIdentitySpans('東京でAtlasを紹介', 'Atlas').length, 1);
  assert.deepEqual(findIdentitySpans('Иванов', 'Иван'), []);
});

test('Unicode normalization maps whole graphemes without permitting partial expansion anchors', () => {
  const text = '😀 Cafe\u0301 ﬃ ①.';
  assert.deepEqual(findIdentitySpans(text, 'Café'), [{ start: 3, end: 8, quote: 'Cafe\u0301' }]);
  assert.deepEqual(findIdentitySpans(text, 'ffi'), [{ start: 9, end: 10, quote: 'ﬃ' }]);
  assert.deepEqual(findIdentitySpans(text, 'f'), []);
  assert.deepEqual(findIdentitySpans(text, 'fi'), []);
  assert.deepEqual(findIdentitySpans(text, '1'), [{ start: 11, end: 12, quote: '①' }]);
});

test('registry anchors normalized upstream canonical identity with untouched source slices', () => {
  const source = 'atlas developed Nova.';
  const input = fixture(source);
  input.candidates[0].mentions = [{ segment_id: 'focus', surface_text: source }];
  const result = registry(input);
  assert.equal(result.coverage_limited, false);
  assert.equal(result.mentions.length, 2);
  assert.equal(result.mentions.find(m => m.item_id === 'atlas').quote, 'atlas');
  assert.equal(result.spans[0].quote, source);
  for (const mention of result.mentions) {
    assert.equal(source.slice(mention.start, mention.end), mention.quote);
    assert.deepEqual(mention.span_ids, [result.spans[0].id]);
  }
});

test('same-segment prior sentence anchors have server source positions and clause membership', () => {
  const result = registry(fixture('Atlas is a company. It launched Nova.'));
  assert.equal(result.spans.length, 2);
  const atlas = result.mentions.find(m => m.item_id === 'atlas'), nova = result.mentions.find(m => m.item_id === 'nova');
  assert.ok(atlas.end < result.spans[1].start);
  assert.deepEqual(atlas.span_ids, [result.spans[0].id]);
  assert.deepEqual(nova.span_ids, [result.spans[1].id]);
});

test('knowledge evidence quotations never become identity aliases', () => {
  const result = registry(fixture('It launched Nova.', { candidates: [candidate('atlas', 'Atlas', { mentions: [
    { segment_id: 'focus', surface_text: 'It launched Nova.' }, { segment_id: 'focus', surface_text: 'fabricated Atlas' }
  ] }), candidate('nova', 'Nova')] }));
  assert.deepEqual(result.mentions.map(m => m.item_id), ['nova']);
  assert.equal(result.diagnostics.invalid_source_mentions, 1);
  const abbreviated = registry(fixture('AT launched Nova.'));
  assert.equal(abbreviated.mentions.some(m => m.item_id === 'atlas'), false);
  const approved = registry(fixture('AT launched Nova.', { candidates: [candidate('atlas', 'Atlas', { aliases: ['AT'] }), candidate('nova', 'Nova')] }));
  assert.equal(approved.mentions.find(m => m.item_id === 'atlas').quote, 'AT');
});

test('shared normalized aliases are ambiguous while unique canonical names remain usable', () => {
  const input = fixture('AT met Atlas Corp and Another Team.', { candidates: [
    candidate('atlas', 'Atlas Corp', { aliases: ['ＡＴ'] }), candidate('other', 'Another Team', { aliases: ['at'] })
  ] });
  const result = registry(input);
  assert.equal(result.diagnostics.ambiguous_names, 1);
  assert.equal(result.diagnostics.ambiguous_occurrences, 1);
  assert.deepEqual(result.mentions.map(m => m.quote).sort(), ['Another Team', 'Atlas Corp']);
  assert.ok(!JSON.stringify(result.diagnostics).includes('Atlas'));
});

test('nested shorter names cannot anchor a different entity inside a uniquely named entity', () => {
  const result = registry(fixture('Acme Corp released Acme.', { candidates: [candidate('a', 'Acme'), candidate('b', 'Acme Corp')] }));
  assert.equal(result.mentions.filter(m => m.item_id === 'a').length, 1);
  assert.equal(result.mentions.find(m => m.item_id === 'a').start, 19);
  assert.equal(result.mentions.find(m => m.item_id === 'b').quote, 'Acme Corp');
});

test('prefix and suffix context preserve exact separate source provenance', () => {
  const text = 'According to Mira. Atlas launched Nova. That is not true.';
  const start = text.indexOf('Atlas'), end = text.indexOf(' That');
  const result = buildEvidenceRegistry(fixture(text), { clauses: () => [{ start, end,
    prefix: 'According to Mira.', suffix: ' That is not true.' }] });
  assert.equal(result.spans[0].quote, 'Atlas launched Nova.');
  assert.deepEqual(result.spans[0].prefix_spans, [{ start: 0, end: 18, quote: 'According to Mira.' }]);
  assert.deepEqual(result.spans[0].suffix_spans, [{ start: end, end: text.length, quote: ' That is not true.' }]);
  assert.equal(result.spans[0].needs_review, undefined);
  const invalid = buildEvidenceRegistry(fixture(text), { clauses: () => [{ start, end, prefix: 'Invented frame' }] });
  assert.equal(invalid.coverage_limited, true);
  assert.equal(invalid.spans[0].prefix, undefined);
  assert.equal(invalid.spans[0].needs_review, true);
});

test('IDs are stable across input ordering and scope but version binds the whole registry snapshot', () => {
  const input = fixture('Atlas launched Nova.', { context_segments: [{ id: 'context', sequence_no: 1, text: 'Atlas is a company.' }] });
  const first = registry(input), reordered = registry({ ...input, candidates: [...input.candidates].reverse() });
  assert.deepEqual(reordered, first);
  assert.match(first.version, new RegExp(`^${RELATION_EVIDENCE_VERSION}:`));
  const changedScope = registry({ ...input, context_segments: [...input.context_segments, ...input.focus_segments], focus_segments: [] });
  assert.deepEqual(changedScope.spans.map(s => s.id), first.spans.map(s => s.id));
  assert.deepEqual(changedScope.mentions.map(s => s.id), first.mentions.map(s => s.id));
  assert.notEqual(changedScope.version, first.version);
  const changedRevision = registry({ ...input, focus_segments: [{ ...input.focus_segments[0], source_revision: 'full-source-revision' }] });
  assert.notEqual(changedRevision.version, first.version);
  assert.notEqual(changedRevision.spans[1].id, first.spans[1].id);
  const changedCandidate = registry({ ...input, candidates: [candidate('atlas', 'Atlas', { aliases: ['AT'] }), input.candidates[1]] });
  assert.notEqual(changedCandidate.version, first.version);
  const uncertain = registry({ ...input, candidates: [{ ...input.candidates[0], certainty: 'needs_review' }, input.candidates[1]] });
  assert.notEqual(uncertain.version, first.version);
  assert.notEqual(registry({ ...input, contract_version: 'relations-v3' }).version, first.version);
  assert.notEqual(registry({ ...input, candidates: [{ ...input.candidates[0], type: 'person' }, input.candidates[1]] }).version, first.version);
});

test('full original source revision survives a bounded source snapshot', () => {
  const input = fixture(); input.focus_segments[0].source_revision = 'original-full-source-hash';
  const result = registry(input);
  assert.ok([...result.spans, ...result.mentions].every(s => s.source_revision === 'original-full-source-hash'));
});

test('long clauses split bounded exact quotes without splitting surrogate pairs and become review-only', () => {
  const text = 'x'.repeat(1999) + '😀 Atlas launched Nova.';
  const result = buildEvidenceRegistry(fixture(text));
  assert.equal(result.spans.length, 2);
  assert.equal(result.spans.map(s => s.quote).join(''), text);
  assert.ok(result.spans.every(s => s.quote.length <= RELATION_EVIDENCE_LIMITS.spanChars && s.fragmented && s.needs_review));
  assert.equal(result.spans[0].end, 1999);
});

test('registry limits are deterministic and mark omitted source, mentions or clauses', () => {
  const many = registry(fixture('Atlas. '.repeat(300)));
  assert.equal(many.spans.length, RELATION_EVIDENCE_LIMITS.spans);
  assert.equal(many.coverage_limited, true);
  const mentions = buildEvidenceRegistry(fixture('Atlas '.repeat(600)));
  assert.equal(mentions.mentions.length, RELATION_EVIDENCE_LIMITS.mentions);
  assert.equal(mentions.coverage_limited, true);
  const input = fixture(undefined, { context_segments: Array.from({ length: 20 }, (_, n) => ({ id: `ctx-${n}`, text: 'Atlas', sequence_no: n - 20 })) });
  const capped = registry(input);
  assert.ok(capped.spans.some(s => s.scope === 'focus'));
  assert.ok(capped.spans.length <= RELATION_EVIDENCE_LIMITS.segments);
  assert.equal(capped.coverage_limited, true);
});

test('invalid source coordinates and conflicting duplicate segments cannot create evidence', () => {
  const invalid = buildEvidenceRegistry(fixture(), { clauses: () => [{ start: -1, end: 3 }, { start: 0, end: 10000 }] });
  assert.deepEqual(invalid.spans, []); assert.deepEqual(invalid.mentions, []); assert.equal(invalid.coverage_limited, true);
  const conflict = registry(fixture('Atlas launched Nova.', { context_segments: [{ id: 'focus', text: 'A different source.' }] }));
  assert.deepEqual(conflict.spans, []); assert.deepEqual(conflict.mentions, []); assert.equal(conflict.coverage_limited, true);
});

test('repeated inherited frame provenance is capped, exact and review-only when incomplete', () => {
  const text = 'If approved. '.repeat(30) + 'Atlas launched Nova.';
  const start = text.indexOf('Atlas');
  const result = buildEvidenceRegistry(fixture(text), { clauses: () => [{ start, end: text.length, prefix: 'If approved.' }] });
  assert.equal(result.spans[0].prefix_spans.length, RELATION_EVIDENCE_LIMITS.frameOccurrences);
  assert.equal(result.spans[0].needs_review, true);
  assert.equal(result.coverage_limited, true);
  assert.ok(result.spans[0].prefix_spans.every(s => text.slice(s.start, s.end) === s.quote));
});
