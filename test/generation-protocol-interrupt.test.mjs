import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deadline, stopChild } from '../test-support/lifecycle.mjs';

test('actual generation process supervisor captures SIGINT and terminates a pending isolated worker', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-generation-interrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = new URL('../scripts/lib/generation-protocol-runner.mjs', import.meta.url).href;
  // Exercise the exact supervisor used by the CLI, before any model work. This
  // control requires no Java cache and does not pretend that a checker ran.
  const worker = "console.log('GENERATION_INTERRUPT_READY '+process.pid);setInterval(()=>{},1000)";
  const script = `import {superviseGenerationWorker} from ${JSON.stringify(module)};import{writeFile}from'node:fs/promises';
    const result=await superviseGenerationWorker(['--input-type=module','-e',${JSON.stringify(worker)}],{directory:${JSON.stringify(directory)},timeoutMs:10000});
    await writeFile(${JSON.stringify(path.join(directory, 'execution.json'))},JSON.stringify(result));process.exitCode=result.execution.ok?0:1;`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stopChild(child)); let output = '', workerPid;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const started = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', () => reject(new Error(`Exited before worker startup: ${output}`)));
    const record = bytes => { output += bytes; const match = output.match(/GENERATION_INTERRUPT_READY (\d+)/); if (match) { workerPid = Number(match[1]); resolve(); } };
    child.stdout.on('data', record); child.stderr.on('data', record);
  });
  await deadline(() => started, 10000, 'generation actual worker startup');
  child.kill('SIGINT'); const exit = await deadline(() => exited, 7000, 'generation supervisor interrupted exit');
  assert.equal(exit.code, 1); assert.equal(exit.signal, null);
  const result = JSON.parse(await readFile(path.join(directory, 'execution.json')));
  assert.equal(result.execution.ok, false); assert.equal(result.execution.interrupted, true); assert.equal(result.execution.timedOut, false);
  assert.equal(result.execution.signal, 'SIGTERM'); assert.equal(result.execution.code, null);
  assert.match(await readFile(path.join(directory, 'supervisor.log'), 'utf8'), new RegExp(`GENERATION_INTERRUPT_READY ${workerPid}`));
  assert.throws(() => process.kill(workerPid, 0), error => error.code === 'ESRCH', 'the isolated worker must really have exited');
});
