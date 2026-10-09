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

test('schema 5→9 preserves legacy data; migrations and read-only snapshots never backfill or enable other histories', t => {
  const h = fixture(t); h.seed();
  for (const row of h.store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'relation_%'").all()) h.store.db.exec(`DROP TRIGGER ${row.name}`);
  h.store.db.exec('DROP TABLE relation_revisions; DROP TABLE relation_supports; DROP TABLE relation_assertions; DROP TABLE relations; DROP TABLE relation_requests; DROP TABLE relation_jobs; DROP TABLE relation_windows;');
  for (const column of ['relation_enabled', 'relation_epoch', 'relation_waiting_key', 'graph_revision']) h.store.db.exec(`ALTER TABLE listenings DROP COLUMN ${column}`);
  h.store.db.exec('PRAGMA user_version=5');
  h.reopen();
  assert.equal(h.store.db.prepare('PRAGMA user_version').get().user_version, 12);
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
  assert.equal(h.job(), null, 'unchanged partial work is settled across explicit continuation');
  h.store.addSegment(h.run.listeningId, h.run.runId, { id: 'updated', text: 'Acme released Camera again.' });
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
  assert.equal(h.job(), null); assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'empty');
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

test('static 192-sentence history completes all 32 windows in one run beyond old time/request/token caps', t => {
  const h = fixture(t); const [acme] = h.seed();
  for (let i = 2; i <= 192; i++) h.store.addSegment(h.run.listeningId, h.run.runId, { id: `s${i}`, text: `Acme released Camera ${i}.` });
  h.store.finishRun(h.run.runId); h.store.enableRelations(h.run.listeningId);
  const first = h.store.relationProcessing(h.run.listeningId).round;
  const starts = [];
  for (let i = 0; i < 32; i++) {
    const now = first.startedAt + i * 25000;
    const job = h.store.nextRelationJob(h.run.listeningId, { quietMs: 0, now });
    assert.ok(job); starts.push(job.input.focus_segments[0].sequence_no);
    assert.ok(h.store.beginRelationRequest(job.id, { now }));
    h.store.commitRelationJob(job.id, { relations: [], usage: { total_tokens: 8000 }, now: now + 1000 });
  }
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.round.id, first.id); assert.equal(status.round.requestCount, 32);
  assert.equal(status.round.totalTokens, 256000); assert.equal(status.round.stopReason, null);
  assert.equal(status.progress.completedWindows, 32); assert.equal(status.progress.remainingWindows, 0);
  assert.equal(status.state, 'empty'); assert.deepEqual(starts, Array.from({ length: 32 }, (_, i) => i * 6 + 1));
  assert.equal(status.round.maxRequests, undefined); assert.equal(status.round.deadlineAt, undefined);
  assert.equal(status.round.maxEstimatedTokens, undefined); assert.equal(status.round.estimatedTokens, undefined);
  for (let i = 0; i < 100; i++) assert.equal(h.job(), null);
  h.store.db.prepare('UPDATE knowledge_items SET content_version=content_version+1,dialogue_summary=? WHERE id=?').run('Updated card prose.', acme.id);
  assert.equal(h.job(), null); assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 32);
});

test('no-op and redundant mention writes do not discard an in-flight paid result or reset retry state', t => {
  const h = fixture(t); const [acme] = h.seed(); h.store.enableRelations(h.run.listeningId);
  const job = h.reserve();
  h.store.db.prepare('UPDATE knowledge_items SET canonical_name=canonical_name,content_version=content_version+1 WHERE id=?').run(acme.id);
  h.store.db.prepare('UPDATE knowledge_mentions SET surface_text=surface_text WHERE item_id=?').run(acme.id);
  h.store.db.exec("UPDATE relation_windows SET revision=revision+1,state='dirty'");
  assert.equal(h.store.commitRelationJob(job.id, { relations: [relation(job)], usage: { total_tokens: 15 } }).stale, false);
  assert.equal(h.job(), null); assert.equal(h.store.graph(h.run.listeningId).relations.length, 1);
  h.store.db.prepare('UPDATE segments SET translation_state=\'complete\',translation_text=? WHERE id=?').run('Acme 推出了 Camera。', h.segment.id);
  const retry = h.reserve(); h.store.failRelationJob(retry.id, { code: 'HTTP_429', retryAt: Date.now() + 20000 });
  h.store.db.exec("UPDATE relation_windows SET revision=revision+1,state='dirty'");
  assert.equal(h.job(), null, 'no-op cannot bypass provider retry delay');
  const pending = h.store.db.prepare('SELECT * FROM relation_jobs WHERE id=?').get(retry.id);
  assert.equal(pending.state, 'pending'); assert.equal(pending.request_count, 1);
});

test('real source or endpoint identity changes stay pending but share a three-attempt window budget', t => {
  const h = fixture(t); const [acme] = h.seed(); h.store.enableRelations(h.run.listeningId);
  for (let i = 1; i <= 3; i++) {
    const job = h.reserve(); assert.equal(job.window_request_count, i);
    h.store.db.prepare('UPDATE knowledge_items SET certainty=? WHERE id=?').run(i % 2 ? 'needs_review' : 'clear', acme.id);
    assert.equal(h.store.commitRelationJob(job.id, { relations: [relation(job)], usage: { total_tokens: 20 } }).stale, true);
  }
  assert.equal(h.job(), null);
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.requestCount, 3); assert.equal(status.state, 'failed');
  assert.equal(status.usageLastHour.totalTokens, 60); assert.equal(status.progress.remainingWindows, 1);
  h.store.enableRelations(h.run.listeningId, { retry: true });
  assert.equal(h.reserve().window_request_count, 1, 'only explicit continuation grants a new bounded window budget');
});

