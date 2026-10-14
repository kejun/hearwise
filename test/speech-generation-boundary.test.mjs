import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Seed only the real module's initial private counter. This reaches the actual
// uint32/Number boundaries without billions of starts or a production debug API.
async function seededController(epoch, wireMaximum = null) {
  const url = new URL('../public/speech-controller.js', import.meta.url);
  let source = await readFile(url, 'utf8');
  const anchor = 'let epoch = 0,';
  assert.equal(source.split(anchor).length, 2);
  source = source.replace(anchor, `let epoch = ${epoch},`).replace(/from '(\.\/.+?)'/g,
    (_match, target) => `from '${new URL(target, url).href}'`);
  if (wireMaximum !== null) {
    assert.equal(source.split('epoch % 0xffffffff + 1').length, 2);
    source = source.replace('epoch % 0xffffffff + 1', `epoch % ${wireMaximum} + 1`);
  }
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createSpeechController;
}
function setup(create) {
  const sockets = [], players = [], states = [], media = { activate() {}, close() {}, setPaused() {}, setContext() {} };
  const controller = create({ media, document: null, onChange: value => states.push(value), createPlayer(callback) {
    const player = { callback, closed: false, async unlock() {}, pause() {}, async resume() { return true; }, close() { this.closed = true; } };
    players.push(player); return player;
  }, createSocket() {
    const socket = new EventTarget(); socket.readyState = 1; socket.sent = [];
    socket.send = raw => socket.sent.push(JSON.parse(raw)); socket.close = () => { socket.readyState = 3; };
    sockets.push(socket); return socket;
  } });
  const start = async () => { await controller.start({}, { preview: true }); sockets.at(-1).dispatchEvent(new Event('open')); };
  return { controller, start, sockets, players, states };
}

test('playback generation remains valid uint32 across the actual wire boundary', async () => {
  const f = setup(await seededController(0xfffffffe));
  try {
    await f.start(); await f.start();
    const epochs = f.sockets.map(socket => socket.sent[0].epoch);
    assert.deepEqual(epochs, [0xffffffff, 1]);
  } finally { f.controller.stop(); }
});

test('numeric precision exhaustion cannot let an old player or connection affect a newer playback', async () => {
  const f = setup(await seededController(Number.MAX_SAFE_INTEGER));
  try {
    await f.start(); const oldPlayer = f.players[0], oldSocket = f.sockets[0];
    await f.start(); const current = f.players.at(-1);
    oldPlayer.callback({ type: 'suspended' });
    assert.equal(f.controller.paused, false, 'Old player callback must not pause new playback');
    oldSocket.dispatchEvent(new Event('close'));
    assert.equal(f.controller.enabled, true); assert.equal(current.closed, false);
  } finally { f.controller.stop(); }
});


test('reusing a bounded wire epoch does not reuse local callback ownership', async () => {
  // Accelerate only the production wire counter's modulus to two valid epochs.
  // All actual controller callback/ownership guards stay unchanged.
  const f = setup(await seededController(0, 2));
  try {
    await f.start(); const oldPlayer = f.players[0], oldSocket = f.sockets[0];
    await f.start(); await f.start(); const current = f.players.at(-1);
    assert.deepEqual(f.sockets.map(socket => socket.sent[0].epoch), [1, 2, 1]);
    oldPlayer.callback({ type: 'suspended' });
    oldSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ epoch: 1, type: 'speech.error', message: 'old failure' }) }));
    oldSocket.dispatchEvent(new Event('close'));
    assert.equal(f.controller.enabled, true); assert.equal(f.controller.paused, false); assert.equal(current.closed, false);
  } finally { f.controller.stop(); }
});
