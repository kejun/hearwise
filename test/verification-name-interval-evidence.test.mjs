import test from 'node:test';
import assert from 'node:assert/strict';
import { gate, profile, requiredSteps, requiredArtifacts } from '../verification/name-interval/profile.mjs';

const source = { sha: 'a'.repeat(40), dirty: false };
const success = { code: 0, signal: null, timedOut: false, interrupted: false, ok: true };
function valid() {
  return { schemaVersion: 1, profileVersion: 1, profileDigest: 'frozen-profile', source, sourceDigests: { 'fixture.mjs': 'c'.repeat(64) }, finalSourceDigests: { 'fixture.mjs': 'c'.repeat(64) },
    startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z', complete: true, interrupted: false,
    tools: { lean: `Lean (version ${profile.lean}, commit ${profile.leanCommit})`, lake: `Lake (Lean version ${profile.lean})`, node: 'v24', sqlite: 'sqlite' },
    environment: { platform: 'linux', arch: 'x64', release: 'fixture' },
    steps: requiredSteps.map(name => ({ name, status: 'passed', execution: { ...success } })),
    implementation: { tests: 9, passed: 9, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
    differential: { complete: true, ok: true, seed: profile.seed, generatedBaseSamples: 256,
      samples: 296, anchors: 10333, sqliteCases: 81, sqliteAnchors: 3675,
      sqliteReopened: true, staleSupportsUnchanged: true, unlinkedSegmentsUnchanged: true, otherListeningsUnchanged: true,
      collision: { publicCommitAccepted: true, code: 'ERR_SQLITE_ERROR', constraint: 'UNIQUE', unchanged: true, receiptAbsent: true },
      importedInvalid: Array.from({ length: 12 }, () => ({ imported: true, status: 409, unchanged: true, reopened: true, receiptAbsent: true })),
      invalid: Array.from({ length: 13 }, (_, id) => ({ id })), mutations: [{ detected: true }],
      invalidOracle: Array.from({ length: 12 }, (_, index) => ({ id: String(index), rejected: true,
        execution: { ...success, code: 1, ok: false } })) },
    artifacts: requiredArtifacts.map(path => ({ path, sha256: 'a'.repeat(64) })) };
}
const options = { target: source, release: true, artifactsValid: true, profileDigest: 'frozen-profile' };
test('name interval evidence requires complete proof, actual regressions, SQLite witness and declared scope', () => {
  assert.equal(gate(valid(), options).ok, true);
  const changes = [r => delete r.finalSourceDigests, r => r.finalSourceDigests['fixture.mjs'] = 'd'.repeat(64),
    r => delete r.finalSourceDigests['fixture.mjs'], r => r.steps.pop(), r => r.steps.push(r.steps[0]), r => r.steps[0].status = 'not_run',
    r => r.steps[0].execution.code = 1, r => r.steps[0].execution.timedOut = true,
    r => r.steps[0].execution.interrupted = true, r => r.steps[0].execution.signal = 'SIGTERM',
    r => r.complete = false, r => r.interrupted = true, r => r.source = { sha: 'b'.repeat(40), dirty: false },
    r => r.source = { ...source, dirty: true }, r => r.profileDigest = 'changed',
    r => r.tools.lean = 'Lean (version 4.34.0)', r => delete r.environment,
    r => r.implementation.tests = 0, r => r.implementation.skipped = 1,
    r => r.differential.samples--, r => r.differential.anchors--, r => r.differential.sqliteCases--,
    r => r.differential.sqliteAnchors--, r => r.differential.sqliteReopened = false,
    r => r.differential.staleSupportsUnchanged = false, r => r.differential.unlinkedSegmentsUnchanged = false,
    r => r.differential.otherListeningsUnchanged = false, r => r.differential.invalid.pop(), r => r.differential.seed++, r => r.differential.mutations[0].detected = false,
    r => delete r.differential.collision, r => r.differential.collision.unchanged = false,
    r => r.differential.importedInvalid.pop(), r => r.differential.importedInvalid[0].unchanged = false,
    r => r.differential.invalidOracle.pop(), r => r.differential.invalidOracle[0].execution.code = 0,
    r => r.differential.invalidOracle[0].execution.timedOut = true,
    r => r.artifacts = r.artifacts.filter(a => a.path !== 'sqlite-witness.sqlite'),
    r => r.startedAt = null, r => r.finishedAt = '2020-01-01'];
  for (const mutate of changes) { const report = valid(); mutate(report); assert.equal(gate(report, options).ok, false, String(mutate)); }
  assert.equal(gate(valid(), { ...options, artifactsValid: false }).ok, false);
});
