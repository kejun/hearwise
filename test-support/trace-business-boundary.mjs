import assert from 'node:assert/strict';
import { fullTraceFixture } from './full-trace-fixture.mjs';
import { traceReport } from './trace-business-fixture.mjs';
import { buildBusinessOverview } from '../dist/server/index.js';
import WebSocket from 'ws';
import { once } from 'node:events';
import { speechFixture } from './speech-fixture.mjs';
import { until } from './full-trace-fixture.mjs';
import { deadline } from './lifecycle.mjs';

export async function runFullTraceComparison() {
  const actual = await fullTraceFixture({ observations: true });
  const report = traceReport(actual.logs), business = buildBusinessOverview(report, actual.listeningId);
  return checkFullTraceComparison(actual, report, business);
}
export function checkFullTraceComparison(actual, report, business) {
  assert.equal(report.completeness, 'unknown', 'A stdout capture has no end manifest, even if all queried work settled');
  assert.deepEqual(report.issues, []); assert.equal(actual.cleanup, true);
  assert.doesNotMatch(JSON.stringify(report), /TRACE_SECRET_KEY|PRIVATE_TRACE_TRANSCRIPT|PRIVATE_PREVIEW_TEXT/);
  const byDomain = name => business.tasks.filter(task => task.domain === name);
  const translated = actual.durable.segments.filter(row => row.run_id === actual.runId);
  assert.equal(translated.length, 1); assert.equal(translated[0].translation_state, 'complete');
  const translation = byDomain('translation');
  assert.equal(translation.length, 1); assert.equal(translation[0].job, translated[0].id);
  assert.equal(translation[0].state, 'succeeded'); assert.equal(translation[0].calls, 1);
  assert.deepEqual(translation[0].segments, [translated[0].id]);
  assert.ok(actual.asrEvents.some(event => event.type === 'translation-updated' && event.segment.id === translated[0].id &&
    event.segment.translation_text === translated[0].translation_text));
  const knowledge = byDomain('knowledge'), jobs = actual.durable.extraction_jobs.filter(job => job.id !== actual.seededJobId);
  assert.equal(jobs.length, 1); assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].job, jobs[0].id); assert.equal(jobs[0].state, 'complete'); assert.equal(jobs[0].outcome, 'empty');
  assert.equal(knowledge[0].state, 'succeeded'); assert.match(knowledge[0].activity, /结果为空/);
  const relations = byDomain('relation');
  assert.ok(relations.length >= 1); assert.equal(relations.length, actual.durable.relation_jobs.length);
  for (const task of relations) {
    const job = actual.durable.relation_jobs.find(row => row.id === task.job);
    assert.equal(job.state, 'complete'); assert.equal(task.state, 'succeeded'); assert.equal(task.calls, job.request_count);
  }
  assert.equal(actual.graph.status.state, 'empty'); assert.equal(actual.graph.relations.length, 0);
  const speech = byDomain('speech'), sessions = speech.filter(task => task.session), units = speech.filter(task => !task.session);
  assert.equal(sessions.length, 2); assert.ok(units.length >= 2);
  for (const task of speech) assert.equal(task.state, 'succeeded');
  const ends = [...actual.speechEvents, ...actual.fishEvents].filter(event => event.type === 'speech.unit-end');
  assert.equal(units.length, ends.length); assert.equal(actual.provider.qwen + actual.provider.fish, units.length);
  assert.ok(ends.every(end => actual.frames.some(frame => frame.unit === end.unit && frame.epoch === end.epoch)));
  const events = report.spans.flatMap(span => span.events), played = events.filter(event => event.event === 'playback_completed');
  assert.equal(played.length, units.length); assert.ok(played.every(event => event.attributes.evidence_source === 'client_report'));
  assert.equal(new Set(played.map(event => event.span_id)).size, units.length);
  assert.equal(business.domains.find(row => row.key === 'speech').played, units.length);
  assert.equal(business.domains.find(row => row.key === 'speech').objectCount, units.length);
  assert.equal(report.spans.filter(span => ['translation.http', 'knowledge.http', 'relation.http'].includes(span.step)).length,
    actual.provider.mt + actual.provider.knowledge);
  const unowned = buildBusinessOverview(report, 'unknown');
  assert.equal(unowned.tasks.length, 1); assert.equal(unowned.tasks[0].domain, 'translation');
  assert.equal(unowned.tasks[0].purpose, '预览 / 试听');
  return { name: 'full-public-boundary', complete: true, ok: true, cleanup: true, actual, report, business, unowned };
}

