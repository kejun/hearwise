import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlaybackTrace, replayPlaybackTrace, createAuditedPlaybackAdapter, auditPlaybackObservation } from '../scripts/lib/playback-protocol-replay.mjs';
import { expectedPlaybackCounterexample } from '../scripts/lib/playback-protocol-evidence.mjs';
import { realPlaybackTraces } from './playback-protocol-fixtures.mjs';
let traces;
before(async () => { traces = await realPlaybackTraces(); });

test('every named Quint witness replays through actual controller/player/worklet/service/SQLite', async () => {
  assert.equal(traces.length, 19);
  for (const entry of traces) {
    const result = await replayPlaybackTrace(entry.trace);
    assert.equal(result.classification, 'matched', `${entry.file}: ${JSON.stringify(result.difference || result.error)}`);
    assert.equal(result.complete, true); assert.equal(result.ok, true); assert.equal(result.observations.length, entry.trace.steps.length + 1);
    for (const observation of result.observations) assert.deepEqual(auditPlaybackObservation(observation.durable, observation.actual, entry.trace.config), []);
  }
});
test('actual source-copy owner deletion diverges at the model ABA callback and yields a bound raw counterexample', async () => {
  const trace = traces.find(entry => entry.file.includes('normalSuccessTest-')).trace;
  const result = await replayPlaybackTrace(trace, config => createAuditedPlaybackAdapter({ ...config, mutation: 'old-player-callback' }));
  assert.equal(result.classification, 'implementation_mismatch'); assert.equal(result.complete, true); assert.equal(result.ok, false);
  assert.equal(expectedPlaybackCounterexample(result), true, JSON.stringify(result.difference));
});
test('raw projection audit rejects missing SQLite, altered accepted text and forged request owners', async () => {
  const trace = traces.find(entry => entry.file.includes('fullTextSuccessTest-')).trace;
  const result = await replayPlaybackTrace(trace), last = result.observations.at(-1);
  for (const mutate of [raw => { delete raw.records; }, raw => { raw.generations[0].incoming.find(row => row.type === 'speech.unit').text = '伪造'; },
    raw => { raw.generations[0].requests[0].generation = 3; }, raw => { raw.observed.generations[0].receivedSamples = 0; },
    raw => { raw.records.A.rows.pop(); }, raw => { delete raw.generations[0].player.buffer; }]) {
    const raw = structuredClone(last.durable); mutate(raw);
    assert.notDeepEqual(auditPlaybackObservation(raw, last.actual, trace.config), []);
  }
});
test('ITF rejects ambiguous namespaces, unsafe numbers, missing fields and a different owner domain', () => {
  const entry = traces.find(entry => entry.file.startsWith('single'));
  assert.throws(() => normalizePlaybackTrace(entry.itf, { owners: 3, maxPcm: 2 }), /domain/);
  for (const mutate of [itf => { itf.vars.push('other::active'); }, itf => { delete itf.states[0][itf.vars[0]]; },
    itf => { itf.states[0][itf.vars.find(name => name.endsWith('::created'))] = { '#bigint': '9007199254740992' }; }]) {
    const itf = structuredClone(entry.itf); mutate(itf); assert.throws(() => normalizePlaybackTrace(itf, entry.trace.config));
  }
});
test('unreplayable actions are not reported as matched and bounded cleanup permits the next fixture', async () => {
  const trace = structuredClone(traces.find(entry => entry.file.includes('fullTextSuccessTest-')).trace);
  trace.steps[0].choice = 'invalid-start'; const failed = await replayPlaybackTrace(trace);
  assert.equal(failed.classification, 'unreplayable'); assert.equal(failed.ok, false);
  assert.equal((await replayPlaybackTrace(traces[0].trace)).ok, true);
});

test('TLC label erasure leaves every business guard, update and invariant independent of trace labels', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('verification/playback-protocol/protocol.qnt', 'utf8');
  for (const line of source.split('\n').filter(line => /\bTRACK_ACTIONS\b/.test(line))) {
    assert.match(line, /^\s*(?:const TRACK_ACTIONS: bool|(?:lastAction|actor|choice)' = \(if \(TRACK_ACTIONS\))/);
  }
  const business = source.split('\n').filter(line => !/^\s*(?:(?:lastAction|actor|choice)' =|var (?:lastAction|actor|choice):)/.test(line)).join('\n');
  assert.doesNotMatch(business, /\b(?:lastAction|actor|choice)\b/);
});
test('TLC modules retain exactly the same constants and business transitions as their labelled counterparts', async () => {
  const { readFile } = await import('node:fs/promises');
  const labelled = await readFile('verification/playback-protocol/configurations.qnt', 'utf8');
  const erased = await readFile('verification/playback-protocol/complete.qnt', 'utf8');
  assert.equal(erased.replaceAll('_complete', '').replaceAll('TRACK_ACTIONS = false', 'TRACK_ACTIONS = true'), labelled);
});
test('cross-record modulo-2 alias witness includes old-provider completion and new-record full consumption', async () => {
  const trace = traces.find(entry => entry.file.includes('oldProviderAfterSwitchTest-')).trace;
  const last = trace.steps.at(-1).expected;
  assert.equal(last.epoch[1], last.epoch[2]); assert.equal(last.frames[1], 0); assert.equal(last.played[2], 2);
  assert.ok(trace.steps.some(step => step.action === 'pcm' && step.actor === 1 && step.expected.active === 2));
  assert.equal((await replayPlaybackTrace(trace)).ok, true);
});
