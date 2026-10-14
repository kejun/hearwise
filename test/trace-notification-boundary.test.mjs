import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { speechFixture } from '../test-support/speech-fixture.mjs';
import { traceEvents, until } from '../test-support/full-trace-fixture.mjs';
import { traceReport } from '../test-support/trace-business-fixture.mjs';
import { deadline } from '../test-support/lifecycle.mjs';

async function fixture(t, source) {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-notification-'));
  const preload = path.join(directory, 'fault.mjs'); await writeFile(preload, source);
  const f = await speechFixture({ extraEnv: { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${preload}`.trim() } });
  t.after(async () => { try { await f.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  return f;
}
async function connect(t, f, route) {
  const ws = new WebSocket(f.base.replace('http', 'ws') + route), events = [];
  ws.on('error', () => {}); ws.on('message', (raw, binary) => { if (!binary) events.push(JSON.parse(raw)); });
  t.after(() => ws.terminate()); await deadline(() => once(ws, 'open'), 2000, 'Trace WebSocket startup');
  return { ws, events, send: value => ws.send(JSON.stringify(value)) };
}

test('translation notification failure preserves committed success and frees both slots for queued work', { timeout: 15000 }, async t => {
  const f = await fixture(t, `import WebSocket from ${JSON.stringify(new URL('../node_modules/ws/wrapper.mjs', import.meta.url).href)};
const send = WebSocket.prototype.send;
WebSocket.prototype.send = function (data, ...args) {
  if (typeof data === 'string' && JSON.parse(data).type === 'translation-updated') {
    console.info('trace_translation_notification_injected'); throw new Error('synthetic notification failure');
  }
  return send.call(this, data, ...args);
};\n`);
  const asr = await connect(t, f, '/ws');
  asr.send({ type: 'start', key: 'trace-notification-test-only', source: 'en', targetLang: 'Chinese', audioSource: 'tab' });
  await until(() => asr.events.some(event => event.type === 'listening-ready'));
  const { listeningId } = asr.events.find(event => event.type === 'listening-ready');
  f.final('Sentence one.', true, 'one'); f.final('Sentence two.', true, 'two'); f.final('Sentence three.', true, 'three');
  await until(() => traceEvents(f.logs()).filter(event => event.step_key === 'translation.execute' && ['failed', 'succeeded'].includes(event.state)).length >= 2);
  const detail = await (await fetch(`${f.base}/api/listenings/${listeningId}`)).json();
  assert.ok(detail.listening); assert.match(f.logs(), /trace_translation_notification_injected/);
  const finalIds = asr.events.filter(event => event.type === 'segment-final').map(event => event.segment.id);
  const persisted = await (await fetch(`${f.base}/api/listenings/${listeningId}/segments?ids=${finalIds.join(',')}`)).json();
  assert.ok(persisted.items.filter(row => row.translation_state === 'complete').length >= 2);
  const report = traceReport(f.logs()), roots = report.spans.filter(span => span.step === 'translation.execute' && span.ownState !== 'unknown');
  assert.ok(roots.every(span => span.state === 'succeeded'), 'Committed translations must not become failed executions because delivery threw: ' +
    JSON.stringify({ durable: persisted.items.map(row => row.translation_state), trace: roots.map(row => row.state), calls: f.stats.mtRequests.length }));
  await until(() => traceEvents(f.logs()).filter(event => event.step_key === 'translation.execute' && event.state === 'succeeded').length === 3);
  assert.equal(f.stats.mtRequests.length, 3, 'Every source is called once; notification failure never retries a paid request');
  const segments = await (await fetch(`${f.base}/api/listenings/${listeningId}/segments?ids=${finalIds.join(',')}`)).json();
  assert.equal(segments.items.length, 3); assert.ok(segments.items.every(row => row.translation_state === 'complete'));
  assert.equal(traceEvents(f.logs()).filter(event => event.step_key === 'translation.execute' && event.event === 'notification_sent').length, 0);
});

test('speech diagnostic callback failure cannot turn playback into failure or leak its consumer', { timeout: 10000 }, async t => {
  const f = await fixture(t, `const info = console.info;
console.info = (...args) => { if (args[0] === 'speech_event') {
  info('trace_speech_metric_injected'); throw new Error('synthetic diagnostic failure');
} return info(...args); };\n`);
  const speech = await connect(t, f, '/ws/tts');
  speech.send({ type: 'speech.preview', epoch: 21, config: { key: 'trace-speech-test-only', region: 'beijing', voice: 'Cherry', rate: 1 } });
  await until(() => speech.events.some(event => ['speech.ready', 'speech.error'].includes(event.type)));
  assert.ok(speech.events.some(event => event.type === 'speech.ready'), 'Throwing diagnostic sink must not fail speech admission');
  await until(() => speech.events.filter(event => event.type === 'speech.unit-end').length === 2);
  const ends = speech.events.filter(event => event.type === 'speech.unit-end');
  speech.send({ type: 'speech.progress', epoch: 21, playedUnit: ends.at(-1).unit, consumedSamples: ends.reduce((n, row) => n + row.samples, 0) });
  await deadline(() => once(speech.ws, 'close'), 3000, 'Speech completion');
  assert.equal(speech.events.at(-1).type, 'speech.finished'); assert.equal(f.stats.commits.length, 2);
  assert.equal((await fetch(f.base)).status, 200); assert.match(f.logs(), /trace_speech_metric_injected/);
  await until(() => traceEvents(f.logs()).some(event => event.step_key === 'speech.session' && event.state === 'succeeded'));
  const report = traceReport(f.logs());
  assert.ok(report.spans.filter(span => span.step === 'speech.unit' || span.step === 'speech.session').every(span => span.state === 'succeeded'));
});
