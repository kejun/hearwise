import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createPlaybackAdapter } from '../test-support/playback-protocol-adapter.mjs';

async function withAdapter(action) {
  const adapter = await createPlaybackAdapter();
  try { await action(adapter); } finally { await adapter.close(); }
  await assert.rejects(access(adapter.root), { code: 'ENOENT' });
}
const current = adapter => adapter.observe().generations.at(-1);

test('actual service/player/worklet consumes the two accepted SQLite text units and finishes after settlement', async () => {
  await withAdapter(async a => {
    const id = await a.start(); await a.unlock(id);
    assert.deepEqual(current(a).requested, ['甲。']);
    await a.pcm(id); await a.complete(id);
    assert.deepEqual(current(a).requested, ['甲。', '乙。']);
    await a.pcm(id); await a.complete(id);
    assert.deepEqual(current(a).accepted, ['甲。', '乙。']);
    assert.equal(current(a).consumedSamples, 0); assert.equal(current(a).finished, false);
    const rendered = await a.consume(id);
    assert.deepEqual(rendered, [513 / 32768, 1027 / 32768, 513 / 32768, 1027 / 32768]);
    assert.equal(current(a).played, 2); assert.equal(current(a).consumedSamples, 4);
    assert.equal(current(a).finished, true); assert.equal(a.controller.enabled, true);
    await a.settled(id); assert.equal(a.controller.enabled, false);
  });
});

test('pause permits the already-running provider to finish but seek stays silent until explicit resume completes', async () => {
  await withAdapter(async a => {
    const first = await a.start(); await a.unlock(first); await a.pause();
    await a.pcm(first); await a.complete(first); await a.consume(first);
    assert.equal(current(a).bufferedSamples, 2); assert.equal(current(a).consumedSamples, 0);
    assert.deepEqual(current(a).requested, ['甲。']);
    const next = await a.seek(2); await a.unlock(next);
    assert.equal(a.controller.paused, true); assert.deepEqual(current(a).requested, []);
    await a.resume(); assert.equal(a.observe().resuming, true); assert.deepEqual(current(a).requested, []);
    await a.resumeComplete(next); assert.deepEqual(current(a).requested, ['乙。']);
    await a.pcm(next); await a.complete(next); await a.consume(next);
    assert.deepEqual(current(a).accepted, ['乙。']); assert.equal(current(a).consumedSamples, 2);
    await a.settled(next);
  });
});

test('a stopped provider may ignore cancellation; its late PCM and completion never cross the new record generation', async () => {
  await withAdapter(async a => {
    const old = await a.start(); await a.unlock(old);
    const next = await a.start('B'); await a.unlock(next);
    const before = current(a);
    await a.pcm(old); await a.complete(old);
    for (const event of ['close', 'socket-error', 'suspended', 'error']) await a.late(old, event);
    assert.deepEqual(current(a), before); assert.equal(a.controller.enabled, true); assert.equal(a.controller.paused, false);
    assert.equal(a.observe().generations[0].sentFrames, 0);
    await a.pcm(next); await a.complete(next); assert.deepEqual(current(a).accepted, ['丙。', '丁。']);
  });
});

test('pending native resume cannot undo a later pause, stop, or record switch', async () => {
  for (const later of ['pause', 'stop', 'switch']) await withAdapter(async a => {
    const old = await a.start(); await a.unlock(old); await a.pause(); await a.resume();
    if (later === 'pause') await a.pause();
    else if (later === 'stop') await a.stop();
    else { const next = await a.start('B'); await a.unlock(next); }
    const before = a.observe(); await a.resumeComplete(old);
    assert.deepEqual(a.observe(), before);
  });
});

test('late initial AudioContext unlock and final device settlement cannot restart or stop a newer generation', async () => {
  await withAdapter(async a => {
    const old = await a.start(); const next = await a.start('B'); await a.unlock(next);
    const before = a.observe(); await a.unlock(old); assert.deepEqual(a.observe(), before);
    await a.pcm(next); await a.complete(next); await a.pcm(next); await a.complete(next); await a.consume(next);
    assert.equal(current(a).settling, true);
    const last = await a.start('A'); await a.unlock(last); const stable = a.observe();
    await a.settled(next); assert.deepEqual(a.observe(), stable);
  });
});

test('the real player ignores a wrong epoch but rejects reordered, interleaved, duplicate, and malformed current frames', async () => {
  for (const frame of [{ frame: 1 }, { unit: 2 }, { declaredSamples: 3 }, { duplicate: true }]) await withAdapter(async a => {
    const id = await a.start(); await a.unlock(id);
    const before = a.observe(); await a.frame(id, { epoch: 999 }); assert.deepEqual(a.observe(), before);
    if (frame.duplicate) await a.pcm(id);
    await a.frame(id, frame);
    assert.equal(a.controller.enabled, false); assert.equal(current(a).closed, true); assert.equal(current(a).providerClosed, true);
    assert.deepEqual(current(a).requested, ['甲。']);
  });
});

test('an actual controller-copy missing its owner fence is caught after finite wire epoch reuse', async () => {
  const run = async mutation => {
    const a = await createPlaybackAdapter({ wireModulus: 2, ...(mutation ? { mutation } : {}) });
    try {
      for (let n = 0; n < 3; n++) { const id = await a.start(); await a.unlock(id); }
      assert.deepEqual(a.observe().generations.map(g => g.epoch), [1, 2, 1]);
      await a.late(1, 'suspended'); return a.observe();
    } finally { await a.close(); }
  };
  const expected = await run(); const actual = await run('old-player-callback');
  assert.equal(expected.paused, false); assert.equal(actual.paused, true);
  assert.equal(expected.active, actual.active); assert.equal(actual.active, 3);
});

test('a failed fixture initialization restores platform globals and permits the next isolated adapter', async () => {
  const keys = ['AudioContext', 'AudioWorkletNode', 'AudioWorkletProcessor', 'sampleRate', 'registerProcessor'];
  const before = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  await assert.rejects(createPlaybackAdapter({ afterPlatformInstall() { throw new Error('fixture setup fault'); } }), /fixture setup fault/);
  assert.deepEqual(keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key)), before);
  await withAdapter(async a => { const id = await a.start(); await a.unlock(id); });
});
