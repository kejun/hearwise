// These files start another full Node profile, a Quint compiler, or a
// multi-server actual workflow/quality collection. Run them
// without competing top-level test files; their own concurrency and deadlines
// remain unchanged. Ordinary files retain the existing four-worker bound.
const exclusiveFiles = new Set([
  'test/edit-consistency-evidence.test.mjs',
  'test/import-atomicity-crash.test.mjs',
  'test/upgrade-recovery.test.mjs',
  'test/knowledge-model-guards.test.mjs',
  'test/playback-evidence.test.mjs',
  'test/playback-protocol-evidence.test.mjs',
  'test/playback-protocol-replay.test.mjs',
  'test/quality-collector.test.mjs',
  'test/quality-offline-evidence.test.mjs',
  'test/trace-business-evidence.test.mjs',
  'test/process-crash-trace.test.mjs',
  'test/relation-result-evidence.test.mjs',
  'test/session-evidence.test.mjs',
  'test/verification-evidence.test.mjs'
]);

// The three profile drivers retain their existing 150s shared child budget and
// 30s cleanup/report allowance, matching the browser runner's parent deadline.
export const nestedProfileDeadlineMs = 180000;
export const nestedProfileTestDeadlineMs = nestedProfileDeadlineMs + 5000;
const longProfiles = new Set(['test/playback-evidence.test.mjs', 'test/relation-result-evidence.test.mjs', 'test/session-evidence.test.mjs']);
export function testExecutionPlan(file) {
  const candidate = file.replaceAll('\\', '/');
  const normalized = path.isAbsolute(candidate) ? path.relative(fileURLToPath(new URL('../../', import.meta.url)), candidate).split(path.sep).join('/') : path.posix.normalize(candidate);
  return { exclusive: exclusiveFiles.has(normalized), timeoutMs: longProfiles.has(normalized) ? nestedProfileTestDeadlineMs + 5000 : 90000 };
}

export async function runTestSchedule(files, execute, { concurrency = 4, stopped = () => false, plan = testExecutionPlan } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid test concurrency');
  let pending = [];
  const drain = async () => {
    const batch = pending; pending = []; let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      while (next < batch.length && !stopped()) { const file = batch[next++]; await execute(file, plan(file)); }
    }));
  };
  for (const file of files) {
    if (stopped()) break;
    if (plan(file).exclusive) { await drain(); if (!stopped()) await execute(file, plan(file)); }
    else pending.push(file);
  }
  await drain();
}
import path from 'node:path';
import { fileURLToPath } from 'node:url';

