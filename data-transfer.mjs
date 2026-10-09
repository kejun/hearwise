import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ListeningStore } from './storage.mjs';

export const CURRENT_DATABASE_VERSION = 11;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
export const REQUIRED_TABLES = Object.freeze([
  'listenings', 'listening_runs', 'segments', 'knowledge_items'
]);

export class DataTransferError extends Error {
  constructor(message, { status = 400, code = 'DATA_TRANSFER_FAILED' } = {}) {
    super(message);
    this.name = 'DataTransferError';
    this.status = status;
    this.code = code;
  }
}

const quoteSqlString = value => `'${String(value).replaceAll("'", "''")}'`;
const quoteIdentifier = value => `"${String(value).replaceAll('"', '""')}"`;
const pragmaValue = row => row && Object.values(row)[0];

function listTables(db, schema = 'main') {
  const rows = db.prepare(`SELECT name FROM ${schema}.sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  return rows.map(row => row.name);
}

function integrityOk(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  return rows.length === 1 && pragmaValue(rows[0]) === 'ok';
}

export function inspectDatabase(filename) {
  let db;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    if (!integrityOk(db)) throw new DataTransferError('数据库完整性检查未通过', { code: 'INVALID_SQLITE' });
    const databaseVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (!Number.isInteger(databaseVersion) || databaseVersion < 1) {
      throw new DataTransferError('这不是可识别的 Hearwise 数据库', { code: 'NOT_HEARWISE_DATABASE' });
    }
    if (databaseVersion > CURRENT_DATABASE_VERSION) {
      throw new DataTransferError('此备份由更新版本的 Hearwise 创建，请先升级 Hearwise 后再导入', {
        status: 409, code: 'DATABASE_VERSION_TOO_NEW'
      });
    }
    const tables = new Set(listTables(db));
    const missing = REQUIRED_TABLES.filter(name => !tables.has(name));
    if (missing.length) {
      throw new DataTransferError('这不是完整的 Hearwise 数据库', { code: 'NOT_HEARWISE_DATABASE' });
    }
    const listeningCount = Number(db.prepare('SELECT COUNT(*) AS n FROM listenings').get().n);
    return { valid: true, databaseVersion, listeningCount };
  } catch (error) {
    if (error instanceof DataTransferError) throw error;
    throw new DataTransferError('无法读取 SQLite 备份文件', { code: 'INVALID_SQLITE' });
  } finally {
    try { db?.close(); } catch {}
  }
}

export function exportDatabase(store, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  rmSync(destination, { force: true });
  try {
    // VACUUM INTO produces a standalone, transactionally consistent snapshot,
    // including committed pages that are currently represented by WAL.
    store.db.exec(`VACUUM INTO ${quoteSqlString(destination)}`);
    const info = inspectDatabase(destination);
    if (info.databaseVersion !== CURRENT_DATABASE_VERSION) {
      throw new DataTransferError('导出的数据库版本异常', { status: 500, code: 'EXPORT_VERSION_INVALID' });
    }
    return info;
  } catch (error) {
    rmSync(destination, { force: true });
    if (error instanceof DataTransferError) throw error;
    throw new DataTransferError('生成数据库备份失败', { status: 500, code: 'EXPORT_FAILED' });
  }
}

export function restoreSafety(store) {
  if (store.db.prepare("SELECT 1 FROM listening_runs WHERE state='active' LIMIT 1").get()) {
    return { ok: false, error: '当前正在收听，请结束当前收听后再导入数据。' };
  }
  if (store.db.prepare("SELECT 1 FROM extraction_jobs WHERE state='running' LIMIT 1").get()) {
    return { ok: false, error: '知识整理仍在写入数据，请稍后再导入。' };
  }
  if (store.db.prepare("SELECT 1 FROM relation_jobs WHERE state='running' LIMIT 1").get()) {
    return { ok: false, error: '知识关系整理仍在写入数据，请稍后再导入。' };
  }
  if (store.db.prepare("SELECT 1 FROM knowledge_edit_jobs WHERE state='running' LIMIT 1").get()) {
    return { ok: false, error: '知识修改仍在保存，请稍后再导入。' };
  }
  return { ok: true };
}

function migrateImportedDatabase(filename) {
  // Migrate only the uploaded temporary file. The constructor also performs the
  // same restart recovery semantics as a normal Hearwise launch.
  const imported = new ListeningStore(filename);
  try {
    imported.recoverKnowledgeEditJobs();
    // Imported work requires an explicit retry. Never inherit permission to call
    // a provider, including after the next server restart.
    imported.db.exec(`
      UPDATE segments SET translation_state='failed' WHERE translation_state='pending';
      UPDATE extraction_jobs SET state='failed',retry_at=NULL,last_error='IMPORT_REQUIRES_RESUME'
        WHERE state IN ('pending','running');
      UPDATE relation_jobs SET state='cancelled',last_error='IMPORT_REQUIRES_RESUME'
        WHERE state IN ('pending','running');
      UPDATE relation_rounds SET state='paused',stop_reason='IMPORT_REQUIRES_RESUME',
        wait_reason=NULL,next_ready_at=NULL WHERE state='active' AND (finished_at IS NULL OR
          EXISTS (SELECT 1 FROM relation_windows w WHERE w.listening_id=relation_rounds.listening_id AND w.state IN ('dirty','pending')));
      UPDATE listenings SET relation_waiting_key=0;
    `);
    imported.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    imported.close();
  }
  const info = inspectDatabase(filename);
  if (info.databaseVersion !== CURRENT_DATABASE_VERSION) {
    throw new DataTransferError('备份数据库升级失败', { status: 500, code: 'IMPORT_MIGRATION_FAILED' });
  }
  return info;
}

function sameTables(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function restoreDatabase(store, source, backupDestination, { prepared = false, revision } = {}) {
  const safety = restoreSafety(store);
  if (!safety.ok) throw new DataTransferError(safety.error, { status: 409, code: 'RESTORE_BUSY' });

  inspectDatabase(source);
  const importedInfo = prepared ? inspectDatabase(source) : migrateImportedDatabase(source);
  const backupInfo = exportDatabase(store, backupDestination);

  const db = store.db;
  let attached = false;
  let inTransaction = false;
  let foreignKeysDisabled = false;
  try {
    db.prepare('ATTACH DATABASE ? AS imported').run(source);
    attached = true;

    const mainTables = listTables(db, 'main');
    const importedTables = listTables(db, 'imported');
    if (!sameTables(mainTables, importedTables)) {
      throw new DataTransferError('备份数据库结构与当前 Hearwise 不兼容', {
        status: 409, code: 'DATABASE_SCHEMA_MISMATCH'
      });
    }

    const triggers = db.prepare("SELECT name, sql FROM main.sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name").all();

    db.exec('PRAGMA foreign_keys = OFF');
    foreignKeysDisabled = true;
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    assertImportRevision(store, revision);

    // Current triggers intentionally react to normal product writes. They must
    // not synthesize graph revisions while an already-consistent backup is copied.
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);

    for (const table of mainTables) db.exec(`DELETE FROM main.${quoteIdentifier(table)}`);
    for (const table of mainTables) {
      const name = quoteIdentifier(table);
      db.exec(`INSERT INTO main.${name} SELECT * FROM imported.${name}`);
    }

    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec(`PRAGMA user_version = ${CURRENT_DATABASE_VERSION}`);

    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length) {
      throw new DataTransferError('导入数据存在关联完整性错误', {
        status: 400, code: 'FOREIGN_KEY_CHECK_FAILED'
      });
    }
    if (!integrityOk(db)) {
      throw new DataTransferError('导入后的数据库完整性检查未通过', {
        status: 500, code: 'RESTORE_INTEGRITY_FAILED'
      });
    }

    db.exec('COMMIT');
    inTransaction = false;
    return { ...importedInfo, backupInfo };
  } catch (error) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); } catch {}
      inTransaction = false;
    }
    if (error instanceof DataTransferError) throw error;
    throw new DataTransferError('导入数据失败，当前数据未被替换', {
      status: 500, code: 'RESTORE_FAILED'
    });
  } finally {
    if (foreignKeysDisabled) {
      try { db.exec('PRAGMA foreign_keys = ON'); } catch {}
    }
    if (attached) {
      try { db.exec('DETACH DATABASE imported'); } catch {}
    }
  }
}

// Ordered by dependency. Tables without a listening_id inherit ownership via
// exactly one documented parent. All other FKs are checked against that owner.
const IMPORT_TABLES = Object.freeze({
  listenings: null,
  listening_runs: null,
  segments: null,
  knowledge_items: null,
  knowledge_aliases: ['item_id', 'knowledge_items'],
  knowledge_mentions: ['item_id', 'knowledge_items'],
  knowledge_revisions: ['item_id', 'knowledge_items'],
  extraction_jobs: null,
  knowledge_candidates: null,
  knowledge_facts: ['item_id', 'knowledge_items'],
  extraction_parts: ['job_id', 'extraction_jobs'],
  relation_windows: null,
  relation_jobs: null,
  relation_requests: ['job_id', 'relation_jobs'],
  relations: null,
  relation_assertions: ['relation_id', 'relations'],
  relation_supports: ['assertion_id', 'relation_assertions'],
  relation_revisions: ['relation_id', 'relations'],
  relation_rounds: null,
  knowledge_manual_items: null,
  knowledge_corrections: null,
  knowledge_edit_jobs: null
});

export function importMode(value) {
  if (value !== 'append' && value !== 'replace') {
    throw new DataTransferError('请选择追加或覆盖导入方式', { code: 'INVALID_IMPORT_MODE' });
  }
  return value;
}

export function importRevision(store) {
  // total_changes covers writes on the server connection; data_version covers
  // commits by other connections, even edits to a child row without updated_at.
  return createHash('sha256').update(JSON.stringify([
    store.db.prepare('SELECT total_changes() AS n').get().n,
    store.db.prepare('PRAGMA main.data_version').get().data_version,
    store.db.prepare('PRAGMA main.schema_version').get().schema_version
  ])).digest('hex');
}

function assertImportRevision(store, revision) {
  if (revision !== undefined && revision !== importRevision(store)) {
    throw new DataTransferError('当前数据已变化，请重新预览后再导入', { status: 409, code: 'IMPORT_PREVIEW_STALE' });
  }
}

function ownedRows(table, schema = 'imported') {
  const parent = IMPORT_TABLES[table];
  const name = `${schema}.${quoteIdentifier(table)}`;
  if (parent) return `SELECT t.*,p.__owner FROM ${name} t JOIN (${ownedRows(parent[1], schema)}) p ON p.id=t.${quoteIdentifier(parent[0])}`;
  return `SELECT t.*,t.${table === 'listenings' ? 'id' : 'listening_id'} AS __owner FROM ${name} t`;
}

function schemaShape(db, schema, table) {
  const name = quoteIdentifier(table);
  const columns = db.prepare(`PRAGMA ${schema}.table_info(${name})`).all();
  const foreignKeys = db.prepare(`PRAGMA ${schema}.foreign_key_list(${name})`).all();
  const unique = db.prepare(`PRAGMA ${schema}.index_list(${name})`).all().filter(row => row.unique).map(row => ({
    partial: row.partial,
    columns: db.prepare(`PRAGMA ${schema}.index_info(${quoteIdentifier(row.name)})`).all().map(col => col.name),
    sql: row.partial ? db.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE name=?`).get(row.name).sql : null
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ columns, foreignKeys, unique });
}

