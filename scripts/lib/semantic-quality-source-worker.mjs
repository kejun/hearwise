// Invoked only by the trusted coordinator with an explicit caller-selected cwd.
// Evidence files never select executable modules. No inherited credentials.
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { realpath, readFile, readdir, lstat, readlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { qualitySources } from './quality-collector.mjs';
import { sourceSnapshot, validBuildSource } from './runner-evidence-contract.mjs';
import { contractDigest, hashBytes } from './quality-contract.mjs';
import { openSemanticQualityBudget } from './quality-budget.mjs';
import { readSemanticCapture as trustedRead } from './semantic-quality-evidence.mjs';
import { verifySyntheticPersistence } from './semantic-quality-paired.mjs';
import { semanticFixtureResponse } from '../../test-support/semantic-quality-fixture.mjs';
const same = (a,b) => assert.equal(contractDigest(a), contractDigest(b));
const root = await realpath(process.cwd());
const local = async name => { const file = await realpath(path.join(root, name)); assert.ok(file.startsWith(root + path.sep), 'ESCAPING_SOURCE'); return import(pathToFileURL(file).href); };
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const abort = new AbortController();
process.on('SIGTERM', () => abort.abort()); process.on('SIGINT', () => abort.abort());
async function dependencyDigest(directory = path.join(root, 'node_modules')) {
  const files = [];
  async function visit(dir) {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else files.push(full);
    }
  }
  await visit(directory);
  // Bound filesystem concurrency without caching bytes across either manifest.
  // Each role still hashes every installed file before and after execution.
  const rows = new Array(files.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
    while (next < files.length) {
      const index = next++, full = files[index], stat = await lstat(full), relative = path.relative(root, full);
      if (stat.isSymbolicLink()) {
        assert.ok((await realpath(full)).startsWith(path.join(root, 'node_modules') + path.sep), 'BORROWED_DEPENDENCY');
        rows[index] = [relative, 'link', await readlink(full)];
      } else { assert.ok(stat.isFile()); rows[index] = [relative, stat.mode & 0o777, hashBytes(await readFile(full))]; }
    }
  }));
  return contractDigest(rows);
}
async function manifest() {
  assert.equal(await realpath(execFileSync('git', ['rev-parse','--show-toplevel'], { encoding: 'utf8', timeout: 10000 }).trim()), root, 'CHECKOUT_ROOT_REQUIRED');
  const files = execFileSync('git', ['ls-files','--cached','--others','--exclude-standard','-z'], { encoding: 'utf8', timeout: 10000 }).split('\0').filter(Boolean);
  for (const file of [...files, 'dist/server/index.js']) assert.ok((await realpath(file)).startsWith(root + path.sep), 'ESCAPING_SOURCE');
  assert.equal(await realpath('node_modules'), path.join(root, 'node_modules'), 'INDEPENDENT_DEPENDENCIES_REQUIRED');
  const pkg = JSON.parse(await readFile('package.json')), lock = JSON.parse(await readFile('package-lock.json'));
  const dependencies = {};
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()) {
    const directory = await realpath(path.join('node_modules', name));
    assert.ok(directory.startsWith(path.join(root, 'node_modules') + path.sep), 'BORROWED_DEPENDENCY');
    const version = JSON.parse(await readFile(path.join(directory, 'package.json'))).version;
    assert.equal(version, lock.packages[`node_modules/${name}`].version); dependencies[name] = version;
  }
  const source = await qualitySources(), build = await sourceSnapshot();
  assert.equal(source.dirty, false, 'CLEAN_SOURCE_REQUIRED'); assert.ok(validBuildSource(build), 'EXACT_BUILD_REQUIRED');
  const k = await local('knowledge.mjs'), r = await local('relations.mjs');
  return { root, source, build, dependencies, dependencyDigest: await dependencyDigest(), profile: { knowledgeModel: k.KNOWLEDGE_MODEL, relationModel: r.RELATION_MODEL, knowledgePrompt: k.SYSTEM_PROMPT_V2, relationPrompt: r.RELATION_SYSTEM_PROMPT }, models: { knowledge: k.KNOWLEDGE_MODEL, relation: r.RELATION_MODEL,
    knowledgeContract: k.CONTRACT_REVISION, relationContract: r.RELATION_CONTRACT_VERSION } };
}
process.once('message', async input => {
  try {
    const before = await manifest();
    if (input.mode === 'probe') { await send({ ok: true, value: before }); return; }
    same(before, input.manifest);
    const { readSemanticCapture } = await local('scripts/lib/semantic-quality-evidence.mjs');
    assert.ok(Array.isArray(input.entries) && input.entries.length === 4);
    const results = []; let ledger;
    try {
      if (input.mode === 'capture') ledger = openSemanticQualityBudget(input.ledger, input.budget, input.freezeDigest);
      else assert.equal(input.mode, 'read');
      for (const entry of input.entries) {
        abort.signal.throwIfAborted();
        if (input.mode === 'capture') {
          const { captureSemanticOffline } = await local('scripts/lib/semantic-quality-capture.mjs');
          const result = await captureSemanticOffline({ directory: entry.directory, sample: entry.sample, response: semanticFixtureResponse(), signal: abort.signal,
            pairedBudget: { ledger, trialId: entry.trialId, expiresAt: input.budget.expiresAt } });
          assert.equal(result.complete, true, 'CAPTURE_INCOMPLETE');
        }
        const read = await readSemanticCapture(entry.directory, before.source, { release: true });
        const trusted = await trustedRead(entry.directory, before.source, { release: true, profile: before.profile });
        same(read, trusted); verifySyntheticPersistence(trusted.report); results.push(read);
      }
    } finally { ledger?.close(); }
    same(await manifest(), before);
    await send({ ok: true, value: results });
  } catch { await send({ ok: false, code: abort.signal.aborted ? 'SEMANTIC_SOURCE_CANCELLED' : 'SEMANTIC_SOURCE_WORKER_FAILED' }); }
  finally { if (process.connected) process.disconnect(); }
});

process.send({ ready: true });
