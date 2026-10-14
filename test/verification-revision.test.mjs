import test from 'node:test';
import assert from 'node:assert/strict';
import { gate, profile, requiredSteps, requiredArtifacts } from '../verification/revision/profile.mjs';
import { baseline, referenceJSON, transport, corpus } from '../verification/revision/corpus.mjs';
import { knowledgeRevision } from '../knowledge-revision.mjs';

const source = { sha: 'a'.repeat(40), dirty: false };
function valid() {
  return { schemaVersion: 1, profileVersion: 1, profileDigest: 'profile-digest', source,
    startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z', complete: true, interrupted: false,
    tools: { lean: `Lean (version ${profile.lean}, commit ${profile.leanCommit})`, lake: `Lake (Lean version ${profile.lean})`, node: 'v24', sqlite: 'sqlite' },
    environment: { platform: 'linux', arch: 'x64', release: 'fixture' },
    steps: requiredSteps.map(name => ({ name, status: 'passed', execution: { code: 0, signal: null, timedOut: false, interrupted: false, ok: true } })),
    legacy: { tests: 8, passed: 8, failed: 0, cancelled: 0, skipped: 0, todo: 0, tapComplete: true },
    differential: { complete: true, ok: true, seed: profile.seed, generatedBaseSamples: 256, samples: 662, pairs: 298,
      groups: { sqlite: 5, field: 40 }, mutations: [{ detected: true }, { detected: true }, { detected: true }] },
    artifacts: requiredArtifacts.map(path => ({ path, sha256: 'a'.repeat(64) })) };
}
const options = { target: source, release: true, artifactsValid: true, profileDigest: 'profile-digest' };
test('revision evidence gate requires proof, audit, differential, frozen compatibility and complete artifacts', () => {
  assert.equal(gate(valid(), options).ok, true);
  const mutations = [
    r => r.steps.pop(), r => r.steps.push(r.steps[0]), r => r.steps[0].status = 'not_run',
    r => r.steps[0].execution.code = 1, r => r.steps[0].execution.timedOut = true,
    r => r.steps[0].execution.interrupted = true, r => r.steps[0].execution.signal = 'SIGTERM',
    r => r.complete = false, r => r.interrupted = true, r => r.source = { sha: 'b'.repeat(40), dirty: false },
    r => r.source = { ...source, dirty: true }, r => r.profileDigest = 'changed',
    r => r.tools.lean = 'Lean (version 4.34.0)', r => r.tools.lake = 'wrong', r => delete r.environment,
    r => r.differential.samples--, r => r.differential.groups.sqlite = 0, r => r.differential.seed++,
    r => r.differential.mutations[0].detected = false, r => r.artifacts.pop(),
    r => r.legacy.tapComplete = false, r => delete r.legacy.tapComplete, r => { r.legacy.tests = 7; r.legacy.passed = 7; }, r => r.legacy.tests = 0, r => r.legacy.skipped = 1, r => delete r.legacy,
    r => r.startedAt = null, r => r.finishedAt = '2020-01-01'
  ];
  for (const change of mutations) { const report = valid(); change(report); assert.equal(gate(report, options).ok, false, String(change)); }
  assert.equal(gate(valid(), { ...options, artifactsValid: false }).ok, false);
});
test('declared differential scope and domain cannot silently shrink or admit lossy numbers', () => {
  const generated = corpus();
  assert.equal(generated.cases.length + 5, 662);
  assert.equal(generated.pairs.length, 298);
  for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, 1n]) {
    const snapshot = baseline(); snapshot.item.policy_version = value;
    assert.throws(() => transport(snapshot), /Outside Lean domain/);
  }
  const snapshot = baseline(); snapshot.item.aliases = [undefined];
  assert.throws(() => transport(snapshot), /aliases must be strings/);
  const duplicate = baseline(), removed = baseline(); removed.item.aliases.splice(2, 1);
  assert.notEqual(referenceJSON(duplicate), referenceJSON(removed), 'multiplicity is not set equality');
  assert.notEqual(knowledgeRevision(duplicate), knowledgeRevision(removed));
});

test('bridge rejects non-enumerable fields, accessors and sparse arrays instead of misprojecting them', () => {
  const hidden = baseline();
  Object.defineProperty(hidden.item, 'background_note', { value: 'hidden', enumerable: false });
  assert.throws(() => transport(hidden), /own enumerable data properties/);
  assert.notEqual(knowledgeRevision(hidden), knowledgeRevision(baseline()));
  const getter = baseline(); let calls = 0;
  Object.defineProperty(getter.item, 'background_note', { get: () => { calls++; return 'value'; }, enumerable: true });
  assert.throws(() => transport(getter), /own enumerable data properties/);
  assert.equal(calls, 0, 'reject before invoking business getters');
  for (const group of ['aliases', 'mentions', 'revisions', 'facts', 'segments']) {
    const sparse = baseline();
    (group === 'segments' ? sparse : sparse.item)[group] = Array(2);
    assert.throws(() => transport(sparse), /dense plain array/);
  }
});
