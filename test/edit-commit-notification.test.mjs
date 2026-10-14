import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { speechFixture } from '../test-support/speech-fixture.mjs';
import { seedNameReplacement } from '../test-support/name-replacement-fixture.mjs';

// Test-only child preload injects a read failure at the real synchronous
// post-commit notification boundary. No production endpoint or fault switch.
test('a committed manual edit cannot be reported as unsaved when notification fails', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'edit-notification-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'notification-failure.mjs');
  await writeFile(preload, `import { ListeningStore } from ${JSON.stringify(new URL('../storage.mjs', import.meta.url).href)};
const original = ListeningStore.prototype.graphMetadata;
let injected = false;
ListeningStore.prototype.graphMetadata = function (...args) {
  if (!injected && this.db.prepare("SELECT 1 FROM knowledge_edit_jobs WHERE state='succeeded' AND name='NotifyProbe'").get()) {
    injected = true; console.info('edit_notification_failure_injected');
    throw new Error('Synthetic notification read failure after durable commit');
  }
  return original.apply(this, args);
};
`);
  const fixture = await speechFixture({ seed: store => seedNameReplacement(store, { graph: true }),
    extraEnv: { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${preload}`.trim() },
    modelResponse: () => { throw new Error('Manual edit must not call a provider'); } });
  t.after(() => fixture.close());
  const { listeningId, item } = fixture.seeded;
  const url = `${fixture.base}/api/listenings/${listeningId}/knowledge/${item.id}`;
  const before = await (await fetch(url)).json(), id = randomUUID();
  const response = await fetch(`${url}/name-replacements`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id },
    body: JSON.stringify({ name: 'NotifyProbe', revision: before.revision }) });
  const result = await response.json();
  const after = await (await fetch(url)).json(), receipt = await (await fetch(`${url}/edits/${id}`)).json();
  assert.equal(after.item.canonical_name, 'NotifyProbe');
  assert.notEqual(after.revision, before.revision);
  assert.equal(receipt.job.state, 'succeeded'); assert.equal(receipt.job.saved, true);
  assert.equal(fixture.stats.providerRequests.length, 0);
  assert.match(fixture.logs(), /edit_notification_failure_injected/);
  assert.equal(response.status, 200, JSON.stringify({ result, persisted: after.item.canonical_name, receipt: receipt.job }));
  assert.equal(result.job.id, id); assert.equal(result.job.saved, true);
  assert.equal(result.changed, true);
});

test('a genuine mid-transaction failure still reports unsaved and leaves no business write or receipt', async t => {
  const fixture = await speechFixture({ seed: store => {
    const seeded = seedNameReplacement(store, { graph: true });
    store.db.exec("CREATE TRIGGER edit_rollback BEFORE UPDATE OF canonical_name ON knowledge_items BEGIN SELECT RAISE(ABORT,'synthetic transaction rollback'); END");
    return seeded;
  }, modelResponse: () => { throw new Error('Manual edit must not call a provider'); } });
  t.after(() => fixture.close());
  const { listeningId, item } = fixture.seeded;
  const url = `${fixture.base}/api/listenings/${listeningId}/knowledge/${item.id}`;
  const before = await (await fetch(url)).json(), id = randomUUID();
  const response = await fetch(`${url}/name-replacements`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id },
    body: JSON.stringify({ name: 'RollbackProbe', revision: before.revision }) });
  const result = await response.json();
  assert.equal(response.status, 502); assert.equal(result.code, 'KNOWLEDGE_EDIT_FAILED'); assert.equal(result.saved, false);
  assert.deepEqual(await (await fetch(url)).json(), before);
  assert.equal((await fetch(`${url}/edits/${id}`)).status, 404);
  assert.equal(fixture.stats.providerRequests.length, 0);
});
