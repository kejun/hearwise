import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relationResultFixture, startResult, settledResult, readResult, assertResult } from '../test-support/relation-result-fixture.mjs';

test('real HTTP relation results preserve sources, normal empty outcomes and saved data', { timeout: 25000 }, async t => {
  const fixture = await relationResultFixture(); t.after(() => fixture.close());
  for (const record of fixture.seeded) {
    await startResult(fixture, record);
    const graph = await settledResult(fixture, record); assertResult(fixture, record, graph);
    if (['shortage', 'empty', 'filtered'].includes(record.name)) {
      assert.equal(graph.status.canRetryProblems, false, 'Normal empty work is not a failed/partial retry target');
      const calls = fixture.calls.length;
      await startResult(fixture, record);
      assertResult(fixture, record, await settledResult(fixture, record));
      assert.equal(fixture.calls.length, calls, 'Explicit continuation cannot regenerate settled empty work');
    }
  }
  const calls = fixture.calls.length;
  await new Promise(resolve => setTimeout(resolve, 3300));
  assert.equal(fixture.calls.length, calls, 'No terminal result auto-retries over the normal retry interval');
  for (const record of fixture.seeded) assertResult(fixture, record, await readResult(fixture, record));
});
