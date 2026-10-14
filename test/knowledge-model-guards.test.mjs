import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('knowledge model rejects response, commit and commit-failure for an earlier completed part', async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, [
    'node_modules/@informalsystems/quint/dist/src/cli.js', 'test', 'verification/knowledge-protocol/actor-guards.qnt',
    '--main', 'actor_guards', '--backend', 'typescript', '--seed', '42', '--max-samples', '1'
  ], { cwd, env, timeout: 10000 });
  assert.match(stdout, /3 passing/);
  assert.doesNotMatch(stdout, /\d+ failing/);
});