test('duplicate start and restart preserve attempts/usage without restoring obsolete whole-run quotas', t => {
  const h = fixture(t); h.seed();
  for (let i = 2; i <= 18; i++) h.store.addSegment(h.run.listeningId, h.run.runId, { id: `s${i}`, text: 'Acme released Camera.' });
  h.store.enableRelations(h.run.listeningId);
  const job = h.reserve(); h.store.commitRelationJob(job.id, { relations: [], usage: { total_tokens: 150000 } });
  const before = h.store.relationProcessing(h.run.listeningId).round;
  h.store.enableRelations(h.run.listeningId, { retry: true }); h.reopen();
  const after = h.store.relationProcessing(h.run.listeningId).round;
  assert.equal(after.id, before.id); assert.equal(after.requestCount, 1); assert.equal(after.totalTokens, 150000);
  h.store.enableRelations(h.run.listeningId, { retry: true });
  for (let i = 0; i < 2; i++) { const next = h.reserve(); h.store.commitRelationJob(next.id, { relations: [] }); }
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.progress.completedWindows, 3); assert.equal(status.round.requestCount, 3);
  assert.equal(status.round.measuredRequests, 1); assert.equal(status.round.totalTokens, 150000);
  assert.equal(h.job(), null);
});

test('cancel is durable, keeps partial graph, ignores late edges and attributes late usage to its original attempt', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const successful = h.reserve(); h.store.commitRelationJob(successful.id, { relations: [relation(successful)] });
  h.store.addSegment(h.run.listeningId, h.run.runId, { id: 's2', text: 'Acme released Camera again.' });
  const late = h.reserve(); h.store.cancelRelations(h.run.listeningId); h.reopen();
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'cancelled');
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 1); assert.equal(h.job(), null);
  h.store.enableRelations(h.run.listeningId, { retry: true }); const current = h.reserve();
  h.store.recordRelationUsage(late.id, { usage: { total_tokens: 123 }, attempt: late.request_count });
  assert.equal(h.store.commitRelationJob(late.id, { relations: [relation(late)] }).stale, true);
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.round.requestCount, 1); assert.equal(status.round.totalTokens, 0);
  assert.equal(status.usageLastHour.totalTokens, 123);
  h.store.commitRelationJob(current.id, { relations: [] });
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 1);
});

test('restored source text does not reuse stale evidence without revalidation', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const first = h.reserve(); h.store.commitRelationJob(first.id, { relations: [relation(first)] });
  h.store.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run('Acme never released Camera.', h.segment.id);
  h.store.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run(h.segment.original_text, h.segment.id);
  assert.equal(h.store.graph(h.run.listeningId).assertions[0].status, 'stale');
  const recheck = h.reserve(); h.store.commitRelationJob(recheck.id, { relations: [relation(recheck)] });
  assert.equal(h.store.graph(h.run.listeningId).assertions[0].status, 'active');
});

test('v6 migration replaces broad update triggers and pauses unbounded legacy work', t => {
  const h = fixture(t); const [acme] = h.seed(); h.store.enableRelations(h.run.listeningId);
  const running = h.reserve(); h.store.db.exec('DROP TABLE relation_rounds; PRAGMA user_version=6'); h.reopen();
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'paused');
  assert.equal(h.store.relationProcessing(h.run.listeningId).round.stopReason, 'REQUEST_INTERRUPTED'); assert.equal(h.job(), null);
  assert.equal(h.store.db.prepare('SELECT request_count FROM relation_jobs WHERE id=?').get(running.id).request_count, 1);
  const revision = h.store.db.prepare('SELECT revision FROM relation_windows').get().revision;
  h.store.db.prepare('UPDATE knowledge_items SET content_version=content_version+1 WHERE id=?').run(acme.id);
  assert.equal(h.store.db.prepare('SELECT revision FROM relation_windows').get().revision, revision);
});

test('an empty revalidation caches changed input even while historical supports remain stale', t => {
  const h = fixture(t); const [acme] = h.seed(); h.store.enableRelations(h.run.listeningId);
  const first = h.reserve(); h.store.commitRelationJob(first.id, { relations: [relation(first)] });
  h.store.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run('Acme never released Camera.', h.segment.id);
  const second = h.reserve(); h.store.commitRelationJob(second.id, { relations: [] });
  assert.equal(h.store.graph(h.run.listeningId).assertions[0].status, 'stale');
  h.store.db.prepare('INSERT INTO knowledge_mentions(item_id,segment_id,surface_text) VALUES(?,?,?)').run(acme.id, h.segment.id, 'Acme never released');
  assert.equal(h.job(), null, 'stale historical support does not force identical already-validated input to repeat');
  assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 2);
});