function validateImportSchema(db) {
  const expected = Object.keys(IMPORT_TABLES).sort();
  if (!sameTables(listTables(db), expected) || !sameTables(listTables(db, 'imported'), expected) ||
      expected.some(table => schemaShape(db, 'main', table) !== schemaShape(db, 'imported', table))) {
    throw new DataTransferError('备份数据库结构与当前 Hearwise 不兼容', { status: 409, code: 'DATABASE_SCHEMA_MISMATCH' });
  }
  if (db.prepare('PRAGMA imported.foreign_key_check').all().length) {
    throw new DataTransferError('备份存在关联完整性错误', { code: 'FOREIGN_KEY_CHECK_FAILED' });
  }
}

const softReferences = {
  knowledge_revisions: { merged_from_id: 'knowledge_items' },
  relation_assertions: { correction_of: 'relation_assertions' },
  knowledge_manual_items: { item_id: 'knowledge_items' },
  knowledge_corrections: { item_id: 'knowledge_items' },
  knowledge_edit_jobs: { item_id: 'knowledge_items' }
};
const jsonColumns = {
  extraction_jobs: ['progress_json'],
  extraction_parts: ['focus_refs', 'unresolved', 'results', 'stats', 'input_snapshot'],
  relation_jobs: ['input_json', 'rejected_json', 'usage_json'],
  relation_requests: ['usage_json'],
  knowledge_revisions: ['old_value', 'new_value'],
  relation_revisions: ['old_value', 'new_value']
};
const jsonReferences = {
  listening_id: 'listenings', listeningId: 'listenings', run_id: 'listening_runs',
  segment_id: 'segments', segmentId: 'segments', item_id: 'knowledge_items', itemId: 'knowledge_items',
  existing_item_id: 'knowledge_items', subject_item_id: 'knowledge_items', object_item_id: 'knowledge_items',
  observed_candidate_id: 'knowledge_candidates',
  assertion_id: 'relation_assertions', relation_id: 'relations', job_id: 'relation_jobs', window_id: 'relation_windows'
};

