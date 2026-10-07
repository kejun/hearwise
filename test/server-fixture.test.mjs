import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { startServer } from '../test-support/server-fixture.mjs';
import { closeServer, deadline, stopChild } from '../test-support/lifecycle.mjs';
import { runProcess } from '../scripts/lib/process.mjs';

test('server startup rejects early exit with exit details and captured logs', async () => {
  await assert.rejects(startServer({ args: ['-e', "console.error('fixture startup failed'); process.exit(23)"] }),
    error => /code=23/.test(error.message) && /fixture startup failed/.test(error.message));
});

test('server startup accumulates split output and waits for the complete port', async t => {
  const app = await startServer({ args: ['-e', `
    process.stdout.write('http://127.0.');
    setTimeout(() => process.stdout.write('0.1:12'), 20);
    setTimeout(() => process.stdout.write('345\\nnext partial line'), 40);
    setInterval(() => {}, 1000);
  `] });
  t.after(() => stopChild(app.child));
  assert.equal(app.base, 'http://127.0.0.1:12345');
});

test('missing startup message has a named timeout and kills the child', async () => {
  let pid;
  await assert.rejects(startServer({ timeoutMs: 1000, args: ['-e', "console.log('fixture-pid:' + process.pid); setInterval(() => {}, 1000)"] }),
    error => {
      pid = Number(error.message.match(/fixture-pid:(\d+)/)?.[1]);
      return /Server startup exceeded 1000ms/.test(error.message) && Number.isInteger(pid) && pid > 0;
    });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('ASR fixture teardown terminates live WebSocket clients', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => server.address() && closeServer(server, 'ASR'));
  await deadline(() => once(server, 'listening'), 5000, 'ASR startup');
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => ws.terminate());
  await deadline(() => once(ws, 'open'), 5000, 'Client open');
  const closed = once(ws, 'close');
  await closeServer(server, 'ASR');
  await deadline(() => closed, 5000, 'Client close');
  assert.equal(server.clients.size, 0);
});

test('ASR parameter test ignores an occupied legacy random port and exits cleanly', async t => {
  let blocker, port;
  // Reserve an available port from the old range, without assuming 38000 is free.
  for (port = 38000; port < 39000; port++) {
    blocker = net.createServer(socket => socket.destroy());
    try {
      blocker.listen(port, '127.0.0.1');
      await once(blocker, 'listening');
      break;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  assert.ok(port < 39000, 'No available legacy port for collision regression');
  t.after(() => closeServer(blocker, 'port blocker'));
  const preload = 'data:text/javascript,' + encodeURIComponent(`Math.random = () => ${(port - 38000 + 0.5) / 1000};`);
  const env = { ...process.env };
  // This is an isolated regression run, not a recursive node:test invocation.
  delete env.NODE_TEST_CONTEXT;
  const result = await runProcess(process.execPath, ['--import=' + preload, '--test', '--test-timeout=30000', 'test/asr-params.test.mjs'],
    { env, timeoutMs: 10000 });
  assert.equal(result.timedOut, false, result.tail);
  assert.equal(result.ok, true, result.tail);
  assert.match(result.tail, /ASR 断句参数按 run 下发/);
});
