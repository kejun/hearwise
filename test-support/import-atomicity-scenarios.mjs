import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { importAtomicityFixture, importedSnapshot, crashBoundaries, afterImport, afterRestart } from './import-atomicity-fixture.mjs';
import { databaseSnapshot } from './import-protocol-fixture.mjs';

export const atomicityCases = ['append', 'replace'].flatMap(mode => [
  ...crashBoundaries.map(boundary => ({ mode, kind: 'crash', boundary })),
  ...['backup', 'write', 'lock'].map(fault => ({ mode, kind: 'failure', fault })),
  { mode, kind: 'negative', boundary: 'after-first-write', mutation: 'early-commit' },
  { mode, kind: 'negative-write', fault: 'write', mutation: 'early-commit' }
]);
export const caseId = row => [row.mode, row.kind, row.boundary || row.fault].join('/');
export async function atomicityScenario(config, observation = {}) {
  const fixture = await importAtomicityFixture();
  let writer, pending, primaryError;
  Object.assign(observation, { id: caseId(config), ...config, snapshots: [], complete: false, ok: false });
  const snapshot = label => { const database = fixture.snapshot(); observation.snapshots.push({ label, database }); return database; };
  try {
    const before = snapshot('before');
    const review = await fixture.upload(config.mode), incoming = await fixture.preparedSnapshot();
    observation.incoming = incoming;
    assert.deepEqual(snapshot('after-upload'), before);
    const expected = importedSnapshot(before, incoming, config.mode);
    const boundary = ['failure', 'negative-write'].includes(config.kind) ? (config.fault === 'backup' ? 'before-backup' : config.fault === 'lock' ? 'after-backup' : 'none') : config.boundary;
    observation.commandId = await fixture.arm({ boundary, fault: config.fault, mutation: config.mutation });
    pending = fixture.commit(review).then(value => ({ response: value }), error => ({ networkError: { name: error.name, message: error.message } }));
    if (boundary !== 'none') observation.marker = await fixture.marker();
    if (['failure', 'negative-write'].includes(config.kind)) {
      if (config.fault === 'backup') {
        // A real filesystem/VACUUM error. Existence alone does not prove that a
        // file is a valid safety backup; production must remove this residue.
        await writeFile(observation.marker.backup, 'incomplete synthetic backup'); await fixture.release();
      } else if (config.fault === 'lock') {
        writer = new DatabaseSync(fixture.filename); writer.exec('BEGIN IMMEDIATE'); await fixture.release();
      }
      observation.http = await pending;
      assert.ok(observation.http.response?.status >= 400, JSON.stringify(observation.http));
      if (writer) { writer.exec('ROLLBACK'); writer.close(); writer = null; }
      await fixture.disarm();
      const rejected = snapshot('after-rejected-commit');
      if (config.kind === 'negative-write') {
        assert.ok(!isDeepStrictEqual(rejected, before), 'early COMMIT exposes partial state after real write failure');
        observation.counterexample = { expected: before, actual: rejected, firstDivergence: 'after-rejected-commit' };
        observation.complete = observation.ok = true; return observation;
      }
      assert.deepEqual(rejected, before, 'all rows and triggers rolled back');
      const events = await fixture.events();
      const failures = events.filter(row => row.event === 'sqlite-error');
      assert.ok(failures.length, 'failure came from actual SQLite execution');
      if (config.fault === 'write') {
        assert.ok(failures.some(row => row.errcode === 8 && row.mutations === 1), 'SQLITE_READONLY after one business mutation');
        assert.ok(events.some(row => row.event === 'rollback' && row.mutations === 1));
      } else if (config.fault === 'lock') {
        assert.ok(failures.some(row => row.errcode === 5 && /BEGIN/.test(row.sql)), 'real SQLITE_BUSY at transaction acquisition');
      } else {
        assert.equal(events.filter(row => row.name === 'after-first-write').length, 0);
        await assert.rejects(access(observation.marker.backup), { code: 'ENOENT' });
      }
      // Explicitly reupload after rollback so real total_changes qualification
      // remains intact. No automatic retry or fabricated revision is used.
      const retried = await fixture.commit(await fixture.upload(config.mode));
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      assert.deepEqual(snapshot('after-explicit-retry'), expected);
      const safetyFile = path.join(fixture.directory, 'backups', retried.body.safetyBackup);
      observation.safetyBackup = databaseSnapshot(safetyFile); assert.deepEqual(observation.safetyBackup, before);
      await fixture.restoreBackup(safetyFile); assert.deepEqual(snapshot('after-safety-restore'), afterImport(before));
    } else {
      await fixture.disarm();
      await fixture.restart({ afterCrash: () => { snapshot('after-sigkill-before-restart'); } });
      observation.http = await pending; assert.ok(observation.http.networkError, 'killed HTTP request cannot report success');
      observation.oldTokenCommit = await fixture.commit(review); assert.equal(observation.oldTokenCommit.status, 410);
      const after = snapshot('after-new-process');
      const intended = config.boundary === 'after-commit' ? expected : before;
      if (config.kind === 'negative') {
        assert.ok(!isDeepStrictEqual(after, intended), 'early COMMIT must expose real persisted partial data/schema');
        observation.counterexample = { expected: intended, actual: after, firstDivergence: 'after-sigkill-before-restart' };
      } else {
        assert.deepEqual(after, afterRestart(intended), 'process crash has all-or-nothing business state');
        assert.deepEqual(observation.snapshots.find(row => row.label === 'after-sigkill-before-restart').database, intended,
          'raw post-kill comparison includes every persisted column');
        const oldPid = observation.marker.pid, life = fixture.lifecycle;
        assert.equal(life[1].pid, oldPid); assert.equal(life[1].signal, 'SIGKILL'); assert.notEqual(life[2].pid, oldPid);
        if (config.boundary === 'before-backup') await assert.rejects(access(observation.marker.backup), { code: 'ENOENT' });
        else {
          observation.safetyBackup = databaseSnapshot(observation.marker.backup); assert.deepEqual(observation.safetyBackup, before);
          // Read and restore the actual file produced by the killed process.
          observation.safetyBackupBytes = (await readFile(observation.marker.backup)).length;
          await fixture.restoreBackup(observation.marker.backup); assert.deepEqual(snapshot('after-safety-restore'), afterImport(before));
        }
      }
    }
    if (config.kind !== 'negative') observation.usable = await fixture.assertUsable();
    assert.equal(fixture.calls.length, 0);
    observation.complete = observation.ok = true;
  } catch (error) { primaryError = error; observation.error = { name: error.name, message: error.message }; throw error; }
  finally {
    if (writer) { writer.exec('ROLLBACK'); writer.close(); }
    observation.runtimes = await fixture.runtimes(); observation.events = await fixture.events(); observation.lifecycle = [...fixture.lifecycle]; observation.providerCalls = [...fixture.calls];
    observation.logs = fixture.logs();
    try { await fixture.close(); observation.cleanup = { ok: true }; }
    catch (error) { observation.cleanup = { ok: false, message: error.message }; observation.complete = observation.ok = false; throw atomicityCleanupError(primaryError, error); }
  }
  return observation;
}

export function atomicityCleanupError(primaryError, cleanupError) {
  return cleanupError;
}