function crossListeningError(table) {
  return new DataTransferError(`备份中的 ${table} 存在跨收听引用，无法追加`, { code: 'IMPORT_CROSS_LISTENING_REFERENCE' });
}

function validateAppendReferences(db, addedIds) {
  const added = new Set(addedIds);
  const references = new Map();
  for (const table of Object.keys(IMPORT_TABLES)) {
    const rows = ownedRows(table);
    // Validate every actual FK, including secondary parents such as a mention's
    // segment or a support's job/window, not just the parent used for selection.
    for (const fk of db.prepare(`PRAGMA imported.foreign_key_list(${quoteIdentifier(table)})`).all()) {
      if (!(fk.table in IMPORT_TABLES)) throw crossListeningError(table);
      if (db.prepare(`SELECT 1 FROM (${rows}) t JOIN (${ownedRows(fk.table)}) p ON p.${quoteIdentifier(fk.to)}=t.${quoteIdentifier(fk.from)}
        WHERE t.__owner!=p.__owner LIMIT 1`).get()) throw crossListeningError(table);
    }
    for (const [column, target] of Object.entries(softReferences[table] || {})) {
      if (db.prepare(`SELECT 1 FROM (${rows}) t JOIN (${ownedRows(target)}) p ON p.id=t.${quoteIdentifier(column)}
        WHERE t.__owner!=p.__owner LIMIT 1`).get()) throw crossListeningError(table);
      if (db.prepare(`SELECT 1 FROM (${rows}) t JOIN (${ownedRows(target, 'main')}) p ON p.id=t.${quoteIdentifier(column)}
        WHERE t.__owner NOT IN (SELECT id FROM main.listenings) AND t.__owner!=p.__owner LIMIT 1`).get()) throw crossListeningError(table);
    }
    // No IDs are remapped. Snapshots and audit payloads retain their references;
    // reject any known embedded reference resolving to another listening.
    if (!jsonColumns[table]) continue;
    for (const row of db.prepare(`SELECT * FROM (${rows}) WHERE __owner NOT IN (SELECT id FROM main.listenings)`).iterate()) {
      if (!added.has(row.__owner)) continue;
      const checkReference = (target, id) => {
        if (typeof id !== 'string') return;
        if (!references.has(target)) references.set(target, db.prepare(`SELECT __owner FROM (${ownedRows(target)}) WHERE id=?
          UNION SELECT __owner FROM (${ownedRows(target, 'main')}) WHERE id=?`));
        const found = references.get(target).all(id, id);
        // Historical revisions can refer to deleted entities. Preserve them.
        if (found.some(ref => ref.__owner !== row.__owner)) throw crossListeningError(table);
      };
      const walk = (value, context = '', depth = 0) => {
        if (depth > 64) throw new DataTransferError('备份任务快照过于复杂', { code: 'INVALID_IMPORT_SNAPSHOT' });
        if (Array.isArray(value)) { for (const child of value) walk(child, context, depth + 1); return; }
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          let target = jsonReferences[key];
          if (key === 'id') target = ['segments', 'focus_segments', 'context_segments'].includes(context) ? 'segments' :
            context === 'observed_candidates' ? 'knowledge_candidates' :
              ['candidates', 'existing_candidates'].includes(context) ? 'knowledge_items' : undefined;
          if (key === 'job_id' && table.startsWith('extraction_')) target = 'extraction_jobs';
          if (target) checkReference(target, child);
          walk(child, key, depth + 1);
        }
      };
      for (const column of jsonColumns[table]) {
        if (!row[column]) continue;
        let value;
        try { value = JSON.parse(row[column]); }
        catch {
          if (column === 'old_value' || column === 'new_value') continue; // Audit text can be plain text.
          throw new DataTransferError('备份任务快照格式无效', { code: 'INVALID_IMPORT_SNAPSHOT' });
        }
        walk(value);
      }
    }
  }
}

