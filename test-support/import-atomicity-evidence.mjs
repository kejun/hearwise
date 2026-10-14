import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { atomicityCases, caseId } from './import-atomicity-scenarios.mjs';
import { dataCases } from './import-atomicity-data.mjs';
import { afterImport, afterRestart, importedSnapshot, wholeListeningAppend } from './import-atomicity-fixture.mjs';

export const atomicityVersion = '1.0';
export const atomicityProperties = ['HW-09-06', 'HW-09-07', 'HW-09-08', 'HW-09-09'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function atomicitySource() {
  const git = args => execFileSync('git', args, { encoding: 'utf8', timeout: 5000 }).trim();
  const names = [...new Set([...git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n'), 'dist/server/index.js', 'public/vendor/cytoscape.js'])].sort();
  return { sha: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain', '--untracked-files=normal'])),
    digests: Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await readFile(name))]))) };
}
export function stableAtomicitySources(start, end, release = false) {
  return Boolean(/^[a-f0-9]{40}$/.test(start?.sha) && typeof start?.dirty === 'boolean' &&
    ['data-transfer.mjs', 'storage.mjs', 'relation-storage.mjs', 'server.mjs', 'dist/server/index.js', 'package-lock.json',
      'test-support/import-atomicity-control.mjs', 'test-support/import-atomicity-evidence.mjs'].every(file => /^[a-f0-9]{64}$/.test(start.digests?.[file])) &&
    isDeepStrictEqual(start, end) && (!release || !start.dirty));
}
function snapshot(row, label) {
  const values = row.snapshots.filter(value => value.label === label); assert.equal(values.length, 1, label);
  const value = values[0].database; assert.equal(value.integrity, 'ok'); assert.deepEqual(value.foreignKeyErrors, []); return value;
}
function validateData(row) {
  const before = snapshot(row, 'before');
  if (row.kind === 'round-trip') {
    assert.deepEqual(snapshot(row, 'exported'), before);
    assert.deepEqual(snapshot(row, 'isolated-restored'), afterImport(before));
    const original = snapshot(row, 'isolated-before');
    assert.deepEqual(snapshot(row, 'safety-backup'), original); assert.deepEqual(snapshot(row, 'isolated-undo'), afterImport(original));
    for (const table of ['listenings', 'segments', 'knowledge_items', 'knowledge_facts', 'relations', 'relation_supports', 'extraction_jobs', 'relation_jobs']) assert.ok(before.rows[table].length);
  } else if (row.kind === 'whole-listening-append') {
    assert.deepEqual(snapshot(row, 'exported'), before);
    const after = snapshot(row, 'appended');
    assert.deepEqual(row.incoming, snapshot(row, 'prepared-incoming'));
    assert.deepEqual(after, wholeListeningAppend(before, row.incoming));
    assert.equal(after.rows.listenings.length, before.rows.listenings.length + 1);
    for (const [table, rows] of Object.entries(before.rows)) for (const value of rows) assert.ok(after.rows[table].some(actual => isDeepStrictEqual(actual, value)));
    assert.deepEqual(snapshot(row, 'repeat-no-op'), after);
  } else {
    assert.deepEqual(snapshot(row, 'rejected'), before);
    const imported = row.importedSource; assert.equal(imported.integrity, 'ok');
    if (row.kind === 'primary-key') assert.ok(imported.rows.knowledge_facts.some(value => before.rows.knowledge_facts.some(local => local.id === value.id && local.item_id !== value.item_id)));
    else if (row.kind === 'ownership') assert.ok(imported.rows.segments.some(segment => imported.rows.listening_runs.some(run => run.id === segment.run_id && run.listening_id !== segment.listening_id)));
    else if (row.kind === 'restore-foreign-key') assert.ok(imported.foreignKeyErrors.some(value => value.table === 'segments'));
    else assert.ok(imported.schema.some(value => value.name === 'segments' && value.sql.includes('unexpected_column')));

    assert.equal(row.errorObserved?.code, { 'primary-key': 'APPEND_FAILED', ownership: 'IMPORT_CROSS_LISTENING_REFERENCE', schema: 'DATABASE_SCHEMA_MISMATCH', 'restore-schema': 'RESTORE_FAILED', 'restore-foreign-key': 'FOREIGN_KEY_CHECK_FAILED' }[row.kind]);
    if (row.kind === 'primary-key' || row.kind.startsWith('restore-')) assert.deepEqual(snapshot(row, 'safety-backup'), before);
    const edited = structuredClone(before), target = edited.rows.listenings.find(value => value.id === row.usable.id);
    assert.ok(target); target.notes = '仍然可编辑'; assert.equal(row.usable.notes, target.notes);
    assert.deepEqual(row.usable.queried, target); assert.deepEqual(row.usable.after, snapshot(row, 'after-edit'));
    assert.deepEqual(row.usable.after, edited);
  }
}
function runtimeEvidence(runtimes, pids, source) {
  assert.ok(/^[a-f0-9]{40}$/.test(source?.sha)); assert.equal(typeof source.dirty, 'boolean');
  assert.deepEqual(runtimes.map(row => row.pid).sort((a, b) => a - b), [...pids].sort((a, b) => a - b));
  for (const row of runtimes) {
    assert.deepEqual(row.diagnostics.build, { git_sha: source.sha, build_dirty: source.dirty, instrumentation_version: 3 });
    assert.equal(row.diagnostics.active_spans, 0); assert.equal(row.diagnostics.complete, true);
  }
}
function boundaryEvidence(row, source) {
  const life = row.lifecycle, crashed = ['crash', 'negative'].includes(row.kind);
  assert.deepEqual(life.map(value => value.action), crashed ? ['start', 'crash', 'start'] : ['start']);
  const time = value => { const result = Date.parse(value); assert.ok(Number.isFinite(result)); return result; };
  for (let i = 1; i < life.length; i++) assert.ok(time(life[i].at) >= time(life[i - 1].at));
  const startAt = time(life[0].at), pid = life[0].pid;
  runtimeEvidence(row.runtimes, life.filter(value => value.action === 'start').map(value => value.pid), source);
  assert.ok(typeof row.commandId === 'string' && row.commandId.length > 0);
  let previous = startAt;
  for (const event of row.events) {
    assert.equal(event.id, row.commandId); assert.equal(event.pid, pid);
    const at = time(event.at); assert.ok(at >= previous); previous = at;
    if (crashed) assert.ok(at <= time(life[1].at));
  }
  const bounds = row.events.filter(event => event.event === 'boundary');
  const names = ['before-backup', 'after-backup', 'after-first-write', 'before-commit', 'after-commit'];
  const end = crashed ? row.boundary : row.fault === 'backup' ? 'before-backup' : row.fault === 'lock' ? 'after-backup' : 'after-first-write';
  assert.deepEqual(bounds.map(value => value.name), names.slice(0, names.indexOf(end) + 1));
  const count = Object.keys(snapshot(row, 'before').rows).length; assert.equal(count, 22);
  for (const event of bounds) {
    const countExpected = ['before-backup', 'after-backup'].includes(event.name) ? 0 : event.name === 'after-first-write' ? 1 : count * (row.mode === 'replace' ? 2 : 1);
    assert.equal(event.mutations, countExpected);
    if (['before-backup', 'after-backup'].includes(event.name)) {
      assert.equal(typeof event.backup, 'string'); assert.ok(event.backup.endsWith('.sqlite'));
      assert.equal(event.sql, `VACUUM INTO '${event.backup.replaceAll("'", "''")}'`);
    } else if (event.name === 'after-first-write') {
      if (row.mode === 'replace') assert.equal(event.sql, 'DELETE FROM main."extraction_jobs"');
      else assert.match(event.sql, /^INSERT INTO main\."listenings" \(/);
    } else assert.equal(event.sql, 'COMMIT');
  }
  if (row.marker) {
    const selected = bounds.filter(event => event.name === row.marker.name); assert.equal(selected.length, 1);
    const { event, ...expected } = selected[0]; assert.deepEqual(row.marker, expected);
    if (crashed) assert.equal(row.marker.name, row.boundary);
  } else assert.ok(!crashed && row.fault === 'write');
}
export function validateAtomicityObservations(observations) {
  const reasons = [];
  try {
    assert.equal(observations.version, atomicityVersion);
    const rows = observations.scenarios, expectedIds = [...dataCases.map(kind => `data/${kind}`), ...atomicityCases.map(caseId)];
    assert.deepEqual(rows.map(row => row.id).sort(), expectedIds.sort(), 'exact required matrix');
    for (const row of rows) {
      assert.equal(row.complete, true); assert.equal(row.ok, true); assert.equal(row.cleanup?.ok, true);
      if (row.id.startsWith('data/')) { assert.equal(row.id, `data/${row.kind}`); validateData(row); continue; }
      const config = atomicityCases.find(value => caseId(value) === row.id);
      for (const key of ['mode', 'kind', 'fault', 'boundary', 'mutation']) assert.equal(row[key], config[key], `frozen scenario ${key}`);
      assert.deepEqual(row.providerCalls, []); boundaryEvidence(row, observations.source);
      if (!row.kind.startsWith('negative')) {
        const usable = row.usable; assert.equal(usable.get.status, 200); assert.equal(usable.patch.status, 200); assert.deepEqual(usable.providerCalls, []);
        const expectedEdit = structuredClone(usable.before), target = expectedEdit.rows.listenings.find(value => value.id === usable.request.id);
        assert.ok(target); assert.ok(usable.get.body.items.some(value => value.id === target.id));
        assert.equal(usable.request.title, 'Recovered editable history'); assert.equal(usable.request.notes, 'Synthetic restore verified.');
        target.title = usable.request.title; target.notes = usable.request.notes;
        assert.deepEqual(usable.patch.body.listening, target); assert.deepEqual(usable.after, expectedEdit);
        const previous = row.snapshots.find(value => value.label === 'after-safety-restore') || row.snapshots.find(value => value.label === 'after-new-process');
        assert.deepEqual(usable.before, previous.database);
      }
      const before = snapshot(row, 'before'); assert.deepEqual(snapshot(row, 'after-upload'), before);
      const imported = importedSnapshot(before, row.incoming, row.mode);
      if (row.kind === 'negative-write') {
        assert.ok(row.http.response.status >= 400);
        const actual = snapshot(row, 'after-rejected-commit');
        assert.ok(!isDeepStrictEqual(actual, before));
        assert.deepEqual(row.counterexample.expected, before); assert.deepEqual(row.counterexample.actual, actual);
        assert.ok(row.events.some(event => event.event === 'mutant-early-commit'));
        assert.ok(row.events.some(event => event.event === 'sqlite-error' && event.errcode === 8 && event.mutations === 1));
      } else if (row.kind === 'failure') {
        assert.ok(row.http.response.status >= 400); assert.deepEqual(snapshot(row, 'after-rejected-commit'), before);
        assert.deepEqual(snapshot(row, 'after-explicit-retry'), imported); assert.deepEqual(row.safetyBackup, before);
        assert.deepEqual(snapshot(row, 'after-safety-restore'), afterImport(before));
        const failures = row.events.filter(event => event.event === 'sqlite-error'); assert.ok(failures.length);
        if (row.fault === 'write') {
          assert.ok(failures.some(event => event.errcode === 8 && event.mutations === 1));
          assert.ok(row.events.some(event => event.event === 'rollback' && event.mutations === 1));
        } else if (row.fault === 'lock') assert.ok(failures.some(event => event.errcode === 5 && /BEGIN/.test(event.sql)));
        else assert.ok(!row.events.some(event => event.name === 'after-first-write'));
      } else {
        const life = row.lifecycle; assert.deepEqual(life.map(event => event.action), ['start', 'crash', 'start']);
        assert.equal(life[0].pid, life[1].pid); assert.equal(life[1].pid, row.marker.pid); assert.equal(life[1].signal, 'SIGKILL');
        assert.ok(Number.isSafeInteger(life[2].pid)); assert.notEqual(life[2].pid, life[0].pid); assert.ok(row.http.networkError);
        assert.equal(row.marker.name, row.boundary); assert.equal(row.oldTokenCommit?.status, 410); assert.equal(row.oldTokenCommit.body.code, 'IMPORT_EXPIRED');
        const killed = snapshot(row, 'after-sigkill-before-restart'), restarted = snapshot(row, 'after-new-process');
        const intended = row.boundary === 'after-commit' ? imported : before;
        if (row.kind === 'negative') {
          assert.ok(row.events.some(event => event.event === 'mutant-early-commit' && event.mutations === 1));
          assert.ok(!isDeepStrictEqual(killed, intended)); assert.deepEqual(row.counterexample.expected, intended);
          assert.deepEqual(row.counterexample.actual, restarted);
        } else {
          assert.deepEqual(killed, intended); assert.deepEqual(restarted, afterRestart(intended));
          if (row.boundary !== 'before-backup') {
            assert.deepEqual(row.safetyBackup, before); assert.ok(row.safetyBackupBytes > 0);
            assert.deepEqual(snapshot(row, 'after-safety-restore'), afterImport(before));
          }
        }
      }
    }
  } catch (error) { reasons.push(error.message); }
  return { ok: reasons.length === 0, reasons };
}
export function validateAtomicityBrowser(browser) {
  try {
    assert.ok(browser.chromium); assert.equal(browser.scenarios.length, 2);
    assert.deepEqual(browser.scenarios.map(row => row.mode).sort(), ['append', 'replace']);
    assert.deepEqual(browser.cleanup, [{ target: 'Chromium', ok: true }]);
    for (const row of browser.scenarios) {
      assert.equal(row.complete, true); assert.equal(row.ok, true);
      assert.deepEqual(row.cleanup, [{ target: 'context', ok: true }, { target: 'fixture', ok: true }]);
      assert.deepEqual(row.pageErrors, []); assert.deepEqual(row.providerCalls, []);
      assert.equal(row.runtimes.length, 1); runtimeEvidence(row.runtimes, [row.runtimes[0].pid], browser.source);
      assert.match(row.failureStatus, /失败/);
      assert.deepEqual(row.http.map(value => value.status), [row.mode === 'append' ? 409 : 500, 200, 200]);
      const failed = row.http[0].body; assert.equal(failed.code, row.mode === 'append' ? 'APPEND_FAILED' : 'RESTORE_FAILED'); assert.match(failed.error, /失败/);
      for (const [index, expectedMode] of [[1, row.mode], [2, 'replace']]) {
        const body = row.http[index].body; assert.equal(body.ok, true); assert.equal(body.mode, expectedMode);
        assert.equal(body.databaseVersion, 12); assert.equal(body.changed, true); assert.equal(body.addedCount, 1); assert.equal(body.skippedCount, 0);
        assert.match(body.safetyBackup, /^before-import-.*\.sqlite$/);
      }
      const before = snapshot(row, 'before'); assert.deepEqual(row.download.database, before); assert.ok(row.download.bytes > 0);
      assert.deepEqual(snapshot(row, 'after-failure'), before);
      assert.ok(row.failureEvents.some(event => event.event === 'sqlite-error' && event.errcode === 8 && event.mutations === 1));
      assert.deepEqual(snapshot(row, 'after-explicit-retry'), importedSnapshot(before, row.incoming, row.mode));
      assert.deepEqual(row.safetyBackup, before); assert.deepEqual(snapshot(row, 'after-safety-restore'), afterImport(before));
      assert.deepEqual(row.screenshots.map(value => value.path), [`atomicity-${row.mode}-failure.png`, `atomicity-${row.mode}-restored.png`]);
    }
    return { ok: true, reasons: [] };
  } catch (error) { return { ok: false, reasons: [error.message] }; }
}
export function executionPassed(value) {
  return value?.code === 0 && value.signal === null && value.timedOut === false && value.interrupted === false && value.ok === true;
}
// Mutate genuine raw evidence and rerun the independent oracle. This catches
// report forgery even when the caller recomputes artifact hashes/cached flags.
export function atomicityEvidenceControls(observations) {
  assert.equal(validateAtomicityObservations(observations).ok, true, 'negative controls require a genuinely passing complete raw matrix');
  const find = (value, id) => value.scenarios.find(row => row.id === id);
  const controls = [
    ['missing-boundary-events', value => { for (const row of value.scenarios.filter(row => row.kind === 'crash')) row.events = []; }],
    ['false-boundary-sql', value => { const row = find(value, 'append/crash/after-commit'); row.marker.sql = 'SELECT 1'; row.marker.mutations = 0; }],
    ['stale-runtime-build', value => { find(value, 'append/crash/after-commit').runtimes[0].diagnostics.build.git_sha = '0'.repeat(40); }],
    ['missing-case', value => { value.scenarios.pop(); }],
    ['duplicate-case', value => { value.scenarios.push(structuredClone(value.scenarios[0])); }],
    ['fault-descriptor', value => { find(value, 'append/failure/write').fault = 'backup'; }],
    ['missing-imported-child', value => {
      const row = find(value, 'data/whole-listening-append'), localIds = new Set(snapshot(row, 'before').rows.listenings.map(item => item.id));
      const database = row.snapshots.find(item => item.label === 'appended').database;
      const index = database.rows.segments.findIndex(item => !localIds.has(item.listening_id)); assert.ok(index >= 0);
      database.rows.segments.splice(index, 1);
    }],
    ['wrong-kill-signal', value => { find(value, 'append/crash/after-first-write').lifecycle[1].signal = 'SIGTERM'; }],
    ['reused-pid', value => { const row = find(value, 'replace/crash/before-commit'); row.lifecycle[2].pid = row.lifecycle[0].pid; }],
    ['wrong-sqlite-error', value => { const row = find(value, 'replace/failure/write'); for (const event of row.events) if (event.errcode === 8) event.errcode = 5; }],
    ['missing-safety-backup', value => { delete find(value, 'append/crash/after-backup').safetyBackup; }],
    ['false-usability', value => { find(value, 'replace/crash/after-commit').usable.patch.body.listening.title = 'Not the requested title'; }],
    ['provider-call', value => { find(value, 'append/crash/before-backup').providerCalls.push({ transport: 'http' }); }],
    ['hidden-half-write', value => { const row = find(value, 'replace/negative/after-first-write');
      row.snapshots.find(item => item.label === 'after-sigkill-before-restart').database = structuredClone(snapshot(row, 'before')); }]
  ];
  return controls.map(([id, mutate]) => {
    const changed = structuredClone(observations); mutate(changed);
    const checked = validateAtomicityObservations(changed);
    return { id, rejected: !checked.ok, reasons: checked.reasons };
  });
}
