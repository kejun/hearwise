import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ListeningStore } from '../../storage.mjs';
import { importedInvalidAnchors, collidingMappedAnchors } from '../../test-support/name-replacement-import-fixture.mjs';
import { seedNameReplacement } from '../../test-support/name-replacement-fixture.mjs';
import { knowledgeTermMatches, replaceKnowledgeTerm } from '../../knowledge-edit.mjs';
import { corpus, transport, units, fromUnits, referenceText, seed, samples } from './corpus.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const supports = (store, segmentId) => store.db.prepare('SELECT * FROM relation_supports WHERE segment_id=? ORDER BY id').all(segmentId);

function prepareCase(store, item, expected) {
  const seeded = seedNameReplacement(store, { graph: true });
  const template = supports(store, seeded.segment.id)[0];
  // Existing real fixture creates the graph, jobs, assertions and identities.
  // Only synthetic transcript/anchors are reseeded; production triggers and the
  // public replaceKnowledgeName transaction remain installed and unmodified.
  store.db.prepare('DELETE FROM relation_supports WHERE segment_id=?').run(seeded.segment.id);
  store.db.prepare('UPDATE segments SET original_text=? WHERE id IN (?,?)').run(item.text, seeded.segment.id, seeded.other.id);
  store.db.prepare('UPDATE knowledge_items SET canonical_name=?,normalized_name=? WHERE id=?')
    .run(item.source, item.source.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' '), seeded.item.id);
  store.db.prepare('UPDATE knowledge_items SET name_override=? WHERE id=?').run(item.nameOverride ?? null, seeded.item.id);
  store.db.prepare('DELETE FROM knowledge_aliases WHERE item_id=?').run(seeded.item.id);
  store.db.prepare('UPDATE knowledge_mentions SET surface_text=? WHERE segment_id=?').run(item.text, seeded.segment.id);
  store.db.prepare('UPDATE knowledge_facts SET surface_text=?,content=? WHERE segment_id=?').run(item.text, item.text, seeded.segment.id);
  const indexes = item.anchors.flatMap(({ start, end }, index) => {
    const oldQuote = item.text.slice(start, end), newQuote = fromUnits(expected.anchors[index].quote);
    return oldQuote.trim() && oldQuote.isWellFormed() && newQuote.isWellFormed() ? [index] : [];
  });
  const insert = store.db.prepare(`INSERT INTO relation_supports
    (id,assertion_id,job_id,window_id,window_revision,segment_id,source_revision,group_id,start,end,quote,role,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const index of indexes) {
    const { start, end } = item.anchors[index];
    insert.run(`anchor-${index}`, template.assertion_id, template.job_id, template.window_id, template.window_revision,
      seeded.segment.id, hash(item.text), `synthetic-group-${index}`, start, end, item.text.slice(start, end), 'relation', 'active', template.created_at);
  }
  // An already-invalid historical support must neither move nor reactivate,
  // including when its old revision, coordinates and quote are all invalid.
  insert.run('stale-history', template.assertion_id, template.job_id, template.window_id, template.window_revision,
    seeded.segment.id, '0'.repeat(64), 'synthetic-stale-group', -3, item.text.length + 9, 'obsolete synthetic quote', 'relation', 'stale', template.created_at);
  const isolated = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Unrelated synthetic listening');
  const isolatedSegment = store.addSegment(isolated.listeningId, isolated.runId, { id: 'unrelated', text: item.text }).segment;
  store.finishRun(isolated.runId);
  return { ...seeded, indexes, isolatedSegment };
}

export function sqliteCase(item, expected, filename, { Store = ListeningStore, compare = true } = {}) {
  let store = new Store(filename);
  try {
    const seeded = prepareCase(store, item, expected);
    const before = supports(store, seeded.segment.id);
    const snapshot = store.knowledgeEditSnapshot(seeded.listeningId, seeded.item.id);
    const receiptId = randomUUID();
    const result = store.replaceKnowledgeName(seeded.listeningId, seeded.item.id, receiptId,
      { name: item.target, revision: snapshot.revision });
    assert.equal(result.job.state, 'succeeded');
    assert.equal(result.item.id, seeded.item.id);
    assert.equal(result.item.canonical_name, item.target);
    store.close(); store = new Store(filename);
    const persistedText = store.db.prepare('SELECT original_text FROM segments WHERE id=?').get(seeded.segment.id).original_text;
    const after = supports(store, seeded.segment.id);
    assert.deepEqual(after.map(row => [row.id, row.group_id, row.state]), before.map(row => [row.id, row.group_id, row.state]));
    assert.deepEqual(after.find(row => row.id === 'stale-history'), before.find(row => row.id === 'stale-history'));
    assert.equal(store.db.prepare('SELECT original_text FROM segments WHERE id=?').get(seeded.other.id).original_text, item.text, 'unlinked segment remains unchanged');
    assert.equal(store.db.prepare('SELECT original_text FROM segments WHERE id=?').get(seeded.isolatedSegment.id).original_text, item.text, 'other listening remains unchanged');
    const observed = seeded.indexes.map(index => {
      const row = after.find(row => row.id === `anchor-${index}`);
      assert.equal(row.source_revision, hash(persistedText));
      assert.equal(row.quote, persistedText.slice(row.start, row.end));
      return { start: row.start, end: row.end, quote: units(row.quote) };
    });
    if (compare) {
      assert.deepEqual(units(persistedText), expected.text, `persisted text: ${item.id}`);
      assert.deepEqual(observed, seeded.indexes.map(index => expected.anchors[index]), `persisted mapped anchors: ${item.id}`);
    }
    return { id: item.id, listeningId: seeded.listeningId, segmentId: seeded.segment.id, itemId: seeded.item.id, receiptId,
      old: units(snapshot.segments[0].original_text), text: units(persistedText), anchorIndexes: seeded.indexes,
      excludedPersistenceAnchors: item.anchors.length - seeded.indexes.length,
      observed, before, after, reopened: true, staleUnchanged: true, unlinkedUnchanged: true, otherListeningUnchanged: true };
  } finally { store.close(); }
}

function invalidInputs(filename) {
  const store = new ListeningStore(filename), observations = [];
  try {
    const seeded = seedNameReplacement(store, { graph: true });
    const snapshot = () => store.knowledgeEditSnapshot(seeded.listeningId, seeded.item.id);
    const initial = snapshot(), graph = store.graph(seeded.listeningId);
    const invalid = [
      ['empty-name', { name: '' }], ['whitespace-name', { name: ' \u3000 ' }],
      ['overlong-utf16-name', { name: '😀'.repeat(81) }], ['control-name', { name: 'T\nibo' }],
      ['wrong-name-type', { name: 42 }], ['unknown-field', { extra: true }],
      ['malformed-revision', { revision: 'not-a-revision' }], ['stale-revision', { revision: '0'.repeat(64) }]
    ];
    for (const [id, extra] of invalid) {
      let error;
      try { store.replaceKnowledgeName(seeded.listeningId, seeded.item.id, randomUUID(), { name: 'Tibo', revision: initial.revision, ...extra }); }
      catch (caught) { error = caught; }
      assert.ok(error && [400, 409].includes(error.status), id);
      assert.deepEqual(snapshot(), initial); assert.deepEqual(store.graph(seeded.listeningId), graph);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM knowledge_edit_jobs').get().n, 0);
      observations.push({ id, status: error.status, unchanged: true });
    }
    assert.throws(() => store.replaceKnowledgeName(seeded.listeningId, seeded.item.id, 'invalid-id', { name: 'Tibo', revision: initial.revision }), error => error.status === 400);
    observations.push({ id: 'invalid-id', status: 400, unchanged: true });
    for (const field of ['quote', 'source_revision']) {
      const anchor = supports(store, seeded.segment.id)[0];
      store.db.prepare(`UPDATE relation_supports SET ${field}=? WHERE id=?`).run(field === 'quote' ? 'wrong source quote' : '0'.repeat(64), anchor.id);
      const corrupt = supports(store, seeded.segment.id);
      assert.throws(() => store.replaceKnowledgeName(seeded.listeningId, seeded.item.id, randomUUID(),
        { name: 'Tibo', revision: snapshot().revision }), error => error.status === 409);
      assert.deepEqual(snapshot(), initial); assert.deepEqual(supports(store, seeded.segment.id), corrupt);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM knowledge_edit_jobs').get().n, 0);
      observations.push({ id: `invalid-active-${field}`, status: 409, unchanged: true });
      store.db.prepare(`UPDATE relation_supports SET ${field}=? WHERE id=?`).run(anchor[field], anchor.id);
    }
    // Input target trimming is API behavior outside the raw interval model.
    store.replaceKnowledgeName(seeded.listeningId, seeded.item.id, randomUUID(), { name: '  Tibo  ', revision: snapshot().revision });
    assert.equal(snapshot().item.canonical_name, 'Tibo');
    observations.push({ id: 'target-trim', target: 'Tibo', accepted: true });
    store.replaceKnowledgeName(seeded.listeningId, seeded.item.id, randomUUID(), { name: '😀'.repeat(80), revision: snapshot().revision });
    assert.equal(snapshot().item.canonical_name.length, 160);
    observations.push({ id: 'maximum-160-utf16-name', utf16Length: 160, accepted: true });
    return observations;
  } finally { store.close(); }
}

function rejectedDomain() {
  const base = { text: 'ABCD', target: 'X', matches: [{ start: 0, end: 2 }], anchors: [{ start: 0, end: 4 }] };
  const changes = [
    ['empty-target', { target: '' }], ['negative-match', { matches: [{ start: -1, end: 1 }] }],
    ['empty-match', { matches: [{ start: 1, end: 1 }] }], ['out-of-bounds-match', { matches: [{ start: 1, end: 5 }] }],
    ['overlapping-matches', { matches: [{ start: 0, end: 3 }, { start: 2, end: 4 }] }],
    ['unsorted-matches', { matches: [{ start: 2, end: 3 }, { start: 0, end: 1 }] }],
    ['negative-anchor', { anchors: [{ start: -1, end: 2 }] }], ['empty-anchor', { anchors: [{ start: 1, end: 1 }] }],
    ['reversed-anchor', { anchors: [{ start: 2, end: 1 }] }], ['out-of-bounds-anchor', { anchors: [{ start: 0, end: 5 }] }],
    ['fractional-anchor', { anchors: [{ start: 0.5, end: 2 }] }], ['unsafe-anchor', { anchors: [{ start: 0, end: Number.MAX_SAFE_INTEGER + 1 }] }]
  ];
  for (const [, change] of changes) assert.throws(() => transport({ ...base, ...change }), /Outside Lean domain/);
  // Public pure-function semantics are recorded, never passed off as API/proof coverage.
  assert.deepEqual(knowledgeTermMatches('A A', ''), []);
  assert.equal(replaceKnowledgeTerm('A A', 'A', ''), ' ');
  assert.throws(() => knowledgeTermMatches('A', 42), TypeError);
  assert.throws(() => knowledgeTermMatches(null, 'A'), TypeError);
  return changes.map(([id]) => ({ id, adapterRejected: true }));
}

async function verifyWitness(directory, temporary, expected) {
  const filename = path.join(temporary, 'witness-readonly-copy.sqlite');
  await copyFile(path.join(directory, 'sqlite-witness.sqlite'), filename);
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(database.prepare('SELECT * FROM relation_supports WHERE segment_id=? ORDER BY id').all(expected.segmentId), expected.after);
    assert.deepEqual(units(database.prepare('SELECT original_text FROM segments WHERE id=?').get(expected.segmentId).original_text), expected.text);
    return { selfContained: true, integrity: 'ok', readOnlyCopy: true, rows: expected.after.length };
  } finally { database.close(); }
}

async function mutations(directory, item, expected) {
  const filename = path.join(root, 'knowledge-name-replacement.mjs');
  const source = await readFile(filename, 'utf8');
  const from = 'name.length', to = '[...name].length';
  assert.equal(source.split(from).length - 1, 2, 'both private mapper length operations are mutated');
  const mutated = source.replaceAll(from, to);
  // Resolve unchanged imports to the actual checkout. Do not export, instrument
  // or directly invoke mappedOffset; exercise the mutated public store method.
  const runnable = mutated.replace(/from '(\.\/[^']+)'/g, (_, specifier) => `from '${pathToFileURL(path.join(root, specifier)).href}'`);
  const file = path.join(directory, 'codepoint-length.mjs');
  await writeFile(file, runnable);
  const module = await import(pathToFileURL(file).href);
  class MutantStore extends ListeningStore {}
  Object.assign(MutantStore.prototype, module.knowledgeNameReplacementMethods);
  const start = item.text.indexOf('Camera'), end = start + 'Camera'.length;
  const selected = item.anchors.findIndex(anchor => anchor.start === start && anchor.end === end);
  assert.ok(selected >= 0, 'nonintersecting UTF-16 mutation witness anchor exists');
  item = { ...item, anchors: [item.anchors[selected]] };
  expected = { ...expected, anchors: [expected.anchors[selected]] };
  const observed = sqliteCase(item, expected, path.join(directory, 'mutant.sqlite'), { Store: MutantStore, compare: false });
  const expectedAnchors = observed.anchorIndexes.map(index => expected.anchors[index]);
  const mismatch = observed.observed.findIndex((anchor, index) => JSON.stringify(anchor) !== JSON.stringify(expectedAnchors[index]));
  assert.ok(mismatch >= 0, 'code-point versus UTF-16 production mutation escaped');
  const index = observed.anchorIndexes[mismatch];
  return [{ id: 'codepoint-vs-utf16-length', detected: true, sourceFile: 'knowledge-name-replacement.mjs',
    originalDigest: hash(source), mutatedDigest: hash(mutated), runnableDigest: hash(runnable), replacements: 2,
    patch: { from, to }, publicEntry: 'ListeningStore.replaceKnowledgeName', evidenceTable: 'relation_supports',
    witness: { input: transport(item), source: item.source, target: item.target, originalAnchor: item.anchors[index],
      expected: expected.anchors[index], actual: observed.observed[mismatch], persistedText: observed.text } }];
}

async function invalidOracleCases(directory, temporary) {
  const base = { enabled: true, text: [65, 66, 67, 68], target: [88], matches: [{ start: 0, end: 2 }], anchors: [{ start: 0, end: 4 }] };
  const invalid = [
    ['empty-target', { target: [] }], ['empty-match', { matches: [{ start: 1, end: 1 }] }],
    ['overlapping-matches', { matches: [{ start: 0, end: 3 }, { start: 2, end: 4 }] }],
    ['unsorted-matches', { matches: [{ start: 2, end: 3 }, { start: 0, end: 1 }] }],
    ['out-of-bounds-match', { matches: [{ start: 1, end: 5 }] }],
    ['empty-anchor', { anchors: [{ start: 1, end: 1 }] }],
    ['reversed-anchor', { anchors: [{ start: 2, end: 1 }] }],
    ['out-of-bounds-anchor', { anchors: [{ start: 0, end: 5 }] }],
    ['negative-anchor', { anchors: [{ start: -1, end: 2 }] }],
    ['fractional-anchor', { anchors: [{ start: 0.5, end: 2 }] }],
    ['invalid-text-unit', { text: [65536, 66, 67, 68] }],
    ['invalid-target-unit', { target: [65536] }]
  ];
  const results = [];
  for (const [id, change] of invalid) {
    const input = { ...base, ...change }, inputFile = path.join(temporary, 'invalid-input.ndjson');
    await writeFile(inputFile, JSON.stringify(input) + '\n');
    const execution = await runProcess(path.join(root, 'verification/lean/.lake/build/bin/name_interval_oracle'),
      [inputFile, path.join(temporary, 'invalid-output.ndjson')], { timeoutMs: 1000 });
    const rejected = execution.code === 1 && execution.signal === null && !execution.timedOut && !execution.interrupted && !execution.error;
    results.push({ id, input, rejected, execution });
    await writeFile(path.join(directory, 'invalid-oracle.json'), json(results));
    await writeFile(path.join(directory, 'invalid-oracle.log'), results.map(result => `${result.id}: ${JSON.stringify(result.execution)}\n`).join(''));
    assert.equal(rejected, true, `oracle must explicitly reject ${id}: ${JSON.stringify(execution)}`);
  }
  return results;
}

export async function main(directory) {
  directory = path.resolve(directory);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, 'temporary-database');
  const mutantDirectory = path.join(directory, 'temporary-mutants');
  await mkdir(temporary, { recursive: true }); await mkdir(mutantDirectory, { recursive: true });
  const { cases } = corpus();
  const observations = [], sqlite = [];
  await writeFile(path.join(directory, 'differential.json'), json({ complete: false, ok: false, seed }));
  try {
    for (const item of cases) {
      assert.deepEqual(knowledgeTermMatches(item.text, item.source), item.matches, `independent matching: ${item.id}`);
      assert.equal(replaceKnowledgeTerm(item.text, item.source, item.target), referenceText(item.text, item.matches, item.target), `independent replacement: ${item.id}`);
    }
    const input = path.join(directory, 'corpus.ndjson'), output = path.join(directory, 'lean-projections.ndjson');
    await writeFile(input, cases.map(item => JSON.stringify(transport(item))).join('\n') + '\n');
    await writeFile(path.join(directory, 'case-index.json'), json(cases.map(({ id, group, source, sqlite }) => ({ id, group, source, sqlite }))));
    const execution = await runProcess(path.join(root, 'verification/lean/.lake/build/bin/name_interval_oracle'), [input, output],
      { logFile: path.join(directory, 'oracle.log'), timeoutMs: 60000 });
    await writeFile(path.join(directory, 'oracle-execution.json'), json(execution));
    assert.equal(execution.ok, true, execution.tail);
    const lines = (await readFile(output, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, cases.length, 'oracle must complete every input');
    const expected = lines.map(line => JSON.parse(line));
    for (let index = 0; index < cases.length; index++) {
      const item = cases[index], result = expected[index];
      assert.deepEqual(result.old, units(item.text), `Lean reconstruction: ${item.id}`);
      assert.deepEqual(result.matches, item.matches, `Lean match reconstruction: ${item.id}`);
      assert.deepEqual(result.rawText, units(replaceKnowledgeTerm(item.text, item.source, item.target)), `Lean/pure replacement: ${item.id}`);
      const effectiveText = transport(item).enabled ? replaceKnowledgeTerm(item.text, item.source, item.target) : item.text;
      assert.deepEqual(result.text, units(effectiveText), `Lean/public effective text: ${item.id}`);
      if (effectiveText === item.text) assert.deepEqual(result.anchors, item.anchors.map(({ start, end }) =>
        ({ start, end, quote: units(item.text.slice(start, end)) })), `public no-op coordinates: ${item.id}`);
      assert.equal(result.anchors.length, item.anchors.length);
      let unchanged = 0, intersecting = 0;
      for (let anchorIndex = 0; anchorIndex < item.anchors.length; anchorIndex++) {
        const anchor = item.anchors[anchorIndex], mapped = result.anchors[anchorIndex];
        assert.ok(Number.isSafeInteger(mapped.start) && Number.isSafeInteger(mapped.end) && 0 <= mapped.start && mapped.start < mapped.end && mapped.end <= result.text.length);
        assert.deepEqual(mapped.quote, result.text.slice(mapped.start, mapped.end));
        const touches = item.matches.some(match => anchor.start < match.end && match.start < anchor.end);
        if (!touches) { assert.deepEqual(mapped.quote, units(item.text.slice(anchor.start, anchor.end)), `unchanged span: ${item.id}`); unchanged++; }
        else intersecting++;
      }
      observations.push({ id: item.id, group: item.group, oldUnits: item.text.length, newUnits: result.text.length,
        matches: item.matches.length, anchors: item.anchors.length, unchanged, intersecting });
      if (item.sqlite) {
        const filename = path.join(temporary, 'case.sqlite');
        const observed = sqliteCase(item, result, filename);
        sqlite.push(observed);
        if (item.id === 'emoji-target') await copyFile(filename, path.join(directory, 'sqlite-witness.sqlite'));
        await rm(filename, { force: true }); await rm(filename + '-wal', { force: true }); await rm(filename + '-shm', { force: true });
      }
    }
    const invalid = invalidInputs(path.join(temporary, 'invalid.sqlite'));
    const domain = rejectedDomain();
    const importedInvalid = importedInvalidAnchors(temporary);
    const collision = collidingMappedAnchors();
    const witnessVerification = await verifyWitness(directory, temporary, sqlite.find(item => item.id === 'emoji-target'));
    const invalidOracle = await invalidOracleCases(directory, temporary);
    const witnessIndex = cases.findIndex(item => item.id === 'emoji-target');
    const mutationResults = await mutations(mutantDirectory, cases[witnessIndex], expected[witnessIndex]);
    const sqliteEvidence = { synthetic: true, fixture: 'test-support/name-replacement-fixture.mjs:seedNameReplacement',
      publicEntry: 'ListeningStore.replaceKnowledgeName', database: 'sqlite-witness.sqlite', witnessVerification,
      query: "SELECT s.id,s.state,s.source_revision,s.start,s.end,s.quote,g.original_text FROM relation_supports s JOIN segments g ON g.id=s.segment_id ORDER BY s.id;",
      persistenceDomain: 'Well-formed source/target/text; legal nonempty anchors with nonblank well-formed old quote and well-formed mapped quote. All UTF-16 intervals remain in pure/Lean corpus.',
      cases: sqlite, invalid, importedInvalid, collision };
    await writeFile(path.join(directory, 'sqlite-evidence.json'), json(sqliteEvidence));
    const result = { complete: true, ok: true, seed, generatedBaseSamples: samples, samples: cases.length,
      groups: Object.fromEntries([...new Set(cases.map(item => item.group))].map(group => [group, cases.filter(item => item.group === group).length])),
      anchors: observations.reduce((sum, item) => sum + item.anchors, 0),
      sqliteCases: sqlite.length, sqliteAnchors: sqlite.reduce((sum, item) => sum + item.observed.length, 0),
      sqliteReopened: sqlite.every(item => item.reopened), staleSupportsUnchanged: sqlite.every(item => item.staleUnchanged),
      unlinkedSegmentsUnchanged: sqlite.every(item => item.unlinkedUnchanged),
      otherListeningsUnchanged: sqlite.every(item => item.otherListeningUnchanged),
      corpusDigest: hash(await readFile(input)), observations, mutations: mutationResults, invalid, importedInvalid, collision, invalidOracle,
      outsideProofDomain: domain,
      boundaries: ['Matching/case-folding/boundaries are finite independent implementation tests, not Lean theorems.',
        'SQLite evidence is synthetic; malformed UTF-16 strings/quotes are tested only in pure UTF-16 transport.',
        'Empty replacement targets, malformed intervals and invalid API inputs are implementation/domain tests, not proof cases.',
        'Imported malformed active coordinates are rejected atomically; stale historical supports remain untouched.',
        'Intersecting anchors expand to replacement endpoints; no general disjointness preservation is claimed.'] };
    await writeFile(path.join(directory, 'differential.json'), json(result));
    console.log(json({ ...result, observations: undefined, invalidOracle: invalidOracle.map(({ id, rejected, execution }) => ({ id, rejected, code: execution.code })),
      mutations: mutationResults.map(({ id, detected }) => ({ id, detected })) }));
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(mutantDirectory, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node verification/name-interval/differential.mjs EVIDENCE_DIRECTORY');
  await main(process.argv[2]);
}
