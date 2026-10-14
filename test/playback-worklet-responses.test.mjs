import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capturePlaybackWorkletResponses, playbackWorkletFiles } from '../test-support/playback-worklet-responses.mjs';
import { playbackFixture } from '../test-support/playback-speech-fixture.mjs';
import { startServer } from '../test-support/server-fixture.mjs';
import { deadline, stopChild } from '../test-support/lifecycle.mjs';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { runProcess } from '../scripts/lib/process.mjs';

async function observedServer(t, handler) {
  const capture = await capturePlaybackWorkletResponses();
  t.after(() => capture.close());
  const app = await startServer({ env: capture.env, args: [...capture.imports.flatMap(file => ['--import', file]), '--input-type=module', '-e', `
    import http from 'node:http'; import assert from 'node:assert/strict';
    let held, callbacks = 0;
    const server = http.createServer((req, res) => { ${handler} });
    server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
  `] });
  t.after(() => stopChild(app.child));
  return { ...app, capture };
}
async function records(capture, count) {
  let rows;
  await deadline(async () => {
    do {
      rows = await capture.read();
      if (rows.length >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (true);
  }, 3000, 'server response log finish');
  return rows;
}

test('server observer captures only completed allowlisted GET bytes without changing write/end semantics', { timeout: 10000 }, async t => {
  const fixture = await observedServer(t, `
    if (req.url === '/release') { held.end(new Uint8Array([0, 255, 42])); return res.end('released'); }
    if (req.url !== '/speech-output-processor.js') return res.end('unrelated content');
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'X-Fixture': 'unchanged' });
    assert.equal(typeof res.write('中', 'utf8', () => {}), 'boolean');
    assert.equal(typeof res.write('é', 'latin1'), 'boolean');
    held = res;
  `);
  assert.deepEqual(await fixture.capture.read(), [], 'No source-file prefill before a request');
  await (await fetch(fixture.base + '/unrelated.js')).text();
  await (await fetch(fixture.base + '/speech-buffer.js', { method: 'HEAD' })).text();
  await (await fetch(fixture.base + '/speech-buffer.js', { method: 'POST' })).text();
  await (await fetch(fixture.base + '/speech-buffer.js?unrelated=1')).text();
  assert.deepEqual(await fixture.capture.read(), [], 'Unrelated paths, methods and query variants are not captured');
  const request = http.get(fixture.base + '/speech-output-processor.js'); t.after(() => request.destroy());
  const [response] = await deadline(() => once(request, 'response'), 3000, 'response headers');
  const chunks = []; response.on('data', chunk => chunks.push(chunk));
  const ended = once(response, 'end');
  assert.deepEqual(await fixture.capture.read(), [], 'A partial response cannot claim completion');
  assert.equal(response.headers['x-fixture'], 'unchanged');
  await (await fetch(fixture.base + '/release')).text();
  await deadline(() => ended, 3000, 'response finish');
  const body = Buffer.concat(chunks), expected = Buffer.concat([Buffer.from('中'), Buffer.from('é', 'latin1'), Buffer.from([0, 255, 42])]);
  assert.deepEqual(body, expected);
  assert.deepEqual(await records(fixture.capture, 1), [{ fixtureId: fixture.capture.fixtureId, origin: fixture.base, source: 'server-response-finish', method: 'GET',
    path: '/speech-output-processor.js', file: 'public/speech-output-processor.js', status: 200, bytes: body.length, sha256: digest(body) }]);
});

test('server observer preserves buffer backpressure, callbacks and end overloads without double-counting', { timeout: 10000 }, async t => {
  const fixture = await observedServer(t, `
    if (req.url === '/callbacks') return res.end(String(callbacks));
    if (req.url === '/speech-output-processor.js') {
      assert.equal(res.write(Buffer.alloc(128 * 1024, 65), () => callbacks++), false);
      assert.equal(res.end(() => callbacks++), res);
    } else {
      assert.equal(res.write(new Uint8Array([1, 2, 3])), true);
      assert.equal(res.end('é', 'latin1', () => callbacks++), res);
    }
  `);
  const first = Buffer.from(await (await fetch(fixture.base + '/speech-output-processor.js')).arrayBuffer());
  const second = Buffer.from(await (await fetch(fixture.base + '/speech-buffer.js')).arrayBuffer());
  assert.deepEqual(first, Buffer.alloc(128 * 1024, 65)); assert.deepEqual(second, Buffer.from([1, 2, 3, 233]));
  const rows = await records(fixture.capture, 2);
  assert.deepEqual(rows.map(row => [row.bytes, row.sha256]), [first, second].map(body => [body.length, digest(body)]));
  let callbacks;
  await deadline(async () => {
    do { callbacks = await (await fetch(fixture.base + '/callbacks')).text(); } while (callbacks !== '3');
  }, 3000, 'write/end callbacks');
});

test('failed, empty, body-suppressed and aborted HTTP responses cannot claim successful module bytes', { timeout: 10000 }, async t => {
  let sequence = 0;
  const fixture = await observedServer(t, `
    const status = Number(req.headers['x-status']);
    if (status === 499) { res.writeHead(200); res.write('partial'); return res.destroy(); }
    res.writeHead(status);
    assert.equal(res.end(status === 200 ? undefined : 'unavailable'), res);
  `);
  for (const status of [404, 200, 204, 304]) {
    const response = await fetch(fixture.base + '/speech-buffer.js', { headers: { 'x-status': String(status) } });
    const body = Buffer.from(await response.arrayBuffer()), rows = await records(fixture.capture, ++sequence);
    assert.equal(rows.length, sequence); assert.equal(rows.at(-1).status, status);
    assert.equal(rows.at(-1).bytes, body.length); assert.equal(rows.at(-1).sha256, digest(body));
    assert.equal(rows.at(-1).status === 200 && rows.at(-1).bytes > 0, false);
  }
  await assert.rejects(fetch(fixture.base + '/speech-buffer.js', { headers: { 'x-status': '499' } }));
  const failedRows = await records(fixture.capture, sequence + 1), aborted = failedRows.at(-1);
  assert.equal(failedRows.length, sequence + 1);
  assert.equal(aborted.source, 'server-response-close', 'Aborted response is visible and cannot claim finish');
});

test('opt-in playback fixture observes its actual server modules with isolated identities and cleans logs', { timeout: 15000 }, async t => {
  const fixtures = [];
  t.after(async () => { for (const fixture of fixtures) await fixture.close(); });
  for (let i = 0; i < 2; i++) {
    const fixture = await playbackFixture({ captureWorkletResponses: true }); fixtures.push(fixture);
    assert.deepEqual(await fixture.workletCapture.read(), []);
    await (await fetch(fixture.base + '/app.js')).arrayBuffer();
    assert.deepEqual(await fixture.workletCapture.read(), []);
    for (const file of playbackWorkletFiles) {
      const body = Buffer.from(await (await fetch(fixture.base + file.slice('public'.length))).arrayBuffer());
      assert.deepEqual(body, await readFile(file));
      const row = (await records(fixture.workletCapture, playbackWorkletFiles.indexOf(file) + 1)).at(-1);
      assert.equal(row.file, file); assert.equal(row.fixtureId, fixture.workletCapture.fixtureId); assert.equal(row.origin, fixture.base);
      assert.equal(row.bytes, body.length); assert.equal(row.sha256, digest(body)); assert.equal(row.status, 200);
    }
  }
  assert.notEqual(fixtures[0].workletCapture.fixtureId, fixtures[1].workletCapture.fixtureId);
  for (const fixture of fixtures) { await fixture.close(); await assert.rejects(fixture.workletCapture.read(), { code: 'ENOENT' }); }
});

test('playback startup failure closes its child, provider servers and independent response log', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'playback-observer-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `import assert from 'node:assert/strict';
    import { playbackFixture } from './test-support/playback-speech-fixture.mjs';
    await assert.rejects(playbackFixture({ captureWorkletResponses: true,
      serverImports: ['data:text/javascript,throw new Error("deliberate startup failure")'] }), /deliberate startup failure/);
  `;
  const result = await runProcess(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory }, timeoutMs: 10000 });
  assert.equal(result.ok, true, result.tail); assert.equal(result.timedOut, false);
  assert.deepEqual(await readdir(directory), []);
});