test('storage cancellation fence rejects late commits and still records paid usage', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const job = h.reserve(); h.store.cancelRelations(h.run.listeningId);
  const result = h.store.commitRelationJob(job.id, { relations: [relation(job)], usage: { total_tokens: 31 } });
  assert.equal(result.stale, true); assert.equal(h.store.graph(h.run.listeningId).relations.length, 0);
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.state, 'cancelled'); assert.equal(status.round.totalTokens, 31);
  assert.equal(h.store.db.prepare('SELECT state FROM relation_jobs WHERE id=?').get(job.id).state, 'cancelled');
});

test('a new mention cannot reorder an unchanged candidate set into another paid input', t => {
  const h = fixture(t); h.seed(); h.store.db.exec('DELETE FROM knowledge_mentions'); h.store.enableRelations(h.run.listeningId);
  const first = h.reserve(); h.store.commitRelationJob(first.id, { relations: [] }); const node = first.input.candidates[1];
  h.store.db.prepare('INSERT INTO knowledge_mentions(item_id,segment_id,surface_text) VALUES(?,?,?)').run(node.id, h.segment.id, node.canonical_name);
  assert.equal(h.job(), null); assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 1);
});

test('two concurrent reservations keep advancing after paid results without a run request cap', t => {
  const h = fixture(t); h.seed();
  for (let i = 2; i <= 18; i++) h.store.addSegment(h.run.listeningId, h.run.runId, { id: `parallel-${i}`, text: 'Acme released Camera.' });
  h.store.enableRelations(h.run.listeningId);
  const next = () => h.store.nextRelationJob(h.run.listeningId, { quietMs: 0, maxConcurrent: 2 });
  const first = h.store.beginRelationRequest(next().id), second = h.store.beginRelationRequest(next().id);
  assert.notEqual(first.window_id, second.window_id); assert.equal(next(), null);
  h.store.commitRelationJob(first.id, { relations: [relation(first)], usage: { total_tokens: 120001 } });
  const third = h.store.beginRelationRequest(next().id); assert.ok(third); assert.equal(next(), null);
  assert.equal(h.store.commitRelationJob(second.id, { relations: [relation(second)] }).stale, false);
  assert.equal(h.store.commitRelationJob(third.id, { relations: [relation(third)] }).stale, false);
  assert.equal(next(), null);
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.state, 'complete'); assert.equal(status.round.stopReason, null);
  assert.equal(status.progress.completedWindows, 3); assert.equal(status.round.requestCount, 3);
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 1);
  h.reopen(); assert.equal(h.store.relationProcessing(h.run.listeningId).round.requestCount, 3);
});

test('v7 token-paused migration preserves results and resumes remaining history without repeating partial windows', t => {
  const h = fixture(t); h.seed();
  for (let i = 2; i <= 192; i++) h.store.addSegment(h.run.listeningId, h.run.runId, { id: `legacy-${i}`, text: 'Acme released Camera.' });
  h.store.enableRelations(h.run.listeningId);
  for (let i = 0; i < 5; i++) { const job = h.reserve(); h.store.commitRelationJob(job.id, { relations: [relation(job)], rejected: [{ code: 'INVALID_SUPPORT' }], usage: { total_tokens: 4163 } }); }
  const before = h.store.graph(h.run.listeningId);
  for (const row of h.store.db.prepare('SELECT id,input_json FROM relation_jobs').all()) {
    const input = JSON.parse(row.input_json);
    input.input_fingerprint = hash(JSON.stringify({ ...input, input_fingerprint: undefined, window_revision: undefined, existing_assertions: undefined }));
    h.store.db.prepare('UPDATE relation_jobs SET input_fingerprint=?,input_json=? WHERE id=?').run(input.input_fingerprint, JSON.stringify(input), row.id);
  }
  h.store.db.exec(`ALTER TABLE relation_rounds ADD COLUMN deadline_at INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE relation_rounds ADD COLUMN max_requests INTEGER NOT NULL DEFAULT 12;
    ALTER TABLE relation_rounds ADD COLUMN max_estimated_tokens INTEGER NOT NULL DEFAULT 120000;
    ALTER TABLE relation_requests ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 21000;
    UPDATE relation_rounds SET state='paused',stop_reason='ROUND_TOKEN_LIMIT'; PRAGMA user_version=7;`);
  h.reopen();
  assert.equal(h.store.db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'paused'); assert.equal(h.job(), null);
  assert.equal(h.store.graph(h.run.listeningId).relations.length, before.relations.length);
  assert.equal(h.store.relationProcessing(h.run.listeningId).usageLastHour.totalTokens, 20815);
  assert.equal(h.store.db.prepare('PRAGMA table_info(relation_rounds)').all().some(c => /max_|deadline/.test(c.name)), false);
  h.store.enableRelations(h.run.listeningId, { retry: true }); const starts = [];
  h.store.db.exec("UPDATE relation_windows SET state='dirty',revision=revision+1 WHERE from_sequence=1");
  for (;;) { const job = h.job(); if (!job) break; starts.push(job.input.focus_segments[0].sequence_no); h.store.beginRelationRequest(job.id); h.store.commitRelationJob(job.id, { relations: [], rejected: [{ code: 'INVALID_SUPPORT' }] }); }
  assert.deepEqual(starts, Array.from({ length: 27 }, (_, i) => (i + 5) * 6 + 1));
  assert.equal(h.store.relationProcessing(h.run.listeningId).progress.completedWindows, 32);
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'partial');
  h.store.enableRelations(h.run.listeningId, { retry: true }); assert.equal(h.job(), null);
  assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 32);
});

