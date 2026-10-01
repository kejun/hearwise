import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ListeningStore } from '../storage.mjs';
import { buildRelationInput, RELATION_LIMITS } from '../relations.mjs';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(t, text = 'Acme released Camera.') {
  const dir = mkdtempSync(path.join(tmpdir(), 'relations-store-'));
  const filename = path.join(dir, 'data.sqlite');
  const h = { store: new ListeningStore(filename), filename };
  h.run = h.store.createRun(null, settings, 'Graph');
  h.segment = h.store.addSegment(h.run.listeningId, h.run.runId, { id: 's1', text }).segment;
  h.addNode = (name, segment = h.segment, extra = {}) => h.store.applyKnowledge(h.run.listeningId, [{
    type: 'other', canonical_name: name, aliases: [], dialogue_summary: `${name} was discussed.`,
    background_note: null, certainty: 'clear', decision: 'create', existing_item_id: null,
    correction_reason: null, evidence: [{ segment_id: segment.id, quote: name }], ...extra }])[0];
  h.seed = () => [h.addNode('Acme'), h.addNode('Camera')];
  h.job = () => h.store.nextRelationJob(h.run.listeningId, { quietMs: 0 });
  h.reserve = () => {
    const job = h.job(); assert.ok(job);
    return h.store.beginRelationRequest(job.id);
  };
  h.reopen = () => { h.store.close(); h.store = new ListeningStore(filename); };
  t.after(() => { h.store.close(); rmSync(dir, { recursive: true, force: true }); });
  return h;
}
function relation(job, extra = {}) {
  const subject = job.input.candidates.find(c => c.canonical_name === 'Acme');
  const object = job.input.candidates.find(c => c.canonical_name === 'Camera');
  const s = job.input.focus_segments.find(s => s.text.includes('released')) || job.input.focus_segments[0];
  return { subject_item_id: subject.id, object_item_id: object.id, predicate: 'released',
    statement: 'Acme 推出了 Camera', polarity: 'positive', modality: 'asserted',
    conditions: null, time_scope: null, attribution: null, status: 'active', correction_of: null,
    supports: [{ segment_id: s.id, source_revision: s.source_revision, start: 0, end: s.text.length, quote: s.text, role: 'relation' }], ...extra };
}

