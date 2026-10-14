import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { tapMetrics, tapSummary } from '../scripts/lib/tap-summary.mjs';
import { checkerConclusion } from '../scripts/lib/formal-protocol-evidence.mjs';

// Real Node reporter output, not manually invented TAP, fixes the console/skip
// false-pass regression at the formal runner's evidence boundary.
test('formal implementation evidence rejects forged console summaries and skipped work', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'formal-tap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const fake = ['tests 2', 'suites 0', 'pass 2', 'fail 0', 'cancelled 0', 'skipped 0', 'todo 0', 'duration_ms 1'];
  for (const [name, body, ok, complete] of [
    ['console-skip', `test('logs', () => ${JSON.stringify(fake)}.forEach(line => console.log(line))); test.skip('not exercised', () => {});`, false, false],
    ['plain-skip', `test('executed', () => {}); test.skip('not exercised', () => {});`, false, false],
    ['pass', `test('executed', () => {});`, true, true],
    ['nested', `test('parent', async t => { await t.test('child', () => {}); });`, true, true],
    ['failure', `test('failed', () => { throw new Error('expected fixture failure'); });`, false, true]
  ]) {
    await t.test(name, async () => {
      const file = path.join(directory, `${name}.test.mjs`), logFile = path.join(directory, `${name}.tap`);
      await writeFile(file, `import { test } from 'node:test';\n${body}\n`);
      const execution = await runProcess(process.execPath, ['--test', '--test-reporter=tap', file], { env, logFile, timeoutMs: 4000 });
      const log = await readFile(logFile, 'utf8');
      assert.equal(execution.code, name === 'failure' ? 1 : 0, log);
      const result = checkerConclusion('implementation-regression', execution, log);
      assert.equal(result.ok, ok, log); assert.equal(result.complete, complete, log);
      const metrics = tapMetrics(log); assert.equal(metrics.tapComplete, complete, log);
      assert.equal(tapSummary(log).ok, ok, log);
      if (name === 'plain-skip') assert.equal(metrics.skipped, 1);
      if (name === 'failure') assert.equal(metrics.failed, 1);
      if (name === 'console-skip') assert.equal(metrics.tests, null);
    });
  }
});

test('all formal and proof consumers require a unique final footer and preserve execution failures', () => {
  const footer = '1..9\n# tests 9\n# suites 0\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.25\n';
  const log = 'TAP version 13\n' + footer;
  const execution = { code: 0, signal: null, timedOut: false, interrupted: false };
  assert.deepEqual(tapMetrics(log), { tests: 9, passed: 9, failed: 0, cancelled: 0, skipped: 0, todo: 0, tapComplete: true });
  assert.equal(tapMetrics(log.replaceAll('\n', '\r\n')).tapComplete, true);
  assert.equal(checkerConclusion('implementation-regression', execution, log.replaceAll('\n', '\r\n')).ok, true);
  for (const invalid of [log + footer, '# pass 99\n' + log, log.replace('# pass 9\n# fail 0', '# fail 0\n# pass 9'),
    log.replace('1..9\n', ''), log.replace('# duration_ms 1.25\n', ''), log + '# unfinished output\n',
    log.split('\n').map(line => '    ' + line).join('\n')]) {
    assert.equal(tapMetrics(invalid).tapComplete, false);
    assert.equal(tapSummary(invalid).testComplete, false);
    assert.deepEqual(checkerConclusion('implementation-regression', execution, invalid).complete, false);
  }
  for (const failed of [{ ...execution, code: 1 }, { ...execution, signal: 'SIGTERM' },
    { ...execution, timedOut: true }, { ...execution, interrupted: true }]) {
    assert.equal(checkerConclusion('implementation-regression', failed, log).ok, false);
  }
});
