import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { exportDatabase, inspectDatabase, restoreDatabase, restoreSafety, previewImport, appendDatabase } from '../data-transfer.mjs';
import { speechFixture } from '../test-support/speech-fixture.mjs';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };

function seed(store, title, text = 'Hello Hearwise.') {
  const run = store.createRun(null, settings, title);
  const segment = store.addSegment(run.listeningId, run.runId, { id: 's1', text, beginMs: 0, endMs: 1000 }).segment;
  store.setTranslation(segment.id, '你好 Hearwise。', false);
  store.finishRun(run.runId);
  return run;
}

test('export creates a standalone consistent sqlite snapshot while WAL is enabled', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hearwise-transfer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'live.sqlite');
  const backup = path.join(directory, 'backup.sqlite');
  const store = new ListeningStore(filename);
  t.after(() => store.close());
  seed(store, 'WAL snapshot');

  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  const info = exportDatabase(store, backup);
  assert.deepEqual(info, { valid: true, databaseVersion: 12, listeningCount: 1 });
  assert.ok(existsSync(backup));

  const exported = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(exported.prepare('SELECT title FROM listenings').get().title, 'WAL snapshot');
    assert.equal(exported.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { exported.close(); }
});

test('inspection rejects non-Hearwise and future-version sqlite files', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hearwise-transfer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const random = path.join(directory, 'random.sqlite');
  writeFileSync(random, 'not sqlite');
  assert.throws(() => inspectDatabase(random), /无法读取 SQLite/);

  const source = path.join(directory, 'source.sqlite');
  const backup = path.join(directory, 'future.sqlite');
  const store = new ListeningStore(source);
  seed(store, 'Future');
  exportDatabase(store, backup);
  store.close();

  const future = new DatabaseSync(backup);
  future.exec('PRAGMA user_version = 13');
  future.close();
  assert.throws(() => inspectDatabase(backup), /更新版本/);
});

test('restore replaces all business data transactionally and preserves a safety backup', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hearwise-transfer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const currentFile = path.join(directory, 'current.sqlite');
  const importFile = path.join(directory, 'import.sqlite');
  const safetyFile = path.join(directory, 'backups', 'before-import.sqlite');

  const current = new ListeningStore(currentFile);
  t.after(() => current.close());
  seed(current, 'Current data', 'Current sentence.');

  const sourceFile = path.join(directory, 'source.sqlite');
  const source = new ListeningStore(sourceFile);
  seed(source, 'Imported data', 'Imported sentence.');
  exportDatabase(source, importFile);
  source.close();

  const result = restoreDatabase(current, importFile, safetyFile);
  assert.equal(result.databaseVersion, 12);
  assert.equal(result.listeningCount, 1);
  assert.equal(current.list().items.length, 1);
  assert.equal(current.list().items[0].title, 'Imported data');
  assert.equal(current.detail(current.list().items[0].id).segments[0].original_text, 'Imported sentence.');

  const safety = new DatabaseSync(safetyFile, { readOnly: true });
  try { assert.equal(safety.prepare('SELECT title FROM listenings').get().title, 'Current data'); }
  finally { safety.close(); }
});

test('restore safety blocks active listening', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hearwise-transfer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ListeningStore(path.join(directory, 'active.sqlite'));
  t.after(() => store.close());
  store.createRun(null, settings, 'Active');
  assert.deepEqual(restoreSafety(store), { ok: false, error: '当前正在收听，请结束当前收听后再导入数据。' });
});

test('settings UI exposes data export and validated replacement import', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const id of ['tab-data-button', 'tab-data', 'data-export', 'data-import', 'data-import-file', 'data-import-confirm']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(app, /\/api\/data\/import\/validate/);
  assert.match(app, /\/api\/data\/import\/commit/);
  assert.match(app, /\/api\/data\/export/);
  assert.match(app, /window\.confirm/);
});