test('explicit correction windows are ordered barriers and see preceding paid assertions', t => {
  const h = fixture(t); h.seed();
  for (let i = 2; i <= 18; i++) h.store.addSegment(h.run.listeningId, h.run.runId,
    { id: `correction-${i}`, text: i === 7 ? 'Correction: Acme did not release Camera.' : 'Acme released Camera.' });
  h.store.enableRelations(h.run.listeningId);
  const next = () => h.store.nextRelationJob(h.run.listeningId, { quietMs: 0, maxConcurrent: 2 });
  const first = h.store.beginRelationRequest(next().id);
  assert.equal(next(), null, 'neither the correction nor later window overtakes prior work');
  h.store.commitRelationJob(first.id, { relations: [relation(first)] });
  const correction = h.store.beginRelationRequest(next().id);
  assert.equal(correction.input.focus_segments[0].sequence_no, 7);
  assert.equal(correction.input.existing_assertions.length, 1);
  assert.equal(next(), null, 'later windows cannot overtake the in-flight correction');
  const s = correction.input.focus_segments[0];
  const row = relation(correction, { polarity: 'negative', correction_of: correction.input.existing_assertions[0].id,
    statement: '更正：Acme 没有推出 Camera', supports: [{ segment_id: s.id, source_revision: s.source_revision,
      start: 0, end: s.text.length, quote: s.text, role: 'relation' }] });
  assert.equal(h.store.commitRelationJob(correction.id, { relations: [row] }).accepted, 1);
  assert.equal(h.store.graph(h.run.listeningId).assertions.find(a => a.id === row.correction_of).status, 'superseded');
  assert.equal(next().input.focus_segments[0].sequence_no, 13);
});

test('generated assertion context crossing 48 cannot discard another valid parallel paid response', t => {
  const h = fixture(t); h.seed();
  for (let i = 2; i <= 24; i++) h.store.addSegment(h.run.listeningId, h.run.runId, { id: `assertions-${i}`, text: 'Acme released Camera.' });
  h.store.enableRelations(h.run.listeningId);
  const next = () => h.store.beginRelationRequest(h.store.nextRelationJob(h.run.listeningId, { quietMs: 0, maxConcurrent: 2 }).id);
  const a = next(), b = next();
  for (const [prefix, job] of [['a', a], ['b', b]]) assert.equal(h.store.commitRelationJob(job.id, {
    relations: Array.from({ length: 24 }, (_, i) => relation(job, { statement: `Acme release assertion ${prefix}${i}` }))
  }).stale, false);
  assert.equal(h.store.graph(h.run.listeningId).assertions.length, 48);
  const c = next(), d = next();
  assert.equal(d.input.coverage_limited, false);
  assert.equal(h.store.commitRelationJob(c.id, { relations: [relation(c, { statement: 'Acme release assertion c' })] }).stale, false);
  assert.equal(h.store.graph(h.run.listeningId).assertions.length, 49);
  assert.equal(h.store.commitRelationJob(d.id, { relations: [relation(d)], usage: { total_tokens: 99 } }).stale, false);
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.progress.completedWindows, 4); assert.equal(status.round.requestCount, 4);
  assert.equal(status.round.totalTokens, 99); assert.equal(h.job(), null);
});

test('unchanged clipped partial windows are terminal and do not starve later windows or loop on retry', t => {
  const h = fixture(t, `Acme released Camera. ${'x'.repeat(15000)}`); h.seed();
  for (let i = 2; i <= 84; i++) h.store.addSegment(h.run.listeningId, h.run.runId, { id: `clipped-${i}`, text: `Acme released Camera. ${'x'.repeat(15000)}` });
  h.store.enableRelations(h.run.listeningId);
  const starts = [];
  for (;;) { const job = h.job(); if (!job) break; starts.push(job.input.focus_segments[0].sequence_no); h.store.beginRelationRequest(job.id); assert.equal(h.store.commitRelationJob(job.id, { relations: [] }).state, 'partial'); }
  assert.deepEqual(starts, Array.from({ length: 14 }, (_, i) => i * 6 + 1));
  for (let i = 0; i < 3; i++) { h.store.enableRelations(h.run.listeningId, { retry: true }); assert.equal(h.job(), null); }
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.state, 'partial'); assert.equal(status.partialJobs, 14); assert.equal(status.requestCount, 14);
});

test('diagnostics persist exact row counts, distinguish unique edges and sanitize rejection text', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const job = h.reserve(), valid = relation(job);
  h.store.commitRelationJob(job.id, { relations: [valid, valid, { ...valid, object_item_id: 'missing' }],
    rejected: [{ code: 'SEMANTIC_NEGATION_DROPPED' }, { code: 'SECRET model text Bearer private-key' }], returnedCount: 5 });
  const expected = { scope: 'latest_result_per_window', resultJobs: 1, measuredJobs: 1, unknownJobs: 0,
    returnedCount: 5, validatorAcceptedCount: 3, acceptedCount: 2, rejectedCount: 3,
    insertedRelationCount: 1, deduplicatedCount: 1, storedRelationCount: 1, visibleRelationCount: 1,
    coverageLimitedWindows: 0 };
  const diagnostics = h.store.graph(h.run.listeningId).status.diagnostics;
  for (const [key, value] of Object.entries(expected)) assert.equal(diagnostics[key], value, key);
  assert.deepEqual(diagnostics.rejectionReasons.map(r => r.code).sort(), ['INVALID_ENDPOINT_OR_PREDICATE', 'SEMANTIC_NEGATION_DROPPED', 'UNKNOWN_REASON']);
  assert.ok(diagnostics.rejectionReasons.every(r => typeof r.label === 'string' && r.count === 1));
  assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET|Bearer|private-key|Acme|Camera/);
  assert.doesNotMatch(h.store.db.prepare('SELECT rejected_json FROM relation_jobs WHERE id=?').get(job.id).rejected_json, /SECRET|Bearer|private-key/);
  h.reopen(); assert.deepEqual(h.store.graph(h.run.listeningId).status.diagnostics, diagnostics);
  assert.equal(h.store.commitRelationJob(job.id, { relations: [] }).duplicate, true);
  assert.deepEqual(h.store.graph(h.run.listeningId).status.diagnostics, diagnostics);
});

