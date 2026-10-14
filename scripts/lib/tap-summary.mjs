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
