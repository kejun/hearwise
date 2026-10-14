import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { securityFixture, SECURITY_KEY, credentialFindings } from '../test-support/security-fixture.mjs';
import { deadline } from '../test-support/lifecycle.mjs';
import { createTraceReport } from '../scripts/trace-report.mjs';

async function until(read, predicate, label) {
  const expires = Date.now() + 5000;
  while (Date.now() < expires) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`${label} exceeded 5000ms`);
}
function inspectDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.ok(tables.length > 15);
    for (const { name } of tables) assert.deepEqual(credentialFindings(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()), [], name);
    return { tables: tables.length, listenings: db.prepare('SELECT COUNT(*) AS n FROM listenings').get().n, segments: db.prepare('SELECT COUNT(*) AS n FROM segments').get().n };
  } finally { db.close(); }
}

test('credential-bearing actual ASR/MT work leaves DB, SQLite export, safety backup, text export and Trace report credential-free after restart', { timeout: 20000 }, async t => {
  const f = await securityFixture(); t.after(f.close);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws'); t.after(() => ws.terminate());
  const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  await deadline(() => once(ws, 'open'), 5000, 'Persistence ASR open');
  ws.send(JSON.stringify({ type: 'start', key: SECURITY_KEY, source: 'en', targetLang: 'Chinese' }));
  const ready = await until(() => messages.find(row => row.type === 'listening-ready'), Boolean, 'Listening persisted');
  f.final('Synthetic security fixture original.');
  await until(() => messages.find(row => row.type === 'translation-updated'), Boolean, 'Translation persisted');
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'stop' })); await deadline(() => closed, 5000, 'Persistence ASR stop');
  const detailRoute = `/api/listenings/${ready.listeningId}`;
  const detail = await until(async () => (await fetch(f.base + detailRoute)).json(), row => row.processing.knowledge.pendingJobs === 0 && row.processing.knowledge.runningJobs === 0, 'Knowledge settled');
  assert.equal(detail.segments.length, 1); assert.equal(detail.segments[0].translation_state, 'complete');
  assert.ok(f.stats.requests.some(row => row.kind === 'asr') && f.stats.requests.some(row => row.model === 'qwen-mt-flash'));
  assert.ok(f.stats.requests.every(row => row.authorization === `Bearer ${SECURITY_KEY}`));
  assert.deepEqual(credentialFindings({ messages, detail }), []);
  const initial = inspectDatabase(f.filename); assert.equal(initial.segments, 1);
  for (const kind of ['original', 'translation']) {
    const response = await fetch(f.base + detailRoute + `/export?kind=${kind}`); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain/); assert.deepEqual(credentialFindings(await response.text()), []);
  }
  const exported = await fetch(f.base + '/api/data/export'); assert.equal(exported.status, 200);
  const bytes = Buffer.from(await exported.arrayBuffer()); assert.deepEqual(credentialFindings(bytes), []);
  const copy = path.join(f.directory, 'downloaded.sqlite'); await writeFile(copy, bytes); assert.deepEqual(inspectDatabase(copy), initial);
  const preview = await fetch(f.base + '/api/data/import/validate?mode=replace', { method: 'POST', body: bytes }); assert.equal(preview.status, 200); const review = await preview.json();
  const committed = await fetch(f.base + '/api/data/import/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: review.token, previewToken: review.previewToken, mode: 'replace' }) });
  assert.equal(committed.status, 200); const receipt = await committed.json(); assert.ok(receipt.safetyBackup);
  const backup = path.join(f.directory, 'backups', receipt.safetyBackup); assert.deepEqual(inspectDatabase(backup), initial);
  assert.deepEqual(credentialFindings(await readFile(backup)), []);
  const log = path.join(f.directory, 'capture.log'), report = path.join(f.directory, 'trace.html');
  await writeFile(log, f.logs()); const trace = await createTraceReport(log, report); assert.ok(trace.eventCount > 0);
  assert.deepEqual(credentialFindings(await readFile(log)), []); assert.deepEqual(credentialFindings(await readFile(report)), []);
  for (const name of await readdir(f.directory)) if (/^business\.sqlite(?:-wal|-shm)?$/.test(name)) assert.deepEqual(credentialFindings(await readFile(path.join(f.directory, name))), []);
  const requests = f.stats.requests.length; await f.restart();
  const reopened = await (await fetch(f.base + detailRoute)).json(); assert.equal(reopened.processingAvailable, false);
  assert.equal(reopened.segments[0].original_text, detail.segments[0].original_text);
  assert.deepEqual(inspectDatabase(f.filename), initial); assert.equal(f.stats.requests.length, requests);
});

test('failed knowledge provider work persists safe status codes and can recover explicitly without storing the credential', { timeout: 15000 }, async t => {
  const { seedNameReplacement } = await import('../test-support/name-replacement-fixture.mjs');
  const f = await securityFixture({ seed: store => {
    const seeded = seedNameReplacement(store); const job = store.detail(seeded.listeningId).jobs[0]; store.markJob(job.id, 'pending'); return seeded;
  } }); t.after(f.close); f.control.modelStatus = 401;
  const route = `/api/listenings/${f.seeded.listeningId}`;
  const retry = async () => fetch(f.base + route + '/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: SECURITY_KEY }) });
  assert.equal((await retry()).status, 202);
  const failed = await until(async () => (await fetch(f.base + route)).json(), row => row.jobs.some(job => job.state === 'failed'), 'Persisted safe provider failure');
  assert.ok(f.stats.requests.length >= 1); assert.deepEqual(credentialFindings(failed), []); inspectDatabase(f.filename);
  assert.deepEqual(credentialFindings(f.logs()), []); assert.match(f.logs(), /HTTP_401|HTTP 401/);
  f.control.modelStatus = 200; assert.equal((await retry()).status, 202);
  await until(async () => (await fetch(f.base + route)).json(), row => row.jobs.every(job => job.state === 'complete'), 'Explicit knowledge recovery');
  inspectDatabase(f.filename); assert.deepEqual(credentialFindings(f.logs()), []);
});
