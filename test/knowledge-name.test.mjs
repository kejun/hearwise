import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { seedGraphListening, graphFixture } from '../test-support/graph-fixture.mjs';
import { validateNameCorrectionResult, nameIdentity } from '../knowledge-name.mjs';
import { exportDatabase, previewImport, appendDatabase, restoreDatabase } from '../data-transfer.mjs';
import { parseTraceInput, buildTraceReport, buildBusinessOverview } from '../dist/server/index.js';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'knowledge-name-'));
  const filename = path.join(directory, 'data.sqlite');
  const h = { directory, filename, store: new ListeningStore(filename) };
  Object.assign(h, seedGraphListening(h.store, { extraNodes: 0 }));
  h.item = h.nodes[0];
  h.store.db.prepare("UPDATE knowledge_items SET canonical_name='Eastmen Kodak' WHERE id=?").run(h.item.id);
  h.reopen = () => { h.store.close(); h.store = new ListeningStore(filename); };
  t.after(() => { h.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return h;
}
function accept(h, options = { hasKey: true }, id = randomUUID()) {
  const input = { revision: h.store.knowledgeEditSnapshot(h.listeningId, h.item.id).revision };
  return { ...h.store.acceptNameCorrection(h.listeningId, h.item.id, id, input, options), input };
}
function corrected(prepared, name = 'Eastman Kodak') {
  const segment = prepared.input.segments.find(row => row.linked);
  return { outcome: 'corrected', name, reason: '关联原文中有明确拼写。',
    evidence: [{ segment_id: segment.id, source_kind: 'original', quote: segment.original }] };
}
function save(h, accepted) {
  assert.equal(h.store.reserveNameCorrection(accepted.job.id), true);
  assert.equal(h.store.reserveNameCorrection(accepted.job.id), false);
  return h.store.saveNameCorrection(h.listeningId, h.item.id, accepted.job.id, accepted.prepared, corrected(accepted.prepared));
}
const rows = (store, table) => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

test('display-only correction preserves source/card/provenance and in-flight relationship input', t => {
  const h = fixture(t);
  h.store.db.prepare('INSERT INTO knowledge_facts VALUES (?,?,?,?,?,?,?)').run(randomUUID(), h.item.id, h.evidence.id,
    h.evidence.original_text, '推出 Brownie 相机', 'clear', new Date().toISOString());
  h.store.enableRelations(h.listeningId);
  const relation = h.store.beginRelationRequest(h.store.nextRelationJob(h.listeningId, { quietMs: 0 }).id);
  const tables = ['segments', 'knowledge_aliases', 'knowledge_mentions', 'knowledge_facts', 'relations', 'relation_assertions', 'relation_supports', 'relation_windows'];
  const before = Object.fromEntries(tables.map(table => [table, rows(h.store, table)]));
  const item = h.store.knowledge(h.listeningId)[0], graphRevision = h.store.graphMetadata(h.listeningId).graphRevision;
  const job = save(h, accept(h));
  assert.equal(job.changed, true); assert.equal(job.result.previous_name, 'Eastmen Kodak');
  const updated = h.store.knowledge(h.listeningId)[0];
  assert.equal(updated.display_name, 'Eastman Kodak'); assert.equal(updated.canonical_name, item.canonical_name);
  for (const key of ['aliases', 'dialogue_summary', 'short_description', 'background_note', 'facts', 'mentions', 'type', 'certainty'])
    assert.deepEqual(updated[key], item[key], key);
  assert.equal(updated.content_version, item.content_version + 1);
  for (const table of tables) assert.deepEqual(rows(h.store, table), before[table], table);
  assert.ok(h.store.graphMetadata(h.listeningId).graphRevision > graphRevision);
  assert.equal(h.store.getRelationJob(relation.id).input_fingerprint, relation.input_fingerprint);
  assert.equal(h.store.commitRelationJob(relation.id, { relations: [] }).state, 'complete');
  const windows = rows(h.store, 'relation_windows');
  const reserved = windows.find(row => row.id === relation.window_id);
  assert.equal(reserved.revision, before.relation_windows.find(row => row.id === relation.window_id).revision);
  h.reopen(); assert.equal(h.store.knowledge(h.listeningId)[0].display_name, 'Eastman Kodak');
  assert.match(h.store.exportText(h.listeningId, 'original').text, /Eastman Kodak released/);
});

test('parallel UUIDs merge, accepted ID and applied-context cache survive repeated clicks without a key', t => {
  const h = fixture(t), first = accept(h), otherId = randomUUID();
  const duplicate = h.store.acceptNameCorrection(h.listeningId, h.item.id, otherId, first.input, { hasKey: false, busy: true });
  assert.equal(duplicate.job.id, first.job.id); assert.equal(duplicate.prepared, undefined);
  assert.equal(h.store.nameCorrectionForRevision(h.listeningId, h.item.id, first.input.revision).id, first.job.id);
  const result = save(h, first);
  assert.equal(h.store.acceptNameCorrection(h.listeningId, h.item.id, first.job.id, first.input).job.id, result.id);
  h.reopen();
  const cached = accept(h, { hasKey: false });
  assert.equal(cached.prepared, undefined); assert.equal(cached.job.result.cache_hit, true);
  assert.equal(cached.job.result.outcome, 'unchanged'); assert.equal(cached.job.changed, false);
  assert.equal(h.store.db.prepare('SELECT sum(request_reserved) n FROM knowledge_edit_jobs').get().n, 1);
  assert.equal(h.store.knowledgeEditForSnapshot(h.listeningId, h.item.id, cached.input.revision), undefined);
  assert.throws(() => h.store.knowledgeEditJob(h.listeningId, h.item.id, first.job.id, first.input), { status: 409 });
  assert.throws(() => h.store.acceptNameCorrection(h.listeningId, h.item.id, first.job.id,
    { revision: '0'.repeat(64) }), { status: 409 });
});

test('local missing evidence and manual confirmation settle without reserving a request', t => {
  for (const mode of ['missing', 'manual', 'oversized']) {
    const h = fixture(t);
    if (mode === 'missing') h.store.db.prepare('DELETE FROM knowledge_mentions WHERE item_id=?').run(h.item.id);
    if (mode === 'oversized') h.store.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run('x'.repeat(9000), h.evidence.id);
    if (mode === 'manual') h.store.db.prepare('INSERT INTO knowledge_corrections(listening_id,item_id,normalized_source,source,target) VALUES (?,?,?,?,?)')
      .run(h.listeningId, h.item.id, 'wrong', 'wrong', 'Eastmen Kodak');
    const result = accept(h, { hasKey: false });
    assert.equal(result.prepared, undefined);
    assert.equal(result.job.result.outcome, mode === 'manual' ? 'unchanged' : 'insufficient_evidence');
    assert.equal(h.store.db.prepare('SELECT request_reserved FROM knowledge_edit_jobs').get().request_reserved, 0);
  }
});

test('evidence must be exact, linked and a complete name; schema failures never repair or alter data', t => {
  const h = fixture(t), accepted = accept(h), input = accepted.prepared.input, valid = corrected(accepted.prepared);
  assert.throws(() => validateNameCorrectionResult({ ...valid, evidence: [{ ...valid.evidence[0], quote: 'invented' }] }, input), { status: 502 });
  assert.throws(() => validateNameCorrectionResult({ ...valid, extra: true }, input), { status: 502 });
  assert.throws(() => validateNameCorrectionResult({ ...valid, outcome: 'unchanged' }, input), { status: 502 });
  assert.equal(validateNameCorrectionResult({ ...valid, name: 'RAIL' }, input).outcome, 'insufficient_evidence');
  assert.equal(validateNameCorrectionResult({ ...valid, name: 'Kod' }, input).outcome, 'insufficient_evidence');
  assert.equal(validateNameCorrectionResult({ ...valid, name: 'EASTMAN KODAK' }, input).outcome, 'insufficient_evidence');
  const neighbor = input.segments.find(row => !row.linked);
  assert.ok(neighbor);
  assert.equal(validateNameCorrectionResult({ ...valid, name: 'Transcript',
    evidence: [{ segment_id: neighbor.id, source_kind: 'original', quote: neighbor.original }] }, input).outcome, 'insufficient_evidence');
  const translation = { ...valid, name: '伊士曼柯达公司',
    evidence: [{ segment_id: h.evidence.id, source_kind: 'translation', quote: input.segments.find(row => row.linked).translation }] };
  assert.equal(validateNameCorrectionResult(translation, input).outcome, 'corrected');
  const before = h.store.detail(h.listeningId);
  assert.throws(() => h.store.saveNameCorrection(h.listeningId, h.item.id, accepted.job.id, accepted.prepared,
    { ...valid, evidence: [{ ...valid.evidence[0], quote: 'invented' }] }));
  assert.deepEqual(h.store.detail(h.listeningId), before);
  h.store.db.prepare('UPDATE segments SET translation_text=? WHERE id=?').run('改变译文', h.evidence.id);
  assert.throws(() => h.store.saveNameCorrection(h.listeningId, h.item.id, accepted.job.id, accepted.prepared, valid), { status: 409 });
});

test('identity changes invalidate overrides, content updates retain them, full manual editing clears them', t => {
  const h = fixture(t); save(h, accept(h));
  h.store.db.prepare('UPDATE knowledge_items SET dialogue_summary=? WHERE id=?').run('新事实摘要', h.item.id);
  assert.equal(h.store.knowledge(h.listeningId)[0].display_name, 'Eastman Kodak');
  const input = { name: 'Kodak Inc', source: 'Eastman Kodak', revision: h.store.knowledgeEditSnapshot(h.listeningId, h.item.id).revision };
  const prepared = h.store.prepareKnowledgeEdit(h.listeningId, h.item.id, input);
  h.store.saveKnowledgeEdit(h.listeningId, h.item.id, prepared, { short_description: '公司', dialogue_summary: '相机公司', facts: [],
    evidence: [{ segment_id: h.evidence.id, quote: prepared.correctedSegments[0].original_text }] });
  assert.equal(h.store.knowledge(h.listeningId)[0].name_override, null);
  h.store.db.prepare('UPDATE knowledge_items SET name_override=?,name_override_identity=? WHERE id=?')
    .run('人工显示名', nameIdentity(h.store.knowledge(h.listeningId)[0]), h.item.id);
  h.store.db.prepare("UPDATE knowledge_items SET display_label='organization' WHERE id=?").run(h.item.id);
  assert.equal(h.store.knowledge(h.listeningId)[0].display_name, 'Kodak Inc');
});

test('changed context bypasses cache, same-name collisions roll back and oversized metadata issues no request', t => {
  const h = fixture(t); save(h, accept(h));
  h.store.db.prepare('UPDATE segments SET translation_text=? WHERE id=?').run('伊士曼柯达公司推出了相机。新上下文。', h.evidence.id);
  const next = accept(h); assert.ok(next.prepared);
  const before = h.store.detail(h.listeningId), collision = corrected(next.prepared, 'Brownie camera');
  assert.throws(() => h.store.saveNameCorrection(h.listeningId, h.item.id, next.job.id, next.prepared, collision), { status: 409 });
  assert.deepEqual(h.store.detail(h.listeningId), before);
  h.store.failKnowledgeEditJob(next.job.id, '冲突');
  h.store.db.prepare('UPDATE knowledge_items SET canonical_name=? WHERE id=?').run('x'.repeat(9000), h.item.id);
  const item = h.store.knowledge(h.listeningId)[0];
  h.store.db.prepare('UPDATE knowledge_items SET name_override=?,name_override_identity=? WHERE id=?').run('短名称', nameIdentity(item), h.item.id);
  assert.throws(() => accept(h), { status: 400 });
  assert.equal(h.store.db.prepare('SELECT sum(request_reserved) n FROM knowledge_edit_jobs').get().n, 1);
});

test('v11 upgrade preserves legacy receipt fingerprints; restart fences the consumed request budget', t => {
  const h = fixture(t), snapshot = h.store.knowledgeEditSnapshot(h.listeningId, h.item.id), manualId = randomUUID();
  const manualInput = { name: 'Kodak', source: 'Eastman Kodak', revision: snapshot.revision };
  h.store.createKnowledgeEditJob(h.listeningId, h.item.id, manualId, manualInput);
  h.store.failKnowledgeEditJob(manualId, '旧失败');
  const old = rows(h.store, 'knowledge_edit_jobs')[0];
  // Remove current triggers that reference v12 columns before constructing v11.
  for (const row of h.store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'relation_%'").all()) h.store.db.exec(`DROP TRIGGER ${row.name}`);
  h.store.db.exec('DROP INDEX name_correction_context; DROP INDEX name_correction_applied;');
  for (const column of ['operation', 'context_hash', 'applied_context_hash', 'result_json', 'request_reserved'])
    h.store.db.exec(`ALTER TABLE knowledge_edit_jobs DROP COLUMN ${column}`);
  for (const column of ['name_override', 'name_override_identity']) h.store.db.exec(`ALTER TABLE knowledge_items DROP COLUMN ${column}`);
  h.store.db.exec('PRAGMA user_version=11'); h.reopen();
  assert.equal(h.store.db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(rows(h.store, 'knowledge_edit_jobs')[0].fingerprint, old.fingerprint);
  assert.equal(h.store.knowledgeEditJob(h.listeningId, h.item.id, manualId, manualInput).state, 'failed');
  const name = accept(h); assert.equal(h.store.reserveNameCorrection(name.job.id), true);
  h.reopen(); h.store.recoverKnowledgeEditJobs();
  assert.equal(h.store.acceptNameCorrection(h.listeningId, h.item.id, name.job.id, name.input).job.state, 'failed');
  assert.equal(h.store.reserveNameCorrection(name.job.id), false);
  assert.equal(h.store.db.prepare('SELECT request_reserved FROM knowledge_edit_jobs WHERE id=?').get(name.job.id).request_reserved, 1);
  assert.equal(h.store.knowledge(h.listeningId)[0].display_name, 'Eastmen Kodak');
});

test('SQLite append/replace retain overrides and receipts; cross-listening evidence is rejected', t => {
  const h = fixture(t), accepted = accept(h); save(h, accepted);
  const exported = path.join(h.directory, 'export.sqlite'), backup = path.join(h.directory, 'backup.sqlite');
  exportDatabase(h.store, exported);
  const target = new ListeningStore(path.join(h.directory, 'target.sqlite')); t.after(() => target.close());
  const plan = previewImport(target, exported, 'append');
  appendDatabase(target, exported, backup, { revision: plan.revision });
  assert.equal(target.knowledge(h.listeningId)[0].display_name, 'Eastman Kodak');
  assert.equal(target.knowledgeEditJob(h.listeningId, h.item.id, accepted.job.id).result.name, 'Eastman Kodak');
  assert.equal(target.db.prepare('SELECT request_reserved FROM knowledge_edit_jobs').get().request_reserved, 1);
  restoreDatabase(target, exported, path.join(h.directory, 'replace.sqlite'));
  assert.equal(target.knowledge(h.listeningId)[0].display_name, 'Eastman Kodak');
  const other = seedGraphListening(h.store, { extraNodes: 0 });
  const receipt = h.store.knowledgeEditJob(h.listeningId, h.item.id, accepted.job.id).result;
  receipt.evidence[0].segment_id = other.evidence.id;
  h.store.db.prepare('UPDATE knowledge_edit_jobs SET result_json=? WHERE id=?').run(JSON.stringify(receipt), accepted.job.id);
  const invalid = path.join(h.directory, 'invalid.sqlite'); exportDatabase(h.store, invalid);
  const empty = new ListeningStore(path.join(h.directory, 'empty.sqlite')); t.after(() => empty.close());
  assert.throws(() => previewImport(empty, invalid, 'append'), { code: 'IMPORT_CROSS_LISTENING_REFERENCE' });
});

async function terminal(url, id) {
  for (let i = 0; i < 150; i++) {
    const job = await fetch(`${url}/edits/${id}`).then(response => response.json()).then(body => body.job);
    if (job.state !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('name correction did not complete');
}

test('real API: one request for merged attempts, durable lost-response recovery, zero-call cache and no shared key', async t => {
  let release, calls = 0, lastBody;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = await graphFixture({ modelResponse: async body => {
    const input = JSON.parse(body.messages.at(-1).content);
    if (input.operation !== 'name_correction') return { items: [] };
    calls++; lastBody = body; await barrier;
    const segment = input.segments.find(row => row.linked);
    return { outcome: 'corrected', name: '伊士曼柯达公司', reason: '已有译文明确对应。',
      evidence: [{ segment_id: segment.id, source_kind: 'translation', quote: segment.translation }] };
  } });
  t.after(() => { release(); return f.close(); });
  const { first } = f.seeded, item = first.nodes[0], id = randomUUID();
  const url = `${f.base}/api/listenings/${first.listeningId}/knowledge/${item.id}`;
  const snapshot = await fetch(url).then(response => response.json());
  const input = { revision: snapshot.revision, key: 'secret-not-stored' };
  const submit = (jobId, body = input) => fetch(`${url}/name-corrections`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': jobId }, body: JSON.stringify(body) });
  assert.equal((await submit(randomUUID(), { ...input, key: '' })).status, 400);
  const results = await Promise.all([submit(id), submit(randomUUID()), submit(id)]);
  assert.deepEqual(results.map(row => row.status), [202, 202, 202]);
  for (const response of results) assert.equal((await response.json()).job.id, id);
  assert.equal((await fetch(`${url}/name-corrections?revision=${input.revision}`).then(r => r.json())).job.id, id);
  assert.equal((await fetch(url).then(r => r.json())).nameCorrectionJob.id, id);
  assert.equal((await submit(id, { ...input, revision: 'f'.repeat(64) })).status, 409);
  const bytes = await fetch(`${f.base}/api/data/export`).then(r => r.arrayBuffer());
  const review = await fetch(`${f.base}/api/data/import/validate?mode=append`, { method: 'POST', body: bytes }).then(r => r.json());
  const blocked = await fetch(`${f.base}/api/data/import/commit`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: review.token, previewToken: review.previewToken, mode: 'append' }) });
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, 'RESTORE_BUSY');
  release(); assert.equal((await terminal(url, id)).changed, true);
  assert.equal((await submit(id)).status, 202);
  const fresh = await fetch(url).then(r => r.json());
  assert.equal(fresh.item.display_name, '伊士曼柯达公司'); assert.equal(fresh.item.canonical_name, 'Eastman Kodak');
  const cached = await submit(randomUUID(), { revision: fresh.revision }).then(r => r.json());
  assert.equal(cached.job.result.cache_hit, true); assert.equal(calls, 1);
  assert.equal(f.stats.providerRequests.length, 1);
  assert.equal(lastBody.model, 'qwen3.8-flash'); assert.equal(lastBody.enable_thinking, false);
  assert.ok(JSON.stringify(JSON.parse(lastBody.messages.at(-1).content)).length <= 8000);
  assert.equal((await fetch(`${f.base}/api/listenings/${first.listeningId}`).then(r => r.json())).processingAvailable, false);
  assert.doesNotMatch(f.logs(), /secret-not-stored/);
  assert.match(f.logs(), /"request_count":1/); assert.match(f.logs(), /"request_count":0/);
  const report = buildTraceReport(parseTraceInput(f.logs())), business = buildBusinessOverview(report, first.listeningId);
  const tasks = business.tasks.filter(task => task.purpose === '知识名称校正');
  assert.equal(tasks.length, 2); assert.equal(tasks.find(task => task.job === id).calls, 1);
  assert.equal(tasks.find(task => task.job === cached.job.id).calls, 0);
  assert.equal(report.spans.filter(span => span.step === 'knowledge.execute' && span.job === id).length, 1);
  assert.doesNotMatch(JSON.stringify(report), /secret-not-stored|伊士曼柯达公司|Eastman Kodak released/);
});

test('real API: invalid output is terminal with one call; only a new explicit attempt can retry', async t => {
  let calls = 0, invalid = true;
  const f = await graphFixture({ modelResponse: body => {
    const input = JSON.parse(body.messages.at(-1).content);
    if (input.operation !== 'name_correction') return { items: [] };
    calls++;
    return invalid ? 'not JSON' : { outcome: 'unchanged', name: input.name, reason: '名称准确。', evidence: [] };
  } }); t.after(() => f.close());
  const { first } = f.seeded, item = first.nodes[0], id = randomUUID();
  const url = `${f.base}/api/listenings/${first.listeningId}/knowledge/${item.id}`;
  const snapshot = await fetch(url).then(r => r.json()), input = { revision: snapshot.revision, key: 'fixture-key' };
  const submit = jobId => fetch(`${url}/name-corrections`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': jobId }, body: JSON.stringify(input) });
  assert.equal((await submit(id)).status, 202);
  assert.equal((await terminal(url, id)).state, 'failed');
  assert.equal((await submit(id).then(r => r.json())).job.state, 'failed');
  assert.equal(calls, 1);
  assert.equal((await fetch(url).then(r => r.json())).revision, snapshot.revision);
  invalid = false; const retry = randomUUID(); await submit(retry);
  assert.equal((await terminal(url, retry)).result.outcome, 'unchanged'); assert.equal(calls, 2);
});
