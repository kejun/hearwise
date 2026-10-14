import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { exportDatabase, restoreDatabase, appendDatabase, previewImport } from '../data-transfer.mjs';
import { seedNameReplacement } from './name-replacement-fixture.mjs';
import { databaseSnapshot } from './import-protocol-fixture.mjs';
import { afterImport, wholeListeningAppend } from './import-atomicity-fixture.mjs';

export const dataCases = ['round-trip', 'whole-listening-append', 'primary-key', 'ownership', 'schema', 'restore-schema', 'restore-foreign-key'];
export async function dataScenario(kind, observation = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-import-data-'));
  const currentFile = path.join(directory, 'current.sqlite'), sourceFile = path.join(directory, 'source.sqlite');
  const imported = path.join(directory, 'import.sqlite'), backup = path.join(directory, 'before.sqlite');
  const current = new ListeningStore(currentFile); let source;
  Object.assign(observation, { id: `data/${kind}`, kind, snapshots: [], complete: false, ok: false });
  const record = (label, filename = currentFile) => { const database = databaseSnapshot(filename); observation.snapshots.push({ label, database }); return database; };
  try {
    const local = seedNameReplacement(current, { graph: true });
    current.db.prepare('UPDATE listenings SET title=?,notes=?').run('本地历史标题', '完整备注。');
    const before = record('before');
    if (kind === 'round-trip' || kind === 'whole-listening-append') {
      exportDatabase(current, imported);
      assert.deepEqual(record('exported', imported), before, 'standalone export preserves every business row and schema');
      if (kind === 'round-trip') {
        source = new ListeningStore(sourceFile);
        seedNameReplacement(source, { graph: true });
        const isolatedBefore = record('isolated-before', sourceFile);
        restoreDatabase(source, imported, backup);
        assert.deepEqual(record('isolated-restored', sourceFile), afterImport(before));
        assert.deepEqual(record('safety-backup', backup), isolatedBefore);
        restoreDatabase(source, backup, path.join(directory, 'before-undo.sqlite'));
        assert.deepEqual(record('isolated-undo', sourceFile), afterImport(isolatedBefore));
        for (const table of ['listenings', 'listening_runs', 'segments', 'knowledge_items', 'knowledge_aliases',
          'knowledge_mentions', 'knowledge_facts', 'extraction_jobs', 'relations', 'relation_assertions', 'relation_supports', 'relation_jobs', 'relation_requests']) {
          assert.ok(before.rows[table].length, `${table} has representative real persisted business records`);
        }
        assert.ok(before.rows.segments.every(row => row.original_text && row.translation_text));
        assert.equal(before.rows.listenings[0].notes, '完整备注。');
      } else {
        source = new ListeningStore(imported);
        source.db.prepare('UPDATE listenings SET title=?, notes=? WHERE id=?').run('备份中的不同标题', '另一份备注', local.listeningId);
        source.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run('Different backup child content.', local.segment.id);
        source.db.prepare('UPDATE knowledge_facts SET content=? WHERE id=?').run('Different backup fact.', local.factId);
        seedNameReplacement(source, { graph: true }); source.close(); source = null;
        const plan = previewImport(current, imported, 'append');
        assert.equal(plan.addedCount, 1); assert.equal(plan.skippedCount, 1);
        observation.incoming = record('prepared-incoming', imported);
        const result = appendDatabase(current, imported, backup, { revision: plan.revision });
        assert.equal(result.changed, true);
        const after = record('appended');
        assert.deepEqual(after, wholeListeningAppend(before, observation.incoming));
        for (const [table, rows] of Object.entries(before.rows)) {
          const found = new Set(after.rows[table].map(row => JSON.stringify(row)));
          assert.ok(rows.every(row => found.has(JSON.stringify(row))), `all local ${table} rows retained verbatim`);
        }
        assert.equal(after.rows.listenings.find(row => row.id === local.listeningId).title, '本地历史标题');
        const second = previewImport(current, imported, 'append', { prepared: true });
        assert.equal(appendDatabase(current, imported, path.join(directory, 'no-op.sqlite'), { revision: second.revision }).changed, false);
        assert.deepEqual(record('repeat-no-op'), after, 'idempotence is business state, not SQLite file bytes');
      }
    } else {
      source = new ListeningStore(sourceFile);
      const incoming = seedNameReplacement(source, { graph: false });
      if (kind === 'primary-key') {
        // Make a collision in a late copied child table, after listenings/runs
        // were really inserted. Foreign keys are intentionally kept valid.
        source.db.prepare('UPDATE knowledge_facts SET id=? WHERE id=?').run(local.factId, incoming.factId);
      } else if (kind === 'ownership') {
        const other = seedNameReplacement(source);
        source.db.prepare("UPDATE segments SET run_id=?,asr_sentence_id='cross-owner' WHERE id=?").run(other.runId, incoming.segment.id);
      } else if (kind === 'restore-foreign-key') {
        source.db.exec('PRAGMA foreign_keys=OFF');
        source.db.prepare('UPDATE segments SET run_id=? WHERE id=?').run('missing-parent-run', incoming.segment.id);
      } else source.db.exec('ALTER TABLE segments ADD COLUMN unexpected_column TEXT');
      exportDatabase(source, imported);
      observation.importedSource = databaseSnapshot(imported);
      let error;
      try {
        if (kind.startsWith('restore-')) restoreDatabase(current, imported, backup, { prepared: true });
        else {
          const plan = previewImport(current, imported, 'append');
          appendDatabase(current, imported, backup, { revision: plan.revision });
        }
      } catch (value) { error = value; }
      assert.equal(error?.code, { 'primary-key': 'APPEND_FAILED', ownership: 'IMPORT_CROSS_LISTENING_REFERENCE', schema: 'DATABASE_SCHEMA_MISMATCH', 'restore-schema': 'RESTORE_FAILED', 'restore-foreign-key': 'FOREIGN_KEY_CHECK_FAILED' }[kind]);
      observation.errorObserved = { code: error.code, message: error.message };
      assert.deepEqual(record('rejected'), before, 'conflict rolls back every row and trigger');
      if (kind === 'primary-key' || kind.startsWith('restore-')) assert.deepEqual(record('safety-backup', backup), before);
      current.db.prepare('UPDATE listenings SET notes=? WHERE id=?').run('仍然可编辑', local.listeningId);
      const queried = current.detail(local.listeningId).listening;
      assert.equal(queried.notes, '仍然可编辑');
      observation.usable = { id: local.listeningId, notes: '仍然可编辑', queried, after: record('after-edit') };
    }
    observation.complete = observation.ok = true;
  } catch (error) { observation.failure = { name: error.name, message: error.message }; throw error; }
  finally { current.close(); source?.close(); await rm(directory, { recursive: true, force: true }); observation.cleanup = { ok: true }; }
  return observation;
}