test('schema 5→6 preserves legacy data; migrations and read-only snapshots never backfill or enable other histories', t => {
  const h = fixture(t); h.seed();
  for (const row of h.store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'relation_%'").all()) h.store.db.exec(`DROP TRIGGER ${row.name}`);
  h.store.db.exec('DROP TABLE relation_revisions; DROP TABLE relation_supports; DROP TABLE relation_assertions; DROP TABLE relations; DROP TABLE relation_requests; DROP TABLE relation_jobs; DROP TABLE relation_windows;');
  for (const column of ['relation_enabled', 'relation_epoch', 'relation_waiting_key', 'graph_revision']) h.store.db.exec(`ALTER TABLE listenings DROP COLUMN ${column}`);
  h.store.db.exec('PRAGMA user_version=5');
  h.reopen();
  assert.equal(h.store.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(h.store.graph(h.run.listeningId).nodes.length, 2);
  assert.equal(h.store.graph(h.run.listeningId).status.state, 'not_generated');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM relation_windows').get().n, 0);
  const other = h.store.createRun(null, settings, 'Other');
  h.store.addSegment(other.listeningId, other.runId, { id: 'o1', text: 'Another session.' });
  h.store.enableRelations(h.run.listeningId);
  assert.deepEqual(h.store.relationListeningIds(), [h.run.listeningId]);
  h.reopen();
  assert.equal(h.store.graph(h.run.listeningId).nodes.length, 2);
  assert.equal(h.store.graph(other.listeningId).enabled, false);
});

test('commits are partial, exact-evidence scoped, deterministic, append-only and include every isolated UUID', t => {
  const h = fixture(t); h.seed(); h.addNode('Isolated');
  h.store.enableRelations(h.run.listeningId);
  const job = h.reserve(), valid = relation(job);
  const revision = h.store.graph(h.run.listeningId).graphRevision;
  const result = h.store.commitRelationJob(job.id, { relations: [valid, valid, { ...valid, object_item_id: 'invented' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  assert.equal(result.state, 'partial'); assert.equal(result.rejected.length, 1);
  let graph = h.store.graph(h.run.listeningId);
  assert.equal(graph.nodes.length, 3); assert.equal(graph.relations.length, 1);
  assert.equal(graph.assertions.length, 1); assert.equal(graph.supports.length, 1);
  assert.ok(graph.graphRevision > revision);
  assert.deepEqual(graph.status.usageLastHour, { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, measuredRequests: 1 });
  assert.equal(h.store.commitRelationJob(job.id, { relations: [valid] }).duplicate, true);
  h.store.enableRelations(h.run.listeningId, { retry: true });
  const retry = h.reserve(); h.store.commitRelationJob(retry.id, { relations: [] });
  graph = h.store.graph(h.run.listeningId);
  assert.equal(graph.relations.length, 1, 'absence from a later response never removes existing edges');
  assert.equal(graph.assertions[0].status, 'active');
  assert.equal(h.job(), null);
});

test('request reservation is durable across crashes; three network attempts exhaust budget and duplicate generation cannot reset it', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const first = h.reserve();
  assert.equal(first.request_count, 1);
  const epoch = first.epoch;
  h.store.enableRelations(h.run.listeningId, { retry: true });
  assert.equal(h.store.db.prepare('SELECT relation_epoch FROM listenings WHERE id=?').get(h.run.listeningId).relation_epoch, epoch);
  h.reopen();
  const next = h.job(); assert.equal(next.id, first.id); assert.equal(next.request_count, 1);
  assert.equal(h.store.beginRelationRequest(next.id).request_count, 2);
  h.reopen();
  assert.equal(h.store.beginRelationRequest(h.job().id).request_count, 3);
  h.reopen();
  assert.equal(h.job(), null);
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'failed');
  assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 3);
  assert.equal(h.store.relationProcessing(h.run.listeningId).usageLastHour.requests, 3);
  assert.equal(h.store.relationHasWork(h.run.listeningId), false);
  h.store.enableRelations(h.run.listeningId, { retry: true });
  assert.equal(h.reserve().request_count, 1, 'explicit retry of terminal work starts a fresh bounded cycle');
});

test('waiting_nodes resumes on late V1 nodes, V2 repeat mentions, confirmed aliases and candidate promotion', t => {
  const h = fixture(t); const acme = h.addNode('Acme'); h.store.enableRelations(h.run.listeningId);
  assert.equal(h.job(), null); assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'waiting_nodes');
  assert.equal(h.store.relationHasWork(h.run.listeningId), false);
  h.addNode('Camera');
  let job = h.reserve(); h.store.commitRelationJob(job.id, { relations: [] });
  const second = h.store.addSegment(h.run.listeningId, h.run.runId, { id: 's2', text: 'Acme released Camera again.' }).segment;
  job = h.reserve(); h.store.commitRelationJob(job.id, { relations: [] });
  const before = h.store.db.prepare('SELECT revision FROM relation_windows').get().revision;
  const v2 = { action: 'repeat', type: 'other', display_label: 'organization', canonical_name: 'Acme',
    existing_item_id: acme.id, observed_candidate_id: null, aliases: ['Acme Inc'], correction_reason: null,
    certainty: 'clear', role: '核心', reason: '重复', short_description: null, new_information: null,
    evidence: [{ segment_id: second.id, quote: 'Acme' }] };
  assert.deepEqual(h.store.applyKnowledgeV2(h.run.listeningId, [v2]), []);
  assert.ok(h.store.db.prepare('SELECT revision FROM relation_windows').get().revision > before);
  assert.ok(h.job(), 'repeat-only mention and alias writes dirty the persisted window');
  const third = h.store.addSegment(h.run.listeningId, h.run.runId, { id: 's3', text: 'Lens was mentioned.' }).segment;
  h.store.applyKnowledgeV2(h.run.listeningId, [{ ...v2, action: 'observe', canonical_name: 'Lens', existing_item_id: null, display_label: 'product', aliases: [], evidence: [{ segment_id: third.id, quote: 'Lens' }] }]);
  const candidate = h.store.db.prepare("SELECT id FROM knowledge_candidates WHERE canonical_name='Lens'").get();
  h.store.applyKnowledgeV2(h.run.listeningId, [{ ...v2, action: 'create', canonical_name: 'Lens', existing_item_id: null, display_label: 'product', aliases: [], observed_candidate_id: candidate.id,
    short_description: 'A lens.', new_information: 'Lens was mentioned.', evidence: [{ segment_id: third.id, quote: 'Lens' }] }]);
  assert.ok(h.store.knowledge(h.run.listeningId).some(k => k.canonical_name === 'Lens' && k.mentions.some(m => m.segment_id === third.id)));
});

test('all dirty changes coalesce, pending translations fall back after bounded quiet, and final translations invalidate in-flight bilingual input', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const dirtyAt = h.store.db.prepare('SELECT dirty_at FROM relation_windows').get().dirty_at;
  assert.equal(h.store.nextRelationJob(h.run.listeningId, { now: dirtyAt + 1 }), null);
  assert.equal(h.store.relationProcessing(h.run.listeningId).nextReadyAt, dirtyAt + 6000);
  const fallback = h.store.nextRelationJob(h.run.listeningId, { now: dirtyAt + 6001 });
  assert.equal(fallback.input.input_mode, 'source_only');
  h.store.beginRelationRequest(fallback.id);
  h.store.setTranslation(h.segment.id, 'Acme 推出了 Camera。', false);
  assert.equal(h.store.commitRelationJob(fallback.id, { relations: [relation(fallback)], usage: { total_tokens: 21 } }).stale, true);
  assert.equal(h.store.relationProcessing(h.run.listeningId).usageLastHour.totalTokens, 21, 'paid stale outputs still count usage');
  const bilingual = h.reserve();
  assert.equal(bilingual.input.input_mode, 'bilingual');
  assert.equal(bilingual.input.focus_segments[0].translation_revision, hash('Acme 推出了 Camera。'));
  assert.notEqual(bilingual.input_fingerprint, fallback.input_fingerprint);
  assert.equal(h.store.commitRelationJob(bilingual.id, { relations: [relation(bilingual)] }).stale, false);
});

test('fingerprints verify actual complete source and translation content even without mutation triggers', t => {
  const h = fixture(t); h.seed(); h.store.setTranslation(h.segment.id, '发布了相机', false); h.store.enableRelations(h.run.listeningId);
  let job = h.reserve();
  h.store.db.exec('DROP TRIGGER relation_segment_update');
  h.store.db.prepare('UPDATE segments SET translation_text=? WHERE id=?').run('没有发布相机', h.segment.id);
  assert.equal(h.store.commitRelationJob(job.id, { relations: [relation(job)] }).stale, true);
  job = h.reserve();
  assert.equal(job.input.focus_segments[0].translation_revision, hash('没有发布相机'));
  h.store.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run('Acme never released Camera.', h.segment.id);
  assert.equal(h.store.commitRelationJob(job.id, { relations: [relation(job)] }).stale, true);
  const current = h.job(); assert.equal(current.input.focus_segments[0].source_revision, hash('Acme never released Camera.'));
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 0);
});

