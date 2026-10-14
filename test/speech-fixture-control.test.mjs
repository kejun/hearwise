import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { speechFixture } from '../test-support/speech-fixture.mjs';

async function waitFor(check) {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() >= end) throw new Error('Real speech fixture event not observed'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
test('automatic ASR can supersede a manual caption; pausing only the producer preserves real manual ASR/MT', { timeout: 10000 }, async t => {
  let time = 0;
  const fixture = await speechFixture({ autoSentences: true, autoNow: () => time });
  t.after(() => fixture.close());
  const ws = new WebSocket(fixture.base.replace('http:', 'ws:') + '/ws'), events = [];
  t.after(() => ws.terminate()); ws.on('message', raw => events.push(JSON.parse(raw.toString())));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start', key: 'mock-only', source: 'en', targetLang: 'Chinese', audioSource: 'tab' }));
  await waitFor(() => events.some(event => event.type === 'listening-ready') && fixture.stats.asrClients.size === 1);
  fixture.final('Sentence 99.'); await waitFor(() => events.some(event => event.type === 'translation-updated' && event.segment.translation_text.includes('99')));
  time = 3000; ws.send(Buffer.alloc(3200));
  await waitFor(() => fixture.stats.automaticSentences === 1 && events.filter(event => event.type === 'translation-updated').length === 2);
  assert.doesNotMatch(events.filter(event => event.type === 'translation-updated').at(-1).segment.translation_text, /99/);
  fixture.setAutoSentences(false);
  fixture.final('Sentence 777.'); await waitFor(() => events.some(event => event.type === 'translation-updated' && event.segment.translation_text.includes('777')));
  const frames = fixture.stats.audioFrames;
  time = 6000; ws.send(Buffer.alloc(3200)); await waitFor(() => fixture.stats.audioFrames === frames + 1);
  assert.equal(fixture.stats.automaticSentences, 1);
  assert.match(events.filter(event => event.type === 'translation-updated').at(-1).segment.translation_text, /777/);
  assert.equal(fixture.stats.mtRequests.some(text => text.includes('777')), true);
  fixture.setAutoSentences(true); time = 9000; ws.send(Buffer.alloc(3200));
  await waitFor(() => fixture.stats.automaticSentences === 2 && events.filter(event => event.type === 'translation-updated').length === 4);
  assert.doesNotMatch(events.filter(event => event.type === 'translation-updated').at(-1).segment.translation_text, /777/);
  assert.throws(() => fixture.setAutoSentences('false'), /boolean/);
  assert.equal(fixture.stats.connections, 0);
  const ready = events.find(event => event.type === 'listening-ready');
  const detail = await (await fetch(`${fixture.base}/api/listenings/${ready.listeningId}`)).json();
  assert.equal(detail.segments.some(segment => segment.original_text === 'Sentence 99.' && segment.translation_text.includes('99')), true);
  assert.equal(detail.segments.some(segment => segment.original_text === 'Sentence 777.' && segment.translation_text.includes('777')), true);
});
