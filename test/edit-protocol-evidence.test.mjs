import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { editTraceContract, decodeEditITF, normalizeEditTrace, validateEditProjection, replayEditTrace, expectedEditMutationViolation } from '../scripts/lib/edit-protocol-replay.mjs';
import { editConfig, editProtocolMetadata, editProtocolPlan, editProtocolCoverage, checkerConclusion, validateEditProtocolEvidence } from '../scripts/lib/edit-protocol-evidence.mjs';
import { writeJson } from '../scripts/lib/verification-evidence.mjs';
const config = { clients: 1, codecs: { 0: 'v1' }, initialOverride: false, background: true };
function initial() {
  const value = { revision: 0, name: 0, override: false, serverOwner: -1, backgroundDone: false };
  for (const field of editTraceContract.clientMaps) value[field] = { 0: field === 'phase' ? 'closed' :
    ['userSaves', 'requests'].includes(field) ? 0 : field === 'commitBaseOverride' ? false :
      ['loadedRevision', 'loadedName', 'draft', 'submittedRevision', 'submittedName', 'commitBaseRevision'].includes(field) ? -1 : 'none' };
  return value;
}
const raw = states => ({ vars: ['m::state', 'm::lastAction', 'm::actor', 'm::argument'], states: states.map(({ value, action = 'init', actor = -1, argument = '' }) =>
  ({ 'm::state': value, 'm::lastAction': action, 'm::actor': actor, 'm::argument': argument })) });
const traceWith = expected => normalizeEditTrace(raw([{ value: initial() }, { value: expected, action: 'read', actor: 0 }]), config);
const loaded = () => ({ ...initial(), phase: { 0: 'loaded' }, loadedRevision: { 0: 0 }, loadedName: { 0: 0 }, draft: { 0: 0 } });

