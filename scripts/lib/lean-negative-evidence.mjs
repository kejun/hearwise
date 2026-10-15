import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as revision from '../../verification/revision/corpus.mjs';
import * as names from '../../verification/name-interval/corpus.mjs';
import { digest } from './verification-evidence.mjs';

// Reconstruct the fixed counterexamples from checked-in contracts, never flags
// or executable code supplied by a report. No proof tool or mutant is executed.
async function revisionMutations() {
  const source = await readFile('knowledge-revision.mjs', 'utf8');
  const changes = [
    ['omit-background-note', "'background_note', 'certainty', 'display_label'", "'certainty', 'display_label'"],
    ['reverse-serialized-order', 'left < right ? -1 : left > right ? 1 : 0', 'left < right ? 1 : left > right ? -1 : 0'],
    ['collapse-falsy-to-null', 'row[key] ?? null', 'row[key] || null']
  ];
  return changes.map(([id, from, to]) => {
    assert.equal(source.split(from).length, 2);
    const snapshot = revision.baseline();
    if (id === 'omit-background-note') snapshot.item.background_note = 'field required';
    if (id === 'collapse-falsy-to-null') { snapshot.item.background_note = ''; snapshot.segments[0].begin_ms = 0; }
    const row = (value, keys, item = false) => Object.fromEntries(keys
      .filter(key => !(item && id === 'omit-background-note' && key === 'background_note'))
      .map(key => [key, id === 'collapse-falsy-to-null' ? value[key] || null : value[key] ?? null]));
    const ordered = values => {
      const serialized = values.map(value => JSON.stringify(value)).sort();
      if (id === 'reverse-serialized-order') serialized.reverse();
      return serialized.map(value => JSON.parse(value));
    };
    const actual = digest(JSON.stringify({ version: 1, item: { ...row(snapshot.item, revision.fields.item, true),
      aliases: ordered(snapshot.item.aliases || []),
      ...Object.fromEntries(['mentions', 'revisions', 'facts'].map(key => [key,
        ordered((snapshot.item[key] || []).map(value => row(value, revision.fields[key])))])) },
      segments: ordered(snapshot.segments.map(value => row(value, revision.fields.segments))) }));
    const expected = digest(revision.referenceJSON(snapshot));
    assert.notEqual(actual, expected);
    return { id, detected: true, sourceDigest: digest(source.replace(from, to)), expected, actual, witness: revision.transport(snapshot) };
  });
}
async function nameMutation() {
  const source = await readFile('knowledge-name-replacement.mjs', 'utf8');
  const from = 'name.length', to = '[...name].length';
  assert.equal(source.split(from).length - 1, 2);
  const mutated = source.replaceAll(from, to);
  const runnable = mutated.replace(/from '(\.\/[^']+)'/g, (_, file) => `from '${pathToFileURL(path.resolve(file)).href}'`);
  const item = names.corpus().cases.find(item => item.id === 'emoji-target');
  const start = item.text.indexOf('Camera'), end = start + 'Camera'.length;
  const originalAnchor = item.anchors.find(anchor => anchor.start === start && anchor.end === end);
  assert.ok(originalAnchor);
  const text = names.referenceText(item.text, item.matches, item.target);
  const mapped = length => {
    const point = (offset, isEnd) => {
      let shift = 0;
      for (const match of item.matches) {
        if (offset <= match.start) break;
        if (offset < match.end) return match.start + shift + (isEnd ? length : 0);
        shift += length - (match.end - match.start);
      }
      return offset + shift;
    };
    const first = point(start, false), last = point(end, true);
    return { start: first, end: last, quote: names.units(text.slice(first, last)) };
  };
  const expected = mapped(item.target.length), actual = mapped([...item.target].length);
  assert.notDeepEqual(actual, expected);
  return [{ id: 'codepoint-vs-utf16-length', detected: true, sourceFile: 'knowledge-name-replacement.mjs',
    originalDigest: digest(source), mutatedDigest: digest(mutated), runnableDigest: digest(runnable), replacements: 2,
    patch: { from, to }, publicEntry: 'ListeningStore.replaceKnowledgeName', evidenceTable: 'relation_supports',
    witness: { input: names.transport({ ...item, anchors: [originalAnchor] }), source: item.source, target: item.target,
      originalAnchor, expected, actual, persistedText: names.units(text) } }];
}

