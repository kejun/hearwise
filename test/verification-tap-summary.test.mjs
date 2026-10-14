import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { sessionTapSummary } from '../test-support/session-evidence.mjs';
import { relationTapSummary } from '../test-support/relation-result-evidence.mjs';

const parsers = [sessionTapSummary, relationTapSummary];
const footer = '1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.25\n';

test('real Node TAP logs cannot hide skipped coverage or a failing assertion', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tap-footer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  for (const [name, second, expected] of [
    ['skip', "test.skip('not exercised', () => {});", { testCount: 2, testComplete: false, ok: false }],
    ['failure', "test('failure', () => { throw new Error('fixed failing assertion'); });", { testCount: 2, testComplete: true, ok: false }],
    ['pass', "test('executed', () => {});", { testCount: 2, testComplete: true, ok: true }],
    ['nested', "test('parent', async t => { await t.test('nested', () => {}); });", { testCount: 3, testComplete: true, ok: true }]
  ]) {
    const file = path.join(directory, `${name}.test.mjs`);
    await writeFile(file, `import { test } from 'node:test';\ntest('metric-like logs', () => { console.log('# pass 2'); console.log('# fail 0'); console.log('# skipped 0'); });\n${second}\n`);
    const execution = await runProcess(process.execPath, ['--test', '--test-reporter=tap', file], { env, timeoutMs: 4000 });
    assert.equal(execution.timedOut, false, execution.tail);
    assert.equal(execution.code, name === 'failure' ? 1 : 0, execution.tail);
    for (const parse of parsers) assert.deepEqual(parse(execution.tail), expected, execution.tail);
  }
});

test('TAP summaries require one final ordered top-level footer', () => {
  for (const parse of parsers) {
    assert.deepEqual(parse(footer), { testCount: 2, testComplete: true, ok: true });
    assert.equal(parse(footer.replaceAll('\n', '\r\n')).ok, true);
    assert.equal(parse(footer.trimEnd()).ok, true);
    assert.equal(parse(`# \\# pass 99\n    # pass 99\n${footer}`).ok, true);
    for (const text of [footer + footer, '# pass 99\n' + footer, footer.replace('# pass 2\n# fail 0', '# fail 0\n# pass 2'),
      footer.split('\n').map(line => '    ' + line).join('\n'), footer.replace('1..2\n', ''),
      footer.replace('# duration_ms 1.25\n', ''), footer + '# unfinished output\n']) {
      assert.equal(parse(text).testComplete, false, text);
      assert.equal(parse(text).ok, false, text);
    }
  }
});