test('edit ITF decodes records and maps without coercing unsafe or duplicate keys', () => {
  assert.deepEqual(decodeEditITF({ field: { '#map': [[{ '#bigint': '0' }, { '#bigint': '-1' }]] } }), { field: { 0: -1 } });
  for (const value of [{ '#bigint': '9007199254740993' }, { '#bigint': '1', extra: 0 }, { '#map': [[0, 1], [0, 2]] },
    { '#map': [['client', 1]] }, { '#map': [[0]] }, { '#set': [] }, []]) assert.throws(() => decodeEditITF(value));
});
test('normalizer preserves Quint projections and rejects missing, ambiguous, malformed or unsupported trace states', () => {
  assert.equal(validateEditProjection(initial(), config), true);
  const trace = traceWith(loaded()); assert.deepEqual(trace.steps[0].expected, loaded());
  assert.deepEqual(trace.config, config); assert.equal(trace.domain, 'edit-protocol');
  for (const mutate of [itf => itf.vars.push('other::state'), itf => delete itf.states[0]['m::actor'],
    itf => itf.states[1]['m::lastAction'] = 'invented', itf => itf.states[1]['m::actor'] = 7,
    itf => itf.states[1]['m::state'].phase[0] = 'impossible', itf => itf.states[1]['m::state'].requests[1] = 0,
    itf => itf.states[0]['m::state'].override = true, itf => itf.states[1]['m::state'].extra = 'unmodeled']) {
    const itf = raw([{ value: initial() }, { value: loaded(), action: 'read', actor: 0 }]); mutate(itf);
    assert.throws(() => normalizeEditTrace(itf, config));
  }
});
test('driver unit double checks every expected state and captures first divergence, not a synthesized pass', async () => {
  const trace = traceWith(loaded()); let actual = initial(), closes = 0;
  const create = async () => ({ project: () => actual, observe: () => ({ fixture: 'unit-double-only' }), check: () => [],
    act: () => { actual = loaded(); }, close: () => { closes++; } });
  const good = await replayEditTrace(trace, create); assert.equal(good.classification, 'matched'); assert.equal(good.observations.length, 2); assert.equal(closes, 1);
  const bad = await replayEditTrace(trace, async () => ({ ...await create(), project: () => initial() }));
  assert.equal(bad.classification, 'implementation_mismatch'); assert.equal(bad.complete, true); assert.equal(bad.ok, false);
  assert.equal(bad.difference.step, 0); assert.equal(bad.counterexample.steps.length, 1);
});
test('driver treats unavailable operations, deadline and failed cleanup as unreplayable', async () => {
  const trace = traceWith(loaded());
  const base = { project: initial, observe: () => ({}), check: () => [], close() {} };
  const thrown = await replayEditTrace(trace, async () => ({ ...base, act() { throw new Error('Unavailable fixture'); } }));
  assert.equal(thrown.classification, 'unreplayable'); assert.equal(thrown.complete, false);
  const timed = await replayEditTrace(trace, async () => ({ ...base, act: () => new Promise(() => {}) }), { stepTimeoutMs: 5 });
  assert.equal(timed.classification, 'unreplayable'); assert.match(timed.error.message, /edit action/);
  const cleanup = await replayEditTrace(trace, async () => ({ ...base, act() {}, close() { throw new Error('Still running'); } }));
  assert.equal(cleanup.classification, 'unreplayable'); assert.equal(cleanup.complete, false); assert.equal(cleanup.cleanupError, 'Still running');
});
test('model-negative acceptance requires its intended invariant, not merely an error exit', () => {
  const invalidCommit = { ...loaded(), revision: 1, submittedRevision: { 0: 0 }, submittedName: { 0: 1 },
    commitBaseRevision: { 0: 1 }, txResult: { 0: 'committed' }, receipt: { 0: 'succeeded' }, userSaves: { 0: 1 }, requests: { 0: 1 } };
  const itf = raw([{ value: initial() }, { value: invalidCommit, action: 'transaction', actor: 0, argument: 'ok' }]);
  assert.equal(expectedEditMutationViolation('mutant_bypass_revision', itf, config).ok, true);
  assert.equal(expectedEditMutationViolation('mutant_auto_revision_resend', itf, config).ok, false);
  const resend = { ...loaded(), requests: { 0: 2 }, userSaves: { 0: 1 } };
  assert.equal(expectedEditMutationViolation('mutant_auto_revision_resend', raw([{ value: initial() }, { value: resend, action: 'automatic_resend', actor: 0 }]), config).ok, true);
});
test('formal completion needs genuine complete logs, bounded depth, and strict unambiguous TAP footer', () => {
  const execution = { code: 0, signal: null, timedOut: false, interrupted: false };
  const tlc = 'Model checking completed. No error has been found.\n100 states generated, 80 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 24.';
  assert.equal(checkerConclusion('finite-state-complete', execution, tlc).ok, true);
  assert.equal(checkerConclusion('finite-state-complete', execution, tlc.replace('0 states left', '2 states left')).ok, false);
  assert.equal(checkerConclusion('finite-state-complete', { ...execution, timedOut: true }, tlc).complete, false);
  assert.equal(checkerConclusion('bounded-model-check', execution, 'Step 5:\nThe outcome is: NoError\n[ok] No violation found', 6).ok, false);
  const footer = 'TAP version 13\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n';
  assert.equal(checkerConclusion('implementation-regression', execution, footer).ok, true);
  assert.equal(checkerConclusion('implementation-regression', execution, '# pass 9\n' + footer).ok, false);
  assert.equal(checkerConclusion('model-negative', { ...execution, code: 1 }, 'Parser failure').ok, false);
});
test('evidence gate rejects cached passing claims with absent results, stale source and missing raw artifacts', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-edit-gate-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await validateEditProtocolEvidence(directory)).ok, false);
  const context = await editProtocolMetadata(), domain = await editConfig(), now = new Date().toISOString();
  await writeJson(path.join(directory, 'report.json'), { ...context, source: { ...context.source, sha: '0'.repeat(40) },
    startedAt: now, finishedAt: now, config: domain, propertyCoverage: editProtocolCoverage(domain), ok: true, complete: true,
    execution: { complete: true, code: 0, signal: null, timedOut: false, interrupted: false }, results: [], artifacts: [{ path: 'absent.log', sha256: '0'.repeat(64) }] });
  const summary = await validateEditProtocolEvidence(directory);
  assert.equal(summary.ok, false); assert.ok(summary.reasons.includes('stale')); assert.ok(summary.reasons.includes('missing_artifact'));
  assert.equal(summary.rows.length, editProtocolPlan(domain).length); assert.ok(summary.rows.every(row => row.status === 'not_run'));
  assert.equal(summary.fullProjectAcceptance, false);
});
