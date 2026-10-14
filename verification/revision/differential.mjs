import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ListeningStore } from '../../storage.mjs';
import { seedGraphListening } from '../../test-support/graph-fixture.mjs';
import { preFixRevision } from '../../test-support/knowledge-revision-fixture.mjs';
import { knowledgeRevision, compatibleKnowledgeRevisions } from '../../knowledge-revision.mjs';
import { corpus, transport, referenceJSON, fromUnits, baseline, equivalent, seed, samples } from './corpus.mjs';
import { runProcess } from '../../scripts/lib/process.mjs';

const directory = path.resolve(process.argv[2]);
const hash = value => createHash('sha256').update(value).digest('hex');
const { cases, pairs } = corpus();
const databaseDirectory = path.join(directory, 'temporary-database');
await mkdir(databaseDirectory, { recursive: true });
let store;
const legacy = [];
try {
  const file = path.join(databaseDirectory, 'revision.sqlite');
  store = new ListeningStore(file);
  const seeded = seedGraphListening(store, { extraNodes: 0 });
  const itemId = seeded.nodes[0].id;
  const snapshot = () => store.knowledgeEditSnapshot(seeded.listeningId, itemId);
  const initial = snapshot();
  for (const version of [11, 12]) {
    const digest = preFixRevision(initial, version);
    assert.ok(compatibleKnowledgeRevisions(initial).includes(digest), `legacy v${version} initial`);
    legacy.push({ version, digest, accepted: true });
  }
  cases.push({ id: 'sqlite-initial', group: 'sqlite', snapshot: initial });
  store.db.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?,?)')
    .run('revision-1', itemId, 'correct', 'old', 'new', null, 'Synthetic reason', '2020-01-01');
  store.db.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?,?)')
    .run('revision-2', itemId, 'correct', 'new', 'newer', null, null, '2020-01-02');
  store.db.prepare('INSERT INTO knowledge_facts VALUES (?,?,?,?,?,?,?)')
    .run('fact-1', itemId, seeded.evidence.id, 'Kodak', 'Synthetic fact', 'clear', '2020-01-01');
  store.db.prepare('INSERT INTO knowledge_facts VALUES (?,?,?,?,?,?,?)')
    .run('fact-2', itemId, seeded.evidence.id, 'Kodak', 'Second fact', 'clear', '2020-01-02');
  const full = snapshot();
  cases.push({ id: 'sqlite-full', group: 'sqlite', snapshot: full });
  const permuted = structuredClone(full);
  permuted.item.revisions.reverse(); permuted.item.facts.reverse();
  assert.equal(knowledgeRevision(permuted), full.revision);
  for (const version of [11, 12]) {
    assert.notEqual(preFixRevision(full, version), preFixRevision(permuted, version), `legacy v${version} preserves query order`);
    assert.ok(!compatibleKnowledgeRevisions(permuted).includes(preFixRevision(full, version)));
    const timestamp = structuredClone(full); timestamp.item.updated_at = '2050-01-01';
    assert.equal(knowledgeRevision(timestamp), full.revision);
    assert.ok(!compatibleKnowledgeRevisions(timestamp).includes(preFixRevision(full, version)), `legacy v${version} preserves timestamp`);
  }
  for (const field of ['name_override', 'name_override_identity']) for (const value of ['', 'present']) {
    const overridden = structuredClone(full); overridden.item[field] = value;
    assert.ok(!compatibleKnowledgeRevisions(overridden).includes(preFixRevision(full, 11)), 'v11 override exclusion');
  }
  store.db.exec("ALTER TABLE knowledge_items ADD COLUMN future_column TEXT DEFAULT 'ignored'; ALTER TABLE segments ADD COLUMN future_column TEXT DEFAULT 'ignored'");
  const extended = snapshot();
  cases.push({ id: 'sqlite-new-columns', group: 'sqlite', snapshot: extended });
  assert.equal(extended.revision, full.revision);
  store.close(); store = new ListeningStore(file);
  const reopened = snapshot();
  cases.push({ id: 'sqlite-reopened', group: 'sqlite', snapshot: reopened });
  assert.equal(reopened.revision, full.revision);
  store.db.prepare('UPDATE segments SET begin_ms=? WHERE id=?').run(1, seeded.evidence.id);
  const changed = snapshot();
  cases.push({ id: 'sqlite-business-change', group: 'sqlite', snapshot: changed });
  assert.notEqual(changed.revision, full.revision);
} finally {
  store?.close();
  await rm(databaseDirectory, { recursive: true, force: true });
}

const input = path.join(directory, 'corpus.ndjson');
const output = path.join(directory, 'lean-projections.ndjson');
await writeFile(input, cases.map(({ snapshot }) => JSON.stringify(transport(snapshot))).join('\n') + '\n');
await writeFile(path.join(directory, 'case-index.json'), JSON.stringify(cases.map(({ id, group }) => ({ id, group })), null, 2) + '\n');
const execution = await runProcess(path.resolve('verification/lean/.lake/build/bin/revision_oracle'), [input, output],
  { logFile: path.join(directory, 'oracle.log'), timeoutMs: 60000 });