export async function runSpeechTraceComparison({ failed = false } = {}) {
  const f = await speechFixture({ fishStatus: failed ? 401 : 200, seed(store) {
    const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'tab' }, 'Trace speech ownership');
    const segment = store.addSegment(run.listeningId, run.runId, { id: 'speech', text: 'Atlas launched Nova.' }).segment;
    store.setTranslation(segment.id, '这是唯一一句。'); store.finishRun(run.runId); return { ...run, segment };
  } });
  const sockets = [], observations = [];
  const get = async () => (await fetch(`${f.base}/api/listenings/${f.seeded.listeningId}/segments?ids=${f.seeded.segment.id}`)).json();
  const connect = async () => {
    const ws = new WebSocket(f.base.replace('http', 'ws') + '/ws/tts'), events = [];
    sockets.push(ws); ws.on('error', () => {}); ws.on('message', (raw, binary) => { if (!binary) events.push(JSON.parse(raw)); });
    await deadline(() => once(ws, 'open'), 2000, 'Trace speech connect');
    return { ws, events, send: value => ws.send(JSON.stringify(value)) };
  };
  const input = epoch => ({ type: 'speech.replay', epoch, listeningId: f.seeded.listeningId, runId: f.seeded.runId, segmentId: f.seeded.segment.id,
    config: failed ? { provider: 'fish', key: 'TRACE_SECRET_KEY', model: 's2.1-pro-free', referenceId: 'voice', rate: 1, latency: 'balanced' } :
      { key: 'TRACE_SECRET_KEY', region: 'beijing', voice: 'Cherry', rate: 1 } });
  let result;
  try {
    const before = await get(), first = await connect(); first.send(input(31));
    if (failed) {
      await deadline(() => once(first.ws, 'close'), 4000, 'Failed speech close');
      assert.equal(first.events.at(-1).type, 'speech.error'); assert.equal(f.stats.fishRequests.length, 1);
    } else {
      await until(() => first.events.some(event => event.type === 'speech.unit-end'));
      const closed = once(first.ws, 'close'); first.send({ type: 'speech.stop', epoch: 31 });
      await deadline(() => closed, 2000, 'Cancelled speech close');
      const second = await connect(); second.send(input(32));
      await until(() => second.events.some(event => event.type === 'speech.unit-end'));
      const end = second.events.find(event => event.type === 'speech.unit-end');
      second.send({ type: 'speech.progress', epoch: 31, playedUnit: end.unit, consumedSamples: end.samples });
      // A valid same-generation pause is a processing barrier after the old frame.
      second.send({ type: 'speech.pause', epoch: 32 }); await until(() => second.events.some(event => event.state === 'paused'));
      const rawInput = f.logs(), pending = traceReport(rawInput), tasks = buildBusinessOverview(pending, f.seeded.listeningId).tasks;
      assert.equal(tasks.filter(task => !task.session && task.state === 'cancelled').length, 1);
      assert.equal(tasks.filter(task => !task.session && task.state === 'unknown').length, 1);
      assert.equal(pending.spans.flatMap(span => span.events).filter(event => event.event === 'playback_completed').length, 0);
      observations.push({ stage: 'old progress ignored', rawInput, report: pending, tasks });
      second.send({ type: 'speech.resume', epoch: 32 });
      const progress = { type: 'speech.progress', epoch: 32, playedUnit: end.unit, consumedSamples: end.samples };
      const closedNext = once(second.ws, 'close'); second.send(progress); second.send(progress);
      await deadline(() => closedNext, 3000, 'New speech complete');
      assert.equal(second.events.at(-1).type, 'speech.finished'); assert.equal(f.stats.commits.length, 2);
      observations.push({ stage: 'new consumer completed', events: second.events });
    }
    await until(() => traceReport(f.logs()).spans.filter(span => span.step === 'speech.session').every(span => span.ownState !== 'unknown'));
    const after = await get(); assert.deepEqual(after, before, 'Speech execution cannot rewrite the durable source/translation');
    const rawInput = f.logs(), report = traceReport(rawInput), business = buildBusinessOverview(report, f.seeded.listeningId);
    const units = business.tasks.filter(task => !task.session), sessions = business.tasks.filter(task => task.session);
    assert.deepEqual(units.map(task => task.state).sort(), failed ? ['failed'] : ['cancelled', 'succeeded']);
    assert.deepEqual(sessions.map(task => task.state).sort(), failed ? ['failed'] : ['cancelled', 'succeeded']);
    assert.equal(business.domains.find(row => row.key === 'speech').played, failed ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(report), /TRACE_SECRET_KEY/);
    result = { name: failed ? 'speech-failed' : 'speech-cancel-old-progress', complete: true, ok: true,
      before, after, observations, firstEvents: first.events, rawInput, report, business,
      provider: { qwen: f.stats.commits.length, fish: f.stats.fishRequests.length } };
  } finally { for (const ws of sockets) ws.terminate(); await f.close(); }
  return { ...result, cleanup: true };
}

