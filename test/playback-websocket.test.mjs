import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playbackFixture, playbackSocket, playbackWait, playbackGolden } from '../test-support/playback-speech-fixture.mjs';
import { speechIntervalLedger } from '../test-support/playback-text-contract.mjs';

test('real server stop closes the old socket even with an obsolete epoch and isolates the next record', { timeout: 15000 }, async t => {
  const fixture = await playbackFixture({ hold: true }); t.after(() => fixture.close());
  const old = await playbackSocket(fixture, 'A', 7); t.after(() => old.ws.terminate());
  await playbackWait(() => fixture.held.length === 1, 'first held synthesis');
  old.send({ type: 'speech.stop', epoch: 999 });
  await playbackWait(() => old.ws.readyState === 3 && fixture.held[0].ws.readyState === 3, 'old browser and provider sockets close');
  const oldEvents = structuredClone(old.events);
  const next = await playbackSocket(fixture, 'B', 8); t.after(() => next.ws.terminate());
  await playbackWait(() => fixture.held.length === 2, 'new record synthesis');
  assert.equal(fixture.held[0].sendDefault(), false, 'the retired real transport is closed');
  fixture.held[1].sendDefault();
  await playbackWait(() => next.events.some(e => e.type === 'speech.unit-end'), 'new PCM and unit end');
  assert.ok(next.packets.length); assert.ok(next.packets.every(packet => packet.readUInt32LE(0) === 8));
  assert.deepEqual(old.events, oldEvents); assert.equal(old.packets.length, 0);
  assert.deepEqual(next.events.filter(e => e.type === 'speech.unit').map(e => e.text), ['丙。', '丁。']);
  assert.equal(fixture.stats.commits.filter(text => text === '甲。').length, 1);
});

test('real paused server accepts its in-flight response but starts no next synthesis until resume', { timeout: 15000 }, async t => {
  const fixture = await playbackFixture({ hold: true }); t.after(() => fixture.close());
  const client = await playbackSocket(fixture, 'A', 11); t.after(() => client.ws.terminate());
  await playbackWait(() => fixture.held.length === 1, 'held first unit');
  client.send({ type: 'speech.pause' });
  await playbackWait(() => client.events.some(e => e.type === 'speech.state' && e.state === 'paused'), 'server pause acknowledgement');
  fixture.held[0].sendDefault();
  await playbackWait(() => client.events.some(e => e.type === 'speech.unit-end'), 'paused in-flight completion');
  assert.equal(fixture.stats.commits.length, 1); assert.equal(client.samples(), 4);
  client.send({ type: 'speech.resume' });
  await playbackWait(() => fixture.held.length === 2, 'next synthesis after resume');
  fixture.held[1].sendDefault();
  await playbackWait(() => client.events.filter(e => e.type === 'speech.unit-end').length === 2, 'second completion');
  assert.deepEqual(fixture.stats.commits, ['甲。', '乙。']); client.acknowledge();
  await playbackWait(() => client.events.some(e => e.type === 'speech.finished'), 'playback finished');
});

test('real Qwen and Fish requests partition independently normalized Unicode and long text without lexical gaps', { timeout: 15000 }, async t => {
  const fixture = await playbackFixture(); t.after(() => fixture.close());
  for (const provider of ['qwen', 'fish']) {
    const before = provider === 'qwen' ? fixture.stats.commits.length : fixture.stats.fishRequests.length;
    const config = provider === 'qwen' ? undefined : { provider: 'fish', key: 'local-fixture-only', model: 's2.1-pro-free', referenceId: 'fixture', rate: 1, latency: 'balanced' };
    const client = await playbackSocket(fixture, 'Text', provider === 'qwen' ? 21 : 22, config); t.after(() => client.ws.terminate());
    client.ws.on('message', (data, binary) => { if (!binary && JSON.parse(data).type === 'speech.unit-end') client.acknowledge(); });
    await playbackWait(() => client.events.some(e => e.type === 'speech.finished'), `${provider} normalized transcript completion`);
    const requests = provider === 'qwen' ? fixture.stats.commits.slice(before) : fixture.stats.fishRequests.slice(before).map(r => r.body.text);
    assert.ok(requests.length > 2); speechIntervalLedger(playbackGolden, requests, { graphemeSafe: true });
    assert.deepEqual(client.events.filter(e => e.type === 'speech.unit').map(e => e.text), requests);
    assert.equal(client.samples(), requests.length * 4);
    assert.equal(client.events.filter(e => e.type === 'speech.unit-end').length, requests.length);
    let unit = 0, frame = 0;
    for (const packet of client.packets) {
      const nextUnit = packet.readUInt32LE(4); if (nextUnit !== unit) { assert.equal(nextUnit, unit + 1); unit = nextUnit; frame = 0; }
      assert.equal(packet.readUInt32LE(8), frame++); assert.equal(packet.length, 16 + packet.readUInt32LE(12) * 2);
    }
  }
});