test('v8 migration preserves unknown counts and rejection reasons without replaying partial results', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const job = h.reserve(); h.store.commitRelationJob(job.id, { relations: [], rejected: [{ code: 'SEMANTIC_PLAN_DROPPED' }] });
  for (const column of ['returned_count', 'validator_accepted_count', 'accepted_count', 'inserted_relation_count', 'deduplicated_count']) h.store.db.exec(`ALTER TABLE relation_jobs DROP COLUMN ${column}`);
  h.store.db.exec('ALTER TABLE relation_windows DROP COLUMN min_result_epoch; PRAGMA user_version=8');
  h.reopen();
  const diagnostics = h.store.graph(h.run.listeningId).status.diagnostics;
  assert.equal(diagnostics.returnedCount, null); assert.equal(diagnostics.acceptedCount, null);
  assert.equal(diagnostics.insertedRelationCount, null); assert.equal(diagnostics.deduplicatedCount, null);
  assert.equal(diagnostics.unknownJobs, 1); assert.equal(diagnostics.rejectedCount, 1);
  assert.equal(diagnostics.rejectionReasons[0].code, 'SEMANTIC_PLAN_DROPPED');
  assert.equal(h.store.relationHasWork(h.run.listeningId), false); assert.equal(h.job(), null);
  h.store.enableRelations(h.run.listeningId, { retry: true }); assert.equal(h.job(), null);
  assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 1);
});

test('selective retry is explicit, epoch fenced, limited to problem windows and preserves prior successful data', t => {
  const h = fixture(t); h.seed();
  for (let i = 2; i <= 18; i++) h.store.addSegment(h.run.listeningId, h.run.runId, { id: `selective-${i}`, text: 'Acme released Camera.' });
  h.store.enableRelations(h.run.listeningId);
  const complete = h.reserve(); h.store.commitRelationJob(complete.id, { relations: [relation(complete)] });
  const partial = h.reserve(); h.store.commitRelationJob(partial.id, { relations: [], coverageLimited: true });
  const failed = h.reserve(); h.store.failRelationJob(failed.id, { code: 'REQUEST_FAILED', terminal: true });
  const before = h.store.graph(h.run.listeningId), epoch = before.status.round.epoch;
  assert.equal(before.status.retryableWindows, 2); assert.equal(before.status.canRetryProblems, true);
  assert.equal(h.job(), null, 'no automatic paid retry of unchanged partial/failed windows');
  h.store.retryProblemRelations(h.run.listeningId, { expectedEpoch: epoch });
  assert.equal(h.store.relationProcessing(h.run.listeningId).round.epoch, epoch + 1);
  assert.throws(() => h.store.retryProblemRelations(h.run.listeningId, { expectedEpoch: epoch }), /RETRY_STATE_CHANGED/);
  assert.throws(() => h.store.retryProblemRelations(h.run.listeningId, { expectedEpoch: epoch + 1 }), /RETRY_STATE_CHANGED/);
  const first = h.reserve(); assert.equal(first.window_id, partial.window_id);
  for (let count = 1; count <= 3; count++) {
    const current = count === 1 ? first : h.store.beginRelationRequest(h.job().id);
    assert.equal(current.request_count, count);
    h.store.failRelationJob(current.id, { code: 'REQUEST_FAILED', retryAt: 0, terminal: count === 3 });
  }
  const second = h.reserve(); assert.equal(second.window_id, failed.window_id);
  h.store.commitRelationJob(second.id, { relations: [relation(second)] }); assert.equal(h.job(), null);
  const after = h.store.graph(h.run.listeningId);
  assert.equal(after.relations.length, 1); assert.equal(after.relations[0].id, before.relations[0].id);
  assert.ok(after.supports.some(s => s.id === before.supports[0].id && s.state === 'active'));
  assert.equal(h.store.getRelationJob(complete.id).request_count, 1, 'successful window never replayed');
  assert.equal(after.status.round.requestCount, 4, 'per-window retry bound remains three');
});

test('a selective retry cannot reopen a cancelled late-result fence', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const first = h.reserve(); h.store.commitRelationJob(first.id, { relations: [], coverageLimited: true });
  h.store.retryProblemRelations(h.run.listeningId, { expectedEpoch: first.epoch });
  const retry = h.reserve(); h.store.cancelRelations(h.run.listeningId);
  assert.equal(h.store.commitRelationJob(retry.id, { relations: [relation(retry)] }).stale, true);
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 0);
  assert.equal(h.store.relationProcessing(h.run.listeningId).state, 'cancelled');
});

