import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { normalizeGenerationTrace, generationReplayRefinement } from '../scripts/lib/generation-protocol-replay.mjs';

export async function runGenerationWitness(argv, { cwd, env, timeoutMs = 10000, signal } = {}) {
  const startedAt = new Date().toISOString(), started = performance.now();
  try { return await promisify(execFile)(process.execPath, argv, { cwd, env, timeout: timeoutMs, signal }); }
  catch (error) {
    error.witnessExecution = { command: process.execPath, argv, cwd, timeoutMs, startedAt, finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started), code: error.code ?? null, signal: error.signal ?? null,
      killed: error.killed === true, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
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