test('HTTP data transfer endpoints export, validate and restore a backup', async t => {
  const fixture = await speechFixture({
    seed(store) {
      const run = seed(store, 'API backup', 'Persist me.');
      return { listeningId: run.listeningId };
    }
  });
  t.after(() => fixture.close());

  const exportedResponse = await fetch(`${fixture.base}/api/data/export`);
  assert.equal(exportedResponse.status, 200);
  assert.match(exportedResponse.headers.get('content-type') || '', /application\/vnd\.sqlite3/);
  assert.match(exportedResponse.headers.get('content-disposition') || '', /hearwise-backup-.*\.sqlite/);
  const bytes = new Uint8Array(await exportedResponse.arrayBuffer());
  assert.equal(Buffer.from(bytes.subarray(0, 16)).toString('binary'), 'SQLite format 3\u0000');

  const invalid = await fetch(`${fixture.base}/api/data/import/validate?mode=replace`, {
    method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3' }, body: Buffer.from('bad')
  });
  assert.equal(invalid.status, 400);

  const validated = await fetch(`${fixture.base}/api/data/import/validate?mode=replace`, {
    method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3' }, body: bytes
  });
  assert.equal(validated.status, 200);
  const review = await validated.json();
  assert.equal(review.valid, true);
  assert.equal(review.databaseVersion, 12);
  assert.equal(review.listeningCount, 1);
  assert.match(review.token, /^[0-9a-f-]{36}$/);

  const committed = await fetch(`${fixture.base}/api/data/import/commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: review.token, mode: review.mode, previewToken: review.previewToken })
  });
  assert.equal(committed.status, 200);
  const result = await committed.json();
  assert.equal(result.ok, true);
  assert.match(result.safetyBackup, /^before-import-.*\.sqlite$/);

  const history = await fetch(`${fixture.base}/api/listenings`).then(response => response.json());
  assert.equal(history.total, 1);
  assert.equal(history.items[0].title, 'API backup');
});

function transferFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hearwise-append-'));
  const current = new ListeningStore(path.join(directory, 'current.sqlite'));
  const source = new ListeningStore(path.join(directory, 'source.sqlite'));
  t.after(() => { current.close(); source.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, current, source, importFile: path.join(directory, 'import.sqlite'), backup: path.join(directory, 'before.sqlite') };
}
const snapshotRows = store => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));

function seedRelation(store) {
  const run = seed(store, 'Acme camera', 'Acme released Camera.');
  const segment = store.detail(run.listeningId).segments[0];
  for (const name of ['Acme', 'Camera']) store.applyKnowledge(run.listeningId, [{
    type: 'other', canonical_name: name, aliases: [name + ' alias'], dialogue_summary: name,
    background_note: null, certainty: 'clear', decision: 'create', existing_item_id: null, correction_reason: null,
    evidence: [{ segment_id: segment.id, quote: name }]
  }]);
  store.enableRelations(run.listeningId);
  const job = store.beginRelationRequest(store.nextRelationJob(run.listeningId, { quietMs: 0 }).id);
  const s = job.input.focus_segments[0];
  store.commitRelationJob(job.id, { relations: [{ subject_item_id: job.input.candidates.find(c => c.canonical_name === 'Acme').id,
    object_item_id: job.input.candidates.find(c => c.canonical_name === 'Camera').id,
    predicate: 'released', statement: s.text, polarity: 'positive', modality: 'asserted', conditions: null,
    time_scope: null, attribution: null, status: 'active', correction_of: null,
    supports: [{ segment_id: s.id, source_revision: s.source_revision, start: 0, end: s.text.length, quote: s.text, role: 'relation' }] }] });
  return run;
}

test('append preserves existing modifications, complete knowledge/graph and IDs; repeat import is a no-op', t => {
  const h = transferFixture(t);
  seed(h.current, 'Same title');
  exportDatabase(h.current, h.importFile);
  const copy = new ListeningStore(h.importFile);
  const old = copy.list().items[0];
  copy.db.prepare('UPDATE listenings SET title=?,notes=? WHERE id=?').run('Backup version', 'backup notes', old.id);
  const added = seedRelation(copy);
  copy.close();
  h.current.db.prepare('UPDATE listenings SET notes=? WHERE id=?').run('local notes', old.id);
  const before = snapshotRows(h.current);
  const plan = previewImport(h.current, h.importFile, 'append');
  assert.equal(plan.addedCount, 1); assert.equal(plan.skippedCount, 1);
  const result = appendDatabase(h.current, h.importFile, h.backup, { revision: plan.revision });
  assert.equal(result.changed, true); assert.equal(h.current.list().total, 2);
  assert.equal(h.current.detail(old.id).listening.notes, 'local notes');
  assert.equal(h.current.list().items.find(x => x.id === old.id).title, 'Same title');
  const after = snapshotRows(h.current);
  for (const [table, rows] of Object.entries(before)) for (const row of rows) assert.ok(after[table].some(value => JSON.stringify(value) === JSON.stringify(row)), `${table} local row unchanged`);
  const graph = h.current.graph(added.listeningId);
  assert.equal(graph.nodes.length, 2); assert.equal(graph.relations.length, 1); assert.equal(graph.supports.length, 1);
  assert.equal(h.current.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const safety = new DatabaseSync(h.backup, { readOnly: true });
  assert.equal(safety.prepare('SELECT COUNT(*) n FROM listenings').get().n, 1); safety.close();
  const again = previewImport(h.current, h.importFile, 'append', { prepared: true });
  const noopBackup = path.join(h.directory, 'no-op.sqlite');
  assert.equal(appendDatabase(h.current, h.importFile, noopBackup, { revision: again.revision }).changed, false);
  assert.equal(existsSync(noopBackup), false); assert.deepEqual(snapshotRows(h.current), after);
});

test('10 + 5 disjoint records append to 15; replace restores 5; same titles are independent', t => {
  const h = transferFixture(t);
  for (let i = 0; i < 10; i++) seed(h.current, 'Same title');
  for (let i = 0; i < 5; i++) seed(h.source, 'Same title');
  exportDatabase(h.source, h.importFile);
  const plan = previewImport(h.current, h.importFile, 'append');
  appendDatabase(h.current, h.importFile, h.backup, { revision: plan.revision });
  assert.equal(h.current.list().total, 15);
  const replace = previewImport(h.current, h.importFile, 'replace', { prepared: true });
  restoreDatabase(h.current, h.importFile, h.backup, { prepared: true, revision: replace.revision });
  assert.equal(h.current.list().total, 5);
});

test('large duplicate previews keep exact counts with bounded titles and no full ID arrays', t => {
  const h = transferFixture(t);
  for (let i = 0; i < 60; i++) seed(h.current, 't'.repeat(1000));
  exportDatabase(h.current, h.importFile);
  const append = previewImport(h.current, h.importFile, 'append');
  assert.equal(append.currentCount, 60); assert.equal(append.listeningCount, 60);
  assert.equal(append.addedCount, 0); assert.equal(append.skippedCount, 60);
  assert.equal(append.skipped.length, 50);
  assert.ok(append.skipped.every(row => row.title === 't'.repeat(200) + '…'));
  assert.equal('addedIds' in append, false);
  const replace = previewImport(h.current, h.importFile, 'replace', { prepared: true });
  assert.equal(replace.listeningCount, 60); assert.deepEqual(replace.skipped, []);
  assert.equal('addedIds' in replace, false);
  assert.deepEqual(appendDatabase(h.current, h.importFile, h.backup, { revision: replace.revision }).addedIds, []);
});

test('child primary key collisions roll back all inserts and restore graph triggers', t => {
  const h = transferFixture(t);
  const local = seed(h.current, 'Local'); const incoming = seed(h.source, 'Incoming');
  const localId = h.current.detail(local.listeningId).segments[0].id;
  h.source.db.prepare('UPDATE segments SET id=? WHERE listening_id=?').run(localId, incoming.listeningId);
  exportDatabase(h.source, h.importFile);
  const before = snapshotRows(h.current), plan = previewImport(h.current, h.importFile, 'append');
  const triggers = h.current.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  assert.throws(() => appendDatabase(h.current, h.importFile, h.backup, { revision: plan.revision }), { code: 'APPEND_FAILED' });
  assert.deepEqual(snapshotRows(h.current), before);
  assert.deepEqual(h.current.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), triggers);
  assert.equal(h.current.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(h.current.db.prepare('PRAGMA defer_foreign_keys').get().defer_foreign_keys, 0);
});

test('append rejects cross-listening FKs and unsupported same-version tables/columns', t => {
  const h = transferFixture(t);
  const a = seed(h.source, 'A'), b = seed(h.source, 'B');
  h.source.db.prepare('UPDATE segments SET run_id=?,asr_sentence_id=? WHERE listening_id=?').run(b.runId, 'cross-session', a.listeningId);
  exportDatabase(h.source, h.importFile);
  assert.throws(() => previewImport(h.current, h.importFile, 'append'), { code: 'IMPORT_CROSS_LISTENING_REFERENCE' });
  h.source.db.prepare('UPDATE segments SET run_id=? WHERE listening_id=?').run(a.runId, a.listeningId);
  h.source.db.exec('ALTER TABLE segments ADD COLUMN surprise TEXT');
  exportDatabase(h.source, h.importFile);
  assert.throws(() => previewImport(h.current, h.importFile, 'append'), { code: 'DATABASE_SCHEMA_MISMATCH' });
  assert.equal(h.current.list().total, 0);
});

test('stale previews detect local edits and external-connection writes for both modes', t => {
  const h = transferFixture(t);
  const local = seed(h.current, 'Local'); seed(h.source, 'New'); exportDatabase(h.source, h.importFile);
  let plan = previewImport(h.current, h.importFile, 'append');
  h.current.db.prepare('UPDATE segments SET original_text=? WHERE listening_id=?').run('Edited child', local.listeningId);
  assert.throws(() => appendDatabase(h.current, h.importFile, h.backup, { revision: plan.revision }), { code: 'IMPORT_PREVIEW_STALE' });
  plan = previewImport(h.current, h.importFile, 'replace', { prepared: true });
  const other = new DatabaseSync(path.join(h.directory, 'current.sqlite'));
  other.prepare('UPDATE listenings SET title=? WHERE id=?').run('External edit', local.listeningId); other.close();
  assert.throws(() => restoreDatabase(h.current, h.importFile, h.backup, { prepared: true, revision: plan.revision }), { code: 'IMPORT_PREVIEW_STALE' });
  assert.equal(h.current.list().items[0].title, 'External edit');
});

test('imported unfinished work remains stopped after reopening; backup failure preserves local data', t => {
  const h = transferFixture(t);
  const run = h.source.createRun(null, settings, 'Unfinished');
  const seg = h.source.addSegment(run.listeningId, run.runId, { id: 'pending', text: 'Pending text.' }).segment;
  h.source.createExtractionJob(run.listeningId, [seg]); h.source.enableRelations(run.listeningId);
  exportDatabase(h.source, h.importFile);
  const plan = previewImport(h.current, h.importFile, 'append');
  appendDatabase(h.current, h.importFile, h.backup, { revision: plan.revision });
  const exported = path.join(h.directory, 'reopen.sqlite'); exportDatabase(h.current, exported);
  const reopened = new ListeningStore(exported);
  try {
    assert.equal(reopened.db.prepare('SELECT state FROM listening_runs').get().state, 'interrupted');
    assert.equal(reopened.db.prepare('SELECT state,last_error FROM extraction_jobs').get().state, 'failed');
    assert.equal(reopened.db.prepare('SELECT translation_state FROM segments').get().translation_state, 'failed');
    assert.equal(reopened.db.prepare('SELECT state FROM relation_rounds').get().state, 'paused');
    assert.equal(reopened.nextRelationJob(run.listeningId, { quietMs: 0 }), null);
  } finally { reopened.close(); }
  seed(h.source, 'Another'); exportDatabase(h.source, h.importFile);
  const next = previewImport(h.current, h.importFile, 'append'), before = snapshotRows(h.current);
  const blocker = path.join(h.directory, 'blocker'); writeFileSync(blocker, 'file');
  assert.throws(() => appendDatabase(h.current, h.importFile, path.join(blocker, 'backup.sqlite'), { revision: next.revision }));
  assert.deepEqual(snapshotRows(h.current), before);
});

test('HTTP modes and previews are bound; stale review refreshes; consumed tokens cannot replay', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hearwise-api-append-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = new ListeningStore(path.join(directory, 'source.sqlite'));
  seedRelation(source); exportDatabase(source, path.join(directory, 'backup.sqlite')); source.close();
  const bytes = readFileSync(path.join(directory, 'backup.sqlite'));
  const fixture = await speechFixture({ seed(store) { seed(store, 'Local'); } }); t.after(() => fixture.close());
  const post = (suffix, body) => fetch(`${fixture.base}/api/data/import/${suffix}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal((await fetch(`${fixture.base}/api/data/import/validate`, { method: 'POST', body: bytes })).status, 400);
  const response = await fetch(`${fixture.base}/api/data/import/validate?mode=append`, { method: 'POST', body: bytes });
  assert.equal(response.status, 200); let review = await response.json();
  assert.equal(review.addedCount, 1); assert.equal(review.currentCount, 1);
  assert.equal((await post('commit', { token: review.token, previewToken: review.previewToken, mode: 'replace' })).status, 409);
  const prior = review;
  review = await post('preview', { token: review.token, mode: 'replace' }).then(r => r.json());
  assert.notEqual(review.previewToken, prior.previewToken);
  assert.equal((await post('commit', { token: prior.token, previewToken: prior.previewToken, mode: 'append' })).status, 409);
  review = await post('preview', { token: review.token, mode: 'append' }).then(r => r.json());
  const payload = { token: review.token, previewToken: review.previewToken, mode: 'append' };
  const results = await Promise.all([post('commit', payload), post('commit', payload)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 410]);
  const committed = await results.find(r => r.status === 200).json();
  assert.equal(committed.addedCount, 1); assert.match(committed.safetyBackup, /^before-import/);
  assert.equal((await fetch(`${fixture.base}/api/listenings`).then(r => r.json())).total, 2);
  assert.equal(fixture.stats.providerRequests.length, 0);
  assert.equal((await post('preview', { token: 'expired', mode: 'append' })).status, 410);
});

test('append rejects embedded cross-listening references and accepts migrated v10 backups', t => {
  const h = transferFixture(t);
  const local = seedRelation(h.current), incoming = seedRelation(h.source);
  const item = h.source.knowledge(incoming.listeningId)[0];
  const externalSegment = h.current.detail(local.listeningId).segments[0].id;
  h.source.db.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?,?)')
    .run('audit-reference', item.id, 'edit', null, JSON.stringify({ segment_id: externalSegment }), null, 'snapshot', new Date().toISOString());
  exportDatabase(h.source, h.importFile);
  assert.throws(() => previewImport(h.current, h.importFile, 'append'), { code: 'IMPORT_CROSS_LISTENING_REFERENCE' });
  h.source.db.exec("DELETE FROM knowledge_revisions WHERE id='audit-reference'; DROP TABLE knowledge_edit_jobs; PRAGMA user_version=10");
  const old = path.join(h.directory, 'v10.sqlite'); h.source.db.exec(`VACUUM INTO '${old}'`);
  const plan = previewImport(h.current, old, 'append');
  assert.equal(plan.databaseVersion, 12); assert.equal(plan.addedCount, 1);
  appendDatabase(h.current, old, h.backup, { revision: plan.revision });
  assert.equal(h.current.list().total, 2);
});

test('failed preview lock acquisition detaches the backup and permits a later retry', t => {
  const h = transferFixture(t);
  seed(h.source, 'New'); exportDatabase(h.source, h.importFile);
  previewImport(h.current, h.importFile, 'append');
  const writer = new DatabaseSync(path.join(h.directory, 'current.sqlite'));
  h.current.db.exec('PRAGMA busy_timeout=0'); writer.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => previewImport(h.current, h.importFile, 'append', { prepared: true }), /locked/); }
  finally { writer.exec('ROLLBACK'); writer.close(); }
  assert.equal(previewImport(h.current, h.importFile, 'append', { prepared: true }).addedCount, 1);
});
