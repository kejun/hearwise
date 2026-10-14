import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { corpus, seed, samples, units, fromUnits, referenceMatches, referenceText, transport } from '../verification/name-interval/corpus.mjs';
import { sqliteCase } from '../verification/name-interval/differential.mjs';
import { knowledgeTermMatches, replaceKnowledgeTerm } from '../knowledge-edit.mjs';

test('name interval corpus keeps its declared deterministic UTF-16 and independent matching coverage', () => {
  const { cases } = corpus();
  assert.equal(seed, 1262832240); assert.equal(samples, 256);
  assert.equal(cases.length, 296); assert.equal(cases.filter(item => item.sqlite).length, 81);
  assert.equal(cases.reduce((sum, item) => sum + item.anchors.length, 0), 10333);
  assert.deepEqual(corpus(), corpus(), 'seed reproduces exact generated text and anchor selection');
  for (const item of cases) {
    assert.deepEqual(knowledgeTermMatches(item.text, item.source), item.matches, item.id);
    assert.equal(replaceKnowledgeTerm(item.text, item.source, item.target), referenceText(item.text, item.matches, item.target), item.id);
    assert.deepEqual(fromUnits(transport(item).text), item.text);
  }
});

test('whole terms, Unicode simple folding and literal whitespace have separately frozen expectations', () => {
  const fixed = [
    ['Deebo xDeebo Deeboverse DEEBO', 'Deebo', 'T', [{ start: 0, end: 5 }, { start: 24, end: 29 }], 'T xDeebo Deeboverse T'],
    ['张三张三', '张三', '李', [{ start: 0, end: 2 }, { start: 2, end: 4 }], '李李'],
    ['😀😀', '😀', '人', [{ start: 0, end: 2 }, { start: 2, end: 4 }], '人人'],
    ['New York|New  York|NEW YORK', 'New York', 'NY', [{ start: 0, end: 8 }, { start: 19, end: 27 }], 'NY|New  York|NY'],
    ['K k K', 'K', 'Z', [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }], 'Z Z Z'],
    ['S s ſ', 'S', 'Z', [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }], 'Z Z Z'],
    ['ß ẞ SS', 'ß', 'Z', [{ start: 0, end: 1 }, { start: 2, end: 3 }], 'Z Z SS'],
    ['Café Cafe\u0301 CAFÉ', 'Café', 'T', [{ start: 0, end: 4 }, { start: 11, end: 15 }], 'T Cafe\u0301 T'],
    ['e\u0301 e', 'e', 'X', [{ start: 0, end: 1 }, { start: 3, end: 4 }], 'X\u0301 X'],
    ['A+B AAB', 'A+B', '$&', [{ start: 0, end: 3 }], '$& AAB'],
    ['哈哈哈', '哈哈', '笑', [{ start: 0, end: 2 }], '笑哈']
  ];
  for (const [text, source, target, matches, replacement] of fixed) {
    assert.deepEqual(referenceMatches(text, source), matches);
    assert.deepEqual(knowledgeTermMatches(text, source), matches);
    assert.equal(replaceKnowledgeTerm(text, source, target), replacement);
  }
});

test('real SQLite public save persists UTF-16 anchors and leaves stale historical supports untouched', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'name-interval-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const item = { id: 'fixed-sqlite', text: 'Deebo Camera.', source: 'Deebo', target: '😀X', matches: [{ start: 0, end: 5 }],
    anchors: [{ start: 0, end: 5 }, { start: 6, end: 12 }, { start: 1, end: 2 }, { start: 3, end: 4 }, { start: 5, end: 6 }] };
  const expected = { old: units(item.text), text: units('😀X Camera.'), matches: item.matches,
    anchors: [[0, 3, '😀X'], [4, 10, 'Camera'], [0, 3, '😀X'], [0, 3, '😀X'], [3, 4, ' ']]
      .map(([start, end, quote]) => ({ start, end, quote: units(quote) })) };
  const result = sqliteCase(item, expected, path.join(directory, 'test.sqlite'));
  assert.equal(result.reopened, true); assert.equal(result.staleUnchanged, true); assert.equal(result.unlinkedUnchanged, true); assert.equal(result.otherListeningUnchanged, true);
  assert.deepEqual(result.observed[2], result.observed[3], 'disjoint old intervals inside one match can map to the same replacement');
});

test('UTF-16 transport preserves lone surrogates and rejects out-of-domain interval inputs', () => {
  const valid = { text: '😀\ud800X', target: '\udfff', matches: [{ start: 0, end: 2 }], anchors: [{ start: 1, end: 2 }] };
  assert.deepEqual(transport(valid).text, [55357, 56832, 55296, 88]);
  assert.deepEqual(transport(valid).target, [57343]);
  for (const matches of [[{ start: 1, end: 1 }], [{ start: -1, end: 1 }], [{ start: 0, end: 5 }],
    [{ start: 0, end: 3 }, { start: 2, end: 4 }], [{ start: 2, end: 3 }, { start: 0, end: 1 }]])
    assert.throws(() => transport({ ...valid, matches }), /Outside Lean domain/);
  for (const anchors of [[{ start: 0, end: 0 }], [{ start: -1, end: 1 }], [{ start: 3, end: 2 }], [{ start: 0, end: 5 }], [{ start: 0.5, end: 2 }]])
    assert.throws(() => transport({ ...valid, anchors }), /Outside Lean domain/);
  assert.throws(() => transport({ ...valid, target: '' }), /Outside Lean domain/);
  assert.equal(replaceKnowledgeTerm('A A', 'A', ''), ' ', 'empty replacement is pure-function behavior outside the nonempty-target proof domain');
});

test('public no-op branches preserve interior anchors, while an override enables the edit', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'name-interval-noop-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const item of corpus().cases.filter(row => row.group === 'no-op')) {
    const enabled = transport(item).enabled, text = enabled ? referenceText(item.text, item.matches, item.target) : item.text;
    const anchor = { start: 1, end: 2 };
    const changed = text !== item.text;
    const expected = { text: units(text), anchors: [{ start: changed ? 0 : 1, end: changed ? 5 : 2,
      quote: units(changed ? 'Deebo' : item.text.slice(1, 2)) }] };
    const observed = sqliteCase({ ...item, anchors: [anchor] }, expected, path.join(directory, `${item.id}.sqlite`));
    assert.deepEqual(observed.observed, expected.anchors);
  }
});