const invalidChanges = [
  ['empty-target', { target: [] }], ['empty-match', { matches: [{ start: 1, end: 1 }] }],
  ['overlapping-matches', { matches: [{ start: 0, end: 3 }, { start: 2, end: 4 }] }],
  ['unsorted-matches', { matches: [{ start: 2, end: 3 }, { start: 0, end: 1 }] }],
  ['out-of-bounds-match', { matches: [{ start: 1, end: 5 }] }],
  ['empty-anchor', { anchors: [{ start: 1, end: 1 }] }], ['reversed-anchor', { anchors: [{ start: 2, end: 1 }] }],
  ['out-of-bounds-anchor', { anchors: [{ start: 0, end: 5 }] }], ['negative-anchor', { anchors: [{ start: -1, end: 2 }] }],
  ['fractional-anchor', { anchors: [{ start: 0.5, end: 2 }] }],
  ['invalid-text-unit', { text: [65536, 66, 67, 68] }], ['invalid-target-unit', { target: [65536] }]
];
export async function validateNegativeEvidence(kind, differential) {
  if (kind === 'revision') {
    assert.deepEqual(differential.mutations, await revisionMutations());
    assert.deepEqual(differential.outsideProofDomain, ['fractional-number', 'non-finite-number', 'BigInt rejection', 'ignored complex property', 'fractional/unsafe SQLite timing values']);
    return;
  }
  assert.deepEqual(differential.mutations, await nameMutation());
  // Bind imported invalid coordinates and quotes to the current fixture text.
  const fixture = await readFile('test-support/name-replacement-fixture.mjs', 'utf8');
  const literal = fixture.match(/text: '([^']+)' \}\)\.segment/);
  assert.ok(literal);
  const text = literal[1];
  const imported = ['append', 'replace'].flatMap(mode => [
    ['empty', 0, 0], ['negative', -1, text.length], ['reversed', 3, 2], ['out-of-bounds', 0, 1000],
    ['fractional-start', 0.5, 5], ['fractional-end', 0, 4.5]
  ].map(([id, start, end]) => {
    const before = { start, end, quote: text.slice(start, end), state: 'active' };
    return { id: `import-${mode}-${id}`, mode, before, after: before, status: 409,
      imported: true, unchanged: true, reopened: true, receiptAbsent: true };
  }));
  assert.deepEqual(differential.importedInvalid, imported);
  assert.deepEqual(differential.invalid, [
    ...['empty-name', 'whitespace-name', 'overlong-utf16-name', 'control-name', 'wrong-name-type', 'unknown-field', 'malformed-revision',
      'stale-revision', 'invalid-id', 'invalid-active-quote', 'invalid-active-source_revision'].map(id =>
      ({ id, status: id === 'stale-revision' || id.startsWith('invalid-active-') ? 409 : 400, unchanged: true })),
    { id: 'target-trim', target: 'Tibo', accepted: true }, { id: 'maximum-160-utf16-name', utf16Length: 160, accepted: true }
  ]);
  assert.deepEqual(differential.collision, { publicCommitAccepted: true, code: 'ERR_SQLITE_ERROR', constraint: 'UNIQUE', unchanged: true,
    receiptAbsent: true, oldAnchors: [{ start: 1, end: 2, quote: 'e' }, { start: 3, end: 4, quote: 'b' }], mappedCollision: { start: 0, end: 4, quote: 'Tibo' } });
  assert.deepEqual(differential.outsideProofDomain, ['empty-target', 'negative-match', 'empty-match', 'out-of-bounds-match',
    'overlapping-matches', 'unsorted-matches', 'negative-anchor', 'empty-anchor', 'reversed-anchor', 'out-of-bounds-anchor',
    'fractional-anchor', 'unsafe-anchor'].map(id => ({ id, adapterRejected: true })));
  assert.deepEqual(differential.boundaries, [
    'Matching/case-folding/boundaries are finite independent implementation tests, not Lean theorems.',
    'SQLite evidence is synthetic; malformed UTF-16 strings/quotes are tested only in pure UTF-16 transport.',
    'Empty replacement targets, malformed intervals and invalid API inputs are implementation/domain tests, not proof cases.',
    'Imported malformed active coordinates are rejected atomically; stale historical supports remain untouched.',
    'Intersecting anchors expand to replacement endpoints; no general disjointness preservation is claimed.'
  ]);
  const base = { enabled: true, text: [65, 66, 67, 68], target: [88], matches: [{ start: 0, end: 2 }], anchors: [{ start: 0, end: 4 }] };
  assert.deepEqual(differential.invalidOracle.map(({ id, input }) => ({ id, input })), invalidChanges.map(([id, change]) => ({ id, input: { ...base, ...change } })));
}
