import assert from 'node:assert/strict';
import path from 'node:path';
import { parseTapFooter, tapSummary } from './tap-summary.mjs';

export const nodeTestArgv = (file, events) => ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout',
  '--test-reporter=./scripts/lib/node-test-event-reporter.mjs', `--test-reporter-destination=${events}`, '--test-timeout=30000', file];
const tapEscape = value => {
  let result = value;
  for (const [raw, escaped] of [['\b', '\\b'], ['\f', '\\f'], ['\t', '\\t'], ['\n', '\\n'], ['\r', '\\r'], ['\v', '\\v']]) result = result.replaceAll(raw, escaped);
  return result.replaceAll('\\', '\\\\').replaceAll('#', '\\#');
};
export function validateNodeTestEvents(log, events, { entry, repositoryRoot, sourceFiles }) {
  const footer = parseTapFooter(log); assert.equal(tapSummary(log).ok, true); assert.ok(log.startsWith('TAP version 13\n'));
  assert.ok(Array.isArray(events) && events.length && path.isAbsolute(repositoryRoot));
  assert.ok(events.every(event => ['test:pass', 'test:fail', 'test:plan', 'test:summary'].includes(event?.type)));
  const bodies = events.filter(event => ['test:pass', 'test:fail'].includes(event.type));
  const plans = events.filter(event => event.type === 'test:plan');
  const summaries = events.filter(event => event.type === 'test:summary');
  const normalize = file => { assert.ok(typeof file === 'string' && path.isAbsolute(file)); const relative = path.relative(repositoryRoot, file).split(path.sep).join('/');
    assert.ok(relative && !relative.startsWith('../') && sourceFiles.includes(relative)); return relative; };
  assert.equal(summaries.length, 2); assert.equal(normalize(summaries[0].data.file), entry); assert.equal(summaries[1].data.file, undefined);
  const counts = { tests: footer.tests, failed: footer.fail, passed: footer.pass, cancelled: footer.cancelled, skipped: footer.skipped,
    todo: footer.todo, topLevel: footer.plan, suites: footer.suites };
  for (const summary of summaries) { assert.equal(summary.data.success, true); assert.deepEqual(summary.data.counts, counts); }
  assert.equal(bodies.length, footer.tests + footer.suites); assert.ok(bodies.length > 0);
  // Native Node 24.15 has no testId/parentId. Reconstruct ownership from the
  // ordered postorder pass/plan stream; optional newer native IDs must agree.
  const located = bodies.map(event => ({ value: event.data, position: events.indexOf(event) }));
  const parents = located.map(({ value }, index) => {
    assert.ok(Number.isSafeInteger(value.nesting) && value.nesting >= 0);
    if (value.nesting === 0) return -1;
    const parent = located.findIndex((row, next) => next > index && row.value.nesting < value.nesting);
    assert.ok(parent > index); assert.equal(located[parent].value.nesting, value.nesting - 1);
    return parent;
  });
  const siblings = new Map(), ids = new Map();
  const hasIds = located.some(({ value }) => Object.hasOwn(value, 'testId') || Object.hasOwn(value, 'parentId'));
  for (const [index, { value }] of located.entries()) {
    assert.equal(bodies[index].type, 'test:pass'); assert.ok(typeof value.name === 'string' && value.name);
    assert.ok(Number.isSafeInteger(value.testNumber) && value.testNumber > 0);
    assert.ok(Number.isSafeInteger(value.line) && value.line > 0 && Number.isSafeInteger(value.column) && value.column > 0);
    normalize(value.file); assert.ok(['test', 'suite'].includes(value.details?.type)); assert.ok(!value.skip && !value.todo);
    if (hasIds) {
      assert.ok(Number.isSafeInteger(value.testId) && value.testId > 0 && !ids.has(value.testId));
      assert.ok(Number.isSafeInteger(value.parentId) && value.parentId >= 0); ids.set(value.testId, value);
      assert.equal(value.parentId, parents[index] === -1 ? 0 : located[parents[index]].value.testId);
    }
    const list = siblings.get(parents[index]) || []; list.push(index); siblings.set(parents[index], list);
  }
  assert.equal(bodies.filter(event => event.data.details.type === 'suite').length, footer.suites);
  for (const indexes of siblings.values()) assert.deepEqual(indexes.map(index => located[index].value.testNumber), indexes.map((_, i) => i + 1));
  const planned = new Set();
  for (const event of plans) {
    const { nesting, count } = event.data, position = events.indexOf(event);
    assert.ok(Number.isSafeInteger(nesting) && nesting >= 0 && Number.isSafeInteger(count) && count >= 0);
    const parent = nesting === 0 ? -1 : located.findIndex(row => row.position > position && row.value.nesting < nesting);
    if (nesting > 0) { assert.ok(parent >= 0); assert.equal(located[parent].value.nesting, nesting - 1); }
    assert.ok(!planned.has(parent)); planned.add(parent);
    const children = siblings.get(parent) || [];
    assert.equal(count, children.length); assert.ok(children.every(index => located[index].position < position));
  }
  assert.ok(planned.has(-1));
  for (const [parent] of siblings) assert.ok(planned.has(parent));
  // Empty suites have no nested plan in Node's native reporter. Nonempty
  // parents are covered by the required plan for every observed sibling group.
  const expected = events.filter(event => event.type !== 'test:summary').map(event => {
    const value = event.data; assert.ok(Number.isSafeInteger(value.nesting) && value.nesting >= 0);
    return event.type === 'test:plan' ? `${'    '.repeat(value.nesting)}1..${value.count}` : `${'    '.repeat(value.nesting)}ok ${value.testNumber} - ${tapEscape(value.name)}`;
  });
  const actual = log.split(/\r?\n/).filter(line => /^(?: {4})*(?:(?:not )?ok \d+(?: - .*)?|1\.\.\d+)$/.test(line));
  assert.deepEqual(actual, expected);
  assert.equal(plans.filter(event => event.data.nesting === 0).length, 1);
  assert.equal(plans.find(event => event.data.nesting === 0).data.count, footer.plan);
  return true;
}
