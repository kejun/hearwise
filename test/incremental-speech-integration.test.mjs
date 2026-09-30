import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { speechFixture } from '../test-support/speech-fixture.mjs';

const config = { key: 'mock-only', region: 'beijing', voice: 'Cherry', rate: 1 };
const first = 'The weather is warm, and the sky is clear';
const next = first + ' above the quiet city';
const final = next + ' for the bus.';
const translate = text => text === 'The weather is warm,' ? '天气很暖。' : text?.startsWith('and ') ? '天空晴朗，我们在外面等车。' : '完整规范译文：天气温暖，天空晴朗，我们等车。';
async function waitFor(check) {
  const end = Date.now() + 7000;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function connect(t, url) {
  const ws = new WebSocket(url), events = [], pcm = [];
  ws.on('message', (raw, binary) => binary ? pcm.push(raw) : events.push(JSON.parse(raw.toString())));
  t.after(() => ws.terminate()); await once(ws, 'open');
  return { ws, events, pcm, send: data => ws.send(JSON.stringify(data)) };
}
async function setup(t, options = {}) {
  const f = await speechFixture({ incremental: true, translationText: translate, ...options }); t.after(() => f.close());
  const asr = await connect(t, f.base.replace('http', 'ws') + '/ws');
  asr.send({ type: 'start', key: 'mock-asr', source: options.source || 'en', targetLang: 'Chinese', audioSource: 'tab' });
  await waitFor(() => asr.events.some(e => e.type === 'listening-ready'));
  const run = asr.events.find(e => e.type === 'listening-ready');
  const speech = await connect(t, f.base.replace('http', 'ws') + '/ws/tts');
  speech.send({ type: 'speech.start', epoch: 17, listeningId: run.listeningId, runId: run.runId, config });
  let consumed = 0;
  speech.ws.on('message', (raw, binary) => {
    if (binary) return;
    const event = JSON.parse(raw.toString());
    if (event.type === 'speech.unit-end') {
      consumed += event.samples;
      speech.send({ type: 'speech.progress', epoch: 17, playedUnit: event.unit, consumedSamples: consumed, underruns: 0 });
    }
  });
  await waitFor(() => speech.events.some(e => e.type === 'speech.ready'));
  return { f, asr, speech, run };
}

// Synthetic original-timed event trace. These intervals are input fixtures, not provider latency measurements.
const trace = [{ at: 0, text: first }, { at: 25, text: first }, { at: 50, text: next }];
for (const enabled of [false, true]) test(`timed ASR trace: ${enabled ? 'candidate' : 'baseline'} before final, canonical archive, no duplicate speech`, async t => {
  const { f, asr, speech, run } = await setup(t, { incremental: enabled });
  let previous = 0;
  for (const event of trace) {
    await new Promise(resolve => setTimeout(resolve, event.at - previous)); previous = event.at;
    f.final(event.text, false, 'long');
  }
  if (enabled) {
    await waitFor(() => speech.pcm.length > 0);
    assert.equal(asr.events.some(e => e.type === 'segment-final'), false);
    assert.deepEqual(f.stats.commits, ['天气很暖。']);
    const unit = speech.events.find(e => e.type === 'speech.unit');
    assert.equal(unit.sourceUnit.preFinal, true); assert.equal(unit.sourceUnit.source, 'The weather is warm,');
  } else {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.stats.commits.length, 0); assert.equal(f.stats.mtRequests.length, 0);
  }
  f.final(final, true, 'long');
  await waitFor(() => asr.events.some(e => e.type === 'translation-updated'));
  await waitFor(() => f.stats.commits.length === (enabled ? 2 : 1));
  const expected = enabled ? ['天气很暖。', '天空晴朗，我们在外面等车。'] : [translate(final)];
  assert.deepEqual(f.stats.commits, expected);
  f.final(final, true, 'long'); // duplicate final cannot replay covered source
  await new Promise(resolve => setTimeout(resolve, 50)); assert.deepEqual(f.stats.commits, expected);
  const stored = await (await fetch(`${f.base}/api/listenings/${run.listeningId}`)).json();
  assert.equal(stored.segments[0].original_text, final);
  assert.equal(stored.segments[0].translation_text, translate(final));
});
test('pre-final source correction stops audio explicitly; canonical final still archives corrected text', async t => {
  const { f, asr, speech } = await setup(t);
  f.final(first, false, 'long'); f.final(next, false, 'long');
  await waitFor(() => speech.pcm.length > 0);
  f.final(next.replace('warm', 'not warm'), false, 'long');
  await waitFor(() => speech.events.some(e => e.type === 'speech.error'));
  assert.match(speech.events.find(e => e.type === 'speech.error').message, /修订/);
  f.final(final.replace('warm', 'not warm'), true, 'long');
  await waitFor(() => asr.events.some(e => e.type === 'translation-updated'));
  assert.equal(f.stats.commits.length, 1);
});
test('final overtakes delayed phrase MT: cancels own request, speaks full canonical once', async t => {
  const { f, asr, speech } = await setup(t, { translationDelay: 180 });
  f.final(first, false, 'long'); f.final(next, false, 'long');
  await waitFor(() => f.stats.mtRequests.length === 1);
  f.final(final, true, 'long');
  await waitFor(() => asr.events.some(e => e.type === 'translation-updated'));
  await waitFor(() => f.stats.commits.length === 1);
  assert.equal(f.stats.mtAborted, 1); assert.deepEqual(f.stats.commits, [translate(final)]);
  assert.equal(speech.events.some(e => e.type === 'speech.error'), false);
});
test('mute during phrase translation rejects late audio and cancels upstream', async t => {
  const { f, speech } = await setup(t, { translationDelay: 180 });
  f.final(first, false, 'long'); f.final(next, false, 'long');
  await waitFor(() => f.stats.mtRequests.length === 1);
  speech.send({ type: 'speech.stop', epoch: 17 });
  await waitFor(() => f.stats.mtAborted === 1);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(f.stats.commits.length, 0); assert.equal(speech.pcm.length, 0);
});
test('unsupported automatic language and unsafe text retain final-only behavior', async t => {
  const { f, speech } = await setup(t, { source: 'auto' });
  assert.equal(speech.events.find(e => e.type === 'speech.ready').incremental, false);
  f.final(first, false, 'long'); f.final(next, false, 'long');
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(f.stats.commits.length, 0);
});


