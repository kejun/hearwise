import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { deadline, stopChild, closeServer } from '../test-support/lifecycle.mjs';
import http from 'node:http';

const root = process.cwd();
test('process watchdog retains failure output and kills a stuck process', async () => {
  const result = await runProcess(process.execPath, ['-e', "console.log('last state: waiting'); setInterval(()=>{},1000)"], { timeoutMs: 300, graceMs: 100 });
  assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.match(result.tail, /last state: waiting/);
  assert.ok(result.durationMs < 3000);
});
test('process runner propagates nonzero exit and persists evidence', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workflow-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'output.log');
  const result = await runProcess(process.execPath, ['-e', "console.error('failed boundary'); process.exit(7)"], { logFile: log });
  assert.equal(result.code, 7); assert.equal(result.ok, false); assert.match(await readFile(log, 'utf8'), /failed boundary/);
});
test('process group cleanup covers grandchildren retaining inherited stdout', async () => {
  const source = "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); process.exit(0)";
  const result = await runProcess(process.execPath, ['-e', source], { timeoutMs: 300, graceMs: 100 });
  assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.ok(result.durationMs < 3000);
});
test('fixture teardown kills a SIGTERM-resistant server and reports the timeout', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await deadline(() => once(child.stdout, 'data'), 2000, 'child startup');
    await assert.rejects(stopChild(child, 100), /shutdown exceeded/);
    assert.equal(child.signalCode, 'SIGKILL');
    await stopChild(child); // Closing an exited child is safe.
  } finally { child.kill('SIGKILL'); }
});
test('HTTP teardown closes a response that never ends', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.write('partial'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const req = http.get(`http://127.0.0.1:${server.address().port}`); req.on('error', () => {});
  await once(req, 'response'); await closeServer(server, 'stuck response');
  assert.equal(server.listening, false);
});
test('format check rejects CRLF and missing EOF, accepts normalized text', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'format-')); t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  await writeFile(path.join(dir, 'sample.js'), 'a\r\nb'); execFileSync('git', ['add', 'sample.js'], { cwd: dir });
  const script = path.join(root, 'scripts/check-text-format.mjs');
  const bad = await runProcess(process.execPath, [script], { cwd: dir });
  assert.equal(bad.ok, false); assert.match(bad.tail, /LF line endings/); assert.match(bad.tail, /final newline/);
  await writeFile(path.join(dir, 'sample.js'), 'a\nb\n');
  assert.equal((await runProcess(process.execPath, [script], { cwd: dir })).ok, true);
});
