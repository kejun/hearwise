import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createSpeechService } from '../speech-service.mjs';
import { createSpeechController } from '../public/speech-controller.js';
import { SpeechPlayer } from '../public/speech-player.js';
import { deadline } from './lifecycle.mjs';
import { playbackControllerVariant } from './playback-controller-variant.mjs';

const config = { key: 'local-fixture-only', region: 'beijing', voice: 'Cherry', rate: 1 };
const settle = () => new Promise(resolve => setImmediate(resolve));
let installed = false;

// Actual controller, SpeechPlayer, worklet, ring buffer, service and SQLite.
// Only browser platform scheduling and the provider boundary are controlled here.
// This is a deterministic bridge, not a claim of real browser or audible quality.
export async function createPlaybackAdapter(options = {}) {
  let createController = createSpeechController;
  if (options.wireModulus !== undefined || options.mutation !== undefined) {
    const url = new URL('../public/speech-controller.js', import.meta.url);
    const source = playbackControllerVariant(await readFile(url, 'utf8'), options)
      .replaceAll("'./speech-player.js'", JSON.stringify(new URL('../public/speech-player.js', import.meta.url).href))
      .replaceAll("'./speech-media-session.js'", JSON.stringify(new URL('../public/speech-media-session.js', import.meta.url).href));
    createController = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).createSpeechController;
  }
  assert.equal(installed, false, 'playback platform fixtures must run serially'); installed = true;
  let root, store; let saved = new Map();
  const restore = () => { for (const [name, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; installed = false; };
  try {
  root = await mkdtemp(path.join(tmpdir(), 'hearwise-playback-'));
  store = new ListeningStore(path.join(root, 'playback.sqlite'));
  const records = {};
  for (const [name, texts] of [['A', ['甲。', '乙。']], ['B', ['丙。', '丁。']]]) {
    const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'tab' }, `record-${name}`);
    for (let n = 0; n < texts.length; n++) {
      const segment = store.addSegment(run.listeningId, run.runId, { id: n + 1, text: `Source ${name}${n + 1}.` }).segment;
      store.setTranslation(segment.id, texts[n], false);
    }
    store.finishRun(run.runId); records[name] = run;
  }
  const names = ['AudioContext', 'AudioWorkletNode', 'AudioWorkletProcessor', 'sampleRate', 'registerProcessor'];
  saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let Processor, currentConstruction, accepting, selectedRecord = 'A', last = {}, closed = false;
  const generations = [], heads = new Map(), requests = [], changes = [];
  class PlatformContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; this.calls = 0; this.pending = []; this.generation = generations.at(-1); }
    async resume() {
      if (this.calls++) { const gate = Promise.withResolvers(); this.pending.push(gate); await gate.promise; }
      else await this.generation.unlock.promise;
      if (this.state === 'closed') throw new Error('AudioContext is closed');
      this.state = 'running'; this.onstatechange?.();
    }
    async suspend() { if (this.state !== 'closed') this.state = 'suspended'; this.onstatechange?.(); }
    async close() { this.state = 'closed'; this.onstatechange?.(); }
    createGain() { return { gain: { value: 0, cancelScheduledValues() {}, setTargetAtTime(value) { this.value = value; } }, connect() {}, disconnect() {} }; }
  }
  class PlatformProcessor {
    constructor() { this.port = { onmessage: null, postMessage: data => currentConstruction?.port.onmessage?.({ data }) }; }
  }
  class PlatformNode {
    constructor(context) {
      this.context = context; this.disconnected = false;
      this.port = { onmessage: null, postMessage: data => this.processor.port.onmessage({ data }), close() {} };
      currentConstruction = this; this.processor = new Processor(); currentConstruction = null;
      // Delivery belongs to this specific node, even after a newer one exists.
      this.processor.port.postMessage = data => this.port.onmessage?.({ data });
    }
    connect() {} disconnect() { this.disconnected = true; }
    render() {
      if (this.disconnected || this.context.state !== 'running') return [];
      const channel = new Float32Array(6000); this.processor.process([], [[channel]]);
      return Array.from(channel.subarray(0, 4));
    }
  }
  Object.assign(globalThis, { AudioContext: PlatformContext, AudioWorkletNode: PlatformNode, AudioWorkletProcessor: PlatformProcessor,
    sampleRate: 24000, registerProcessor: (_name, value) => { Processor = value; } });
  options.afterPlatformInstall?.();
  await import(`../public/speech-output-processor.js?playback=${encodeURIComponent(root)}`);
  const service = createSpeechService({ store, now: () => 0, setHead: (owner, value) => value ? heads.set(owner, value) : heads.delete(owner),
    createTts: () => {
      const generation = accepting;
      return { close() { generation.providerClosed = true; }, synthesize(text, onAudio) {
        const gate = Promise.withResolvers();
        const request = { generation: generation.id, text, onAudio, gate, emitted: false, completed: false };
        requests.push(request); generation.requests.push(request);
        return gate.promise;
      } };
    } });
  class BridgeSocket extends EventTarget {
    constructor(generation) {
      super(); this.generation = generation; this.readyState = 0;
      const client = this.client = new EventEmitter(); client.readyState = 1; client.bufferedAmount = 0;
      client.send = data => {
        const value = Buffer.isBuffer(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
        if (typeof value === 'string') generation.incoming.push(JSON.parse(value)); else generation.sentFrames++;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: value })));
      };
      client.close = () => this.close();
      service.accept(client);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); } });
    }
    send(raw) {
      const message = JSON.parse(raw); this.generation.outgoing.push(message);
      const previous = accepting; accepting = this.generation;
      try { this.client.emit('message', Buffer.from(raw), false); } finally { accepting = previous; }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = this.client.readyState = 3; this.client.emit('close');
      queueMicrotask(() => this.dispatchEvent(new Event('close')));
    }
  }
  const controller = createController({ document: null,
    media: { close() {}, setPaused() {}, setContext() {}, activate(actions) { generations.at(-1).media = actions; } },
    onChange: value => { last = value; changes.push({ ...value }); },
    createPlayer: callback => {
      const generation = { id: generations.length + 1, record: selectedRecord, callback, requests: [], incoming: [], outgoing: [], sentFrames: 0,
        unlock: Promise.withResolvers(), settlement: Promise.withResolvers(), settling: false, providerClosed: false };
      const player = generation.player = new SpeechPlayer(callback);
      const drain = player.settle.bind(player);
      player.settle = () => { generation.settling = true; return generation.drained = generation.settlement.promise.then(drain); };
      generations.push(generation); return player;
    }, createSocket: () => { const generation = generations.at(-1); return generation.socket = new BridgeSocket(generation); } });
  const flush = async () => { await settle(); await settle(); };
  const get = id => { const generation = generations[id - 1]; assert.ok(generation, `generation ${id} exists`); return generation; };
  const pending = id => { const request = get(id).requests.find(value => !value.completed); assert.ok(request, `generation ${id} has a pending provider request`); return request; };
  const setRecord = name => { assert.ok(records[name]); selectedRecord = name; controller.setContext({ ...records[name], phase: 'idle', target: 'Chinese' }); };
  setRecord('A');
  return {
    root, controller, store, records, generations, requests, changes,
    async start(record = selectedRecord, { paused = false, position = 1 } = {}) {
      setRecord(record); const promise = controller.start(config, { transcript: 'translation', paused, startPosition: position });
      generations.at(-1).start = promise; await flush(); return generations.length;
    },
    async unlock(id) { const generation = get(id); generation.unlock.resolve(); await generation.start; await flush(); },
    async pause() { controller.pause(); await flush(); },
    async resume() { const generation = generations.at(-1); generation.resume = controller.resume(); await flush(); },
    async resumeComplete(id) { const generation = get(id); assert.ok(generation.player.context.pending.length); generation.player.context.pending.shift().resolve(); await generation.resume; await flush(); },
    async stop() { controller.stop(); await flush(); },
    async seek(position) { const promise = controller.seek(position); if (generations.at(-1)) generations.at(-1).start = promise; await flush(); return generations.length; },
    async switchRecord(name) { setRecord(name); await flush(); },
    async pcm(id) { const request = pending(id); assert.equal(request.emitted, false); request.emitted = true; request.onAudio(Buffer.from([1, 2, 3, 4])); await flush(); },
    async complete(id) { const request = pending(id); request.completed = true; request.gate.resolve({ id: `fixture-${id}`, status: 'completed', attempts: 1 }); await flush(); },
    async consume(id) { const generation = get(id); const output = generation.player.node?.render() || []; await flush(); return output; },
    async settled(id) { const generation = get(id); assert.equal(generation.settling, true); generation.settlement.resolve(); await deadline(() => generation.drained, 1000, 'actual player settlement'); await flush(); },
    async late(id, kind) {
      const generation = get(id);
      if (kind === 'suspended') generation.callback({ type: 'suspended' });
      else if (kind === 'error') generation.callback({ type: 'error' });
      else if (kind === 'close') generation.socket.dispatchEvent(new Event('close'));
      else if (kind === 'socket-error') generation.socket.dispatchEvent(new Event('error'));
      else throw new Error(`Unknown late callback ${kind}`);
      await flush();
    },
    async frame(id, { epoch, unit = 1, frame = 0, declaredSamples = 2 } = {}) {
      const generation = get(id); const packet = new ArrayBuffer(20); const header = new DataView(packet);
      header.setUint32(0, epoch ?? generation.outgoing.find(message => message.type === 'speech.transcript').epoch, true);
      header.setUint32(4, unit, true); header.setUint32(8, frame, true); header.setUint32(12, declaredSamples, true);
      generation.socket.dispatchEvent(new MessageEvent('message', { data: packet })); await flush();
    },
    observe() {
      return { selectedRecord, enabled: controller.enabled, paused: controller.paused, resuming: Boolean(last.resuming),
        active: controller.enabled ? generations.length : 0,
        generations: generations.map(generation => ({ id: generation.id, record: generation.record, unlocked: Boolean(generation.player.node),
          epoch: generation.outgoing.find(message => message.type === 'speech.transcript')?.epoch || 0,
          requested: generation.requests.map(request => request.text), emitted: generation.requests.filter(request => request.emitted).length,
          completed: generation.incoming.filter(message => message.type === 'speech.unit-end').length,
          accepted: generation.incoming.filter(message => message.type === 'speech.unit').map(message => message.text),
          sentFrames: generation.sentFrames, receivedSamples: generation.player.node?.processor.buffer.write || 0,
          bufferedSamples: (generation.player.node?.processor.buffer.write || 0) - (generation.player.node?.processor.buffer.consumedSamples || 0),
          consumedSamples: generation.player.node?.processor.buffer.consumedSamples || 0,
          played: generation.player.node?.processor.buffer.playedUnit || 0, closed: generation.player.closed,
          paused: generation.player.paused, providerClosed: generation.providerClosed,
          finished: generation.incoming.some(message => message.type === 'speech.finished'), settling: generation.settling })) };
    },
    async close() {
      if (closed) return; closed = true;
      controller.stop();
      for (const generation of generations) {
        generation.unlock.resolve(); generation.settlement.resolve();
        for (const gate of generation.player.context?.pending || []) gate.resolve();
        generation.socket?.close();
      }
      for (const request of requests) request.gate.resolve();
      try {
        await deadline(() => Promise.all(generations.flatMap(g => [g.start, g.resume, g.drained]).filter(Boolean)), 2000, 'playback fixture shutdown');
        await flush();
      } finally { store.db.close(); restore(); await rm(root, { recursive: true, force: true }); }
    }
  };
  } catch (error) {
    try { store?.db.close(); } finally { restore(); if (root) await rm(root, { recursive: true, force: true }); }
    throw error;
  }
}
