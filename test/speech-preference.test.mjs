import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ListeningStore } from '../storage.mjs';
import { createSpeechService } from '../speech-service.mjs';
import { createSpeechController } from '../public/speech-controller.js';
import { PREVIEW_TEXT } from '../public/speech-protocol.js';

const config = { key: 'mock-preference-key', region: 'beijing', voice: 'Cherry', rate: 1 };
const first = 'The weather is warm, and the sky is clear';
const next = first + ' above the quiet city';
const final = next + ' for the bus.';
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class Client extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  events = [];
  packets = [];
  send(data) { if (Buffer.isBuffer(data)) this.packets.push(data); else this.events.push(JSON.parse(data)); }
  message(data) { this.emit('message', Buffer.from(JSON.stringify(data)), false); }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.emit('close'); } }
}

function fixture(t, { source = 'en', targetLang = 'Chinese', translatePhrase, createTts } = {}) {
  const store = new ListeningStore(':memory:');
  const run = store.createRun(null, { source, targetLang, audioSource: 'tab' }, 'preference-test');
  const clients = [], requests = [], providers = [];
  const service = createSpeechService({ store, now: () => 0,
    translatePhrase: async request => {
      requests.push(request);
      return translatePhrase ? translatePhrase(request) : request.final ? '剩余后缀。' : '提前前缀。';
    },
    createTts: () => {
      const provider = createTts ? createTts() : {
        spoken: [], closed: false,
        async synthesize(text, audio) { this.spoken.push(text); audio(Buffer.alloc(480)); },
        close() { this.closed = true; }
      };
      providers.push(provider);
      return provider;
    }
  });
  t.after(() => { for (const client of clients) client.close(); store.db.close(); });
  const start = (message = {}) => {
    const client = new Client(); clients.push(client); service.accept(client);
    client.message({ type: 'speech.start', epoch: clients.length, ...run, config, ...message });
    return client;
  };
  const observe = async (id = 'sentence', a = first, b = next) => {
    service.observe(run.listeningId, run.runId, id, a);
    service.observe(run.listeningId, run.runId, id, b);
    await flush();
  };
  const addFinal = (id = 'sentence', original = final, translation = '完整规范译文。') => {
    const segment = store.addSegment(run.listeningId, run.runId, { id, text: original }).segment;
    store.setTranslation(segment.id, translation, false);
    service.final(run.listeningId, run.runId, segment);
    service.notify(run.listeningId);
    return segment;
  };
  return { store, run, service, start, observe, addFinal, requests, providers };
}

const ready = client => client.events.find(event => event.type === 'speech.ready');
const units = client => client.events.filter(event => event.type === 'speech.unit');

for (const [label, value] of [
  ['missing', undefined], ['false', false], ['null', null], ['zero', 0], ['one', 1],
  ['string true', 'true'], ['object', {}], ['array', []], ['true', true]
]) test(`speech.start enables incremental speech only for boolean true: ${label}`, async t => {
  const f = fixture(t);
  const client = f.start(value === undefined ? {} : { incremental: value });
  assert.equal(ready(client).incremental, value === true);
  await f.observe();
  assert.equal(f.requests.length, value === true ? 1 : 0);
  assert.equal(units(client).length, value === true ? 1 : 0);
  assert.equal(client.events.some(event => event.type === 'speech.error'), false);
});

test('provider config cannot opt into the live-session protocol preference', async t => {
  const f = fixture(t);
  const client = f.start({ config: { ...config, incremental: true } });
  assert.equal(ready(client).incremental, false);
  await f.observe();
  assert.deepEqual(f.requests, []);
});

for (const source of ['en', 'auto', 'ja']) test(`incremental opt-in requires explicit English source: ${source}`, async t => {
  const f = fixture(t, { source });
  const client = f.start({ incremental: true });
  assert.equal(ready(client).incremental, source === 'en');
  await f.observe();
  assert.equal(f.requests.length, source === 'en' ? 1 : 0);
  assert.equal(units(client).length, source === 'en' ? 1 : 0);
});

