import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, copyFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ListeningStore } from '../storage.mjs';
import { fixtures, hash, materializeHistorical, upgradeSnapshot, assertUpgradeProjection } from './upgrade-fixture.mjs';
import { importAtomicityFixture } from './import-atomicity-fixture.mjs';
import { deadline, stopChild } from './lifecycle.mjs';

export const faultCases = [
  ...fixtures.slice(0, -1).flatMap(f => ['before-commit', 'after-commit'].map(boundary => ({ version: f.version, boundary, fault: null }))),
  ...[1, 6, 11].map(version => ({ version, boundary: 'after-write', fault: null })),
  { version: 1, boundary: null, fault: 'readonly' }, { version: 1, boundary: null, fault: 'constraint' },
  { version: 1, boundary: 'after-write', fault: 'early-commit' }
];
export const faultId = config => `v${config.version}/${config.fault || config.boundary}`;
export async function migrationFault(config, observation = {}) {
  observation.scenarioStartedAt = Date.now();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-upgrade-fault-')), filename = path.join(directory, 'old.sqlite');
  const backup = path.join(directory, 'before-upgrade.sqlite'), control = path.join(directory, 'control');
  let child;
  const fixture = fixtures[config.version - 1]; Object.assign(observation, { id: faultId(config), config, complete: false, ok: false });
  try {
    await mkdir(control); observation.before = materializeHistorical(fixture, filename);
    // Closed SQLite copy is the documented pre-upgrade backup, not live WAL copying.
    await copyFile(filename, backup); observation.backup = upgradeSnapshot(backup);
    assert.deepEqual(observation.backup, observation.before);
    if (config.fault === 'constraint') {
      const db = new DatabaseSync(filename);
      try { db.exec("CREATE TRIGGER reject_upgrade BEFORE UPDATE OF short_description ON knowledge_items BEGIN SELECT RAISE(ABORT, 'synthetic migration constraint'); END"); }
      finally { db.close(); }
      observation.before = upgradeSnapshot(filename);
    }
    observation.childStartedAt = Date.now();
    let logs = ''; child = spawn(process.execPath, ['--import', path.resolve('test-support/upgrade-control.mjs'), 'test-support/upgrade-child.mjs', filename], {
      env: { ...process.env, UPGRADE_CONTROL: control, UPGRADE_BOUNDARY: config.boundary || '', UPGRADE_FAULT: config.fault || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
    const exited = once(child, 'exit');
    if (config.boundary) {
      let waiting = true;
      try { observation.marker = await deadline(async () => { while (waiting) {
        try { return JSON.parse(await readFile(path.join(control, 'marker.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (child.exitCode !== null) throw new Error(`Child exited before boundary: ${logs}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      } }, 5000, 'migration boundary'); } finally { waiting = false; }
      observation.observedMarkerAt = Date.now(); assert.equal(observation.marker.pid, child.pid); observation.killRequestedAt = Date.now(); child.kill('SIGKILL');
    }
    const [code, signal] = await deadline(() => exited, 5000, 'migration child exit');
    observation.exitedAt = Date.now();
    observation.exit = { pid: child.pid, code, signal, logs };
    assert.equal(signal, config.boundary ? 'SIGKILL' : null); assert.equal(code, config.boundary ? null : 1);
    observation.events = (await readFile(path.join(control, 'events.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    observation.afterFailure = upgradeSnapshot(filename);
    if (config.fault === 'early-commit') {
      assert.throws(() => assert.deepEqual(observation.afterFailure, observation.before)); observation.negativeDetected = true;
    } else if (config.boundary === 'after-commit') {
      const targetVersion = config.version < 5 ? config.version + 1 : config.version < 9 ? 9 : config.version + 1;
      assertUpgradeProjection(fixture, observation.afterFailure, { stageOnly: true, targetVersion });
    } else assert.deepEqual(observation.afterFailure, observation.before, 'failed stage rolls back complete rows, schema and user_version');
    if (config.fault === 'readonly') assert.ok(observation.events.some(row => row.event === 'sqlite-error' && row.errcode === 8));
    if (config.fault === 'constraint') {
      assert.ok(observation.events.some(row => row.event === 'sqlite-error' && (row.errcode & 255) === 19));
      observation.backupSha256 = hash(await readFile(backup));
      observation.httpRecovery = await historicalRestore(config.version, backup);
      assert.equal(observation.httpRecovery.backupSha256, observation.backupSha256);
      assert.deepEqual(observation.httpRecovery.before, observation.backup);
      // Restore the actual pre-upgrade file after the failed process is gone.
      await rm(filename, { force: true }); await rm(`${filename}-wal`, { force: true }); await rm(`${filename}-shm`, { force: true }); await copyFile(backup, filename);
    }
    observation.startedAt = Date.now(); const store = new ListeningStore(filename); store.close(); observation.finishedAt = Date.now(); observation.recoveryWindow = { startedAt: observation.startedAt, finishedAt: observation.finishedAt };
    observation.recovered = upgradeSnapshot(filename); assertUpgradeProjection(fixture, observation.recovered, observation);
    assert.deepEqual(upgradeSnapshot(backup), observation.backup, 'pre-upgrade backup remains unchanged');
    observation.complete = observation.ok = true; return observation;
  } catch (error) { recordFailure(observation, error); throw error; }
  finally { try { if (child) await stopChild(child); } finally { await rm(directory, { recursive: true, force: true }); } observation.cleanupOk = true; observation.scenarioFinishedAt = Date.now(); }
}

export async function historicalRestore(version, inputFile = null, observation = {}) {
  const fixture = fixtures[version - 1], server = await importAtomicityFixture();
  Object.assign(observation, { id: `restore/v${version}`, version, complete: false, ok: false, scenarioStartedAt: Date.now() });
  try {
    const oldFile = inputFile || path.join(server.directory, `pre-upgrade-v${version}.sqlite`);
    observation.before = inputFile ? upgradeSnapshot(oldFile) : materializeHistorical(fixture, oldFile);
    observation.backupSha256 = hash(await readFile(oldFile)); observation.startedAt = Date.now();
    observation.review = await server.uploadFile(oldFile, 'replace');
    const preparedFiles = (await readdir(path.join(server.directory, '.imports'))).filter(file => file.endsWith('.sqlite'));
    assert.equal(preparedFiles.length, 1); observation.prepared = upgradeSnapshot(path.join(server.directory, '.imports', preparedFiles[0]));
    observation.finishedAt = Date.now(); assertUpgradeProjection(fixture, observation.prepared, { ...observation, imported: true });
    observation.commit = await server.commit(observation.review); assert.equal(observation.commit.status, 200);
    observation.restored = upgradeSnapshot(server.filename); assert.deepEqual(observation.restored, observation.prepared);
    observation.usable = await server.assertUsable();
    const id = fixture.identities.complete.listening, detail = await server.request(`/api/listenings/${id}`, { method: 'GET' });
    assert.equal(detail.status, 200); observation.detail = detail;
    observation.graph = await server.request(`/api/listenings/${id}/graph`, { method: 'GET' }); assert.equal(observation.graph.status, 200);
    observation.providerCalls = [...server.calls]; assert.deepEqual(observation.providerCalls, []);
    observation.backupAfterSha256 = hash(await readFile(oldFile)); assert.equal(observation.backupAfterSha256, observation.backupSha256);
    observation.backupAfter = upgradeSnapshot(oldFile); assert.deepEqual(observation.backupAfter, observation.before);
    observation.complete = observation.ok = true; return observation;
  } catch (error) { recordFailure(observation, error); throw error; }
  finally { await server.close(); observation.cleanupOk = true; observation.scenarioFinishedAt = Date.now(); }
}

export async function historicalUpgrade(version, observation = {}) {
  const fixture = fixtures[version - 1]; Object.assign(observation, { id: `upgrade/v${version}`, version, complete: false, ok: false });
  observation.scenarioStartedAt = Date.now();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-upgrade-')), filename = path.join(directory, 'old.sqlite');
  let store;
  try {
    observation.before = materializeHistorical(fixture, filename);
    const startedAt = Date.now(); store = new ListeningStore(filename); const finishedAt = Date.now();
    const after = upgradeSnapshot(filename); Object.assign(observation, { startedAt, finishedAt, upgraded: after }); assertUpgradeProjection(fixture, after, { startedAt, finishedAt });
    observation.graphs = JSON.parse(JSON.stringify(Object.values(fixture.identities).filter(Boolean).map(entry => store.graph(entry.listening))));
    observation.queries = JSON.parse(JSON.stringify(Object.values(fixture.identities).filter(Boolean).map(entry => store.detail(entry.listening))));
    for (const detail of observation.queries) {
      assert.deepEqual(JSON.parse(JSON.stringify(detail.segments)), after.rows.segments.filter(segment => segment.listening_id === detail.listening.id).sort((a, b) => a.sequence_no - b.sequence_no));
      assert.ok(detail.knowledge.length >= 2);
    }
    const id = fixture.identities.complete.listening;
    observation.editRequest = { id, title: 'Upgrade remains editable', notes: 'Synthetic post-upgrade note' };
    const result = store.updateMetadata(id, { title: observation.editRequest.title, notes: observation.editRequest.notes });
    const expectedEdited = structuredClone(after);
    Object.assign(expectedEdited.rows.listenings.find(row => row.id === id), { title: observation.editRequest.title, notes: observation.editRequest.notes });
    assert.deepEqual(upgradeSnapshot(filename), expectedEdited, 'metadata edit changes only title and notes');
    const edited = upgradeSnapshot(filename); store.close(); store = new ListeningStore(filename);
    assert.deepEqual(upgradeSnapshot(filename), edited, 'reopening does not mutate settled data');
    assert.equal(store.detail(id).listening.title, 'Upgrade remains editable');
    Object.assign(observation, { editResult: JSON.parse(JSON.stringify(result)), edited, reopened: upgradeSnapshot(filename), complete: true, ok: true });
    return observation;
  } catch (error) { recordFailure(observation, error); throw error; }
  finally { try { store?.close(); } finally { await rm(directory, { recursive: true, force: true }); } observation.cleanupOk = true; observation.scenarioFinishedAt = Date.now(); }
}

function recordFailure(observation, error) {
  observation.failure = { name: error.name, code: error.code, errcode: error.errcode, message: error.message, stack: error.stack };
  observation.complete = error.code === 'ERR_ASSERTION' || Number.isInteger(error.errcode);
  observation.ok = false;
}
