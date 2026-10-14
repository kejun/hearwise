import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { digest } from './verification-evidence.mjs';
import { securityTableNames } from '../../test-support/security-evidence.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validateBusinessSnapshot(snapshot) {
  assert.equal(snapshot?.integrity, 'ok'); assert.deepEqual(snapshot.foreignKeyErrors, []);
  assert.deepEqual(Object.keys(snapshot.rows).sort(), [...securityTableNames].sort());
  for (const rows of Object.values(snapshot.rows)) assert.ok(Array.isArray(rows) && rows.every(row => row && typeof row === 'object' && !Array.isArray(row)));
  assert.ok(Array.isArray(snapshot.schema) && snapshot.schema.length > 0);
  for (const name of securityTableNames) assert.equal(snapshot.schema.filter(row => row.type === 'table' && row.name === name && typeof row.sql === 'string' && row.sql).length, 1);
  assert.equal(new Set(snapshot.rows.listenings.map(row => row.id)).size, snapshot.rows.listenings.length);
  return true;
}
export function validateImportedRows(backup, before, after, mode, { stoppedWork = false } = {}) {
  validateBusinessSnapshot(backup);
  const canonical = rows => rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort();
  for (const [table, source] of Object.entries(backup.rows)) {
    const prior = new Set(before.rows[table].map(row => JSON.stringify(row)));
    const imported = mode === 'replace' ? after.rows[table] : after.rows[table].filter(row => !prior.has(JSON.stringify(row)));
    if (mode === 'append') assert.ok(before.rows[table].every(row => after.rows[table].some(value => JSON.stringify(value) === JSON.stringify(row))));
    const expected = source.map(row => {
      const value = { ...row }; if (!stoppedWork) return value;
      const timed = () => { const actual = imported.find(item => item.id === row.id); assert.ok(actual && Number.isFinite(Date.parse(actual.updated_at)) && Date.parse(actual.updated_at) >= Date.parse(row.updated_at)); value.updated_at = actual.updated_at; };
      if (table === 'listenings') value.relation_waiting_key = 0;
      if (table === 'segments' && value.translation_state === 'pending') value.translation_state = 'failed';
      if (table === 'extraction_jobs' && ['pending', 'running'].includes(value.state)) { Object.assign(value, { state: 'failed', retry_at: null, last_error: 'IMPORT_REQUIRES_RESUME' }); timed(); }
      if (table === 'relation_jobs') {
        if (value.state === 'running') { value.state = value.request_count >= value.max_requests ? 'failed' : 'pending'; value.last_error = 'REQUEST_INTERRUPTED'; timed(); }
        if (value.state === 'pending') Object.assign(value, { state: 'cancelled', last_error: 'IMPORT_REQUIRES_RESUME' });
      }
      if (table === 'relation_rounds' && value.state === 'active' && (value.finished_at == null || backup.rows.relation_windows.some(window => window.listening_id === value.listening_id && ['dirty', 'pending'].includes(window.state)))) Object.assign(value, { state: 'paused', stop_reason: 'IMPORT_REQUIRES_RESUME', wait_reason: null, next_ready_at: null });
      if (table === 'knowledge_edit_jobs' && value.state === 'running') { Object.assign(value, { state: 'failed', error: value.operation === 'name_correction' ? '服务在名称校正期间重启，原名称未更改；可明确重试。' : '服务在生成期间重启，原内容未更改，请重新保存。' }); timed(); }
      return value;
    });
    assert.deepEqual(canonical(imported), canonical(expected), `imported ${table} content differs from uploaded backup`);
  }
  return true;
}
// Reconstruct public projections from the cumulative raw HTTP ledger and actual
// table snapshots. Cached actual/unchanged/violation booleans are not an oracle.
export async function validateImportDurableReplay(replay, { negative = false, repositoryRoot = process.cwd() } = {}) {
  assert.ok(Array.isArray(replay.observations) && replay.observations.length);
  const first = replay.observations[0], keys = Object.keys(first.actual.clientGeneration), tokens = keys.length;
  assert.ok([1, 2].includes(tokens)); assert.deepEqual(keys, Array.from({ length: tokens }, (_, i) => String(i)));
  const clients = Object.fromEntries(['clientGeneration', 'clientMode', 'clientCurrentCount', 'clientAddedCount', 'clientSkippedCount'].map(key => [key, Object.fromEntries(keys.map(actor => [actor, key === 'clientMode' ? '' : 0]))]));
  const identities = new Map(), reviews = new Map(); let status = 0, code = '', previous;
  for (const [index, observation] of replay.observations.entries()) {
    assert.equal(observation.step, index - 1); const raw = observation.durable;
    validateBusinessSnapshot(raw?.snapshot); assert.ok(Array.isArray(raw.backups) && raw.backups.length === tokens); raw.backups.forEach(validateBusinessSnapshot); assert.deepEqual(raw.providerCalls, []);
    assert.ok(Array.isArray(raw.events)); assert.equal(raw.events.length, index);
    assert.ok(Array.isArray(raw.lifecycle) && raw.lifecycle.length); assert.equal(raw.lifecycle[0].action, 'start');
    assert.ok(raw.lifecycle.every(row => Number.isInteger(row.pid) && row.pid > 0));
    const restarts = raw.events.filter(row => row.action === 'restart').length;
    assert.deepEqual(raw.lifecycle.map(row => row.action), ['start', ...Array.from({ length: restarts }, () => ['crash', 'start']).flat()]);
    for (let n = 1; n < raw.lifecycle.length; n += 2) { assert.equal(raw.lifecycle[n].signal, 'SIGKILL'); assert.equal(raw.lifecycle[n].pid, raw.lifecycle[n - 1].pid); assert.notEqual(raw.lifecycle[n + 1].pid, raw.lifecycle[n].pid); }
    assert.ok(Array.isArray(raw.clockEvents));
    if (!index) { assert.equal(raw.snapshot.rows.listenings.length, 1); identities.set(raw.snapshot.rows.listenings[0].id, 0); }
    else {
      assert.deepEqual(raw.events.slice(0, -1), previous.events); assert.deepEqual(raw.backups, previous.backups);
      assert.deepEqual(raw.lifecycle.slice(0, previous.lifecycle.length), previous.lifecycle); assert.deepEqual(raw.clockEvents.slice(0, previous.clockEvents.length), previous.clockEvents); assert.deepEqual(raw.snapshot.schema, previous.snapshot.schema);
      const event = raw.events.at(-1), { result, action, actor } = event;
      assert.equal(event.providerCallDelta, 0);
      if (['upload', 'preview', 'commit'].includes(action)) {
        assert.ok(Number.isInteger(result?.status) && result.body && typeof result.body === 'object'); status = result.status; code = result.body.code || '';
        if (status !== 200) assert.deepEqual(raw.snapshot, previous.snapshot);
        else if (action !== 'commit') {
          assert.deepEqual(raw.snapshot, previous.snapshot);
          const body = result.body; assert.equal(body.mode, event.requestedMode); assert.equal(body.databaseVersion, 12); assert.ok(hash(body.revision));
          assert.ok(typeof body.token === 'string' && body.token && typeof body.previewToken === 'string' && body.previewToken);
          const prior = reviews.get(actor);
          if (prior) { assert.equal(body.token, prior.token); assert.notEqual(body.previewToken, prior.previewToken); }
          reviews.set(actor, body); clients.clientGeneration[actor]++;
          for (const [field, name] of [['clientMode', 'mode'], ['clientCurrentCount', 'currentCount'], ['clientAddedCount', 'addedCount'], ['clientSkippedCount', 'skippedCount']]) clients[field][actor] = body[name];
          assert.equal(body.currentCount, raw.snapshot.rows.listenings.length); assert.equal(body.addedCount, 1); assert.equal(body.skippedCount, 0);
        } else {
          assert.equal(result.body.mode, event.requestedMode); assert.equal(result.body.changed, true); assert.equal(result.body.addedCount, 1); assert.equal(result.body.skippedCount, 0);
          validateImportedRows(raw.backups[actor], previous.snapshot, raw.snapshot, event.requestedMode);
          const added = raw.snapshot.rows.listenings.filter(row => !identities.has(row.id));
          assert.equal(added.length, 1); identities.set(added[0].id, actor + 1);
          if (event.requestedMode === 'append') for (const [table, rows] of Object.entries(previous.snapshot.rows)) {
            const actual = new Set(raw.snapshot.rows[table].map(row => JSON.stringify(row))); assert.ok(rows.every(row => actual.has(JSON.stringify(row))));
          }
          else assert.equal(raw.snapshot.rows.listenings.length, 1);
        }
      } else {
        assert.equal(result, null);
        if (['expire', 'cleanup', 'stutter', 'restart'].includes(action)) assert.deepEqual(raw.snapshot, previous.snapshot);
        if (['same_write', 'other_write'].includes(action)) { assert.deepEqual(raw.snapshot.rows.listenings.map(row => row.id), previous.snapshot.rows.listenings.map(row => row.id)); assert.notDeepEqual(raw.snapshot.rows, previous.snapshot.rows); }
      }
      const expired = raw.events.filter(row => row.action === 'expire').length;
      assert.equal(raw.clockEvents.filter(row => row.command === 'expire').length, expired);
      for (const clock of raw.clockEvents) { assert.equal(clock.error, null); for (const timer of clock.timers || []) assert.equal(timer.requestedMilliseconds, 900000); }
      if (action === 'expire') { const clock = raw.clockEvents.at(-1); assert.equal(clock.command, 'expire'); assert.ok(clock.timers.some(timer => timer.active === false)); }
    }
    const businessIds = raw.snapshot.rows.listenings.map(row => identities.get(row.id)).sort((a, b) => a - b);
    assert.ok(businessIds.every(Number.isInteger)); assert.deepEqual(observation.actual, { lastHTTPStatus: status, lastHTTPCode: code, businessIds, ...clients });
    if (!negative) assert.equal(raw.mutation, null);
    previous = raw;
  }
  if (negative) {
    assert.equal(replay.difference?.step, 2); assert.equal(replay.observations.length, 4);
    assert.deepEqual(replay.observations.at(-1).actual, replay.difference.actual); assert.notDeepEqual(replay.difference.expected, replay.difference.actual);
    assert.deepEqual(replay.counterexample.steps.at(-1).expected, replay.difference.expected);
    const source = await readFile('server.mjs', 'utf8'), from = 'const options = { prepared: true, revision: pending.info.revision };', to = 'const options = { prepared: true };';
    assert.equal(source.split(from).length, 2); const mutant = source.replace(from, to);
    const runnable = mutant.replace(/from '([^']+)'/g, (_, file) => `from '${file.startsWith('./') ? pathToFileURL(path.resolve(repositoryRoot, file)).href : file.startsWith('node:') ? file : import.meta.resolve(file).replace(pathToFileURL(process.cwd()).href, pathToFileURL(repositoryRoot).href)}'`);
    const expected = { id: 'skip_http_revision', file: 'server.mjs', from, to, sourceSha256: digest(source), mutantSha256: digest(mutant), runnableSha256: digest(runnable) };
    for (const row of replay.observations) assert.deepEqual(row.durable.mutation, expected);
  }
  return true;
}
