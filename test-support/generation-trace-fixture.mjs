import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { deadline } from './lifecycle.mjs';
import { normalizeGenerationTrace, generationReplayRefinement } from '../scripts/lib/generation-protocol-replay.mjs';

export async function runGenerationWitness(argv, { cwd, env, timeoutMs = 10000, signal } = {}) {
  const startedAt = new Date().toISOString(), started = performance.now();
  const emptyStream = () => ({ chunks: 0, bytes: 0, firstAtMs: null, lastAtMs: null });
  const lifecycle = { spawn: null, stdout: emptyStream(), stderr: emptyStream(), exit: null, close: null };
  const elapsed = () => Math.round((performance.now() - started) * 1000) / 1000;
  try {
    const pending = promisify(execFile)(process.execPath, argv, { cwd, env, timeout: timeoutMs, signal });
    const child = pending.child;
    child.once('spawn', () => { lifecycle.spawn = { atMs: elapsed(), pid: child.pid }; });
    for (const stream of ['stdout', 'stderr']) child[stream]?.on('data', chunk => {
      // Parent delivery times, not claims about when the child printed or ran.
      const output = lifecycle[stream], atMs = elapsed();
      output.firstAtMs ??= atMs; output.lastAtMs = atMs;
      output.chunks++; output.bytes += Buffer.byteLength(chunk);
    });
    child.once('exit', (code, signal) => { lifecycle.exit = { atMs: elapsed(), code, signal }; });
    child.once('close', (code, signal) => { lifecycle.close = { atMs: elapsed(), code, signal }; });
    return await pending;
  }
  catch (error) {
    error.witnessExecution = { command: process.execPath, argv, cwd, timeoutMs, startedAt, finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started), code: error.code ?? null, signal: error.signal ?? null,
      killed: error.killed === true, stdout: error.stdout ?? '', stderr: error.stderr ?? '', lifecycle: structuredClone(lifecycle) };
    error.message += `\nGeneration witness execution: ${JSON.stringify(error.witnessExecution)}`;
    throw error;
  }
}

export async function fixedTrace(t, protocol = 'relation', actors = 1, capacity = 1, name = 'normalSuccessTest', refinement = false, { deadlineAt = Infinity } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-generation-itf-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = fileURLToPath(new URL('../', import.meta.url)), env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const timeoutMs = Math.min(10000, Math.ceil(deadlineAt - performance.now()));
  if (!(timeoutMs > 0)) throw Object.assign(new Error('Shared generation witness deadline exhausted before invocation'), { code: 'GENERATION_WITNESS_BUDGET_EXHAUSTED' });
  await runGenerationWitness(['node_modules/@informalsystems/quint/dist/src/cli.js', 'test',
    `verification/generation-protocol/${refinement ? 'replay-witnesses' : 'witnesses'}.qnt`, '--main', `${refinement ? 'replay_' : ''}${protocol}_${actors === 1 ? 'single' : `multi_cap${capacity}`}_witnesses`,
    '--match', name, '--backend', 'typescript', '--seed', '42', '--max-samples', '1', '--out-itf', path.join(directory, '{test}-{seq}.itf.json')],
  { cwd, env, timeoutMs, signal: t.signal });
  const files = (await readdir(directory)).filter(file => file.endsWith('.itf.json')); assert.equal(files.length, 1);
  return normalizeGenerationTrace(JSON.parse(await readFile(path.join(directory, files[0]), 'utf8')), { protocol, actors, capacity, ...(refinement ? { refinement: generationReplayRefinement } : {}) });
}


// A test-only lifetime wrapper. The shared protocol driver and production
// schedulers retain their existing contracts and limits.
export function generationDeadlineFactory(createAdapter, { deadlineAt, signal }) {
  return async config => {
    if (signal?.aborted) throw new Error('Generation replay aborted');
    if (performance.now() >= deadlineAt) throw new Error('Generation replay deadline exceeded');
    let adapter, timer, stopped, closing, closed = false;
    const active = new Set();
    let rejectStopped;
    const interrupted = new Promise((_, reject) => { rejectStopped = reject; });
    interrupted.catch(() => {});
    const creation = Promise.resolve().then(() => { check(); return createAdapter(config); });
    const close = () => {
      if (closing) return closing;
      closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const cleanup = (async () => {
        const actual = await creation;
        // restart owns a temporary close/reopen transaction. Let its already
        // bounded in-flight operation finish before closing the reopened owner.
        await Promise.allSettled([...active].filter(row => row.action === 'restart').map(row => row.promise));
        const closingAdapter = Promise.resolve().then(() => actual.close());
        closingAdapter.catch(() => {});
        await Promise.allSettled([...active].map(row => row.promise));
        await closingAdapter;
      })();
      closing = deadline(() => cleanup, 5000, 'Generation replay cleanup');
      closing.catch(() => {});
      return closing;
    };
    const stop = reason => {
      if (stopped) return;
      stopped = new Error(`Generation replay ${reason}`); rejectStopped(stopped);
      close().catch(() => {});
    };
    const abort = () => stop('aborted');
    const check = () => {
      if (!stopped && performance.now() >= deadlineAt) stop('deadline exceeded');
      if (stopped) throw stopped;
      if (closed) throw new Error('Generation replay already closed');
    };
    timer = setTimeout(() => stop('deadline exceeded'), Math.max(0, deadlineAt - performance.now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      adapter = await Promise.race([creation, interrupted]); check();
      return { ...adapter,
        project() { check(); return adapter.project(); },
        observe() { check(); return adapter.observe(); },
        check() { check(); return adapter.check?.() || []; },
        async act(step) {
          check();
          const row = { action: step.action, promise: Promise.resolve().then(() => { check(); return adapter.act(step); }) };
          active.add(row); row.promise.then(() => active.delete(row), () => active.delete(row));
          await Promise.race([row.promise, interrupted]); check();
        }, close };
    } catch (error) { await close(); throw error; }
  };
}
