export function parseTapFooter(tail) {
  // Node prefixes/escapes test output. Only its final, unindented reporter footer
  // is authoritative; a substring such as "# \\# pass 2" is a test diagnostic.
  const footer = tail.match(/(?:^|\n)1\.\.(\d+)\r?\n# tests (\d+)\r?\n# suites (\d+)\r?\n# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)\r?\n# duration_ms (\d+(?:\.\d+)?)\r?\n?$/);
  const keys = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'];
  const unique = keys.every(key => [...tail.matchAll(new RegExp(`^# ${key} [^\\r\\n]*\\r?$`, 'gm'))].length === 1) &&
    [...tail.matchAll(/^1\.\.\d+\r?$/gm)].length === 1;
  if (!footer || !unique) return null;
  const [plan, tests, suites, pass, fail, cancelled, skipped, todo, duration] = footer.slice(1).map(Number);
  if (![plan, tests, suites, pass, fail, cancelled, skipped, todo].every(Number.isSafeInteger) || !Number.isFinite(duration)) return null;
  return { plan, tests, suites, pass, fail, cancelled, skipped, todo, duration };
}

const completeFooter = footer => Boolean(footer && footer.plan > 0 && footer.tests > 0 && footer.cancelled === 0 &&
  footer.skipped === 0 && footer.todo === 0 && footer.pass + footer.fail === footer.tests);

// Keep the original three-field browser API; all consumers share one parser.
export function tapSummary(tail) {
  const footer = parseTapFooter(tail), testComplete = completeFooter(footer);
  return { testCount: footer?.tests ?? 0, testComplete, ok: testComplete && footer.fail === 0 };
}

// Proof runners retain their canonical counts and their own minimum test count.
// Missing/ambiguous footers have unknown counts, never fabricated zero failures.
export function tapMetrics(tail) {
  const footer = parseTapFooter(tail);
  return { tests: footer?.tests ?? null, passed: footer?.pass ?? null, failed: footer?.fail ?? null,
    cancelled: footer?.cancelled ?? null, skipped: footer?.skipped ?? null, todo: footer?.todo ?? null,
    tapComplete: completeFooter(footer) };
}
