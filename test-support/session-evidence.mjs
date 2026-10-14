import { summarize } from '../scripts/lib/verification-evidence.mjs';

// Extracted without behavior changes so the session failure paths can be tested.
export function sessionTapSummary(tail) {
  const testCount = Number(tail.match(/# tests (\d+)/)?.[1] || 0);
  return { testCount, ok: testCount > 0 && /# fail 0(?:\r?\n|$)/.test(tail) && /# cancelled 0(?:\r?\n|$)/.test(tail) };
}
export async function runSessionChecks(specifications, execute, { cleanup = async () => {} } = {}) {
  const checks = [];
  try {
    for (const specification of specifications) {
      const execution = await execute(specification, specification.timeoutMs);
      checks.push({ name: specification.name, execution });
      if (execution.interrupted) break;
    }
    return { checks, budgetExpired: false };
  } finally { await cleanup(); }
}
export function summarizeSessionResults({ results, checks, target, required, artifactsValid, release, sourceStable }) {
  const execution = { code: checks.every(({ execution: e }) => e.ok) ? 0 : 1, signal: null,
    timedOut: checks.some(({ execution: e }) => e.timedOut), interrupted: checks.some(({ execution: e }) => e.interrupted),
    complete: checks.every(({ execution: e }) => !e.timedOut && !e.interrupted && e.signal == null && [0, 1].includes(e.code)) };
  if (!sourceStable) execution.complete = false;
  return { execution, summary: summarize({ results, target, required, artifactsValid, release, execution }) };
}