function buildImportPlan(store, info, mode) {
  const current = store.db.prepare('SELECT id FROM listenings ORDER BY id').all();
  const existing = new Set(current.map(row => row.id));
  const incoming = store.db.prepare('SELECT id,title FROM imported.listenings ORDER BY created_at,id').all();
  const added = incoming.filter(row => !existing.has(row.id));
  const skipped = incoming.filter(row => existing.has(row.id));
  return { ...info, mode, currentCount: current.length, addedCount: added.length, skippedCount: skipped.length,
    skipped: skipped.map(row => ({ id: row.id, title: row.title })), addedIds: added.map(row => row.id), revision: importRevision(store) };
}

export function previewImport(store, source, mode, { prepared = false } = {}) {
  importMode(mode);
  inspectDatabase(source);
  const info = prepared ? inspectDatabase(source) : migrateImportedDatabase(source);
  const db = store.db;
  db.prepare('ATTACH DATABASE ? AS imported').run(source);
  let transaction = false;
  try {
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    validateImportSchema(db);
    const plan = buildImportPlan(store, info, mode);
    if (mode === 'append') validateAppendReferences(db, plan.addedIds);
    return plan;
  } finally {
    try { if (transaction) db.exec('ROLLBACK'); }
    finally { db.exec('DETACH DATABASE imported'); }
  }
}