test('v2 rejection metadata is bounded, allowlisted and persisted without source or model strings', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId); const job = h.reserve();
  const metadata = { schema_version: 2, stage: 'identity', row_shape: 'object', evidence_count: 5,
    unknown_evidence_count: 999, focus_evidence_count: -1, subject_mention_known: false, object_mention_known: true,
    subject_endpoint_known: true, object_endpoint_known: true, has_legacy_supports: false,
    raw_row: 'PRIVATE ATLAS SOURCE', quote: 'PRIVATE ORIGINAL', subject_item_id: 'SECRET_ID', field: 'SECRET FIELD', token: 'Bearer SECRET' };
  h.store.commitRelationJob(job.id, { relations: [], rejected: [{ code: 'MENTION_ENDPOINT_MISMATCH', index: 0, metadata }], returnedCount: 1 });
  const saved = h.store.getRelationJob(job.id).rejected[0];
  assert.deepEqual(saved.metadata, { schema_version: 2, stage: 'identity', row_shape: 'object', evidence_count: 5,
    unknown_evidence_count: 99, subject_mention_known: false, object_mention_known: true,
    subject_endpoint_known: true, object_endpoint_known: true, has_legacy_supports: false });
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|SECRET|Bearer/);
  assert.equal(h.store.relationProcessing(h.run.listeningId).diagnostics.rejectionStages.identity, 1);
  assert.equal(h.store.relationProcessing(h.run.listeningId).diagnostics.rejectionReasons[0].code, 'MENTION_ENDPOINT_MISMATCH');
  h.reopen(); assert.deepEqual(h.store.getRelationJob(job.id).rejected[0], saved);
});

test('v2 registry clipping is persisted as partial coverage without an automatic paid replay', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId); const job = h.reserve();
  const fingerprint = job.input_fingerprint;
  h.store.commitRelationJob(job.id, { relations: [relation(job, { status: 'needs_review' })], returnedCount: 1, coverageLimited: true });
  const graph = h.store.graph(h.run.listeningId);
  assert.equal(graph.status.state, 'partial'); assert.equal(graph.status.diagnostics.coverageLimitedWindows, 1);
  assert.equal(graph.status.diagnostics.reviewRelationCount, 1); assert.equal(graph.status.diagnostics.reviewAssertionCount, 1);
  assert.equal(h.store.getRelationJob(job.id).input_fingerprint, fingerprint);
  assert.equal(h.store.getRelationJob(job.id).input.coverage_limited, true);
  assert.equal(h.job(), null); h.reopen(); assert.equal(h.job(), null);
  assert.equal(h.store.relationProcessing(h.run.listeningId).diagnostics.coverageLimitedWindows, 1);
  assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 1);
});

test('v1 pending and interrupted requests are fenced without another attempt, explicit retry creates v3 only for problems', t => {
  const h = fixture(t); h.seed();
  for (let i = 2; i <= 18; i++) h.store.addSegment(h.run.listeningId, h.run.runId, { id: `protocol-${i}`, text: 'Acme released Camera.' });
  h.store.enableRelations(h.run.listeningId);
  const completed = h.reserve(); h.store.commitRelationJob(completed.id, { relations: [relation(completed)] });
  const running = h.reserve(); const pending = h.store.nextRelationJob(h.run.listeningId, { quietMs: 0, maxConcurrent: 2 });
  assert.ok(pending);
  h.store.db.exec("UPDATE relation_jobs SET prompt_version='relations-v1'");
  for (const row of h.store.db.prepare('SELECT id,input_json FROM relation_jobs').all()) {
    const input = JSON.parse(row.input_json); input.prompt_version = 'relations-v1';
    for (const candidate of input.candidates) delete candidate.mentions;
    const oldFingerprint = hash(JSON.stringify({ ...input, input_fingerprint: undefined, window_revision: undefined, existing_assertions: undefined, coverage_limited: undefined }));
    input.input_fingerprint = oldFingerprint;
    h.store.db.prepare('UPDATE relation_jobs SET input_json=?,input_fingerprint=? WHERE id=?').run(JSON.stringify(input), oldFingerprint, row.id);
  }
  h.reopen();
  assert.equal(h.store.getRelationJob(completed.id).state, 'complete');
  assert.equal(h.store.getRelationJob(completed.id).prompt_version, 'relations-v1', 'legacy protocol metadata is not relabeled');
  for (const old of [running, pending]) {
    const job = h.store.getRelationJob(old.id);
    assert.equal(job.state, 'failed'); assert.equal(job.last_error, 'RELATION_CONTRACT_CHANGED');
    assert.equal(job.request_count, old.request_count); assert.equal(h.store.beginRelationRequest(old.id), null);
  }
  assert.equal(h.job(), null); assert.equal(h.store.graph(h.run.listeningId).relations.length, 1);
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.diagnostics.failureReasons[0].code, 'RELATION_CONTRACT_CHANGED');
  h.store.retryProblemRelations(h.run.listeningId, { expectedEpoch: status.round.epoch });
  const retry = h.reserve(); assert.equal(retry.prompt_version, 'relations-v3'); assert.equal(retry.window_id, running.window_id);
  h.store.commitRelationJob(retry.id, { relations: [] });
  const next = h.reserve(); assert.equal(next.window_id, pending.window_id); assert.equal(next.prompt_version, 'relations-v3');
  h.store.commitRelationJob(next.id, { relations: [] });
  assert.equal(h.job(), null); assert.equal(h.store.getRelationJob(completed.id).request_count, 1);
});

