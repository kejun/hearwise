import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { normalizeGenerationTrace, generationReplayRefinement } from '../scripts/lib/generation-protocol-replay.mjs';

export async function fixedTrace(t, protocol = 'relation', actors = 1, capacity = 1, name = 'normalSuccessTest', refinement = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-generation-itf-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = fileURLToPath(new URL('../', import.meta.url)), env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  await promisify(execFile)(process.execPath, ['node_modules/@informalsystems/quint/dist/src/cli.js', 'test',
    `verification/generation-protocol/${refinement ? 'replay-witnesses' : 'witnesses'}.qnt`, '--main', `${refinement ? 'replay_' : ''}${protocol}_${actors === 1 ? 'single' : `multi_cap${capacity}`}_witnesses`,
    '--match', name, '--backend', 'typescript', '--seed', '42', '--max-samples', '1', '--out-itf', path.join(directory, '{test}-{seq}.itf.json')],
  { cwd, env, timeout: 10000 });
  const files = (await readdir(directory)).filter(file => file.endsWith('.itf.json')); assert.equal(files.length, 1);
  return normalizeGenerationTrace(JSON.parse(await readFile(path.join(directory, files[0]), 'utf8')), { protocol, actors, capacity, ...(refinement ? { refinement: generationReplayRefinement } : {}) });
}

