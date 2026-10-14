import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { normalizeProcessTrace, replayProcessTrace, validateProcessTrace } from '../scripts/lib/process-crash-replay.mjs';
import { createProcessProtocolAdapter } from '../test-support/process-crash-adapter.mjs';

async function fixedTrace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-crash-itf-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = fileURLToPath(new URL('../', import.meta.url)), env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  await promisify(execFile)(process.execPath, ['node_modules/@informalsystems/quint/dist/src/cli.js', 'test',
    'verification/process-crash/witnesses.qnt', '--main', 'relation_single_witnesses', '--match', 'normalSuccessTest',
    '--backend', 'typescript', '--seed', '42', '--max-samples', '1', '--out-itf', path.join(directory, '{test}-{seq}.itf.json')], { cwd, env, timeout: 10000 });
  const files = (await readdir(directory)).filter(file => file.endsWith('.itf.json'));
  assert.equal(files.length, 1);
  return normalizeProcessTrace(JSON.parse(await readFile(path.join(directory, files[0]), 'utf8')), { protocol: 'relation', actors: 1, capacity: 1 });
}

test('real Quint crash trace matches actual SIGKILL/new-PID recovery and detects reset-on-recovery mutation', async t => {
  const trace = await fixedTrace(t);
  assert.equal(validateProcessTrace(trace), true);
  const valid = await replayProcessTrace(trace, createProcessProtocolAdapter);
  assert.equal(valid.classification, 'matched', JSON.stringify(valid.difference || valid.error));
  assert.equal(valid.complete, true);
  const broken = await replayProcessTrace(trace, config => createProcessProtocolAdapter({ ...config, mutation: 'reset_on_recovery' }));
  assert.equal(broken.classification, 'implementation_mismatch');
  assert.equal(broken.difference.step, 2);
  assert.equal(broken.difference.expected.counts[0], 1);
  assert.equal(broken.difference.actual.counts[0], 0);
  assert.equal(broken.counterexample.steps.length, 3);
});

test('an abnormal worker exit stays diagnosed and cannot masquerade as completed SIGKILL replay', async t => {
  const trace = await fixedTrace(t);
  const result = await replayProcessTrace(trace, async config => {
    const adapter = await createProcessProtocolAdapter(config), act = adapter.act;
    return { ...adapter, act: async step => {
      if (step.action === 'crash') { await act({ action: 'abnormal_exit' });
        throw new Error(`Unexpected worker exit: ${JSON.stringify(adapter.observe().exits.at(-1))}`); }
      return act(step);
    } };
  });
  assert.equal(result.classification, 'unreplayable');
  assert.equal(result.complete, false);
  assert.match(result.error.message, /"code":73/);
  assert.match(result.error.message, /"signal":null/);
  assert.match(result.error.message, /unexpected/);
  assert.equal(result.cleanupError, undefined);
});

test('process trace parser rejects unknown domains, ambiguous ITF and unsupported action shapes', async t => {
  const trace = await fixedTrace(t);
  for (const change of [value => { value.config.protocol = 'unknown'; }, value => { value.config.actors = 2; },
    value => { value.steps[0].action = 'close_reopen'; }, value => { delete value.initial.processState; },
    value => { value.steps[0].expected.counts[99] = 0; }]) {
    const broken = structuredClone(trace); change(broken); assert.equal(validateProcessTrace(broken), false);
  }
  assert.throws(() => normalizeProcessTrace({ vars: ['a::lastAction', 'b::lastAction'], states: [{}] }, trace.config), /ambiguous/);
});