test('multi-sentence evidence is invalidated as a group, while independent valid groups survive source changes', t => {
  const h = fixture(t, 'Acme made an announcement about Camera.'); h.seed();
  const s2 = h.store.addSegment(h.run.listeningId, h.run.runId, { id: 's2', text: 'It released that product.' }).segment;
  h.store.enableRelations(h.run.listeningId);
  let job = h.reserve();
  const s1 = job.input.focus_segments.find(s => s.id === h.segment.id), claim = job.input.focus_segments.find(s => s.id === s2.id);
  const first = relation(job, { supports: [
    { segment_id: s1.id, source_revision: s1.source_revision, start: 0, end: 4, quote: 'Acme', role: 'subject_reference' },
    { segment_id: claim.id, source_revision: claim.source_revision, start: 0, end: claim.text.length, quote: claim.text, role: 'relation' }
  ] });
  h.store.commitRelationJob(job.id, { relations: [first] });
  const s3 = h.store.addSegment(h.run.listeningId, h.run.runId, { id: 's3', text: 'Acme released Camera.' }).segment;
  job = h.reserve();
  const independent = job.input.focus_segments.find(s => s.id === s3.id);
  h.store.commitRelationJob(job.id, { relations: [relation(job, { supports: [{ segment_id: s3.id, source_revision: independent.source_revision, start: 0, end: independent.text.length, quote: independent.text, role: 'relation' }] })] });
  h.store.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run('OtherCo made that announcement.', h.segment.id);
  let graph = h.store.graph(h.run.listeningId);
  assert.equal(graph.assertions[0].status, 'active');
  assert.equal(graph.supports.filter(s => s.state === 'stale').length, 2);
  assert.equal(graph.supports.filter(s => s.state === 'active').length, 1);
  assert.ok(graph.revisions.some(r => r.action === 'source_invalidated'));
  h.store.db.prepare('DELETE FROM segments WHERE id=?').run(s3.id);
  graph = h.store.graph(h.run.listeningId);
  assert.equal(graph.assertions[0].status, 'stale');
});

test('exact scopes reject forged offsets and unlisted endpoints; valid symmetric relations deduplicate', t => {
  const h = fixture(t); const [a, b] = h.seed(); const foreign = h.addNode('Foreign'); h.store.db.prepare('DELETE FROM knowledge_mentions WHERE item_id=?').run(foreign.id); h.store.enableRelations(h.run.listeningId);
  const job = h.reserve(), base = relation(job);
  const result = h.store.commitRelationJob(job.id, { relations: [
    { ...base, supports: [{ ...base.supports[0], start: 1 }] },
    { ...base, object_item_id: foreign.id },
    { ...base, predicate: 'partners_with', subject_item_id: a.id, object_item_id: b.id },
    { ...base, predicate: 'partners_with', subject_item_id: b.id, object_item_id: a.id }
  ] });
  assert.equal(result.stale, false);
  assert.equal(result.rejected.length, 2);
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 1);
});

