import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { graphFixture } from '../test-support/graph-fixture.mjs';
import { relationWireEnvelope } from '../test-support/relation-wire-fixture.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 7000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for realtime fixture event'); await pause(10); }
}
async function socket(t, url) {
  const ws = new WebSocket(url), events = [], pcm = [];
  ws.on('message', (raw, binary) => binary ? pcm.push(raw) : events.push(JSON.parse(raw.toString())));
  t.after(() => ws.terminate()); await once(ws, 'open');
  return { ws, events, pcm, send: event => ws.send(JSON.stringify(event)) };
}
for (const graphEnabled of [false, true]) test(`synthetic ${graphEnabled ? 'held relation request' : 'baseline'}: captions and two TTS units finish independently`, { timeout: 18000 }, async t => {
  let release, relationStarted = false, relationFinished = false;
  const held = new Promise(resolve => { release = resolve; });
  const fixture = await graphFixture({ translationDelay: 30, modelResponse: async body => {
    if (body.model === 'qwen-mt-flash') return undefined;
    const input = JSON.parse(body.messages.at(-1).content);
    if (!input.candidates) return { items: [] };
    relationStarted = true;
    await held;
    relationFinished = true;
    return relationWireEnvelope(input);
  } });
  t.after(async () => { release(); await fixture.close(); });
  if (graphEnabled) {
    assert.equal((await fetch(`${fixture.base}/api/listenings/${fixture.seeded.first.listeningId}/graph`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'mock-shared-key' }) })).status, 202);
    await until(() => relationStarted);
  }
  const asr = await socket(t, fixture.base.replace('http', 'ws') + '/ws');
  asr.send({ type: 'start', key: 'mock-shared-key', source: 'en', targetLang: 'Chinese', audioSource: 'tab' });
  await until(() => asr.events.some(e => e.type === 'listening-ready'));
  const run = asr.events.find(e => e.type === 'listening-ready');
  const speech = await socket(t, fixture.base.replace('http', 'ws') + '/ws/tts');
  speech.send({ type: 'speech.start', epoch: 51, listeningId: run.listeningId, runId: run.runId,
    incremental: false, config: { key: 'mock-shared-key', region: 'beijing', voice: 'Cherry', rate: 1 } });
  let samples = 0;
  speech.ws.on('message', (raw, binary) => {
    if (binary) return;
    const event = JSON.parse(raw.toString());
    if (event.type === 'speech.unit-end') {
      samples += event.samples;
      speech.send({ type: 'speech.progress', epoch: 51, playedUnit: event.unit, consumedSamples: samples });
    }
  });
  await until(() => speech.events.some(e => e.type === 'speech.ready'));
  const start = performance.now();
  fixture.final('Sentence 501.', true, 'first');
  await until(() => asr.events.some(e => e.type === 'segment-final'));
  const finalMs = performance.now() - start;
  await until(() => asr.events.some(e => e.type === 'translation-updated'));
  const translationMs = performance.now() - start;
  await until(() => speech.pcm.length > 0);
  const pcmMs = performance.now() - start;
  fixture.final('Sentence 502.', true, 'second');
  await until(() => fixture.stats.commits.length >= 2);
  assert.deepEqual(fixture.stats.commits, ['这是第 501 句中文译文。', '这是第 502 句中文译文。']);
  assert.equal(asr.events.filter(e => e.type === 'segment-final').length, 2);
  assert.equal(asr.events.filter(e => e.type === 'translation-updated').length, 2);
  assert.equal(speech.events.some(e => e.type === 'speech.error'), false);
  if (graphEnabled) {
    assert.equal(relationFinished, false, 'all foreground work completed while graph HTTP was unresolved');
    release(); await until(() => relationFinished);
  }
  t.diagnostic(JSON.stringify({ fixture: graphEnabled ? 'held_relation' : 'baseline', finalMs, translationMs, firstPcmMs: pcmMs,
    units: fixture.stats.commits.length, scope: 'local synthetic provider only; not a live-provider performance benchmark' }));
});