export async function runTranslationTraceRecovery() {
  let fail = true;
  const f = await speechFixture({ modelResponse: body => body.model === 'qwen-mt-flash' ? fail ? '' : '恢复后的唯一译文。' : { items: [] } });
  const ws = new WebSocket(f.base.replace('http', 'ws') + '/ws'), events = [];
  ws.on('error', () => {}); ws.on('message', raw => events.push(JSON.parse(raw)));
  let result;
  try {
    await deadline(() => once(ws, 'open'), 2000, 'Translation Trace connect');
    ws.send(JSON.stringify({ type: 'start', key: 'TRACE_SECRET_KEY', source: 'en', targetLang: 'Chinese', audioSource: 'tab' }));
    await until(() => events.some(event => event.type === 'listening-ready'));
    const { listeningId } = events.find(event => event.type === 'listening-ready');
    f.final('Trace translation recovery.', true, 'recovery');
    await until(() => events.some(event => event.type === 'translation-updated'));
    const segmentId = events.find(event => event.type === 'segment-final').segment.id;
    const get = async () => (await fetch(`${f.base}/api/listenings/${listeningId}/segments?ids=${segmentId}`)).json();
    await until(() => traceReport(f.logs()).spans.some(span => span.step === 'translation.execute' && span.ownState === 'failed'));
    const failed = { query: await get(), rawInput: f.logs() }; failed.report = traceReport(failed.rawInput);
    assert.equal(failed.query.items[0].translation_state, 'failed'); assert.equal(f.stats.mtRequests.length, 1);
    assert.equal(buildBusinessOverview(failed.report, listeningId).tasks.find(task => task.domain === 'translation').state, 'failed');
    const stopped = once(ws, 'close'); ws.send(JSON.stringify({ type: 'stop' })); await deadline(() => stopped, 3000, 'Translation ASR stop');
    fail = false;
    const retry = await fetch(`${f.base}/api/listenings/${listeningId}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'TRACE_SECRET_KEY' }) });
    assert.equal(retry.status, 202);
    await until(() => traceReport(f.logs()).spans.some(span => span.step === 'translation.execute' && span.ownState === 'succeeded'));
    const recovered = { query: await get(), rawInput: f.logs() }; recovered.report = traceReport(recovered.rawInput);
    assert.equal(recovered.query.items[0].translation_state, 'complete'); assert.equal(recovered.query.items[0].translation_text, '恢复后的唯一译文。');
    const tasks = buildBusinessOverview(recovered.report, listeningId).tasks.filter(task => task.domain === 'translation');
    assert.equal(tasks.length, 1); assert.equal(tasks[0].job, segmentId); assert.equal(tasks[0].state, 'recovered');
    assert.equal(tasks[0].calls, 2); assert.equal(f.stats.mtRequests.length, 2); assert.equal(tasks[0].spanIds.length, 2);
    assert.doesNotMatch(JSON.stringify(recovered.report), /TRACE_SECRET_KEY/);
    result = { name: 'translation-failure-retry', complete: true, ok: true, listeningId, segmentId, failed, recovered, calls: f.stats.mtRequests.length };
  } finally { ws.terminate(); await f.close(); }
  return { ...result, cleanup: true };
}
