import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { exportDatabase, previewImport, appendDatabase, restoreDatabase } from '../data-transfer.mjs';
import { seedNameReplacement } from './name-replacement-fixture.mjs';

const snapshot = store => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));

// Import deliberately accepts structurally valid historical backups. Name
// replacement must reject malformed active evidence without rewriting any rows.
export function importedInvalidAnchors(directory) {
  const observations = [];
  for (const mode of ['append', 'replace']) for (const [id, start, end] of [
    ['empty', 0, 0], ['negative', -1, null], ['reversed', 3, 2],
    ['out-of-bounds', 0, 1000], ['fractional-start', 0.5, 5], ['fractional-end', 0, 4.5]
  ]) {
    const prefix = path.join(directory, `${mode}-${id}`), source = new ListeningStore(':memory:');
    let current = new ListeningStore(`${prefix}-current.sqlite`);
    try {
      const seeded = seedNameReplacement(source, { graph: true });
      const row = source.db.prepare("SELECT * FROM relation_supports WHERE segment_id=? AND role='relation'").get(seeded.segment.id);
      exportDatabase(source, `${prefix}-import.sqlite`);
      const backup = new DatabaseSync(`${prefix}-import.sqlite`);
      const before = { start, end: end ?? seeded.segment.original_text.length,
        quote: seeded.segment.original_text.slice(start, end ?? seeded.segment.original_text.length), state: 'active' };
      try { backup.prepare('UPDATE relation_supports SET start=?,end=?,quote=? WHERE id=?').run(before.start, before.end, before.quote, row.id); }
      finally { backup.close(); }
      const preview = previewImport(current, `${prefix}-import.sqlite`, mode);
      assert.equal(preview.databaseVersion, 12);
      if (mode === 'append') appendDatabase(current, `${prefix}-import.sqlite`, `${prefix}-safety.sqlite`);
      else restoreDatabase(current, `${prefix}-import.sqlite`, `${prefix}-safety.sqlite`);
      // Normalize the constructor's transient relation-waiting flag before
      // taking the transaction baseline, then verify another reopen is stable.
      current.close(); current = new ListeningStore(`${prefix}-current.sqlite`);
      const read = () => ({ ...current.db.prepare('SELECT start,end,quote,state FROM relation_supports WHERE id=?').get(row.id) });
      assert.deepEqual(read(), before, 'the malformed active anchor reaches the public replacement through import');
      const initial = snapshot(current), receiptId = randomUUID();
      assert.throws(() => current.replaceKnowledgeName(seeded.listeningId, seeded.item.id, receiptId,
        { name: 'Tibo', revision: current.knowledgeEditSnapshot(seeded.listeningId, seeded.item.id).revision }),
      error => error.status === 409, `${mode}: ${id} must fail closed`);
      assert.deepEqual(snapshot(current), initial, 'all business rows and the attempted receipt roll back');
      current.close(); current = new ListeningStore(`${prefix}-current.sqlite`);
      assert.deepEqual(snapshot(current), initial, 'rollback remains complete after reopen');
      assert.deepEqual(read(), before);
      observations.push({ id: `import-${mode}-${id}`, mode, before, after: read(), status: 409,
        imported: true, unchanged: true, reopened: true, receiptAbsent: !current.db.prepare('SELECT 1 FROM knowledge_edit_jobs WHERE id=?').get(receiptId) });
    } finally { source.close(); current.close(); }
  }
  return observations;
}
