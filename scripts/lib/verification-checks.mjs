import { summarize } from './verification-evidence.mjs';

export { tapSummary } from './tap-summary.mjs';

export function checkExecution(checks) {
  return { code: checks.every(({ execution: e }) => e.ok) ? 0 : 1, signal: null,
    timedOut: checks.some(({ execution: e }) => e.timedOut), interrupted: checks.some(({ execution: e }) => e.interrupted),
    complete: checks.every(({ execution: e }) => !e.timedOut && !e.interrupted && e.signal == null && [0, 1].includes(e.code) && e.testComplete !== false) };
}
// The browser parent gives this profile 180s. Reserve 30s for process-group
// termination, runtime cleanup, hashing, source checks and the final report.
export async function runChecks(specifications, execute, { budgetMs = 150000, now = Date.now, cleanup = async () => {} } = {}) {
  const checks = [], deadline = now() + budgetMs;
  let budgetExpired = false;
  try {
    for (const specification of specifications) {
      const remaining = deadline - now();
      if (remaining <= 0) { budgetExpired = true; break; }
      const execution = await execute(specification, Math.min(specification.timeoutMs, remaining));
      checks.push({ name: specification.name, execution });
      if (execution.timedOut || execution.interrupted || execution.signal != null || execution.testComplete === false) break;
    }
    return { checks, budgetExpired };
  } finally { await cleanup(); }
}
export function summarizeChecks({ results, checks, target, required, artifactsValid, release, sourceStable, expectedChecks, checksForProperty, budgetExpired = false }) {
  const execution = checkExecution(checks);
  execution.timedOut ||= budgetExpired;
  execution.complete &&= sourceStable && !budgetExpired && expectedChecks.every(name => checks.some(check => check.name === name));
  // A failed browser must not rewrite an independently completed SQLite result.
  // Each shared gate sees only the execution scope that produced its property.
  const template = summarize({ results: [], target, required, release, execution, artifactsValid: [] });
  const summaries = required.map(id => {
    const matches = results.map((result, index) => ({ result, index })).filter(({ result }) => result.property?.id === id);
    const names = checksForProperty(id);
    const applicable = checks.filter(check => names.includes(check.name));
    const scoped = checkExecution(applicable);
    scoped.complete &&= sourceStable && applicable.length === names.length;
    return summarize({ results: matches.map(match => match.result), target, required: [id], release, execution: scoped,
      artifactsValid: matches.map(match => artifactsValid[match.index]) });
  });
  const rows = summaries.flatMap(summary => summary.rows);
  const summary = { ...template, rows,
    ok: execution.complete && execution.code === 0 && summaries.every(summary => summary.ok),
    coverage: template.coverage.map(property => ({ ...property, ...(rows.find(row => row.id === property.id) || {}) })) };
  return { execution, summary };
}
