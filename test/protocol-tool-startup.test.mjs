import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { probeJavaVersion, JAVA_STARTUP_TIMEOUT_MS } from '../scripts/lib/relation-protocol-tools.mjs';

const java = process.env.JAVA_HOME_21_X64 ? path.join(process.env.JAVA_HOME_21_X64, 'bin/java') : 'java';
test('tool startup permits one bounded real Java launch delayed beyond the former five-second probe', { timeout: 15000 }, async () => {
  const script = `setTimeout(() => { const child = require('node:child_process').spawn(${JSON.stringify(java)}, ['-version'], {stdio:'inherit'}); child.on('error', () => process.exit(2)); child.on('exit', code => process.exit(code ?? 3)); }, 5500);`;
  const result = await probeJavaVersion({ command: process.execPath, args: ['-e', script] });
  assert.ok(result.major >= 21); assert.match(result.output, /version/);
  assert.equal(JAVA_STARTUP_TIMEOUT_MS, 30000);
  assert.equal(result.execution.timeoutMs, 30000); assert.ok(result.execution.durationMs >= 5500);
  assert.equal(result.execution.ok, true); assert.equal(result.execution.code, 0); assert.equal(result.execution.signal, null);
});
test('tool startup timeout remains a diagnostic failure and does not retry or look like an old Java version', async () => {
  const script = `console.log('JAVA_START_ATTEMPT');setInterval(()=>{},1000);`;
  await assert.rejects(probeJavaVersion({ command: process.execPath, args: ['-e', script], timeoutMs: 200 }), error => {
    assert.equal(error.code, 'JAVA_STARTUP_TIMEOUT');
    assert.equal(error.execution.timedOut, true); assert.equal(error.execution.ok, false);
    assert.equal(error.execution.timeoutMs, 200); assert.equal(error.execution.interrupted, false);
    assert.equal((error.execution.tail.match(/JAVA_START_ATTEMPT/g) || []).length, 1);
    assert.match(error.message, /startup probe timed out/); assert.doesNotMatch(error.message, /is required/);
    return true;
  });
});
for (const [name, output, exit] of [['old version', 'openjdk version "17.0.1"', 0], ['missing version', 'unknown runtime', 0], ['failed runtime', 'openjdk version "21.0.1"', 1]]) {
  test(`tool startup rejects ${name}`, async () => {
    await assert.rejects(probeJavaVersion({ command: process.execPath, args: ['-e', `console.error(${JSON.stringify(output)});process.exit(${exit})`] }), error => {
      assert.equal(error.code, exit ? 'JAVA_STARTUP_FAILED' : 'JAVA_VERSION_UNSUPPORTED');
      assert.equal(error.execution.timedOut, false); assert.match(error.execution.tail, /runtime|version/); return true;
    });
  });
}
