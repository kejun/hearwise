import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { QwenTts } from '../qwen-tts.mjs';
import { closeServer, deadline } from '../test-support/lifecycle.mjs';

// These are ordered transport deliveries of delayed provider events, not TCP
// packet reordering. Retired IDs must stay excluded for the whole connection.
for (const [label, currentFirst, completedTasks] of [
  ['after the current created event', true, 1],
  ['before the current created event', false, 1],
  ['from earlier completed history', false, 3]
]) test(`a retired Qwen response ${label} cannot own a new task`, { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let commits = 0;
  server.on('connection', ws => {
    const send = event => ws.send(JSON.stringify(event));
    const audio = (id, sample) => { const pcm = Buffer.alloc(2); pcm.writeInt16LE(sample); send({ type: 'response.audio.delta', response_id: id, delta: pcm.toString('base64') }); };
    const created = id => send({ type: 'response.created', response: { id } });
    const done = id => send({ type: 'response.done', response: { id, status: 'completed' } });
    send({ type: 'session.created' });
    ws.on('message', raw => {
      const event = JSON.parse(raw);
      if (event.type === 'session.update') send({ type: 'session.updated' });
      if (event.type !== 'input_text_buffer.commit') return;
      if (++commits <= completedTasks) { const id = `completed-${commits}`; created(id); audio(id, 111); done(id); }
      else {
        if (currentFirst) created('new-current');
        created('completed-1'); audio('completed-1', 777); done('completed-1');
        if (!currentFirst) created('new-current');
        audio('new-current', 222); done('new-current');
      }
    });
  });
  const tts = new QwenTts({ key: 'local-fixture-only', region: 'beijing', voice: 'Cherry', rate: 1 },
    { endpoint: `ws://127.0.0.1:${server.address().port}`, timeoutMs: 1000 });
  try {
    const first = [], second = [];
    for (let n = 1; n <= completedTasks; n++)
      assert.equal((await tts.synthesize(`Accepted text ${n}.`, pcm => first.push(pcm.readInt16LE()))).id, `completed-${n}`);
    const result = await tts.synthesize('Second accepted text.', pcm => second.push(pcm.readInt16LE()));
    assert.equal(result.id, 'new-current'); assert.deepEqual(first, Array(completedTasks).fill(111)); assert.deepEqual(second, [222]); assert.equal(commits, completedTasks + 1);
  } finally { tts.close(); await closeServer(server, 'Qwen response ownership fixture'); }
});

// Exercise the actual bound, without substituting a smaller test-only limit.
test('Qwen retires a full response-ID history by rotating its idle connection before request 4097', { timeout: 30000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let commits = 0, connections = 0, releaseFinal;
  const finalStarted = Promise.withResolvers();
  server.on('connection', ws => {
    const connection = ++connections; let localCommits = 0;
    const send = event => ws.send(JSON.stringify(event));
    send({ type: 'session.created' });
    ws.on('message', raw => {
      const event = JSON.parse(raw);
      if (event.type === 'session.update') send({ type: 'session.updated' });
      if (event.type !== 'input_text_buffer.commit') return;
      const id = `response-${++localCommits}`; commits++;
      send({ type: 'response.created', response: { id } });
      const finish = () => {
        send({ type: 'response.audio.delta', response_id: id, delta: 'AQI=' });
        send({ type: 'response.done', response: { id, status: 'completed' } });
      };
      if (commits === 4097) { releaseFinal = finish; finalStarted.resolve(connection); } else finish();
    });
  });
  const tts = new QwenTts({ key: 'local-fixture-only', region: 'beijing', voice: 'Cherry', rate: 1 },
    { endpoint: `ws://127.0.0.1:${server.address().port}`, timeoutMs: 1000 });
  try {
    let pcmCount = 0;
    for (let n = 1; n <= 4096; n++) {
      const result = await tts.synthesize(`Unit ${n}.`, () => pcmCount++);
      assert.equal(result.id, `response-${n}`); assert.equal(result.attempts, 1);
    }
    const retired = tts.ws;
    assert.equal(connections, 1); assert.equal(commits, 4096); assert.equal(pcmCount, 4096);
    assert.equal(tts.responseIds.size, 4096);
    const final = tts.synthesize('Unit 4097.', () => pcmCount++);
    // Attach rejection handling before injecting queued old-socket callbacks.
    const outcome = final.then(value => ({ value }), error => ({ error }));
    assert.equal(await deadline(() => finalStarted.promise, 2000, 'rotated request'), 2);
    assert.notEqual(tts.ws, retired); assert.equal(commits, 4097);
    // Actual ws handlers see callbacks queued from the retired transport. The
    // new connection may reuse an ID because its identity, not just the set, changed.
    retired.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'late-old' } })));
    retired.emit('message', Buffer.from(JSON.stringify({ type: 'response.audio.delta', response_id: 'late-old', delta: 'AwQ=' })));
    retired.emit('close'); retired.emit('error', new Error('queued retired transport error'));
    releaseFinal();
    const result = await deadline(() => outcome, 2000, 'rotated result');
    assert.equal(result.error, undefined); assert.equal(result.value.id, 'response-1'); assert.equal(result.value.attempts, 1);
    assert.equal(connections, 2); assert.equal(commits, 4097); assert.equal(pcmCount, 4097);
    assert.deepEqual([...tts.responseIds], ['response-1']);
  } finally { tts.close(); await closeServer(server, 'Qwen bounded response history fixture'); }
});

test('Qwen history also bounds retained response-ID bytes without rejecting long valid IDs or replaying text', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let connections = 0, commits = 0;
  server.on('connection', ws => {
    connections++; let local = 0; const send = event => ws.send(JSON.stringify(event));
    send({ type: 'session.created' });
    ws.on('message', raw => {
      const event = JSON.parse(raw);
      if (event.type === 'session.update') send({ type: 'session.updated' });
      if (event.type !== 'input_text_buffer.commit') return;
      commits++; const id = String(++local) + '😀'.repeat(131071) + 'xyz';
      assert.equal(Buffer.byteLength(id), 512 * 1024);
      send({ type: 'response.created', response: { id } });
      send({ type: 'response.audio.delta', response_id: id, delta: 'AQI=' });
      send({ type: 'response.done', response: { id, status: 'completed' } });
    });
  });
  const tts = new QwenTts({ key: 'local-fixture-only', region: 'beijing', voice: 'Cherry', rate: 1 },
    { endpoint: `ws://127.0.0.1:${server.address().port}`, timeoutMs: 1000 });
  try {
    let received = 0;
    for (let n = 1; n <= 3; n++) {
      const result = await tts.synthesize(`Accepted unit ${n}.`, () => received++);
      assert.equal(result.attempts, 1); assert.equal(Buffer.byteLength(result.id), 512 * 1024);
    }
    assert.equal(connections, 2); assert.equal(commits, 3); assert.equal(received, 3);
    assert.equal(tts.responseIds.size, 1); assert.equal(tts.responseIdBytes, 512 * 1024);
  } finally { tts.close(); await closeServer(server, 'Qwen response byte-history fixture'); }
});
