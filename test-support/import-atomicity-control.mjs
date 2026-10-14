// Test-only synchronous barriers around actual SQLite/file boundaries. The
// production importer remains synchronous and is never given a test await.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { createTaskRuntime } from '../dist/server/index.js';

const directory = process.env.HEARWISE_IMPORT_TEST_CONTROL;
if (!directory) throw new Error('Atomicity preload requires the isolated import control directory');
const file = name => path.join(directory, `atomicity-${name}`);
const runtime = createTaskRuntime();
writeFileSync(file(`runtime-${process.pid}.json`), JSON.stringify({ pid: process.pid, diagnostics: runtime.diagnostics() }));
await runtime.dispose();
const original = DatabaseSync.prototype.exec;
let selected, backedUp = false, mutations = 0;
const journal = row => {
  const event = { id: selected?.id, pid: process.pid, at: new Date().toISOString(), ...row };
  appendFileSync(file('events.ndjson'), JSON.stringify(event) + '\n'); return event;
};
function command() {
  if (!existsSync(file('command.json'))) return null;
  const value = JSON.parse(readFileSync(file('command.json'), 'utf8'));
  if (value.id !== selected?.id) { selected = value; backedUp = false; mutations = 0; }
  return value;
}
function barrier(name, sql) {
  const event = journal({ event: 'boundary', name, sql, mutations, backup: selected.backup || null });
  if (selected.boundary !== name) return;
  const marker = { ...event }; delete marker.event;
  writeFileSync(file('marker.next'), JSON.stringify(marker)); renameSync(file('marker.next'), file('marker.json'));
  const until = Date.now() + 12000, sleep = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < until) {
    if (existsSync(file('release.json'))) {
      const release = JSON.parse(readFileSync(file('release.json'), 'utf8'));
      if (release.id === selected.id) return;
    }
    Atomics.wait(sleep, 0, 0, 10);
  }
  throw new Error(`Atomicity boundary ${name} release timed out`);
}
DatabaseSync.prototype.exec = function (sql) {
  if (!command()) return original.call(this, sql);
  const vacuum = /^VACUUM INTO '((?:[^']|'')+)'$/i.exec(sql.trim());
  if (vacuum) { selected.backup = vacuum[1].replaceAll("''", "'"); barrier('before-backup', sql); }
  const businessWrite = backedUp && /^(?:DELETE FROM|INSERT INTO) main\./i.test(sql.trim());
  if (backedUp && /^COMMIT\s*;?$/i.test(sql.trim())) barrier('before-commit', sql);
  // Fails a real SQLite write only after the first real business-table write.
  // Keep query_only enabled until SQLite rejects that next write, then disable
  // it so production ROLLBACK can actually execute.
  const readOnly = selected.fault === 'write' && businessWrite && mutations === 1;
  if (readOnly) original.call(this, 'PRAGMA query_only=ON');
  let result;
  try { result = original.call(this, sql); }
  catch (error) {
    journal({ event: 'sqlite-error', sql, code: error.code, errcode: error.errcode, errstr: error.errstr, message: error.message, mutations });
    throw error;
  } finally { if (readOnly) original.call(this, 'PRAGMA query_only=OFF'); }
  if (vacuum) { backedUp = true; barrier('after-backup', sql); }
  if (businessWrite) {
    mutations++;
    if (mutations === 1) {
      if (selected.mutation === 'early-commit') {
        original.call(this, 'COMMIT'); journal({ event: 'mutant-early-commit', sql, mutations });
      }
      barrier('after-first-write', sql);
    }
  }
  if (backedUp && /^COMMIT\s*;?$/i.test(sql.trim())) barrier('after-commit', sql);
  if (/^ROLLBACK\s*;?$/i.test(sql.trim())) journal({ event: 'rollback', mutations });
  return result;
};
