import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { importProtocolFixture, databaseSnapshot } from './import-protocol-fixture.mjs';
import { deadline } from './lifecycle.mjs';

export const crashBoundaries = ['before-backup', 'after-backup', 'after-first-write', 'before-commit', 'after-commit'];
// Exact production mappings, never blanket exclusion of task columns.
export function afterImport(snapshot) {
  const result = structuredClone(snapshot);
  for (const row of result.rows.listenings) row.relation_waiting_key = 0;
  return result;
}
export function afterRestart(snapshot) {
  const result = structuredClone(snapshot);
  for (const row of result.rows.listenings) row.relation_waiting_key = row.relation_enabled;
  return result;
}
export const sortedRows = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function importedSnapshot(before, incoming, mode) {
  assert.deepEqual(before.schema, incoming.schema);
  return { ...incoming, rows: Object.fromEntries(Object.entries(incoming.rows).map(([table, rows]) =>
    [table, sortedRows(mode === 'append' ? [...before.rows[table], ...rows] : [...rows])])) };
}
// Independent ownership oracle. A duplicate listening excludes its entire tree,
// including descendants without listening_id; no child records are merged.
export function wholeListeningAppend(before, incoming) {
  const parents = { knowledge_aliases: ['item_id', 'knowledge_items'], knowledge_mentions: ['item_id', 'knowledge_items'],
    knowledge_revisions: ['item_id', 'knowledge_items'], knowledge_facts: ['item_id', 'knowledge_items'],
    extraction_parts: ['job_id', 'extraction_jobs'], relation_requests: ['job_id', 'relation_jobs'],
    relation_assertions: ['relation_id', 'relations'], relation_supports: ['assertion_id', 'relation_assertions'],
    relation_revisions: ['relation_id', 'relations'] };
  const owner = (table, row) => {
    if (table === 'listenings') return row.id;
    if (Object.hasOwn(row, 'listening_id')) return row.listening_id;
    const [column, parent] = parents[table] || [];
    assert.ok(parent, `declared ownership for ${table}`);
    const found = incoming.rows[parent].find(value => value.id === row[column]); assert.ok(found);
    return owner(parent, found);
  };
  assert.deepEqual(before.schema, incoming.schema);
  const retained = new Set(before.rows.listenings.map(row => row.id));
  return { ...before, rows: Object.fromEntries(Object.entries(incoming.rows).map(([table, rows]) =>
    [table, sortedRows([...before.rows[table], ...rows.filter(row => !retained.has(owner(table, row)))])])) };
}
export async function importAtomicityFixture() {
  const fixture = await importProtocolFixture({ rich: true, preloads: ['test-support/import-atomicity-control.mjs'] });
  const file = name => path.join(fixture.directory, 'control', `atomicity-${name}`);
  const atomic = async (name, value) => {
    await writeFile(file(`${name}.next`), JSON.stringify(value)); await rename(file(`${name}.next`), file(`${name}.json`));
  };
  let id;
  async function arm({ boundary = 'none', fault = null, mutation = null } = {}) {
    id = randomUUID(); await atomic('command', { id, boundary, fault, mutation }); return id;
  }
  async function disarm() { await rm(file('command.json'), { force: true }); }
  async function marker() {
    let done = false;
    try {
      return await deadline(async () => {
        while (!done) {
          try { const value = JSON.parse(await readFile(file('marker.json'), 'utf8')); if (value.id === id) return value; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }, 7000, 'real SQLite atomicity boundary');
    } finally { done = true; }
  }
  async function uploadFile(filename, mode) {
    const result = await fixture.request(`/api/data/import/validate?mode=${mode}`, { body: await readFile(filename) });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function upload(mode) { return uploadFile(fixture.backups[0], mode); }
  async function preparedSnapshot() {
    const names = (await readdir(path.join(fixture.directory, '.imports'))).filter(name => name.endsWith('.sqlite'));
    assert.equal(names.length, 1); return databaseSnapshot(path.join(fixture.directory, '.imports', names[0]));
  }
  async function commit(review) {
    return fixture.request('/api/data/import/commit', { body: { token: review.token, mode: review.mode, previewToken: review.previewToken } });
  }
  async function events() {
    try { return (await readFile(file('events.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function assertUsable() {
    const before = fixture.snapshot();
    const response = await fixture.request('/api/listenings', { method: 'GET' }); assert.equal(response.status, 200);
    const listening = response.body.items[0]; assert.ok(listening);
    const changed = await fixture.request(`/api/listenings/${listening.id}`, { method: 'PATCH', body: { title: 'Recovered editable history', notes: 'Synthetic restore verified.' } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(fixture.snapshot().rows.listenings.find(row => row.id === listening.id).title, 'Recovered editable history');
    assert.equal(fixture.calls.length, 0);
    return { before, get: response, request: { id: listening.id, title: 'Recovered editable history', notes: 'Synthetic restore verified.' },
      patch: changed, after: fixture.snapshot(), providerCalls: [...fixture.calls] };
  }
  return { ...fixture, arm, disarm, marker, events, upload, uploadFile, preparedSnapshot, commit, assertUsable,
    release: () => atomic('release', { id }),
    restoreBackup: async filename => { const result = await commit(await uploadFile(filename, 'replace')); assert.equal(result.status, 200, JSON.stringify(result.body)); return result; }
  };
}