test('terminal legacy cache survives upgrade, restart and redundant mention dirtiness without new requests', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const job = h.reserve(); h.store.commitRelationJob(job.id, { relations: [relation(job)], rejected: [{ code: 'FIELD_INVALID' }] });
  const input = job.input; input.prompt_version = 'relations-v1'; for (const c of input.candidates) delete c.mentions;
  const fingerprint = hash(JSON.stringify({ ...input, input_fingerprint: undefined, window_revision: undefined, existing_assertions: undefined, coverage_limited: undefined }));
  input.input_fingerprint = fingerprint;
  h.store.db.prepare("UPDATE relation_jobs SET prompt_version='relations-v1',input_json=?,input_fingerprint=?,returned_count=NULL,accepted_count=NULL WHERE id=?")
    .run(JSON.stringify(input), fingerprint, job.id);
  h.store.db.prepare('UPDATE relation_windows SET last_fingerprint=? WHERE id=?').run(fingerprint, job.window_id);
  h.reopen();
  assert.equal(h.job(), null); assert.equal(h.store.getRelationJob(job.id).prompt_version, 'relations-v1');
  assert.equal(h.store.relationProcessing(h.run.listeningId).diagnostics.returnedCount, null);
  h.store.db.prepare('INSERT INTO knowledge_mentions(item_id,segment_id,surface_text) VALUES(?,?,?)').run(job.input.candidates[0].id, h.segment.id, h.segment.original_text);
  assert.equal(h.job(), null, 'redundant provenance does not bypass the settled legacy cache');
  h.reopen(); assert.equal(h.job(), null); assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 1);
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 1);
});

test('compact v3 wire avoids clipping source that v2 duplicated beyond the byte budget', async t => {
  const { buildRelationRequest } = await import('../relations.mjs');
  const text = 'Acme released Camera. ' + '甲'.repeat(13970);
  const h = fixture(t, text); h.seed(); h.store.enableRelations(h.run.listeningId);
  const job = h.job();
  assert.equal(job.request_count, 0); assert.equal(job.input.coverage_limited, false);
  assert.ok(Buffer.byteLength(JSON.stringify(buildRelationRequest(job.input).body)) <= RELATION_LIMITS.requestBytes);
  assert.equal(job.input.focus_segments[0].text, text);
  assert.equal(job.input.focus_segments[0].source_revision, hash(text), 'full original revision remains the storage fence');
  assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 0);
});

test('workflow rejects oversized input before reservation', async () => {
  const { buildRelationRequest, RELATION_CONTRACT_VERSION } = await import('../relations.mjs');
  const { createRelationWorkflow } = await import('../relation-workflow.mjs');
  const input = { listening_id: 'local', focus_segments: [{ id: 's1', text: 'Acme launched Camera. ' + '甲'.repeat(14001) }],
    context_segments: [], candidates: [{ id: 'a', canonical_name: 'Acme', type: 'other' }, { id: 'b', canonical_name: 'Camera', type: 'other' }], existing_assertions: [] };
  assert.throws(() => buildRelationRequest(input), error => error.reason === 'INPUT_BUDGET_EXCEEDED');
  let requests = 0, calls = 0, failure;
  const store = { hasListening: () => true, relationProcessing: () => ({ state: 'running' }),
    failRelationJob: (_id, error) => { failure = error; }, beginRelationRequest: () => { requests++; } };
  const workflow = createRelationWorkflow({ store, extract: async () => { calls++; } });
  const result = await workflow.execute({ id: 'job', listening_id: 'local', prompt_version: RELATION_CONTRACT_VERSION, input }, 'fixture-key');
  assert.equal(result.outcome, 'failed'); assert.equal(failure.code, 'INPUT_BUDGET_EXCEEDED');
  assert.equal(requests, 0); assert.equal(calls, 0);
});

test('v3 workflow forwards registry coverage and preserves precise root protocol failure codes', async t => {
  const { createRelationWorkflow } = await import('../relation-workflow.mjs');
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const workflow = createRelationWorkflow({ store: h.store, extract: async () => ({ relations: [], rejected: [], returnedCount: 0, coverageLimited: true }) });
  assert.equal((await workflow.execute(h.job(), 'fixture-key')).outcome, 'partial');
  assert.equal(h.store.relationProcessing(h.run.listeningId).diagnostics.coverageLimitedWindows, 1);
  h.store.retryProblemRelations(h.run.listeningId, { expectedEpoch: h.store.relationProcessing(h.run.listeningId).round.epoch });
  const failure = createRelationWorkflow({ store: h.store, extract: async () => {
    throw Object.assign(new Error('PRIVATE raw model response'), { code: 'RELATION_INVALID_RESPONSE', reason: 'CONTRACT_VERSION_INVALID' });
  } });
  const job = h.job(); await failure.execute(job, 'fixture-key');
  assert.equal(h.store.getRelationJob(job.id).last_error, 'CONTRACT_VERSION_INVALID');
  assert.doesNotMatch(h.store.getRelationJob(job.id).last_error, /PRIVATE/);
});