test('realistic AI news and interview clauses emit before a long ASR sentence ends', async t => {
  const { f, speech } = await setup(t, { translationText: text => `模拟译文：${text}` });
  const news = 'The company released a new AI model, and the team improved the deployment tools';
  f.final(news, false, 'news'); f.final(news + ' for enterprise customers', false, 'news');
  await waitFor(() => speech.pcm.length > 0);
  assert.equal(f.stats.mtRequests[0], 'The company released a new AI model,');
  f.final(news + ' for enterprise customers.', true, 'news');
  await waitFor(() => f.stats.commits.length === 2);
  const interview = 'We built a new training system, and the research team improved the evaluation process';
  f.final(interview, false, 'interview'); f.final(interview + ' for production workloads', false, 'interview');
  await waitFor(() => f.stats.commits.length === 3);
  assert.ok(f.stats.mtRequests.includes('We built a new training system,'));
  assert.ok(f.stats.commits[2].includes('We built a new training system,'));
});

test('pause during final-remainder MT holds prepared audio until resume without retranslating', async t => {
  const { f, speech } = await setup(t, { translationDelay: 100 });
  f.final(first, false, 'long'); f.final(next, false, 'long');
  await waitFor(() => f.stats.commits.length === 1);
  f.final(final, true, 'long');
  await waitFor(() => f.stats.mtRequests.some(text => text.startsWith('and ')));
  speech.send({ type: 'speech.pause', epoch: 17 });
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(f.stats.commits.length, 1);
  speech.send({ type: 'speech.resume', epoch: 17 });
  await waitFor(() => f.stats.commits.length === 2);
  assert.equal(f.stats.mtRequests.filter(text => text.startsWith('and ')).length, 1);
});

test('later open ASR sentence does not overtake an earlier uncovered suffix', async t => {
  const { f, speech } = await setup(t);
  f.final(first, false, 'long'); f.final(next, false, 'long');
  await waitFor(() => speech.pcm.length > 0);
  const news = 'The company released a new AI model, and the team improved the deployment tools';
  f.final(news, false, 'later'); f.final(news + ' for developers', false, 'later');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.stats.commits.length, 1);
  f.final(final, true, 'long');
  await waitFor(() => f.stats.commits.length >= 3);
  assert.equal(f.stats.commits[1], '天空晴朗，我们在外面等车。');
});
