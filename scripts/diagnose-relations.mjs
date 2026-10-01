// node scripts/diagnose-relations.mjs /path/listenings.sqlite [listening-id]
// Read-only and content-free, including on legacy v8. Never imports the store,
// migrates, calls a provider, or prints transcript/title/quote/ID/key contents.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readRelationDiagnostics } from '../relation-diagnostics.mjs';
let db;
try {
  const file = process.argv[2];
  if (!file || !existsSync(file)) throw new Error();
  db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  const id = process.argv[3] || db.prepare('SELECT listening_id FROM relation_rounds ORDER BY started_at DESC LIMIT 1').get()?.listening_id;
  if (!id) throw new Error();
  const current = db.prepare('SELECT relation_epoch,graph_revision FROM listenings WHERE id=?').get(id);
  if (!current) throw new Error();
  console.log(JSON.stringify({ selection: process.argv[3] ? 'requested listening' : 'most recently started relation listening',
    schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
    epoch: current.relation_epoch, graphRevision: current.graph_revision,
    diagnostics: readRelationDiagnostics(db, id) }, null, 2));
} catch {
  console.error('Could not read relation diagnostics. Pass an existing Hearwise v8+ database and an optional valid listening ID. No changes were made.');
  process.exitCode = 1;
} finally { db?.close(); }