test('incremental opt-in cannot bypass the Chinese live-target restriction', async t => {
  const f = fixture(t, { targetLang: 'English' });
  const client = f.start({ incremental: true });
  assert.equal(ready(client), undefined);
  assert.match(client.events.at(-1).message, /中文译文/);
  assert.equal(client.readyState, 3);
  assert.deepEqual(f.providers, []);
  await f.observe();
  assert.deepEqual(f.requests, []);
});

for (const [type, kind, expected] of [
  ['speech.preview', undefined, PREVIEW_TEXT],
  ['speech.replay', undefined, '完整规范译文。'],
  ['speech.transcript', 'original', final],
  ['speech.transcript', 'translation', '完整规范译文。']
]) test(`${type} ${kind || ''} ignores incremental opt-in and retains canonical text`, async t => {
  const f = fixture(t);
  const segment = f.addFinal(); f.store.finishRun(f.run.runId);
  const client = f.start({ type, kind, segmentId: segment.id, incremental: true });
  await flush();
  assert.equal(ready(client).incremental, false);
  assert.equal(units(client).map(unit => unit.text).join(''), expected);
  assert.ok(units(client).every(unit => !Object.hasOwn(unit, 'sourceUnit')));
  assert.deepEqual(f.requests, []);
  assert.equal(f.store.speechSegment(f.run.listeningId, f.run.runId, segment.id).translation_text, '完整规范译文。');
});

test('opposite live preferences are isolated on one service and cannot change within an epoch', async t => {
  const f = fixture(t);
  const early = f.start({ incremental: true });
  const canonical = f.start({ incremental: false });
  // A second start frame is not a live preference-update protocol.
  early.message({ type: 'speech.start', epoch: 1, ...f.run, config, incremental: false });
  canonical.message({ type: 'speech.start', epoch: 2, ...f.run, config, incremental: true });
  await f.observe();
  assert.equal(ready(early).incremental, true);
  assert.equal(ready(canonical).incremental, false);
  assert.deepEqual(units(early).map(unit => unit.text), ['提前前缀。']);
  assert.deepEqual(units(canonical), []);
  assert.equal(f.requests.length, 1);
  const segment = f.addFinal(); await flush();
  assert.deepEqual(units(early).map(unit => unit.text), ['提前前缀。', '剩余后缀。']);
  assert.deepEqual(units(canonical).map(unit => unit.text), ['完整规范译文。']);
  assert.equal(units(early)[0].sourceUnit.preFinal, true);
  assert.equal(units(early)[1].sourceUnit.preFinal, false);
  assert.ok(units(canonical).every(unit => !Object.hasOwn(unit, 'sourceUnit')));
  f.service.final(f.run.listeningId, f.run.runId, segment);
  f.service.notify(f.run.listeningId); await flush();
  assert.equal(units(early).length, 2);
  assert.equal(units(canonical).length, 1);
  assert.equal(f.store.speechSegment(f.run.listeningId, f.run.runId, segment.id).translation_text, '完整规范译文。');
});

