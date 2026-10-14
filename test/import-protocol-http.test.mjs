import test from 'node:test';
import assert from 'node:assert/strict';
import { importProtocolFixture, importedWorkObservation } from '../test-support/import-protocol-fixture.mjs';

const payload = review => ({ token: review.token, mode: review.mode, previewToken: review.previewToken });
async function review(fixture, mode = 'append') {
  const result = await fixture.upload(0, mode);
  assert.equal(result.status, 200); assert.equal(result.body.databaseVersion, 12);
  assert.match(result.body.revision, /^[a-f0-9]{64}$/);
  return result.body;
}
async function unchangedRejection(fixture, body, status, code) {
  const before = fixture.snapshot(), count = fixture.calls.length;
  const result = await fixture.request('/api/data/import/commit', { body });
  assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.code, code);
  assert.deepEqual(fixture.snapshot(), before, 'rejected HTTP commit leaves every business row/schema unchanged');
  assert.equal(fixture.calls.length, count);
  return result;
}
for (const mode of ['append', 'replace']) {
  test(`HTTP ${mode}: valid preview commits exactly once under concurrent duplicate requests`, async t => {
    const f = await importProtocolFixture(); t.after(() => f.close());
    const r = await review(f, mode);
    const results = await Promise.all([f.request('/api/data/import/commit', { body: payload(r) }), f.request('/api/data/import/commit', { body: payload(r) })]);
    assert.deepEqual(results.map(row => row.status).sort(), [200, 410]);
    assert.deepEqual(f.businessIds(), mode === 'append' ? [0, 1] : [1]);
    await unchangedRejection(f, payload(r), 410, 'IMPORT_EXPIRED');
    assert.equal(f.calls.length, 0);
  });
  for (const origin of ['same', 'other']) test(`HTTP ${mode}: ${origin}-connection child write invalidates retained revision`, async t => {
    const f = await importProtocolFixture(); t.after(() => f.close());
    const r = await review(f, mode); await f.write(origin);
    await unchangedRejection(f, { ...payload(r), revision: 'caller-cannot-replace-retained-revision' }, 409, 'IMPORT_PREVIEW_STALE');
    const next = await f.request('/api/data/import/preview', { body: { token: r.token, mode } });
    assert.equal(next.status, 200); assert.notEqual(next.body.revision, r.revision); assert.notEqual(next.body.previewToken, r.previewToken);
    const result = await f.request('/api/data/import/commit', { body: payload(next.body) });
    assert.equal(result.status, 200); assert.deepEqual(f.businessIds(), mode === 'append' ? [0, 1] : [1]);
    assert.equal(f.calls.length, 0);
  });
  test(`HTTP ${mode}: mode and rotating preview token are bound without renewing expiry`, async t => {
    const f = await importProtocolFixture(); t.after(() => f.close());
    const r = await review(f, mode), other = mode === 'append' ? 'replace' : 'append';
    await unchangedRejection(f, { ...payload(r), mode: other }, 409, 'IMPORT_PREVIEW_STALE');
    const next = await f.request('/api/data/import/preview', { body: { token: r.token, mode } });
    assert.equal(next.status, 200); assert.notEqual(next.body.previewToken, r.previewToken);
    await unchangedRejection(f, payload(r), 409, 'IMPORT_PREVIEW_STALE');
    const clock = await f.control('state');
    assert.deepEqual(clock.timers, [{ id: 0, active: true, requestedMilliseconds: 900000 }]);
    await f.control('expire', { timer: 0 });
    await unchangedRejection(f, payload(next.body), 410, 'IMPORT_EXPIRED');
    const expired = await f.request('/api/data/import/preview', { body: { token: r.token, mode } });
    assert.equal(expired.status, 410); assert.equal(expired.body.code, 'IMPORT_EXPIRED');
    assert.equal(f.calls.length, 0);
  });
  test(`HTTP ${mode}: actual process restart invalidates old retained upload tokens`, async t => {
    const f = await importProtocolFixture(); t.after(() => f.close());
    const r = await review(f, mode); await f.restart();
    assert.deepEqual(f.lifecycle.map(row => row.action), ['start', 'crash', 'start']);
    assert.equal(f.lifecycle[1].signal, 'SIGKILL');
    await unchangedRejection(f, payload(r), 410, 'IMPORT_EXPIRED');
    assert.deepEqual(f.businessIds(), [0]); assert.equal(f.calls.length, 0);
  });
  test(`HTTP ${mode}: real transaction rolls back a post-write COMMIT failure and needs re-preview`, async t => {
    const f = await importProtocolFixture(); t.after(() => f.close());
    const r = await review(f, mode); await f.control('fail-commit');
    await unchangedRejection(f, payload(r), mode === 'append' ? 409 : 500, mode === 'append' ? 'APPEND_FAILED' : 'RESTORE_FAILED');
    assert.equal((await f.control('state')).injectedCommits, 1);
    await unchangedRejection(f, payload(r), 409, 'IMPORT_PREVIEW_STALE');
    const next = await f.request('/api/data/import/preview', { body: { token: r.token, mode } });
    assert.equal(next.status, 200);
    assert.equal((await f.request('/api/data/import/commit', { body: payload(next.body) })).status, 200);
    assert.equal(f.calls.length, 0);
  });
  test(`HTTP ${mode}: removing the retained-revision argument is detected on real SQLite`, async t => {
    const f = await importProtocolFixture({ mutation: 'skip_http_revision' }); t.after(() => f.close());
    const r = await review(f, mode); await f.write('other');
    const before = f.snapshot(), result = await f.request('/api/data/import/commit', { body: payload(r) });
    assert.equal(result.status, 200, 'the actual production-copy mutant wrongly accepts stale preview');
    assert.notDeepEqual(f.snapshot(), before, 'the stale acceptance has a real durable business effect');
    assert.deepEqual(f.businessIds(), mode === 'append' ? [0, 1] : [1]);
    assert.equal(f.mutationEvidence.id, 'skip_http_revision'); assert.equal(f.calls.length, 0);
  });
}