export function appendDatabase(store, source, backupDestination, { revision } = {}) {
  const safety = restoreSafety(store);
  if (!safety.ok) throw new DataTransferError(safety.error, { status: 409, code: 'RESTORE_BUSY' });
  assertImportRevision(store, revision);
  const plan = previewImport(store, source, 'append', { prepared: true });
  assertImportRevision(store, revision);
  if (!plan.addedCount) return { ...plan, changed: false, backupInfo: null };
  const backupInfo = exportDatabase(store, backupDestination);
  const db = store.db;
  db.prepare('ATTACH DATABASE ? AS imported').run(source);
  let transaction = false;
  try {
    // Deferred FKs allow the persisted dependency graph to be copied atomically.
    // Triggers are disabled transactionally, preserving graph/window revisions.
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    assertImportRevision(store, revision);
    db.exec('PRAGMA defer_foreign_keys=ON');
    db.exec(`CREATE TEMP TABLE import_added (id TEXT PRIMARY KEY);
      INSERT INTO import_added SELECT id FROM imported.listenings WHERE id NOT IN (SELECT id FROM main.listenings);`);
    const triggers = db.prepare("SELECT name,sql FROM main.sqlite_master WHERE type='trigger'").all();
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
    for (const table of Object.keys(IMPORT_TABLES)) {
      const columns = db.prepare(`PRAGMA main.table_info(${quoteIdentifier(table)})`).all().map(col => quoteIdentifier(col.name));
      // Existing listening IDs are never modified. PK/unique collisions in new
      // child rows fail the whole transaction; do not silently ignore them.
      db.exec(`INSERT INTO main.${quoteIdentifier(table)} (${columns.join(',')})
        SELECT ${columns.map(col => `t.${col}`).join(',')} FROM (${ownedRows(table)}) t
        WHERE t.__owner IN (SELECT id FROM temp.import_added)`);
    }
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec('DROP TABLE temp.import_added');
    if (db.prepare('PRAGMA main.foreign_key_check').all().length || !integrityOk(db)) {
      throw new DataTransferError('追加数据关联完整性检查未通过', { code: 'FOREIGN_KEY_CHECK_FAILED' });
    }
    db.exec('COMMIT'); transaction = false;
    return { ...plan, changed: true, backupInfo };
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    if (error instanceof DataTransferError) throw error;
    throw new DataTransferError('追加失败：数据 ID 冲突或写入错误，当前数据未改变', { status: 409, code: 'APPEND_FAILED' });
  } finally { db.exec('DETACH DATABASE imported'); }
}