test('stopping pending phrase MT aborts it; restart uses its new preference with no old coverage or audio', async t => {
  const pending = deferred(); let calls = 0;
  const f = fixture(t, { translatePhrase: () => ++calls === 1 ? pending.promise : '新会话前缀。' });
  const old = f.start({ incremental: true });
  await f.observe();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal.aborted, false);
  old.message({ type: 'speech.stop', epoch: 1 });
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.providers[0].closed, true);
  const eventCount = old.events.length;
  const fresh = f.start({ incremental: false });
  assert.equal(ready(fresh).incremental, false);
  pending.resolve('已取消的旧译文。'); await flush();
  assert.equal(old.events.length, eventCount);
  assert.deepEqual(old.packets, []);
  assert.deepEqual(units(fresh), []);
  await f.observe('sentence', next, next + ' for the bus');
  assert.equal(f.requests.length, 1);
  const segment = f.addFinal(); await flush();
  assert.deepEqual(units(fresh).map(unit => unit.text), ['完整规范译文。']);
  assert.equal(f.store.speechSegment(f.run.listeningId, f.run.runId, segment.id).translation_text, '完整规范译文。');
  fresh.message({ type: 'speech.stop', epoch: 2 });
  const optedBackIn = f.start({ incremental: true });
  assert.equal(ready(optedBackIn).incremental, true);
  assert.equal(ready(optedBackIn).afterSequence, segment.sequence_no);
  await f.observe('new-sentence');
  assert.deepEqual(units(optedBackIn).map(unit => unit.text), ['新会话前缀。']);
  assert.equal(units(optedBackIn)[0].sourceUnit.epoch, 3);
});

test('a stopped provider cannot deliver late PCM into either the old or restarted consumer', async t => {
  const pending = deferred(); let lateAudio, providers = 0;
  const f = fixture(t, { createTts: () => {
    const delayed = providers++ === 0;
    return {
      closed: false,
      async synthesize(_text, audio) {
        if (delayed) { lateAudio = audio; await pending.promise; }
        else audio(Buffer.alloc(480));
      },
      close() { this.closed = true; }
    };
  } });
  const old = f.start({ incremental: true }); await f.observe();
  assert.equal(typeof lateAudio, 'function');
  old.message({ type: 'speech.stop', epoch: 1 });
  const eventCount = old.events.length;
  const fresh = f.start({ incremental: false });
  lateAudio(Buffer.alloc(480)); pending.resolve(); await flush();
  assert.equal(f.providers[0].closed, true);
  assert.deepEqual(old.packets, []);
  assert.equal(old.events.length, eventCount);
  assert.deepEqual(fresh.packets, []);
  f.addFinal(); await flush();
  assert.deepEqual(units(fresh).map(unit => unit.text), ['完整规范译文。']);
  assert.equal(fresh.packets.length, 1);
  assert.equal(fresh.packets[0].readUInt32LE(0), 2);
});

function controllerFixture(t, { unlock } = {}) {
  const states = [], sockets = [], players = [];
  const controller = createSpeechController({ onChange: state => states.push(state),
    document: new EventTarget(),
    media: { activate() {}, setContext() {}, setPaused() {}, close() {} },
    createPlayer: callback => {
      const index = players.length;
      const player = { callback, closed: false, audioCalls: [], begun: [],
        async unlock() { await unlock?.(index); },
        close() { this.closed = true; },
        begin(unit) { this.begun.push(unit); }, end() {},
        audio(...args) { this.audioCalls.push(args); },
        pause() {}, async resume() { return true; }
      };
      players.push(player); return player;
    },
    createSocket: () => {
      const socket = new EventTarget(); socket.readyState = 1; socket.sent = [];
      socket.send = data => socket.sent.push(JSON.parse(data));
      socket.close = () => { socket.readyState = 3; socket.dispatchEvent(new Event('close')); };
      sockets.push(socket); return socket;
    }
  });
  controller.setContext({ phase: 'listening', target: 'Chinese', runId: 'run', listeningId: 'record' });
  t.after(() => controller.stop());
  const open = () => { sockets.at(-1).dispatchEvent(new Event('open')); return sockets.at(-1).sent[0]; };
  return { controller, states, sockets, players, open };
}

