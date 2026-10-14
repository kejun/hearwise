// Test-only synchronous pause at actual SQLite boundaries. No production hook.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, renameSync, appendFileSync } from 'node:fs';
const { UPGRADE_CONTROL: directory, UPGRADE_BOUNDARY: boundary, UPGRADE_FAULT: fault } = process.env;
if (!directory) throw new Error('Isolated upgrade control directory required');
const exec = DatabaseSync.prototype.exec;
let transaction = 0, writes = 0;
const record = event => { const row = { pid: process.pid, at: Date.now(), ...event }; appendFileSync(`${directory}/events.ndjson`, JSON.stringify(row) + '\n'); return row; };
function pause(name, sql) {
  const event = record({ event: 'boundary', name, sql, transaction, writes });
  if (boundary !== name) return;
  writeFileSync(`${directory}/marker.next`, JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'event'))));
  renameSync(`${directory}/marker.next`, `${directory}/marker.json`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  throw new Error('Upgrade test boundary deadline expired');
}
DatabaseSync.prototype.exec = function(sql) {
  const normalized = sql.trim();
  if (/^BEGIN IMMEDIATE$/i.test(normalized)) transaction++;
  if (transaction !== 1) return exec.call(this, sql);
  const mutation = /^(?:ALTER|CREATE|UPDATE)/i.test(normalized), commit = /^COMMIT$/i.test(normalized);
  if (commit) pause('before-commit', sql);
  // SQLite itself rejects the real DDL with SQLITE_READONLY, not a fake throw.
  if (mutation && fault === 'readonly') exec.call(this, 'PRAGMA query_only=ON');
  try { exec.call(this, sql); }
  catch (error) { record({ event: 'sqlite-error', sql, code: error.code, errcode: error.errcode, message: error.message }); throw error; }
  finally { if (mutation && fault === 'readonly') exec.call(this, 'PRAGMA query_only=OFF'); }
  if (mutation) {
    writes++;
    if (fault === 'early-commit') { exec.call(this, 'COMMIT'); record({ event: 'mutant-early-commit', sql }); }
    pause('after-write', sql);
  }
  if (commit) pause('after-commit', sql);
  if (/^ROLLBACK$/i.test(normalized)) record({ event: 'rollback' });
};
