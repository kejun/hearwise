import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validatePilotEvidence } from '../scripts/lib/pilot-release-evidence.mjs';
import { historicalBindings } from '../scripts/lib/historical-release-evidence.mjs';
import { runProcess } from '../scripts/lib/process.mjs';

test('real pilot header cannot claim success after incomplete execution or another source', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pilot-release-header-')); t.after(() => rm(root, { recursive: true, force: true }));
  const run = await runProcess(process.execPath, ['scripts/verify.mjs'], { env: { ...process.env, VERIFICATION_EVIDENCE_DIR: root }, timeoutMs: 15000 });
  assert.equal(run.code, 0, run.tail);
  const directory = path.join(root, (await readdir(root))[0]), file = path.join(directory, 'report.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  assert.equal((await validatePilotEvidence(directory, { release: false })).ok, true);
  for (const [name, change] of [['incomplete', r => { r.complete = false; }], ['wrong-source', r => { r.source.sha = '0'.repeat(40); }],
    ['dirty-header', r => { r.source.dirty = !r.source.dirty; }], ['wrong-tool-header', r => { r.tools.node = 'v0.0.0'; }]]) await t.test(name, async () => {
    const report = structuredClone(original); change(report); await writeFile(file, JSON.stringify(report));
    const verdict = await validatePilotEvidence(directory, { release: false }); assert.equal(verdict.ok, false, JSON.stringify(verdict));
  });
});
test('historical actual bindings retain the originally recorded environment and tools', async () => {
  const report = { environment: { platform: process.platform, arch: process.arch, release: os.release() }, tools: { node: process.version, sqlite: process.versions.sqlite } };
  const expected = await historicalBindings('revision', 'fast');
  assert.deepEqual(await historicalBindings('revision', 'fast', report), expected);
  for (const change of [r => { r.environment.platform = 'other-platform'; }, r => { r.environment.arch = 'other-arch'; }, r => { r.environment.release = 'other-kernel'; }]) {
    const changed = structuredClone(report); change(changed);
    assert.notEqual((await historicalBindings('revision', 'fast', changed)).environment, expected.environment);
  }
  const changed = structuredClone(report); changed.tools.node = 'v0.0.0';
  assert.notEqual((await historicalBindings('revision', 'fast', changed)).tools, expected.tools);
  await assert.rejects(historicalBindings('revision', 'fast', { ...report, environment: {} }));
});
