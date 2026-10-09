import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { seedNameReplacement } from '../test-support/name-replacement-fixture.mjs';
import { speechFixture } from '../test-support/speech-fixture.mjs';
import { preFixRevision } from '../test-support/knowledge-revision-fixture.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'name-replace-')), filename = path.join(dir, 'data.sqlite');
  const h = { store: new ListeningStore(filename), filename };
  Object.assign(h, seedNameReplacement(h.store, options));
  h.snapshot = () => h.store.knowledgeEditSnapshot(h.listeningId, h.item.id);
  h.rename = (name = 'Tibo', extra = {}) => h.store.replaceKnowledgeName(h.listeningId, h.item.id,
    randomUUID(), { name, revision: h.snapshot().revision }, extra);
  t.after(() => { h.store.close(); rmSync(dir, { recursive: true, force: true }); });
  return h;
}

test('manual replacement updates actual name, linked source, quotes and wording without rebuilding IDs or translation', t => {
  const h = fixture(t), before = h.snapshot(), input = { name: 'Tibo', revision: before.revision }, id = randomUUID();
  assert.ok(!JSON.stringify(before).includes('Tibo'));
  const result = h.store.replaceKnowledgeName(h.listeningId, h.item.id, id, input);
  assert.equal(result.item.id, h.item.id); assert.equal(result.item.canonical_name, 'Tibo');
  assert.equal(result.item.normalized_name, 'tibo'); assert.equal(result.item.display_name, 'Tibo');
  assert.equal(result.item.name_override, null); assert.equal(result.job.state, 'succeeded');
  assert.equal(result.item.dialogue_summary, 'Tibo appeared with Tibo.');
  assert.deepEqual(result.item.aliases, ['D-man']);
  assert.equal(result.item.facts[0].id, h.factId); assert.equal(result.item.facts[0].content, 'Tibo released Camera.');
  const snapshot = h.snapshot(), text = snapshot.segments[0].original_text;
  assert.equal(text, 'Tibo released Camera. Camera belongs to Tibo. Deeboverse is unrelated.');
  assert.equal(snapshot.segments[0].translation_text, before.segments[0].translation_text);
  assert.ok(snapshot.item.mentions.every(mention => text.includes(mention.surface_text)));
  const camera = h.store.knowledge(h.listeningId).find(item => item.id === h.camera.id);
  assert.equal(camera.canonical_name, 'Camera'); assert.equal(camera.dialogue_summary, 'Camera appeared with Tibo.');
  assert.equal(camera.mentions[0].surface_text, text);
  assert.equal(h.store.db.prepare('SELECT original_text FROM segments WHERE id=?').get(h.other.id).original_text, h.other.original_text);
  const duplicate = h.store.replaceKnowledgeName(h.listeningId, h.item.id, id, input);
  assert.equal(duplicate.job.id, id); assert.equal(duplicate.changed, false); assert.deepEqual(h.snapshot(), snapshot);
  assert.throws(() => h.store.replaceKnowledgeName(h.listeningId, h.item.id, id, { ...input, name: 'Other' }), /同一保存任务/);
  assert.throws(() => h.store.replaceKnowledgeName(h.listeningId, h.item.id, randomUUID(), input), error => error.code === 'KNOWLEDGE_EDIT_STALE');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM knowledge_manual_items').get().n, 0, 'simple rename must not lock the whole card');
  const run = h.store.createRun(h.listeningId, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' });
  assert.equal(h.store.addSegment(h.listeningId, run.runId, { id: 'new', text: 'Deebo returned.' }).segment.original_text, 'Tibo returned.');
});

test('graph evidence is reanchored locally; edge/support IDs, groups, statuses and paid attempts survive restart', t => {
  const h = fixture(t, { graph: true }), before = h.store.graph(h.listeningId);
  const windows = h.store.db.prepare('SELECT * FROM relation_windows').all();
  const jobs = h.store.db.prepare('SELECT * FROM relation_jobs').all();
  h.rename('Tibo');
  h.store.close(); h.store = new ListeningStore(h.filename);
  const after = h.store.graph(h.listeningId), text = h.snapshot().segments[0].original_text;
  assert.deepEqual(after.relations.map(({ assertions, ...relation }) => relation), before.relations.map(({ assertions, ...relation }) => relation));
  assert.deepEqual(after.supports.map(s => [s.id, s.group_id, s.state]), before.supports.map(s => [s.id, s.group_id, s.state]));
  for (const support of after.supports) { assert.equal(support.source_revision, hash(text)); assert.equal(text.slice(support.start, support.end), support.quote); }
  assert.deepEqual(after.assertions.map(a => [a.id, a.status]), before.assertions.map(a => [a.id, a.status]));
  assert.equal(after.assertions[0].statement, 'Tibo released Camera.');
  assert.deepEqual(h.store.db.prepare('SELECT * FROM relation_windows').all(), windows);
  assert.deepEqual(h.store.db.prepare('SELECT * FROM relation_jobs').all(), jobs);
  assert.equal(h.store.nextRelationJob(h.listeningId, { quietMs: 0 }), null);
  assert.equal(h.store.db.prepare('PRAGMA user_version').get().user_version, 12);
  // Ordinary edits still invalidate anchors: the bypass ends with this receipt.
  h.store.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run('Someone else released Camera.', h.segment.id);
  assert.ok(h.store.db.prepare("SELECT 1 FROM relation_supports WHERE state='stale'").get());
  assert.equal(h.store.db.prepare('SELECT state FROM relation_windows').get().state, 'dirty');
});

test('local transaction rolls back source, graph anchors and receipt together; conflicts cannot merge identities', t => {
  const h = fixture(t, { graph: true }), snapshot = h.snapshot(), graph = h.store.graph(h.listeningId);
  assert.throws(() => h.rename('Camera'), /同名条目/);
  assert.throws(() => h.rename('Tibo', { busy: true }), /正在保存/);
  h.store.db.exec("CREATE TRIGGER fail_name_replace BEFORE UPDATE OF canonical_name ON knowledge_items BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => h.rename(), /fixture failure/);
  assert.deepEqual(h.snapshot(), snapshot); assert.deepEqual(h.store.graph(h.listeningId), graph);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM knowledge_edit_jobs').get().n, 0);
  h.store.db.exec('DROP TRIGGER fail_name_replace');
  h.rename('Tibo');
  assert.equal(h.snapshot().item.canonical_name, 'Tibo');
});

test('legacy v12 token and display override can materialize into the actual name; raw anchor is used', t => {
  const h = fixture(t), prepared = h.store.prepareNameCorrection(h.listeningId, h.item.id, { revision: h.snapshot().revision });
  const accepted = h.store.acceptNameCorrection(h.listeningId, h.item.id, randomUUID(), { revision: prepared.revision }, { hasKey: true });
  // Simulate an existing valid display override from the old release.
  h.store.failKnowledgeEditJob(accepted.job.id, 'fixture failure');
  const identity = hash(JSON.stringify([h.item.canonical_name, h.item.type, h.item.display_label ?? null]));
  h.store.db.prepare('UPDATE knowledge_items SET name_override=?,name_override_identity=? WHERE id=?').run('Tibo', identity, h.item.id);
  const snapshot = h.snapshot();
  h.store.replaceKnowledgeName(h.listeningId, h.item.id, randomUUID(), { name: 'Tibo', revision: preFixRevision(snapshot, 12) });
  assert.equal(h.snapshot().item.canonical_name, 'Tibo'); assert.equal(h.snapshot().item.name_override, null);
  assert.match(h.snapshot().segments[0].original_text, /^Tibo released/);
});

test('longer corrections stay composable and later relation analysis reuses the original assertion ID', t => {
  const h = fixture(t, { graph: true }), assertionId = h.store.graph(h.listeningId).assertions[0].id;
  h.rename('Tibo Longname'); h.rename('Tibo');
  const text = h.snapshot().segments[0].original_text;
  for (const support of h.store.graph(h.listeningId).supports) assert.equal(text.slice(support.start, support.end), support.quote);
  assert.equal(h.store.correctKnowledgeText(h.listeningId, 'Deebo met Tibo Longname.'), 'Tibo met Tibo.');
  // A later, independent translation update legitimately opens new analysis.
  h.store.db.prepare('UPDATE segments SET translation_text=? WHERE id=?').run('新的已有译文', h.segment.id);
  const job = h.store.beginRelationRequest(h.store.nextRelationJob(h.listeningId, { quietMs: 0 }).id);
  const row = job.input.focus_segments.find(row => row.id === h.segment.id);
  const result = h.store.commitRelationJob(job.id, { relations: [{ subject_item_id: h.item.id, object_item_id: h.camera.id,
    predicate: 'released', statement: 'Tibo released Camera.', polarity: 'positive', modality: 'asserted',
    conditions: null, time_scope: null, attribution: null, correction_of: null, status: 'active',
    supports: [{ segment_id: row.id, source_revision: row.source_revision, start: 0, end: row.text.length, quote: row.text, role: 'relation' }] }] });
  assert.equal(result.accepted, 1); assert.equal(h.store.graph(h.listeningId).assertions.length, 1);
  assert.equal(h.store.graph(h.listeningId).assertions[0].id, assertionId);
});

test('in-flight relations and reused legacy receipt IDs reject replacement before changing data', t => {
  const h = fixture(t), before = h.snapshot();
  h.store.enableRelations(h.listeningId);
  const relation = h.store.nextRelationJob(h.listeningId, { quietMs: 0 });
  assert.throws(() => h.rename(), /等待图谱关系/); assert.deepEqual(h.snapshot(), before);
  h.store.beginRelationRequest(relation.id);
  assert.throws(() => h.rename(), /等待图谱关系/); assert.deepEqual(h.snapshot(), before);
  h.store.cancelRelations(h.listeningId);
  const id = randomUUID(); h.store.createKnowledgeEditJob(h.listeningId, h.item.id, id,
    { name: 'Tibo', source: 'Deebo', revision: before.revision });
  h.store.failKnowledgeEditJob(id, 'legacy failure');
  assert.throws(() => h.store.replaceKnowledgeName(h.listeningId, h.item.id, id, { name: 'Tibo', revision: before.revision }), /同一保存任务/);
  assert.deepEqual(h.snapshot(), before);
});

test('HTTP manual save requires no key or provider, suggestions call once and never save or auto-retry', async t => {
  let invalid = false, suggestionCalls = 0;
  const f = await speechFixture({ seed: store => seedNameReplacement(store, { graph: true }), modelResponse: body => {
    const input = JSON.parse(body.messages.at(-1).content);
    assert.equal(input.operation, 'name_suggestion'); assert.equal(body.enable_thinking, false);
    suggestionCalls++; return invalid ? 'malformed JSON' : { name: 'Tibo', reason: '建议由用户确认。' };
  } });
  t.after(() => f.close());
  const url = `${f.base}/api/listenings/${f.seeded.listeningId}/knowledge/${f.seeded.item.id}`;
  const before = await (await fetch(url)).json();
  const post = (suffix, input, id) => fetch(url + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(id ? { 'Idempotency-Key': id } : {}) }, body: JSON.stringify(input) });
  assert.equal((await post('/name-suggestions', { revision: before.revision })).status, 400);
  assert.equal(f.stats.providerRequests.length, 0);
  const suggestion = await post('/name-suggestions', { revision: before.revision, key: 'stub-only' });
  assert.equal(suggestion.status, 200, await suggestion.clone().text()); assert.equal((await suggestion.json()).suggestion.name, 'Tibo');
  assert.deepEqual(await (await fetch(url)).json(), before); assert.equal(suggestionCalls, 1);
  invalid = true;
  assert.equal((await post('/name-suggestions', { revision: before.revision, key: 'stub-only' })).status, 502);
  assert.equal(suggestionCalls, 2); assert.deepEqual(await (await fetch(url)).json(), before);
  const id = randomUUID(), input = { name: 'Tibo', revision: before.revision };
  const saved = await post('/name-replacements', input, id);
  assert.equal(saved.status, 200, await saved.clone().text()); assert.equal((await saved.json()).item.canonical_name, 'Tibo');
  assert.equal((await post('/name-replacements', input, id)).status, 200);
  const receipt = await (await fetch(`${url}/edits/${id}`)).json(); assert.equal(receipt.job.saved, true);
  assert.equal((await post('/name-replacements', input, randomUUID())).status, 409);
  assert.equal(suggestionCalls, 2); assert.equal(f.stats.providerRequests.length, 2);
  const graph = await (await fetch(`${f.base}/api/listenings/${f.seeded.listeningId}/graph`)).json();
  assert.equal(graph.relations.length, 1); assert.equal(graph.assertions[0].status, 'active');
});
