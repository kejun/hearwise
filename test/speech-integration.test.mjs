import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { speechFixture } from '../test-support/speech-fixture.mjs';
import { QwenTts } from '../qwen-tts.mjs';

const config = { key: 'mock-only-key', region: 'beijing', voice: 'Cherry', rate: 1.1 };
async function waitFor(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Timed out waiting for protocol event');
}
async function socket(url) {
  const ws = new WebSocket(url), events = [], pcm = [];
  ws.on('message', (raw, binary) => binary ? pcm.push(raw) : events.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  return { ws, events, pcm, send: data => ws.send(JSON.stringify(data)) };
}

test('real /ws/tts → Qwen protocol → PCM, idle has no TTS calls, ignores partial/history, drains after ASR closes', { timeout: 15000 }, async t => {
  const f = await speechFixture(); t.after(() => f.close());
  for (const file of ['speech-controller.js', 'speech-buffer.js', 'speech-output-processor.js']) assert.equal((await fetch(`${f.base}/${file}`)).status, 200);
  const asr = await socket(f.base.replace('http', 'ws') + '/ws'); t.after(() => asr.ws.terminate());
  asr.send({ type: 'start', key: 'mock-asr-key', source: 'en', targetLang: 'Chinese', audioSource: 'tab' });
  await waitFor(() => asr.events.some(e => e.type === 'listening-ready'));
  const run = asr.events.find(e => e.type === 'listening-ready');
  f.final('Sentence 1.'); await waitFor(() => asr.events.some(e => e.type === 'translation-updated'));
  assert.equal(f.stats.connections, 0);
  const speech = await socket(f.base.replace('http', 'ws') + '/ws/tts'); t.after(() => speech.ws.terminate());
  speech.send({ type: 'speech.start', epoch: 11, listeningId: run.listeningId, runId: run.runId, config });
  await waitFor(() => speech.events.some(e => e.type === 'speech.ready'));
  assert.equal(speech.events[0].afterSequence, 1);
  f.final('Partial sentence', false); await new Promise(r => setTimeout(r, 50)); assert.equal(f.stats.connections, 0);
  f.final('Sentence 2.'); await waitFor(() => speech.events.some(e => e.type === 'speech.unit-end'));
  assert.deepEqual(f.stats.commits, ['这是第 2 句中文译文。']);
  assert.deepEqual(f.stats.sessions[0], { mode: 'commit', voice: 'Cherry', language_type: 'Chinese', response_format: 'pcm', sample_rate: 24000, speech_rate: 1.1 });
  let samples = 0;
  speech.pcm.forEach((p, index) => { assert.equal(p.readUInt32LE(0), 11); assert.equal(p.readUInt32LE(8), index); assert.equal(p.length, 16 + p.readUInt32LE(12) * 2); samples += p.readUInt32LE(12); });
  assert.equal(samples, 2400); // Including the odd-sized network chunk tails.
  speech.send({ type: 'speech.drain', epoch: 11 });
  asr.send({ type: 'stop' }); await once(asr.ws, 'close');
  speech.send({ type: 'speech.progress', epoch: 11, consumedSamples: samples, playedUnit: 1 });
  await waitFor(() => speech.events.some(e => e.type === 'speech.finished'));
  assert.equal(f.stats.connections, 1);
});

test('speech endpoint rejects cross-origin upgrades and rejects unsupported configuration without upstream calls', { timeout: 10000 }, async t => {
  const f = await speechFixture(); t.after(() => f.close());
  const foreign = new WebSocket(f.base.replace('http', 'ws') + '/ws/tts', { origin: 'https://example.org' });
  foreign.on('error', () => {});
  const [_request, response] = await once(foreign, 'unexpected-response'); assert.equal(response.statusCode, 403); foreign.terminate();
  const client = await socket(f.base.replace('http', 'ws') + '/ws/tts');
  client.send({ type: 'speech.preview', epoch: 1, config: { ...config, region: 'http://localhost' } });
  await once(client.ws, 'close'); assert.equal(client.events[0].type, 'speech.error'); assert.equal(f.stats.connections, 0);
});

test('Qwen reconnects before first audio, never replays after partial audio, and close aborts in-flight work', { timeout: 10000 }, async t => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(upstream, 'listening');
  t.after(async () => { for (const c of upstream.clients) c.terminate(); await new Promise(r => upstream.close(r)); });
  let connections = 0, commits = 0;
  upstream.on('connection', ws => {
    connections++; ws.send(JSON.stringify({ type: 'session.created' }));
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
      if (msg.type === 'input_text_buffer.commit') {
        commits++;
        if (commits === 1) return ws.close();
        if (commits === 4) return; // Hold a response until the local cancel closes it.
        ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r' } }));
        ws.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'r', delta: Buffer.alloc(8).toString('base64') }));
        if (commits === 2) ws.send(JSON.stringify({ type: 'response.done', response: { id: 'r', status: 'completed' } }));
        else ws.close();
      }
    });
  });
  const q = new QwenTts(config, { endpoint: `ws://127.0.0.1:${upstream.address().port}` }); t.after(() => q.close());
  const pcm = []; await q.synthesize('第一句。', data => pcm.push(data));
  assert.equal(connections, 2); assert.equal(commits, 2); assert.equal(pcm.length, 1);
  await assert.rejects(q.synthesize('第二句。', data => pcm.push(data)), /断开/);
  assert.equal(commits, 3); assert.equal(pcm.length, 2);
  q.close(); await assert.rejects(q.synthesize('关闭。', () => {}), /关闭/);
  const pendingQ = new QwenTts(config, { endpoint: `ws://127.0.0.1:${upstream.address().port}` });
  const pending = pendingQ.synthesize('等待取消。', () => {});
  const rejected = assert.rejects(pending, /关闭/);
  await waitFor(() => commits === 4); pendingQ.close(); await rejected;
});
