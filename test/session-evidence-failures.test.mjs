// Synthetic execution outcomes test evidence classification, not actual ASR/MT/UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metadata } from '../scripts/lib/verification-evidence.mjs';
import { sessionProfile } from '../verification/session-properties.mjs';
import { sessionTapSummary, runSessionChecks, summarizeSessionResults } from '../test-support/session-evidence.mjs';

const outcome = (changes = {}) => ({ code: 0, signal: null, ok: true, timedOut: false, interrupted: false, ...changes });
test('session properties preserve independently passed checks after browser/caption/source failure', async () => {
  const context = await metadata(), time = new Date().toISOString();
  for (const [failed, expected] of [['browser', ['passed', 'failed', 'failed', 'failed', 'failed']],
    ['caption-frontier', ['passed', 'passed', 'passed', 'failed', 'passed']],
    ['identity-and-source', ['failed', 'passed', 'failed', 'passed', 'passed']]]) {
    const results = sessionProfile.map((id, i) => ({ ...context, property: { id, version: 1 },
      startedAt: time, finishedAt: time, complete: true, status: expected[i],
      scope: { description: 'Synthetic session execution gate', scenario: 'unit-test', samples: 1, seed: null },
      artifacts: ['observations.json', 'worker.log'].map(path => ({ path, sha256: '0'.repeat(64) })) }));
    const checks = ['identity-and-source', 'caption-frontier', 'browser'].map(name => ({ name,
      execution: outcome(name === failed ? { code: 1, ok: false } : {}) }));
    const { execution, summary } = summarizeSessionResults({ results, checks, target: context.source,
      required: sessionProfile, artifactsValid: results.map(() => true), release: false, sourceStable: true });
    assert.equal(execution.code, 1); assert.equal(summary.ok, false);
    assert.deepEqual(summary.rows.map(row => row.status), expected, failed);
  }
});

test('session TAP requires actual complete passing coverage', () => {
  const tap = ({ tests = 2, pass = 2, fail = 0, cancelled = 0, skipped = 0, todo = 0 } = {}) =>
    `1..${tests}\n` + Object.entries({ tests, suites: 0, pass, fail, cancelled, skipped, todo, duration_ms: 1 }).map(([key, value]) => `# ${key} ${value}\n`).join('');
  assert.equal(sessionTapSummary(tap()).ok, true);
  for (const text of [tap({ pass: 0, skipped: 2 }), tap({ pass: 0, todo: 2 }), tap().replace('# pass 2\n', ''),
    tap({ pass: 1 }), tap({ pass: 1, cancelled: 1 }), tap({ tests: 0, pass: 0 })]) {
    assert.equal(sessionTapSummary(text).ok, false, text);
    assert.equal(sessionTapSummary(text).testComplete, false, text);
  }
});

test('session timeout stops later checks and the shared deadline reserves parent cleanup/report headroom', async () => {
  const specifications = [{ name: 'identity-and-source', timeoutMs: 30000 }, { name: 'caption-frontier', timeoutMs: 30000 }, { name: 'browser', timeoutMs: 100000 }];
  const calls = []; let cleaned = false;
  await runSessionChecks(specifications, async specification => { calls.push(specification.name); return outcome({ ok: false, code: null, timedOut: true }); },
    { cleanup: async () => { cleaned = true; } });
  assert.deepEqual(calls, ['identity-and-source']); assert.equal(cleaned, true);
  let time = 0; const allowances = [];
  await runSessionChecks(specifications, async (_specification, timeoutMs) => {
    allowances.push(timeoutMs); time += timeoutMs; return outcome();
  }, { now: () => time });
  assert.deepEqual(allowances, [30000, 30000, 90000]);
});

test('session scoped gate accepts complete coverage but rejects missing dispatch and source changes', async () => {
  const context = await metadata(), time = new Date().toISOString();
  const results = sessionProfile.map(id => ({ ...context, property: { id, version: 1 }, startedAt: time, finishedAt: time,
    complete: true, status: 'passed', scope: { description: 'Synthetic gate only', scenario: 'unit-test', samples: 1, seed: null },
    artifacts: ['observations.json', 'worker.log'].map(path => ({ path, sha256: '0'.repeat(64) })) }));
  const checks = ['identity-and-source', 'caption-frontier', 'browser'].map(name => ({ name, execution: outcome() }));
  const options = { results, checks, target: context.source, required: sessionProfile, artifactsValid: results.map(() => true),
    release: false, sourceStable: true };
  assert.equal(summarizeSessionResults(options).summary.ok, true);
  const missing = summarizeSessionResults({ ...options, checks: checks.slice(0, 1) });
  assert.equal(missing.execution.complete, false); assert.equal(missing.summary.ok, false);
  assert.deepEqual(missing.summary.rows.map(row => row.status), ['passed', 'incomplete', 'incomplete', 'incomplete', 'incomplete']);
  const changed = summarizeSessionResults({ ...options, sourceStable: false });
  assert.equal(changed.execution.complete, false); assert.equal(changed.summary.ok, false);
  assert.ok(changed.summary.rows.every(row => row.status === 'incomplete'));
});
