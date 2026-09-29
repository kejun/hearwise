import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechMediaSession } from '../public/speech-media-session.js';
import { createSpeechController } from '../public/speech-controller.js';
import { SpeechPlayer } from '../public/speech-player.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function platform() {
  const handlers = new Map(), audioSession = { type: 'auto' };
  const mediaSession = { metadata: null, playbackState: 'none', setActionHandler(action, handler) { handlers.set(action, handler); } };
  const media = createSpeechMediaSession({ navigator: { mediaSession, audioSession }, Metadata: class { constructor(data) { Object.assign(this, data); } } });
  return { handlers, audioSession, mediaSession, media };
}
function controller() {
  const p = platform(), players = [], sockets = [], states = [];
  const document = new EventTarget(); document.visibilityState = 'visible';
  const c = createSpeechController({ media: p.media, document, onChange: state => states.push(state),
    createPlayer(callback) {
      const player = { callback, pauses: 0, resumes: 0, closed: false, async unlock() {},
        pause() { this.pauses++; }, async resume() { this.resumes++; return true; }, close() { this.closed = true; }, begin() {} };
      players.push(player); return player;
    }, createSocket() {
      const s = new EventTarget(); s.readyState = 1; s.sent = [];
      s.send = data => s.sent.push(JSON.parse(data)); s.close = () => { s.readyState = 3; }; sockets.push(s); return s;
    }
  });
  c.setContext({ phase: 'idle', listeningId: 'record', target: 'Chinese', audioSource: 'microphone' });
  const start = async () => { await c.start({}, { preview: true }); sockets.at(-1).dispatchEvent(new Event('open')); };
  return { ...p, c, start, players, sockets, states, document };
}

test('Media Session 默认不激活；锁屏暂停和继续复用播放器、连接及进度，停止后清理', async () => {
  const f = controller();
  assert.equal(f.handlers.size, 0); assert.equal(f.audioSession.type, 'auto');
  await f.start();
  assert.equal(f.mediaSession.metadata.title, '语音试听'); assert.equal(f.audioSession.type, 'playback');
  f.handlers.get('pause')();
  assert.equal(f.players[0].pauses, 1); assert.equal(f.c.paused, true);
  assert.equal(f.mediaSession.playbackState, 'paused');
  const { epoch } = f.sockets[0].sent[0];
  f.sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ epoch, type: 'speech.state', state: 'playing', message: '正在播报' }) }));
  assert.match(f.states.at(-1).message, /已暂停/);
  f.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(f.players[0].resumes, 0, 'user pause must not auto-resume');
  f.handlers.get('play')(); await flush();
  assert.equal(f.c.paused, false); assert.equal(f.players.length, 1); assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].sent.at(-1).type, 'speech.resume');
  f.handlers.get('stop')();
  assert.equal(f.c.enabled, false); assert.equal(f.players[0].closed, true);
  assert.equal(f.mediaSession.metadata, null); assert.equal(f.mediaSession.playbackState, 'none');
  assert.ok([...f.handlers.values()].every(handler => handler === null)); assert.equal(f.audioSession.type, 'auto');
});

test('隐藏页面不暂停；系统中断保留内容并在返回页面时恢复，恢复失败可再手动继续', async () => {
  const f = controller(); await f.start();
  f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.c.paused, false);
  f.players[0].callback({ type: 'suspended' });
  assert.equal(f.c.enabled, true); assert.equal(f.players[0].closed, false);
  f.players[0].resume = async () => { throw new Error('blocked'); };
  f.document.visibilityState = 'visible'; f.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(f.c.paused, true); assert.match(f.states.at(-1).message, /回到页面点击继续/);
  f.players[0].resume = async () => true; await f.c.resume();
  assert.equal(f.c.paused, false); f.c.stop();
});

test('恢复中的停止、再次暂停和旧系统回调不会复活已结束的播报', async () => {
  const f = controller(); await f.start(); f.c.pause();
  let release;
  f.players[0].resume = () => new Promise(resolve => { release = resolve; });
  const resuming = f.c.resume(); f.c.pause(); release(true); await resuming;
  assert.equal(f.c.paused, true); assert.equal(f.mediaSession.playbackState, 'paused');
  const oldPlay = f.handlers.get('play'), oldStop = f.handlers.get('stop');
  const restarting = f.c.resume(); f.c.stop(); await f.start();
  release(true); await restarting; oldPlay(); oldStop();
  assert.equal(f.c.enabled, true); assert.equal(f.players[1].resumes, 0);
  assert.ok(!f.sockets[0].sent.some(msg => msg.type === 'speech.resume'));
  f.c.stop();
});

test('Audio Session 随采集方式切换且清理恢复；不支持 API 或部分操作不影响播报', () => {
  const p = platform(); const options = { mode: 'transcript', kind: 'original', context: { phase: 'idle' }, play() {}, pause() {}, stop() {} };
  p.media.activate(options); assert.equal(p.audioSession.type, 'playback');
  p.media.setContext({ phase: 'listening', audioSource: 'microphone' }); assert.equal(p.audioSession.type, 'play-and-record');
  p.media.setContext({ phase: 'listening', audioSource: 'tab' }); assert.equal(p.audioSession.type, 'auto');
  p.media.setContext({ phase: 'idle' }); p.media.close(); assert.equal(p.audioSession.type, 'auto');
  const noop = createSpeechMediaSession({ navigator: {}, Metadata: undefined });
  noop.activate(options); noop.setPaused(true); noop.close();
  const handlers = [];
  const partial = createSpeechMediaSession({ navigator: { mediaSession: { setActionHandler(action) { if (action === 'stop') throw new Error('unsupported'); handlers.push(action); } } }, Metadata: class { constructor() { throw new Error('unsupported'); } } });
  partial.activate(options); partial.close(); assert.deepEqual(handlers, ['play', 'pause', 'play', 'pause']);
});

test('实际播放器暂停保留 Worklet，恢复音量；晚到的 resume 不得覆盖再次暂停', async t => {
  class Context {
    state = 'running'; currentTime = 0; destination = {}; audioWorklet = { async addModule() {} };
    gain = { value: 1, cancelScheduledValues() {}, setTargetAtTime(value) { this.value = value; } };
    createGain() { return { gain: this.gain, connect() {}, disconnect() {} }; }
    async suspend() { this.state = 'suspended'; this.onstatechange?.(); }
    async resume() { this.state = 'running'; this.onstatechange?.(); }
    async close() { this.state = 'closed'; }
  }
  class Node { port = { postMessage() {}, close() {} }; connect() {} disconnect() {} }
  for (const [name, value] of Object.entries({ AudioContext: Context, AudioWorkletNode: Node })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  const events = [], p = new SpeechPlayer(event => events.push(event)); await p.unlock(.8);
  const node = p.node;
  p.pause(); p.volume(.3); assert.equal(p.gain.gain.value, 0); assert.equal(events.length, 0);
  assert.equal(await p.resume(), true); assert.equal(p.node, node); assert.equal(p.gain.gain.value, .3);
  p.context.state = 'interrupted'; p.context.onstatechange(); assert.equal(events.at(-1).type, 'suspended');
  p.pause(); let release; p.context.resume = () => new Promise(resolve => { release = resolve; });
  const resuming = p.resume(); p.pause(); release(); assert.equal(await resuming, false); assert.equal(p.gain.gain.value, 0);
  p.close(); assert.equal(p.context.onstatechange, null);
});
