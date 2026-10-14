import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ListeningStore } from '../storage.mjs';
import { seedNameReplacement } from './name-replacement-fixture.mjs';

export function nameTables(store) {
  return Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, store.db.prepare(`SELECT * FROM ${JSON.stringify(name)}`).all().map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}
export function seedNameTransaction(store) {
  const selected = seedNameReplacement(store, { graph: true });
  const unrelated = seedNameReplacement(store, { graph: true });
  store.db.prepare('UPDATE listenings SET title=? WHERE id=?').run('Unrelated name transaction fixture', unrelated.listeningId);
  const template = store.db.prepare('SELECT * FROM relation_supports WHERE segment_id=? ORDER BY id LIMIT 1').get(selected.segment.id);
  const stale = { ...template, id: randomUUID(), group_id: randomUUID(), state: 'stale', source_revision: '0'.repeat(64), start: -3, end: 999, quote: 'historical-invalid-name-evidence' };
  const keys = Object.keys(stale);
  store.db.prepare(`INSERT INTO relation_supports (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => stale[key]));
  return { ...selected, unrelated, staleId: stale.id };
}
export function openNameTransaction(filename) {
  let store = new ListeningStore(filename);
  const seeded = seedNameTransaction(store);
  // Normalize normal startup recovery before taking the immutable baseline.
  store.close(); store = new ListeningStore(filename);
  return { ...seeded, store, filename,
    snapshot: () => store.knowledgeEditSnapshot(seeded.listeningId, seeded.item.id),
    rename: (id, input) => store.replaceKnowledgeName(seeded.listeningId, seeded.item.id, id, input),
    close: () => store.close() };
}
export const nameWriteFaults = Object.freeze([
  ['receipt-insert', 'BEFORE INSERT ON knowledge_edit_jobs', '1'],
  ['support-write', 'BEFORE UPDATE ON relation_supports', "OLD.state='active'"],
  ['source-write', 'BEFORE UPDATE OF original_text ON segments', 'OLD.original_text IS NOT NEW.original_text'],
  ['item-write', 'BEFORE UPDATE OF canonical_name ON knowledge_items', 'OLD.canonical_name IS NOT NEW.canonical_name'],
  ['revision-write', 'BEFORE INSERT ON knowledge_revisions', "NEW.action='name_replace'"],
  ['receipt-success', 'BEFORE UPDATE OF state ON knowledge_edit_jobs', "NEW.state='succeeded'"],
  ['commit-deferred', null, null]
]);
export function installNameWriteFault(store, name) {
  const entry = nameWriteFaults.find(row => row[0] === name); assert.ok(entry, 'Unknown bounded SQLite fault');
  if (name === 'commit-deferred') {
    // Real COMMIT-time constraint failure, after the succeeded receipt update.
    // This table exists only in the isolated synthetic test database.
    store.db.exec(`CREATE TABLE verification_deferred_fault (item_id TEXT REFERENCES knowledge_items(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER name_protocol_fault AFTER UPDATE OF state ON knowledge_edit_jobs WHEN NEW.state='succeeded'
      BEGIN INSERT INTO verification_deferred_fault VALUES ('missing-synthetic-item'); END;`);
  } else store.db.exec(`CREATE TRIGGER name_protocol_fault ${entry[1]} WHEN ${entry[2]}
    BEGIN SELECT RAISE(ABORT,'synthetic name transaction ${name}'); END;`);
}
export function removeNameWriteFault(store, name) {
  store.db.exec('DROP TRIGGER name_protocol_fault');
  if (name === 'commit-deferred') store.db.exec('DROP TABLE verification_deferred_fault');
}
