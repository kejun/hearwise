import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { databaseSnapshot } from './import-protocol-fixture.mjs';

const fixtureUrl = new URL('../test/fixtures/upgrade/', import.meta.url);
export function readHistoricalFixtures(manifest, read = filename => readFileSync(new URL(filename, fixtureUrl))) {
  assert.equal(manifest.manifestVersion, 1); assert.equal(manifest.metadata.formatVersion, 2);
  assert.equal(manifest.metadata.providerCalls, 0);
  assert.deepEqual(manifest.fixtures.map(row => row.version), Array.from({ length: 12 }, (_, index) => index + 1));
  const records = manifest.fixtures.map(entry => {
    const values = {};
    for (const kind of ['schema', 'rows']) {
      assert.equal(entry[kind].path, `v${entry.version}.${kind}.json`);
      const bytes = read(entry[kind].path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry[kind].sha256);
      values[kind] = JSON.parse(bytes);
    }
    assert.equal(values.schema.version, entry.version); assert.equal(Object.hasOwn(values.schema, 'rows'), false);
    return { ...values.schema, rows: values.rows };
  });
  return { ...manifest.metadata, fixtures: records };
}
export const historical = readHistoricalFixtures(JSON.parse(readFileSync(new URL('manifest.json', fixtureUrl))));
export const targetSchema = JSON.parse(readFileSync(new URL('../test/fixtures/upgrade/target-v12-schema.json', import.meta.url)));
// Ignore spacing only BETWEEN SQL tokens. Quoted strings/identifiers and word
// boundaries remain distinct (INTEGER PRIMARY KEY != INTEGERPRIMARYKEY).
export function semanticSchema(schema) {
  return schema.map(row => ({ ...row, sql: row.sql === null ? null :
    row.sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9$]*|[0-9]+(?:\.[0-9]+)?|[^\s]/g)
      .map(token => /^[a-zA-Z_]/.test(token) ? token.toLowerCase() : token) }));
}
export const fixtures = historical.fixtures;
export const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const quote = value => `"${value.replaceAll('"', '""')}"`;
export function materializeHistorical(fixture, filename) {
  assert.equal(hash(JSON.stringify(fixture.schema)), fixture.schemaSha256, 'frozen historical schema digest');
  const db = new DatabaseSync(filename);
  try {
    populateHistorical(db, fixture);
  } finally { db.close(); }
  const snapshot = upgradeSnapshot(filename);
  assert.equal(snapshot.version, fixture.version);
  for (const [table, rows] of Object.entries(fixture.rows)) assert.deepEqual(sortRows(table, snapshot.rows[table]), sortRows(table, rows));
  return snapshot;
}
function populateHistorical(db, fixture) {
    // Insert before installing the original triggers. This reconstructs the
    // original snapshot, rather than triggering business writes a second time.
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    for (const entry of fixture.schema.filter(row => row.type === 'table')) db.exec(entry.sql);
    for (const [table, rows] of Object.entries(fixture.rows)) for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${quote(table)} (${keys.map(quote).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
    }
    for (const entry of fixture.schema.filter(row => row.type !== 'table' && row.sql)) db.exec(entry.sql);
    db.exec(`PRAGMA user_version=${fixture.version}; COMMIT; PRAGMA foreign_keys=ON`);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const [table, columns] of Object.entries(fixture.columns)) assert.deepEqual(plain(db.prepare(`PRAGMA table_info(${quote(table)})`).all()), columns);

}
export function committedPrefixSchema(fixture, statements) {
  const db = new DatabaseSync(':memory:');
  try {
    populateHistorical(db, fixture); db.exec('BEGIN IMMEDIATE');
    for (const sql of statements) db.exec(sql);
    db.exec('COMMIT');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return plain({ rows: Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])),
      schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check, foreignKeyErrors: db.prepare('PRAGMA foreign_key_check').all(),
      version: db.prepare('PRAGMA user_version').get().user_version });
  } finally { db.close(); }
}
export function upgradeSnapshot(filename) {
  const snapshot = databaseSnapshot(filename), db = new DatabaseSync(filename, { readOnly: true });
  try { return { ...snapshot, version: db.prepare('PRAGMA user_version').get().user_version }; }
  finally { db.close(); }
}
export function sortRows(table, rows) {
  const keys = fixtures.at(-1).columns[table].filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
  assert.ok(keys.length, `declared primary key for ${table}`);
  return [...rows].sort((a, b) => JSON.stringify(keys.map(key => a[key])).localeCompare(JSON.stringify(keys.map(key => b[key]))));
}
const removed = { relation_rounds: ['deadline_at', 'max_requests', 'max_estimated_tokens'], relation_requests: ['estimated_tokens'] };
const defaultValue = column => column.dflt_value === null ? null : /^'.*'$/.test(column.dflt_value)
  ? column.dflt_value.slice(1, -1).replaceAll("''", "'") : Number(column.dflt_value);
