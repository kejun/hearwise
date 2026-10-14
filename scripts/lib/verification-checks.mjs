import { summarize } from './verification-evidence.mjs';

export function tapSummary(tail) {
  // Node prefixes/escapes test output. Only its final, unindented reporter footer
  // is authoritative; a substring such as "# \\# pass 2" is a test diagnostic.
  const footer = tail.match(/(?:^|\n)1\.\.(\d+)\r?\n# tests (\d+)\r?\n# suites (\d+)\r?\n# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)\r?\n# duration_ms (\d+(?:\.\d+)?)\r?\n?$/);
  const keys = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'];
  const unique = keys.every(key => [...tail.matchAll(new RegExp(`^# ${key} [^\\r\\n]*\\r?$`, 'gm'))].length === 1) &&
    [...tail.matchAll(/^1\.\.\d+\r?$/gm)].length === 1;
  if (!footer || !unique) return { testCount: 0, testComplete: false, ok: false };
  const [plan, tests, suites, pass, fail, cancelled, skipped, todo, duration] = footer.slice(1).map(Number);
  const testComplete = [plan, tests, suites, pass, fail, cancelled, skipped, todo].every(Number.isSafeInteger) &&
    Number.isFinite(duration) && plan > 0 && tests > 0 && cancelled === 0 && skipped === 0 && todo === 0 && pass + fail === tests;
  return { testCount: tests, testComplete, ok: testComplete && fail === 0 };
}

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