for (const [label, options, type] of [
  ['default live', {}, 'speech.start'],
  ['enabled live', { incremental: true }, 'speech.start'],
  ['malformed live', { incremental: 'true' }, 'speech.start'],
  ['preview', { preview: true, incremental: true }, 'speech.preview'],
  ['replay', { replay: { segmentId: 'segment', runId: 'run', listeningId: 'record' }, incremental: true }, 'speech.replay'],
  ['original transcript', { transcript: 'original', incremental: true }, 'speech.transcript'],
  ['translation transcript', { transcript: 'translation', incremental: true }, 'speech.transcript']
]) test(`controller sends the strict preference only on live starts: ${label}`, async t => {
  const f = controllerFixture(t);
  if (options.transcript) f.controller.setContext({ phase: 'idle', target: 'Chinese', runId: 'run', listeningId: 'record' });
  await f.controller.start(config, options);
  const message = f.open();
  assert.equal(message.type, type);
  assert.equal(Object.hasOwn(message, 'incremental'), type === 'speech.start');
  if (type === 'speech.start') assert.equal(message.incremental, options.incremental === true);
  assert.equal(Object.hasOwn(message.config, 'incremental'), false);
});

test('settings stop and manual restart reject old socket/player events and do not retain the old preference', async t => {
  const f = controllerFixture(t);
  await f.controller.start(config, { incremental: true });
  const firstStart = f.open(), oldSocket = f.sockets[0], oldPlayer = f.players[0];
  f.controller.stop('设置已保存，请手动开启译文播报');
  assert.equal(f.controller.enabled, false);
  assert.equal(oldPlayer.closed, true);
  assert.equal(oldSocket.sent.at(-1).type, 'speech.stop');
  assert.equal(oldSocket.sent.at(-1).epoch, firstStart.epoch);
  assert.equal(f.sockets.length, 1, 'saving stops without automatically restarting');
  await f.controller.start(config, { incremental: false });
  const freshStart = f.open();
  assert.equal(freshStart.incremental, false);
  assert.ok(freshStart.epoch > firstStart.epoch);
  const statesBefore = f.states.length, oldSent = oldSocket.sent.length, freshSent = f.sockets[1].sent.length;
  for (const data of [
    { type: 'speech.ready', incremental: true },
    { type: 'speech.unit', unit: 1, text: '过期内容。' },
    { type: 'speech.error', message: '过期错误' },
    { type: 'speech.finished', message: '过期完成' }
  ]) oldSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ ...data, epoch: firstStart.epoch }) }));
  oldSocket.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(18) }));
  for (const event of ['open', 'close', 'error']) oldSocket.dispatchEvent(new Event(event));
  for (const event of [{ type: 'progress', consumedSamples: 240, playedUnit: 1 }, { type: 'started', unit: 1 }, { type: 'error' }, { type: 'suspended' }]) oldPlayer.callback(event);
  await flush();
  assert.equal(f.states.length, statesBefore);
  assert.equal(oldSocket.sent.length, oldSent);
  assert.equal(f.sockets[1].sent.length, freshSent);
  assert.deepEqual(oldPlayer.audioCalls, []);
  assert.deepEqual(f.players[1].audioCalls, []);
  assert.deepEqual(f.players[1].begun, []);
  assert.equal(f.controller.enabled, true);
  assert.equal(f.controller.paused, false);
  assert.equal(f.players[1].closed, false);
  f.sockets[1].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ epoch: freshStart.epoch, type: 'speech.ready', incremental: false }) }));
  f.sockets[1].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ epoch: freshStart.epoch, type: 'speech.state', state: 'waiting', message: '等待' }) }));
  assert.match(f.states.at(-1).message, /说话人说完一句/);
  assert.doesNotMatch(f.states.at(-1).message, /实验/);
});

test('settings stop while unlock is pending cannot create an old opt-in socket after restart', async t => {
  const pending = deferred();
  const f = controllerFixture(t, { unlock: index => index === 0 ? pending.promise : undefined });
  const oldStart = f.controller.start(config, { incremental: true });
  f.controller.stop('设置已保存，请手动开启译文播报');
  await f.controller.start(config, { incremental: false });
  assert.equal(f.open().incremental, false);
  pending.resolve(); await oldStart;
  assert.equal(f.sockets.length, 1);
  assert.equal(f.players[0].closed, true);
  assert.equal(f.players[1].closed, false);
  assert.equal(f.controller.enabled, true);
});