// Frozen contract calculation, deliberately does not import the production
// migration/recovery/fingerprint implementation or use actual values as defaults.
function normalizedFingerprint(input) {
  const projected = {};
  for (const [key, value] of Object.entries(input)) if (!['input_fingerprint', 'window_revision', 'prompt_version', 'existing_assertions', 'coverage_limited'].includes(key)) {
    projected[key] = key === 'candidates' ? value.map(candidate => Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'mentions'))) : value;
  }
  return hash(JSON.stringify(projected));
}
export function assertUpgradeProjection(fixture, actual, { startedAt, finishedAt, server = false, imported = false, stageOnly = false, targetVersion = 12 } = {}) {
  if (!stageOnly) assert.deepEqual(semanticSchema(actual.schema), semanticSchema(targetSchema), 'target table constraints, indexes and triggers');
  assert.equal(actual.version, targetVersion); assert.equal(actual.integrity, 'ok'); assert.deepEqual(actual.foreignKeyErrors, []);
  assert.deepEqual(Object.keys(actual.rows).sort(), Object.keys(fixtures[targetVersion - 1].rows).sort());
  const timestamp = (value, label) => { assert.ok(Number.isFinite(Date.parse(value)) && Date.parse(value) >= startedAt && Date.parse(value) <= finishedAt, label); return value; };
  const fingerprintByWindow = new Map();
  for (const row of fixture.rows.relation_jobs || []) fingerprintByWindow.set(row.window_id, normalizedFingerprint(JSON.parse(row.input_json)));
  for (const [table, columns] of Object.entries(fixtures[targetVersion - 1].columns)) {
    const before = sortRows(table, fixture.rows[table] || []), after = sortRows(table, actual.rows[table]);
    if (!stageOnly && fixture.version === 6 && table === 'relation_rounds') {
      assert.equal(after.length, 1); const row = after[0], listening = fixture.rows.listenings.find(row => row.relation_enabled);
      assert.match(row.id, /^[0-9a-f-]{36}$/);
      assert.deepEqual({ ...row, id: null, started_at: null, finished_at: null }, { id: null, listening_id: listening.id,
        epoch: listening.relation_epoch, state: 'paused', started_at: null, finished_at: null,
        stop_reason: 'REQUEST_INTERRUPTED', wait_reason: null, next_ready_at: null });
      assert.ok(row.started_at >= startedAt && row.started_at <= finishedAt); assert.equal(row.finished_at, row.started_at); continue;
    }
    assert.equal(after.length, before.length, `v${fixture.version} ${table} row count`);
    for (let i = 0; i < before.length; i++) {
      const old = before[i], found = after[i], expected = Object.fromEntries(columns.map(column => [column.name,
        Object.hasOwn(old, column.name) ? old[column.name] : defaultValue(column)]));
      for (const key of Object.keys(old)) assert.ok(columns.some(column => column.name === key) || removed[table]?.includes(key), `only declared obsolete column removed: ${table}.${key}`);
      if (table === 'knowledge_items' && fixture.version === 1 && targetVersion >= 2) expected.short_description = old.dialogue_summary;
      if (!stageOnly && table === 'listenings') expected.relation_waiting_key = imported ? 0 : expected.relation_enabled;
      if (!stageOnly && table === 'listening_runs' && old.state === 'active') { expected.state = 'interrupted'; expected.ended_at = timestamp(found.ended_at, 'interrupted run end'); }
      if (table === 'extraction_jobs') {
        if (fixture.version < 4 && targetVersion >= 4 && old.state === 'complete') expected.outcome = 'legacy';
        if (fixture.version < 4 && targetVersion >= 4 && old.prompt_version === 2 && old.state !== 'complete') {
          Object.assign(expected, { state: 'failed', outcome: 'legacy', last_error: 'LEGACY_RECOVERY_REQUIRED', retry_at: null });
        } else if (!stageOnly && old.state === 'running') { expected.state = 'pending'; expected.updated_at = timestamp(found.updated_at, 'recovered extraction timestamp'); }
        if (imported && ['pending', 'running'].includes(expected.state)) Object.assign(expected, { state: 'failed', last_error: 'IMPORT_REQUIRES_RESUME', updated_at: timestamp(found.updated_at, 'imported task timestamp') });
      }
      if (table === 'segments' && imported && old.translation_state === 'pending') Object.assign(expected, { translation_state: 'failed' });
      if (!stageOnly && table === 'extraction_parts' && old.phase === 'extract_inflight') { expected.phase = 'extract_pending'; expected.updated_at = timestamp(found.updated_at, 'recovered checkpoint timestamp'); }
      if (targetVersion >= 9 && (!stageOnly || fixture.version < 9) && table === 'relation_jobs') {
        const input = JSON.parse(old.input_json), fingerprint = normalizedFingerprint(input);
        expected.input_fingerprint = fingerprint; expected.input_json = JSON.stringify({ ...input, input_fingerprint: fingerprint });
      }
      if (targetVersion >= 9 && (!stageOnly || fixture.version < 9) && table === 'relation_windows' && old.last_fingerprint) expected.last_fingerprint = fingerprintByWindow.get(old.id);
      if (table === 'knowledge_edit_jobs' && old.state === 'running' && (server || imported)) {
        expected.state = 'failed'; expected.error = '服务在生成期间重启，原内容未更改，请重新保存。';
        expected.updated_at = timestamp(found.updated_at, 'recovered edit timestamp');
      }
      assert.deepEqual(found, expected, `v${fixture.version} ${table} ${JSON.stringify(old.id || i)}`);
    }
  }
}
