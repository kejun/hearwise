import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runTestSchedule, testExecutionPlan, nestedProfileDeadlineMs, nestedProfileTestDeadlineMs } from '../scripts/lib/test-schedule.mjs';

test('nested profiles run alone between bounded ordinary batches without losing failed files', async () => {
  const files = ['a', 'b', 'c', 'profile', 'd', 'e', 'compiler', 'f'], active = new Set(), completed = [], starts = [];
  const exclusive = file => ['profile', 'compiler'].includes(file);
  await runTestSchedule(files, async file => {
    assert.ok(active.size < 2); assert.ok(![...active].some(exclusive));
    if (exclusive(file)) assert.equal(active.size, 0);
    active.add(file); starts.push(file); await new Promise(resolve => setImmediate(resolve));
    active.delete(file); completed.push(file); return { ok: file !== 'b' };
  }, { concurrency: 2, plan: file => ({ exclusive: exclusive(file) }) });
  assert.deepEqual(starts, files); assert.deepEqual([...completed].sort(), [...files].sort());
});

test('stop drains running files without dispatching later exclusive or ordinary work', async () => {
  let stopping = false; const started = [];
  await runTestSchedule(['a', 'b', 'profile', 'c'], async file => {
    started.push(file); stopping = true; await new Promise(resolve => setImmediate(resolve));
  }, { stopped: () => stopping, plan: file => ({ exclusive: file === 'profile' }) });
  assert.deepEqual(started, ['a']);
});

test('actual nested profile and compiler files are isolated and parent deadlines cover cleanup', () => {
  for (const file of ['edit-consistency-evidence', 'knowledge-model-guards', 'playback-evidence', 'playback-protocol-evidence', 'playback-protocol-replay', 'quality-collector', 'quality-offline-evidence', 'trace-business-evidence', 'process-crash-trace', 'relation-result-evidence', 'session-evidence', 'verification-evidence'])
    assert.equal(testExecutionPlan(`test/${file}.test.mjs`).exclusive, true, file);
  assert.deepEqual(testExecutionPlan('test/relations.test.mjs'), { exclusive: false, timeoutMs: 90000 });
  assert.equal(nestedProfileDeadlineMs, 150000 + 30000);
  assert.ok(nestedProfileTestDeadlineMs > nestedProfileDeadlineMs + 1500);
  for (const file of ['playback-evidence', 'relation-result-evidence', 'session-evidence'])
    { assert.ok(testExecutionPlan(`./test/${file}.test.mjs`).timeoutMs > nestedProfileTestDeadlineMs);
      assert.deepEqual(testExecutionPlan(fileURLToPath(new URL(`./${file}.test.mjs`, import.meta.url))), testExecutionPlan(`test/${file}.test.mjs`)); }
});
