import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { QwenTts } from '../qwen-tts.mjs';
import { closeServer } from '../test-support/lifecycle.mjs';

// Ordered transport of a delayed/duplicate provider event is not TCP packet
// reordering. The second task has already received its own response.created.
test('a late old response.created cannot reassign the active Qwen response or leak its PCM', { timeout: 5000 }, async () => {
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
      if (++commits === 1) { created('old-completed'); audio('old-completed', 111); done('old-completed'); }
      else {
        created('new-current'); created('old-completed'); audio('old-completed', 777); done('old-completed');
        audio('new-current', 222); done('new-current');
      }
    });
  });
  const tts = new QwenTts({ key: 'local-fixture-only', region: 'beijing', voice: 'Cherry', rate: 1 },
    { endpoint: `ws://127.0.0.1:${server.address().port}`, timeoutMs: 1000 });
  try {
    const first = [], second = [];
    assert.equal((await tts.synthesize('First accepted text.', pcm => first.push(pcm.readInt16LE()))).id, 'old-completed');
    const result = await tts.synthesize('Second accepted text.', pcm => second.push(pcm.readInt16LE()));
    assert.equal(result.id, 'new-current'); assert.deepEqual(first, [111]); assert.deepEqual(second, [222]); assert.equal(commits, 2);
  } finally { tts.close(); await closeServer(server, 'Qwen response ownership fixture'); }
});
