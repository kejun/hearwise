import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessProtocolAdapter } from '../test-support/process-crash-adapter.mjs';

for (const protocol of ['knowledge', 'relation']) test(`${protocol} finalization survives a real independent SQLite write lock after a paid response`, async t => {
  const adapter = await createProcessProtocolAdapter(protocol === 'knowledge' ? { protocol, parts: 1 } : { protocol, actors: 1, capacity: 1 });
  t.after(() => adapter.close());
  for (const action of ['admit', 'send']) await adapter.act({ action, actor: 0 });
  await adapter.act({ action: 'response', actor: 0, response: 'ok' });
  const release = adapter.holdWriteLock();
  t.after(release);
  // Both the result transaction and its first failure-finalization exceed the
  // unchanged production SQLite busy_timeout=3000. The parent remains alive.
  const timer = setTimeout(release, 6500);
  t.after(() => clearTimeout(timer));
  await adapter.act({ action: 'commit_locked', actor: 0 });
  release();
  await adapter.act({ action: 'pump' });
  const actual = adapter.observe();
  assert.equal(actual.ledger.length, 1);
  assert.ok(actual.errors.some(error => error.errcode === 5 || /database is locked/.test(error.message)), 'SQLite BUSY must be diagnosed');
  const job = protocol === 'knowledge' ? actual.durable.checkpoint.job : actual.durable.actors[0].jobs.at(-1);
  t.diagnostic(JSON.stringify({ protocol, pid: actual.pid, ledgerCalls: actual.ledger.length, sqliteDiagnostics: actual.errors, finalState: job.state }));
  assert.equal(job.state, 'failed', 'failure finalization must not leave an orphan running paid request');
  assert.deepEqual(adapter.check(), []);
});
