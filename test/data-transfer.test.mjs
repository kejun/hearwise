import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { exportDatabase, inspectDatabase, restoreDatabase, restoreSafety } from '../data-transfer.mjs';
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
  assert.deepEqual(info, { valid: true, databaseVersion: 11, listeningCount: 1 });
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
  future.exec('PRAGMA user_version = 12');
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
  assert.equal(result.databaseVersion, 11);
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

  const invalid = await fetch(`${fixture.base}/api/data/import/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3' }, body: Buffer.from('bad')
  });
  assert.equal(invalid.status, 400);

  const validated = await fetch(`${fixture.base}/api/data/import/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3' }, body: bytes
  });
  assert.equal(validated.status, 200);
  const review = await validated.json();
  assert.equal(review.valid, true);
  assert.equal(review.databaseVersion, 11);
  assert.equal(review.listeningCount, 1);
  assert.match(review.token, /^[0-9a-f-]{36}$/);

  const committed = await fetch(`${fixture.base}/api/data/import/commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: review.token })
  });
  assert.equal(committed.status, 200);
  const result = await committed.json();
  assert.equal(result.ok, true);
  assert.match(result.safetyBackup, /^before-import-.*\.sqlite$/);

  const history = await fetch(`${fixture.base}/api/listenings`).then(response => response.json());
  assert.equal(history.total, 1);
  assert.equal(history.items[0].title, 'API backup');
});
