import assert from 'node:assert/strict';
import { tapSummary, parseTapFooter } from './tap-summary.mjs';
const escape = name => name.replaceAll('\\', '\\\\').replaceAll('#', '\\#');
export function validateTapTree(log, nodes) {
  const footer = parseTapFooter(log), expected = []; let tests = 0;
  const group = (rows, nesting = 0) => {
    for (const [i, row] of rows.entries()) {
      const node = typeof row === 'string' ? { name: row } : row;
      if (node.children?.length) group(node.children, nesting + 1);
      expected.push(`${'    '.repeat(nesting)}ok ${i + 1} - ${escape(node.name)}`); tests++;
    }
    expected.push(`${'    '.repeat(nesting)}1..${rows.length}`);
  };
  group(nodes);
  assert.ok(log.startsWith('TAP version 13\n')); assert.equal(tapSummary(log).ok, true);
  assert.equal(footer.suites, 0); assert.equal(footer.tests, tests); assert.equal(footer.plan, nodes.length);
  const actual = log.split(/\r?\n/).filter(line => /^\s*(?:(?:not )?ok\b|\d+\.\.|Bail out!)/.test(line));
  assert.deepEqual(actual, expected); return true;
}
// Flat stages retain an exact result/plan stream; a nested failure cannot hide
// behind a rewritten success footer. Import explicitly declares its child tests.
export const validateFlatTap = (log, names) => validateTapTree(log, names);