for (const mode of ['append', 'replace']) test(`HTTP ${mode}: imported unfinished work stays stopped across actual process restart with zero provider calls`, async t => {
  const f = await importProtocolFixture({ unfinished: true }); t.after(() => f.close());
  const r = await review(f, mode);
  assert.equal((await f.request('/api/data/import/commit', { body: payload(r) })).status, 200);
  const before = importedWorkObservation(f);
  await f.restart();
  assert.equal((await f.request('/api/listenings', { method: 'GET' })).status, 200);
  const after = importedWorkObservation(f);
  assert.deepEqual(after, before, 'all imported work classes retain stopped states after actual restart');
  assert.equal(f.calls.length, 0);
});

test('HTTP no-op append of a re-uploaded backup preserves another token preview and every business row', async t => {
  const f = await importProtocolFixture({ tokens: 2 }); t.after(() => f.close());
  const first = await review(f);
  assert.equal((await f.request('/api/data/import/commit', { body: payload(first) })).status, 200);
  const other = await f.upload(1, 'append'); assert.equal(other.status, 200);
  const duplicate = await review(f);
  assert.equal(duplicate.addedCount, 0); assert.equal(duplicate.skippedCount, 1);
  assert.equal(duplicate.revision, other.body.revision);
  const before = f.snapshot(), result = await f.request('/api/data/import/commit', { body: payload(duplicate) });
  assert.equal(result.status, 200); assert.equal(result.body.changed, false);
  assert.deepEqual(f.snapshot(), before);
  // Unlike changing imports in the unique-backup model, a true no-op does not
  // invalidate the other pending preview. Do not weaken this to re-preview first.
  const next = await f.request('/api/data/import/commit', { body: payload(other.body) });
  assert.equal(next.status, 200); assert.equal(next.body.changed, true);
  assert.deepEqual(f.businessIds(), [0, 1, 2]); assert.equal(f.calls.length, 0);
});
