import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { seedGraphListening, graphFixture } from '../test-support/graph-fixture.mjs';
import { preFixRevision, preFixContextHash } from '../test-support/knowledge-revision-fixture.mjs';
import { knowledgeRevision, compatibleKnowledgeRevisions } from '../knowledge-revision.mjs';
import { nameIdentity } from '../knowledge-name.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'knowledge-revision-'));
  const file = path.join(directory, 'test.sqlite');
  const h = { store: new ListeningStore(file) };
  Object.assign(h, seedGraphListening(h.store, { extraNodes: 0 })); h.item = h.nodes[0];
  h.snapshot = () => h.store.knowledgeEditSnapshot(h.listeningId, h.item.id);
  h.reopen = () => { h.store.close(); h.store = new ListeningStore(file); };
  t.after(() => { h.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return h;
}
function card(prepared) {
  return { short_description: '公司', dialogue_summary: '推出相机', facts: [],
    evidence: [{ segment_id: prepared.correctedSegments[0].id, quote: prepared.correctedSegments[0].original_text }] };
}
function downgrade(h) {
  for (const row of h.store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'relation_%'").all()) h.store.db.exec(`DROP TRIGGER ${row.name}`);
  h.store.db.exec('DROP INDEX name_correction_context; DROP INDEX name_correction_applied;');
  for (const column of ['operation', 'context_hash', 'applied_context_hash', 'result_json', 'request_reserved'])
    h.store.db.exec(`ALTER TABLE knowledge_edit_jobs DROP COLUMN ${column}`);
  for (const column of ['name_override', 'name_override_identity']) h.store.db.exec(`ALTER TABLE knowledge_items DROP COLUMN ${column}`);
  h.store.db.exec('PRAGMA user_version=11');
}

test('revision v1 wire contract has a fixed golden digest', () => {
  const snapshot = { item: { id: 'item', listening_id: 'listening', type: 'term', canonical_name: 'Name', normalized_name: 'name',
    dialogue_summary: 'Summary', background_note: null, certainty: 'clear', display_label: 'concept', short_description: 'Description',
    policy_version: 2, content_version: 1, name_override: null, name_override_identity: null, aliases: ['Alias'],
    mentions: [{ item_id: 'item', segment_id: 'segment', surface_text: 'Name' }],
    facts: [{ id: 'fact', item_id: 'item', segment_id: 'segment', surface_text: 'Name', content: 'Fact', certainty: 'clear' }],
    revisions: [{ id: 'audit', item_id: 'item', action: 'manual', old_value: 'Old', new_value: 'Name', merged_from_id: null, reason: 'Correction' }] },
    segments: [{ id: 'segment', listening_id: 'listening', run_id: 'run', sequence_no: 1, asr_sentence_id: '1',
      original_text: 'Name is mentioned.', translation_text: '译文', translation_state: 'complete', begin_ms: 0, end_ms: 100 }] };
  assert.equal(knowledgeRevision(snapshot), '3893251d917da70bbeff2f2b625ab4d478b97d15f50a9b2a27c345ba3683fbaa');
});

test('explicit projection survives column additions, derived fields, key order, array order and reopen', t => {
  const h = fixture(t), original = h.snapshot();
  assert.equal(original.revisionVersion, 1);
  const revision = original.revision, reordered = structuredClone(original);
  reordered.item.aliases.push('Another alias');
  reordered.item.mentions.push({ ...reordered.item.mentions[0], surface_text: 'Kodak' });
  reordered.item.facts = [1, 2].map(i => ({ id: 'f' + i, item_id: h.item.id, segment_id: h.evidence.id,
    surface_text: 'Kodak', content: 'Fact ' + i, certainty: 'clear', created_at: '2020' }));
  reordered.item.revisions = [1, 2].map(i => ({ id: 'r' + i, item_id: h.item.id, action: 'manual', old_value: 'a', new_value: 'b',
    merged_from_id: null, reason: 'Reason ' + i, created_at: '2020' }));
  reordered.segments.push({ ...reordered.segments[0], id: 'extra', sequence_no: 999 });
  const before = knowledgeRevision(reordered);
  const reverseKeys = value => Object.fromEntries(Object.entries(value).reverse());
  for (const field of ['mentions', 'facts', 'revisions']) reordered.item[field] = reordered.item[field].reverse().map(row =>
    reverseKeys({ ...row, new_column: 'ignored', created_at: '2040' }));
  reordered.item.aliases.reverse(); reordered.item = reverseKeys({ ...reordered.item, new_column: 'ignored',
    display_name: 'derived label', created_at: '2040', updated_at: '2040' });
  reordered.segments = reordered.segments.reverse().map(row => reverseKeys({ ...row, new_column: 'ignored', created_at: '2040' }));
  assert.equal(knowledgeRevision(reordered), before);
  h.store.db.exec("ALTER TABLE knowledge_items ADD COLUMN future_column TEXT DEFAULT 'ignored'; ALTER TABLE segments ADD COLUMN future_column TEXT DEFAULT 'ignored'");
  assert.equal(h.snapshot().revision, revision);
  const knowledge = h.store.knowledge.bind(h.store);
  h.store.knowledge = id => knowledge(id).map(item => ({ ...item, future_display: 'ignored' }));
  assert.equal(h.snapshot().revision, revision);
  h.reopen(); assert.equal(h.snapshot().revision, revision);
});

test('semantic edits to identity, overrides, content, aliases, provenance or source still invalidate revision', t => {
  const h = fixture(t), snapshot = h.snapshot();
  for (const field of ['canonical_name', 'normalized_name', 'type', 'dialogue_summary', 'background_note', 'certainty',
    'display_label', 'short_description', 'policy_version', 'content_version', 'name_override', 'name_override_identity']) {
    const copy = structuredClone(snapshot); copy.item[field] = field.includes('version') ? 99 : 'changed';
    assert.notEqual(knowledgeRevision(copy), snapshot.revision, field);
  }
  const mutate = callbacks => {
    for (const callback of callbacks) { const copy = structuredClone(snapshot); callback(copy); assert.notEqual(knowledgeRevision(copy), snapshot.revision); }
  };
  mutate([s => s.item.aliases.push('New'), s => s.item.mentions[0].surface_text = 'New',
    s => s.item.revisions.push({ id: 'new', action: 'manual' }),
    s => s.item.facts.push({ id: 'new', content: 'New', surface_text: 'Kodak', segment_id: h.evidence.id }),
    s => s.segments[0].original_text += ' New source.', s => s.segments[0].translation_text += '新译文',
    s => s.segments[0].translation_state = 'failed', s => s.segments[0].begin_ms = 1,
    s => s.segments[0].end_ms = 1, s => s.segments[0].sequence_no++]);
});

test('real v11 migration accepts unchanged old save/receipt, keeps failure visible and rejects later concurrent edits', t => {
  const h = fixture(t), unchanged = h.snapshot();
  assert.notEqual(preFixRevision(unchanged, 11), preFixRevision(unchanged, 12), 'pre-fix upgrade changes the digest with zero content edits');
  downgrade(h);
  const old = preFixRevision(h.snapshot(), 11), id = randomUUID();
  const input = { name: 'Kodak Inc', source: 'Eastman Kodak', revision: old };
  h.store.createKnowledgeEditJob(h.listeningId, h.item.id, id, input);
  h.store.failKnowledgeEditJob(id, '旧失败');
  const fingerprint = h.store.db.prepare('SELECT fingerprint FROM knowledge_edit_jobs WHERE id=?').get(id).fingerprint;
  h.reopen();
  const current = h.snapshot();
  assert.notEqual(current.revision, old);
  assert.ok(compatibleKnowledgeRevisions(current).includes(old));
  assert.equal(h.store.knowledgeEditJob(h.listeningId, h.item.id, id, input).state, 'failed');
  const failed = h.store.knowledgeEditForSnapshot(h.listeningId, h.item.id, current.revision, current);
  assert.equal(failed.id, id); assert.equal(failed.staleRevision, false);
  const prepared = h.store.prepareKnowledgeEdit(h.listeningId, h.item.id, input);
  assert.equal(prepared.revision, current.revision);
  h.store.saveKnowledgeEdit(h.listeningId, h.item.id, prepared, card(prepared));
  const fresh = h.snapshot();
  assert.throws(() => h.store.prepareKnowledgeEdit(h.listeningId, h.item.id, input), { status: 409, code: 'KNOWLEDGE_EDIT_STALE', revision: fresh.revision });
  assert.throws(() => h.store.deleteKnowledgeItem(h.listeningId, h.item.id, old), { status: 409, code: 'KNOWLEDGE_EDIT_STALE' });
  assert.equal(h.store.knowledgeEditForSnapshot(h.listeningId, h.item.id, fresh.revision, fresh).staleRevision, true);
  assert.equal(h.store.db.prepare('SELECT fingerprint FROM knowledge_edit_jobs WHERE id=?').get(id).fingerprint, fingerprint);
  const success = randomUUID(), next = { ...input, source: 'Kodak Inc', revision: fresh.revision };
  h.store.createKnowledgeEditJob(h.listeningId, h.item.id, success, next);
  const again = h.store.prepareKnowledgeEdit(h.listeningId, h.item.id, next);
  h.store.saveKnowledgeEdit(h.listeningId, h.item.id, again, card(again), success);
  assert.equal(h.store.knowledgeEditForSnapshot(h.listeningId, h.item.id, h.snapshot().revision, h.snapshot()), undefined);
});

test('unchanged v11/v12 deletes work, but legacy v11 cannot hide a newly present override', t => {
  for (const version of [11, 12]) {
    const h = fixture(t), revision = preFixRevision(h.snapshot(), version);
    h.store.deleteKnowledgeItem(h.listeningId, h.item.id, revision);
    assert.ok(!h.store.knowledge(h.listeningId).some(item => item.id === h.item.id));
  }
  const h = fixture(t), old = preFixRevision(h.snapshot(), 11);
  h.store.db.prepare('UPDATE knowledge_items SET name_override=?,name_override_identity=? WHERE id=?')
    .run('New display', nameIdentity(h.item), h.item.id);
  assert.throws(() => h.store.deleteKnowledgeItem(h.listeningId, h.item.id, old), { code: 'KNOWLEDGE_EDIT_STALE' });
});

test('name correction coalesces legacy/current tokens and recovers both after a changed commit or restart', t => {
  const h = fixture(t);
  h.store.db.prepare("UPDATE knowledge_items SET canonical_name='Eastmen Kodak' WHERE id=?").run(h.item.id);
  const before = h.snapshot(), legacy = preFixRevision(before, 11), id = randomUUID();
  const accepted = h.store.acceptNameCorrection(h.listeningId, h.item.id, id, { revision: legacy }, { hasKey: true });
  assert.equal(h.store.acceptNameCorrection(h.listeningId, h.item.id, randomUUID(), { revision: before.revision }, { hasKey: true }).job.id, id);
  const prepared = accepted.prepared, segment = prepared.input.segments.find(row => row.linked);
  h.store.saveNameCorrection(h.listeningId, h.item.id, id, prepared, { outcome: 'corrected', name: 'Eastman Kodak', reason: '逐字依据',
    evidence: [{ segment_id: segment.id, source_kind: 'original', quote: segment.original }] });
  h.reopen();
  for (const revision of [legacy, before.revision, preFixRevision(before, 12)]) {
    const receipt = h.store.nameCorrectionForRevision(h.listeningId, h.item.id, revision);
    assert.equal(receipt.id, id); assert.equal(receipt.changed, true);
    assert.equal(receipt.result.input_revisions, undefined);
  }
  assert.equal(h.store.acceptNameCorrection(h.listeningId, h.item.id, id, { revision: legacy }).job.changed, true);
  assert.throws(() => h.store.acceptNameCorrection(h.listeningId, h.item.id, randomUUID(), { revision: legacy }, { hasKey: true }),
    { code: 'KNOWLEDGE_EDIT_STALE' });
});

test('pre-fix v12 applied/unchanged cache survives revision upgrade with zero new request budget', t => {
  for (const outcome of ['corrected', 'unchanged', 'insufficient_evidence']) {
    const h = fixture(t);
    h.store.db.prepare("UPDATE knowledge_items SET canonical_name='Eastmen Kodak' WHERE id=?").run(h.item.id);
    const before = h.snapshot(), id = randomUUID();
    const accepted = h.store.acceptNameCorrection(h.listeningId, h.item.id, id, { revision: before.revision }, { hasKey: true });
    const segment = accepted.prepared.input.segments.find(row => row.linked);
    const result = { outcome, name: outcome === 'corrected' ? 'Eastman Kodak' : 'Eastmen Kodak', reason: '已核对',
      evidence: [{ segment_id: segment.id, source_kind: 'original', quote: segment.original }] };
    h.store.reserveNameCorrection(id); h.store.saveNameCorrection(h.listeningId, h.item.id, id, accepted.prepared, result);
    const applied = h.snapshot(), appliedInput = h.store.prepareNameCorrection(h.listeningId, h.item.id, { revision: applied.revision }).input;
    const oldResult = JSON.parse(h.store.db.prepare('SELECT result_json FROM knowledge_edit_jobs WHERE id=?').get(id).result_json);
    delete oldResult.input_revisions;
    h.store.db.prepare('UPDATE knowledge_edit_jobs SET revision=?,context_hash=?,applied_context_hash=?,result_json=? WHERE id=?')
      .run(preFixRevision(before), preFixContextHash(preFixRevision(before), accepted.prepared.input),
        preFixContextHash(preFixRevision(applied), appliedInput), JSON.stringify(oldResult), id);
    h.reopen();
    assert.equal(h.store.nameCorrectionForSnapshot(h.listeningId, h.item.id, h.snapshot()).id, id);
    const cached = h.store.acceptNameCorrection(h.listeningId, h.item.id, randomUUID(), { revision: h.snapshot().revision });
    assert.equal(cached.prepared, undefined); assert.equal(cached.job.result.cache_hit, true);
    assert.equal(cached.job.changed, false);
    assert.equal(h.store.db.prepare('SELECT sum(request_reserved) n FROM knowledge_edit_jobs').get().n, 1);
    h.store.db.prepare('UPDATE segments SET translation_text=? WHERE id=?').run('新的依据', h.evidence.id);
    const next = h.store.acceptNameCorrection(h.listeningId, h.item.id, randomUUID(), { revision: h.snapshot().revision }, { hasKey: true });
    assert.ok(next.prepared); h.store.failKnowledgeEditJob(next.job.id, '模拟失败');
    h.store.db.prepare('UPDATE segments SET translation_text=? WHERE id=?').run('另一份依据', h.evidence.id);
    const failed = h.store.nameCorrectionForSnapshot(h.listeningId, h.item.id, h.snapshot());
    assert.equal(failed.id, next.job.id); assert.equal(failed.staleRevision, true);
  }
});

test('HTTP old revisions pass preflight; real conflicts return current revision and safe diagnostics without model calls', async t => {
  const f = await graphFixture(); t.after(() => f.close());
  const { first } = f.seeded, item = first.nodes[0];
  const url = `${f.base}/api/listenings/${first.listeningId}/knowledge/${item.id}`;
  const snapshot = await (await fetch(url)).json(), legacy = preFixRevision(snapshot, 11);
  const request = (method, body) => fetch(url + (method === 'POST' ? '/name-corrections' : ''), { method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  const unchanged = await request('PATCH', { name: 'Kodak Inc', source: 'Eastman Kodak', revision: legacy });
  assert.equal(unchanged.status, 400); assert.match((await unchanged.json()).error, /API Key/);
  assert.equal((await request('POST', { revision: legacy })).status, 400);
  const wrong = 'a'.repeat(64), calls = f.stats.providerRequests.length;
  for (const method of ['PATCH', 'DELETE', 'POST']) {
    const response = await request(method, { revision: wrong, ...(method === 'PATCH' ?
      { name: 'Private draft', source: 'Eastman Kodak', key: 'private-key-fixture' } : {}) });
    assert.equal(response.status, 409);
    const failure = await response.json();
    assert.equal(failure.code, 'KNOWLEDGE_EDIT_STALE'); assert.equal(failure.saved, false);
    assert.equal(failure.revision, snapshot.revision); assert.equal(failure.revisionVersion, 1);
  }
  const logs = f.logs().split('\n').filter(line => line.includes('knowledge_revision_conflict'));
  assert.equal(logs.length, 3);
  for (const log of logs) {
    assert.match(log, new RegExp(first.listeningId)); assert.match(log, new RegExp(item.id));
    assert.doesNotMatch(log, /Eastman|Private draft|private-key-fixture/);
    assert.ok(!log.includes(wrong)); assert.ok(!log.includes(snapshot.revision));
    const data = JSON.parse(log.slice(log.indexOf('{')));
    assert.equal(data.expected, snapshot.revision.slice(0, 8)); assert.equal(data.actual, wrong.slice(0, 8));
  }
  assert.equal(f.stats.providerRequests.length, calls);
  assert.equal((await request('DELETE', { revision: legacy })).status, 200);
});
