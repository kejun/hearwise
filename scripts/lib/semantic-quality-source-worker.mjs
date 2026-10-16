// Invoked only by the trusted coordinator with an explicit caller-selected cwd.
// Evidence files never select executable modules. No inherited credentials.
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { realpath, readFile, lstat } from 'node:fs/promises';
import { readdirSync, lstatSync, realpathSync, readlinkSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { qualitySources } from './quality-collector.mjs';
import { sourceSnapshot, validBuildSource } from './runner-evidence-contract.mjs';
import { contractDigest, hashBytes } from './quality-contract.mjs';
import { openSemanticQualityBudget } from './quality-budget.mjs';
import { readSemanticCapture as trustedRead } from './semantic-quality-evidence.mjs';
import { verifySyntheticPersistence } from './semantic-quality-paired.mjs';
import { validateSemanticCorpusPlan, semanticCorpusBudget } from './semantic-quality-corpus-plan.mjs';
import { validateSemanticBatchPlan, semanticBatchTrials, semanticBatchBudget } from './semantic-quality-batch-plan.mjs';
import { collectSemanticCorpusOffline, inspectSemanticCorpusOffline, validateSemanticCorpusPair } from './semantic-quality-corpus.mjs';
import { semanticFixtureResponse } from '../../test-support/semantic-quality-fixture.mjs';
const same = (a,b) => assert.equal(contractDigest(a), contractDigest(b));
const root = await realpath(process.cwd());
const local = async name => { const file = await realpath(path.join(root, name)); assert.ok(file.startsWith(root + path.sep), 'ESCAPING_SOURCE'); return import(pathToFileURL(file).href); };
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const abort = new AbortController();
process.on('SIGTERM', () => abort.abort()); process.on('SIGINT', () => abort.abort());
async function dependencyDigest(directory = path.join(root, 'node_modules')) {
  const files = [];
  function visit(dir) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(full);
    }
  }
  visit(directory);
  // Reread every installed byte on each manifest. Synchronous filesystem calls
  // avoid per-file promise overhead; no bytes or hashes cross manifest boundaries.
  const rows = files.map(full => {
    const stat = lstatSync(full), relative = path.relative(root, full);
    if (stat.isSymbolicLink()) {
      assert.ok(realpathSync(full).startsWith(path.join(root, 'node_modules') + path.sep), 'BORROWED_DEPENDENCY');
      return [relative, 'link', readlinkSync(full)];
    }
    assert.ok(stat.isFile());
    return [relative, stat.mode & 0o777, hashBytes(readFileSync(full))];
  });
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
  let hasCorpus=false;
  try { await lstat(path.join(root,'scripts/lib/semantic-quality-corpus.mjs')); hasCorpus=true; }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  const corpus=hasCorpus?await local('scripts/lib/semantic-quality-corpus.mjs'):undefined;
  const protocol=corpus?.semanticCorpusBatchProtocolVersion;
  return { root, source, build, dependencies, dependencyDigest: await dependencyDigest(), ...(protocol===undefined?{}:{semanticCorpusBatchProtocolVersion:protocol}), profile: { knowledgeModel: k.KNOWLEDGE_MODEL, relationModel: r.RELATION_MODEL, knowledgePrompt: k.SYSTEM_PROMPT_V2, knowledgeRepairPrompt: k.knowledgeRepairRequestMessages({},[])[0].content, relationPrompt: r.RELATION_SYSTEM_PROMPT }, models: { knowledge: k.KNOWLEDGE_MODEL, relation: r.RELATION_MODEL,
    knowledgeContract: k.CONTRACT_REVISION, relationContract: r.RELATION_CONTRACT_VERSION } };
}
async function verifyBatchPlan(plan,source) {
  assert.equal(source.semanticCorpusBatchProtocolVersion,1,'CORPUS_BATCH_CAPABILITY_REQUIRED');
  const targetPlan=await local('scripts/lib/semantic-quality-corpus-plan.mjs'),targetBatch=await local('scripts/lib/semantic-quality-batch-plan.mjs');
  const targetCorpus=await local('scripts/lib/semantic-quality-corpus.mjs');
  assert.equal(targetCorpus.semanticCorpusBatchProtocolVersion,1,'CORPUS_BATCH_CAPABILITY_REQUIRED');
  same(targetBatch.validateSemanticBatchPlan(plan),validateSemanticBatchPlan(plan));
  const trials=semanticBatchTrials(plan);same(targetBatch.semanticBatchTrials(plan),trials);
  same(targetBatch.semanticBatchBudget(plan),semanticBatchBudget(plan));
  for(const trial of trials.filter(row=>row.role==='baseline'&&row.repetition===0)){
    same(targetPlan.validateSemanticCorpusPlan(trial.plan),validateSemanticCorpusPlan(trial.plan));
    same(targetPlan.semanticCorpusBudget(trial.plan),semanticCorpusBudget(trial.plan));
  }
  return targetCorpus;
}
process.once('message', async input => {
  try {
    const before = await manifest();
    if (input.mode === 'probe') { if(input.corpusBatchPlan!==undefined)await verifyBatchPlan(input.corpusBatchPlan,before); await send({ ok: true, value: before }); return; }
    same(before, input.manifest);
    if (['corpus-capture','corpus-read'].includes(input.mode)) {
      const targetPlan = await local('scripts/lib/semantic-quality-corpus-plan.mjs');
      same(targetPlan.semanticCorpusBudget(input.corpusPlan), semanticCorpusBudget(input.corpusPlan));
      let collect=collectSemanticCorpusOffline;
      if(input.pair?.batch){
        const targetCorpus=await verifyBatchPlan(input.pair.batch.plan,before);
        const context={directory:input.directory,source:before.source};
        same(targetCorpus.validateSemanticCorpusPair(input.pair,input.corpusPlan,context),validateSemanticCorpusPair(input.pair,input.corpusPlan,context));
        collect=targetCorpus.collectSemanticCorpusOffline;
      }
      const options = { plan: input.corpusPlan, pair: input.pair, executionRoot: root, signal: abort.signal, release: true, realtime: input.realtime === true, providerCapability: input.providerCapability };
      const result = input.mode === 'corpus-capture'
        ? await collect(input.directory, { ...options, providerEndpoint: input.providerEndpoint })
        : await inspectSemanticCorpusOffline(input.directory, options);
      assert.equal(result.complete, true, 'CORPUS_INCOMPLETE');
      same(await manifest(), before); await send({ ok: true, value: result }); return;
    }
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
