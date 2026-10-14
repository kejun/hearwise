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
  const ids = new Map(), siblings = new Map();
  for (const event of bodies) {
    const value = event.data; assert.equal(event.type, 'test:pass'); assert.ok(typeof value.name === 'string' && value.name);
    assert.ok(Number.isSafeInteger(value.nesting) && value.nesting >= 0 && Number.isSafeInteger(value.testId) && value.testId > 0 && !ids.has(value.testId));
    assert.ok(Number.isSafeInteger(value.parentId) && value.parentId >= 0 && Number.isSafeInteger(value.line) && value.line > 0 && Number.isSafeInteger(value.column) && value.column > 0);
    normalize(value.file); assert.ok(['test', 'suite'].includes(value.details?.type)); assert.ok(!value.skip && !value.todo);
    ids.set(value.testId, value); const list = siblings.get(value.parentId) || []; list.push(value.testNumber); siblings.set(value.parentId, list);
  }
  assert.equal(bodies.filter(event => event.data.details.type === 'suite').length, footer.suites);
  for (const value of ids.values()) {
    if (value.nesting === 0) assert.equal(value.parentId, 0);
    else assert.equal(ids.get(value.parentId)?.nesting, value.nesting - 1);
  }
  for (const values of siblings.values()) assert.deepEqual(values, values.map((_, i) => i + 1));
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