await writeFile(path.join(directory, 'oracle-execution.json'), JSON.stringify(execution, null, 2) + '\n');
assert.equal(execution.ok, true, execution.tail);
const lines = (await readFile(output, 'utf8')).trimEnd().split('\n');
assert.equal(lines.length, cases.length, 'oracle must complete every input');
const digests = [], observations = [];
for (let i = 0; i < cases.length; i++) {
  const { id, group, snapshot } = cases[i];
  const actual = fromUnits(JSON.parse(lines[i]));
  assert.equal(actual, referenceJSON(snapshot), `Lean/independent JS serialized UTF-16 mismatch: ${id}`);
  const digest = hash(actual);
  assert.equal(knowledgeRevision(snapshot), digest, `public revision/Lean digest mismatch: ${id}`);
  if (group === 'field') assert.notEqual(digest, digests[0], `business field omitted: ${id}`);
  digests.push(digest); observations.push({ id, group, utf16Length: actual.length, digest });
}
for (const [left, right] of pairs) assert.equal(digests[left], digests[right], `normalization equivalence ${cases[left].id}`);

const source = await readFile('knowledge-revision.mjs', 'utf8');
const mutations = [
  { id: 'omit-background-note', from: "'background_note', 'certainty', 'display_label'", to: "'certainty', 'display_label'", witness: s => { s.item.background_note = 'field required'; } },
  { id: 'reverse-serialized-order', from: 'left < right ? -1 : left > right ? 1 : 0', to: 'left < right ? 1 : left > right ? -1 : 0', witness: () => {} },
  { id: 'collapse-falsy-to-null', from: 'row[key] ?? null', to: 'row[key] || null', witness: s => { s.item.background_note = ''; s.segments[0].begin_ms = 0; } }
];
const mutationResults = [];
const mutantDirectory = path.join(directory, 'temporary-mutants');
await mkdir(mutantDirectory);
try {
  for (const mutation of mutations) {
    assert.equal(source.split(mutation.from).length, 2, `unique mutation anchor ${mutation.id}`);
    const mutated = source.replace(mutation.from, mutation.to), file = path.join(mutantDirectory, mutation.id + '.mjs');
    await writeFile(file, mutated);
    const mutant = await import(pathToFileURL(file).href);
    const snapshot = baseline(); mutation.witness(snapshot);
    const expected = hash(referenceJSON(snapshot)), actual = mutant.knowledgeRevision(snapshot);
    assert.notEqual(actual, expected, `mutation escaped: ${mutation.id}`);
    mutationResults.push({ id: mutation.id, detected: true, sourceDigest: hash(mutated), expected, actual,
      witness: transport(snapshot) });
  }
} finally { await rm(mutantDirectory, { recursive: true, force: true }); }

// Domain exclusions remain implementation tests; never count them as Lean cases.
const outside = baseline(); outside.item.background_note = 0.5;
assert.throws(() => transport(outside), /Outside Lean domain/);
assert.equal(knowledgeRevision(outside), hash(referenceJSON(outside)));
for (const value of [NaN, Infinity, -Infinity]) {
  const special = baseline(); special.item.background_note = value;
  assert.throws(() => transport(special), /Outside Lean domain/);
  const asNull = structuredClone(special); asNull.item.background_note = null;
  assert.equal(knowledgeRevision(special), knowledgeRevision(asNull));
}
for (const field of ['begin_ms', 'end_ms']) for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
  const timing = baseline(); timing.segments[0][field] = value;
  assert.throws(() => transport(timing), /Outside Lean domain/);
  assert.equal(knowledgeRevision(timing), hash(referenceJSON(timing)));
}
const big = baseline(); big.item.background_note = 1n;
assert.throws(() => knowledgeRevision(big), /BigInt/);
const ignored = baseline(); ignored.item.future_object = { nested: ['ignored'] };
assert.equal(knowledgeRevision(ignored), knowledgeRevision(baseline()));
assert.equal(knowledgeRevision(equivalent(baseline())), knowledgeRevision(baseline()));
const result = { complete: true, ok: true, seed, generatedBaseSamples: samples, samples: cases.length,
  pairs: pairs.length, groups: Object.fromEntries([...new Set(cases.map(c => c.group))].map(group => [group, cases.filter(c => c.group === group).length])),
  corpusDigest: hash(await readFile(input)), observations, legacy, mutations: mutationResults,
  outsideProofDomain: ['fractional-number', 'non-finite-number', 'BigInt rejection', 'ignored complex property', 'fractional/unsafe SQLite timing values'] };
await writeFile(path.join(directory, 'differential.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, observations: undefined, mutations: mutationResults.map(({ id, detected }) => ({ id, detected })) }, null, 2));