test('bounded text and candidates report incomplete coverage; input fingerprints hash unclipped text', t => {
  const h = fixture(t, `Acme released Camera. ${'x'.repeat(20000)}`); h.seed(); h.store.enableRelations(h.run.listeningId);
  const job = h.reserve();
  assert.equal(job.input.focus_segments[0].text.length, RELATION_LIMITS.sourceChars);
  assert.equal(job.input.focus_segments[0].source_revision, hash(h.segment.original_text));
  assert.equal(job.input.coverage_limited, true);
  assert.equal(h.store.commitRelationJob(job.id, { relations: [] }).state, 'partial');
});

test('deleting a listening cascades all graph work and late network responses cannot resurrect it', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const first = h.reserve(); h.store.commitRelationJob(first.id, { relations: [relation(first)] });
  h.store.addSegment(h.run.listeningId, h.run.runId, { id: 's2', text: 'Acme released Camera again.' });
  const pending = h.reserve();
  h.store.finishRun(h.run.runId);
  assert.equal(h.store.removeListening(h.run.listeningId), 'deleted');
  for (const table of ['relation_windows', 'relation_jobs', 'relations', 'relation_assertions', 'relation_supports', 'relation_revisions', 'relation_requests']) {
    assert.equal(h.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(h.store.commitRelationJob(pending.id, { relations: [relation(pending)] }).stale, true);
  assert.equal(h.store.graph(h.run.listeningId), null);
});


test('scope changes and all dirty writes roll back atomically with a failed knowledge transaction', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const job = h.reserve(); h.store.commitRelationJob(job.id, { relations: [] });
  const before = h.store.graph(h.run.listeningId), windows = h.store.db.prepare('SELECT * FROM relation_windows').all();
  assert.throws(() => h.addNode('Broken', { id: 'does-not-exist' }), /FOREIGN KEY/);
  assert.deepEqual(h.store.graph(h.run.listeningId), before);
  assert.deepEqual(h.store.db.prepare('SELECT * FROM relation_windows').all(), windows);
});

test('oversized bilingual and alias inputs fit the real UTF-8 wire budget with honest partial coverage', t => {
  const h = fixture(t, `Acme released Camera. ${'测'.repeat(13900)}`); h.seed();
  h.store.setTranslation(h.segment.id, '译'.repeat(14000), false);
  for (let i = 0; i < 48; i++) h.addNode(`Node ${i}`, h.segment, { aliases: Array.from({ length: 12 }, (_, j) => `${i}-${j}-${'别'.repeat(100)}`) });
  h.store.enableRelations(h.run.listeningId);
  const job = h.reserve();
  assert.equal(job.input.candidates.length, 48);
  assert.equal(job.input.candidate_count, 50);
  assert.equal(job.input.coverage_limited, true);
  assert.ok(Buffer.byteLength(JSON.stringify(buildRelationInput(job.input))) <= RELATION_LIMITS.requestBytes);
  assert.equal(job.input.focus_segments[0].source_revision, hash(h.segment.original_text));
  assert.equal(job.input.focus_segments[0].translation_revision, hash('译'.repeat(14000)));
});

test('uncertain node identities remain review-only at commit and explicit correction keeps a revision trail', t => {
  const h = fixture(t); const [a] = h.seed();
  h.store.db.prepare("UPDATE knowledge_items SET certainty='needs_review' WHERE id=?").run(a.id);
  h.store.enableRelations(h.run.listeningId);
  let job = h.reserve(); h.store.commitRelationJob(job.id, { relations: [relation(job)] });
  const old = h.store.graph(h.run.listeningId).assertions[0];
  assert.equal(old.status, 'needs_review');
  const correction = h.store.addSegment(h.run.listeningId, h.run.runId, { id: 's2', text: 'Correction: Acme never released Camera.' }).segment;
  job = h.reserve(); const source = job.input.focus_segments.find(s => s.id === correction.id);
  const corrected = relation(job, { statement: '更正：Acme 从未推出 Camera', polarity: 'negative', correction_of: old.id,
    supports: [{ segment_id: correction.id, source_revision: source.source_revision, start: 0, end: source.text.length, quote: source.text, role: 'relation' }] });
  assert.equal(h.store.commitRelationJob(job.id, { relations: [corrected] }).accepted, 1);
  const graph = h.store.graph(h.run.listeningId);
  assert.equal(graph.assertions.find(a => a.id === old.id).status, 'superseded');
  assert.equal(graph.assertions.find(a => a.id !== old.id).status, 'needs_review');
  assert.ok(graph.revisions.some(r => r.action === 'explicit_correction'));
});
