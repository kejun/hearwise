import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { compareBoundedDirectories, boundedLimitMs } from './lib/performance-bounded.mjs';
const [argument, flag, ...extra] = process.argv.slice(2);
if (!argument || extra.length || (flag && flag !== '--collecting')) throw new Error('Usage: node scripts/verify-performance-bounded.mjs PAIR_DIRECTORY [--collecting]');
const directory = path.resolve(argument), report = JSON.parse(await readFile(path.join(directory, 'pair.json'), 'utf8'));
const local = relative => {
  assert.ok(typeof relative === 'string' && relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'));
  return path.join(directory, relative);
};
let result;
try {
  assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'bounded-performance-pair');
  assert.equal(report.timeoutMs, boundedLimitMs);
  const policy = JSON.parse(await readFile(local(report.policy), 'utf8'));
  result = await compareBoundedDirectories(local(report.baseline), local(report.candidate), policy);
  if (!flag) {
    assert.equal(report.complete, true); assert.equal(report.interrupted, false);
    assert.ok(Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.finishedAt)));
    assert.ok(Date.parse(report.finishedAt) >= Date.parse(report.startedAt) && Date.parse(report.finishedAt) - Date.parse(report.startedAt) <= boundedLimitMs + 1000);
    const expected = ['build-baseline', ...(report.stages.some(row => row.id === 'build-candidate') ? ['build-candidate'] : []), 'prepare', 'baseline', 'verify-baseline', 'candidate', 'verify-candidate', 'compare'];
    assert.deepEqual(report.stages.map(row => row.id), expected);
    let previous = Date.parse(report.startedAt);
    for (const row of report.stages) {
      assert.equal(row.execution.ok, true); assert.equal(row.execution.code, 0); assert.equal(row.execution.signal, null);
      assert.equal(row.execution.timedOut, false); assert.equal(row.execution.interrupted, false);
      assert.ok(Date.parse(row.startedAt) >= previous && Date.parse(row.finishedAt) >= Date.parse(row.startedAt));
      previous = Date.parse(row.finishedAt);
      assert.ok(row.timeoutMs > 0 && row.timeoutMs <= boundedLimitMs);
    }
    assert.ok(previous <= Date.parse(report.finishedAt));
    assert.deepEqual(report.comparison, result, 'Pair summary differs from independent raw evidence comparison');
    assert.equal(report.performanceEvaluated, result.performanceEvaluated);
    assert.equal(report.performancePassed, result.passed);
    assert.equal(report.exitCode, result.performanceEvaluated && !result.passed ? 1 : 0);
  }
} catch (error) { result = { evidenceValid: false, comparable: false, performanceEvaluated: false, passed: false, reason: 'invalid_pair_evidence', detail: error.message }; }
console.log(JSON.stringify(result));
// Internal collecting mode returns evidence validity, not a performance verdict.
// Default independently checks the completed pair and fails approved regressions.
process.exitCode = !result.evidenceValid ? 3 : !flag && result.performanceEvaluated && !result.passed ? 1 : 0;