test('an obsolete in-flight protocol cannot commit or reopen its window and late usage is retained', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId); const job = h.reserve();
  h.store.db.prepare("UPDATE relation_jobs SET prompt_version='relations-v1' WHERE id=?").run(job.id);
  const result = h.store.commitRelationJob(job.id, { relations: [relation(job)], usage: { total_tokens: 13 } });
  assert.equal(result.stale, true); assert.equal(result.reason, 'RELATION_CONTRACT_CHANGED');
  assert.equal(h.store.graph(h.run.listeningId).relations.length, 0); assert.equal(h.job(), null);
  assert.equal(h.store.getRelationJob(job.id).request_count, 1);
  assert.equal(h.store.getRelationJob(job.id).last_error, 'RELATION_CONTRACT_CHANGED');
  assert.equal(h.store.relationProcessing(h.run.listeningId).usageLastHour.totalTokens, 13);
});

test('all-filtered windows complete normally, keep diagnostics and cannot be retried as failures', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const job = h.reserve();
  const result = h.store.commitRelationJob(job.id, { relations: [], returnedCount: 3,
    rejected: [{ code: 'IDENTITY_REFERENCE_UNANCHORED' }, { code: 'ENDPOINT_INVALID' }, { code: 'QUALIFIER_NOT_IN_SOURCE' }] });
  assert.equal(result.state, 'complete');
  let status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.state, 'empty'); assert.equal(status.partialJobs, 0); assert.equal(status.failedJobs, 0);
  assert.equal(status.canRetryProblems, false); assert.equal(status.diagnostics.rejectedCount, 3);
  h.store.retryProblemRelations(h.run.listeningId, { expectedEpoch: job.epoch });
  assert.equal(h.job(), null); h.reopen(); assert.equal(h.job(), null);
  status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.requestCount, 1); assert.equal(status.round.epoch, job.epoch);
});

test('v9 candidate-only partial history is settled locally without replaying or losing edges/counts', t => {
  const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId);
  const job = h.reserve(); h.store.commitRelationJob(job.id, { relations: [relation(job)], rejected: [{ code: 'SEMANTIC_PREDICATE_UNSUPPORTED' }] });
  const before = h.store.graph(h.run.listeningId);
  h.store.db.prepare("UPDATE relation_jobs SET state='partial',prompt_version='relations-v2',returned_count=NULL,accepted_count=NULL WHERE id=?").run(job.id);
  h.store.db.prepare("UPDATE relation_windows SET state='partial' WHERE id=?").run(job.window_id);
  h.reopen();
  const after = h.store.graph(h.run.listeningId), saved = h.store.getRelationJob(job.id);
  assert.equal(saved.state, 'complete'); assert.equal(saved.prompt_version, 'relations-v2');
  assert.equal(after.status.state, 'complete'); assert.equal(after.status.canRetryProblems, false);
  assert.equal(after.status.requestCount, 1); assert.equal(after.status.round.epoch, job.epoch);
  assert.equal(after.status.diagnostics.returnedCount, null); assert.equal(after.status.diagnostics.acceptedCount, null);
  assert.equal(after.status.diagnostics.rejectionReasons[0].code, 'SEMANTIC_PREDICATE_UNSUPPORTED');
  assert.deepEqual(after.relations, before.relations); assert.equal(h.job(), null);
  h.reopen(); assert.equal(h.job(), null); assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 1);
});

test('migration preserves real coverage/storage problems and windows changed after an old partial result', t => {
  for (const kind of ['coverage', 'storage', 'changed']) {
    const h = fixture(t); h.seed(); h.store.enableRelations(h.run.listeningId); const job = h.reserve();
    h.store.commitRelationJob(job.id, { relations: [], coverageLimited: kind === 'coverage',
      rejected: [{ code: kind === 'storage' ? 'INVALID_SUPPORT' : 'FIELD_INVALID' }] });
    h.store.db.prepare("UPDATE relation_jobs SET state='partial',prompt_version='relations-v2' WHERE id=?").run(job.id);
    h.store.db.prepare("UPDATE relation_windows SET state='partial' WHERE id=?").run(job.window_id);
    if (kind === 'changed') h.store.db.prepare("UPDATE segments SET original_text='Acme did not release Camera.' WHERE id=?").run(h.segment.id);
    h.reopen();
    if (kind === 'changed') {
      assert.equal(h.store.db.prepare('SELECT state FROM relation_windows WHERE id=?').get(job.window_id).state, 'dirty');
    } else {
      assert.equal(h.store.getRelationJob(job.id).state, 'partial');
      assert.equal(h.store.relationProcessing(h.run.listeningId).canRetryProblems, true);
    }
    assert.equal(h.store.relationProcessing(h.run.listeningId).requestCount, 1);
  }
});

test('fewer than two candidate nodes settles the current window without a model request', t => {
  const h = fixture(t); h.addNode('Acme'); h.store.enableRelations(h.run.listeningId);
  assert.equal(h.job(), null);
  const status = h.store.relationProcessing(h.run.listeningId);
  assert.equal(status.state, 'empty'); assert.equal(status.requestCount, 0);
  assert.equal(status.progress.completedWindows, 1); assert.equal(status.progress.remainingWindows, 0);
  assert.equal(status.canRetryProblems, false);
});
