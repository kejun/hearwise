import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
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

export function restoreDatabase(store, source, backupDestination) {
  const safety = restoreSafety(store);
  if (!safety.ok) throw new DataTransferError(safety.error, { status: 409, code: 'RESTORE_BUSY' });

  inspectDatabase(source);
  const importedInfo = migrateImportedDatabase(source);
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
