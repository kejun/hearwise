// Offline cross-revision rehearsal. Checkouts are caller-selected trusted code,
// not paths loaded from evidence. A process boundary is not a security sandbox.
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { qualitySources } from './quality-collector.mjs';
import { contractDigest } from './quality-contract.mjs';
import { openSemanticQualityBudget } from './quality-budget.mjs';
import { frozenSemanticPairPlan, inspectSemanticPairEvidence, semanticPairBoundary as boundary, semanticPairSpecs as specs } from './semantic-quality-paired.mjs';
import { createSemanticReviewTemplate, assessSemanticReview } from './semantic-quality-review.mjs';
import { semanticFixtureSample } from '../../test-support/semantic-quality-fixture.mjs';
const worker = fileURLToPath(new URL('./semantic-quality-source-worker.mjs', import.meta.url));
const same = (a,b) => assert.equal(contractDigest(a), contractDigest(b));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const write = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const roles = ['baseline','candidate'];
async function assertHarnessRoot() {
  const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  assert.equal(await realpath(process.cwd()), root, 'HARNESS_CWD_MISMATCH');
  assert.equal(await realpath(execFileSync('git', ['rev-parse','--show-toplevel'], { encoding: 'utf8', timeout: 10000 }).trim()), root, 'HARNESS_GIT_ROOT_MISMATCH');
}
function execute(root, input, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], { cwd: root, env: { PATH: process.env.PATH }, execArgv: [],
      detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe','ipc'] });
    let result, bytes = 0, stopped = false, killTimer;
    const kill = sig => { try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch {} };
    const stop = () => { stopped = true; kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 1500); };
    const timer = setTimeout(stop, 25000);
    const consume = chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) stop(); };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    signal?.addEventListener('abort', stop, { once: true });
    child.on('message', message => { if (message?.ready === true) { child.send(input); return; } if (result || Buffer.byteLength(JSON.stringify(message)) > 8 * 1024 * 1024) stop(); else result = message; });
    child.once('error', () => { stopped = true; });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); kill('SIGKILL');
      if (code === 0 && !stopped && result?.ok) resolve(result.value); else reject(new Error('SEMANTIC_SOURCE_WORKER_FAILED'));
    });
  });
}
async function manifests(checkouts, signal) {
  assert.ok(checkouts && roles.every(role => typeof checkouts[role] === 'string' && checkouts[role]), 'TWO_EXPLICIT_CHECKOUTS_REQUIRED');
  const roots = Object.fromEntries(await Promise.all(roles.map(async role => [role, await realpath(checkouts[role])])));
  assert.notEqual(roots.baseline, roots.candidate, 'INDEPENDENT_CHECKOUTS_REQUIRED');
  assert.ok(!roots.baseline.startsWith(roots.candidate + path.sep) && !roots.candidate.startsWith(roots.baseline + path.sep));
  const values = {};
  const probes = await Promise.allSettled(roles.map(role => execute(roots[role], { mode: 'probe' }, signal)));
  for (const [index, role] of roles.entries()) { if (probes[index].status === 'rejected') throw probes[index].reason; values[role] = probes[index].value; }
  assert.notEqual(values.baseline.source.sha, values.candidate.source.sha, 'DISTINCT_COMMITS_REQUIRED');
  assert.notEqual(values.baseline.source.tree, values.candidate.source.tree, 'DISTINCT_TREES_REQUIRED');
  return values;
}
function planFor(directory, source, frozenAt, sources, reviewers) {
  assert.ok(Array.isArray(reviewers) && reviewers.length > 0 && reviewers.length <= 20 && reviewers.every(x => typeof x === 'string' && x.trim() && x.length <= 100));
  assert.equal(new Set(reviewers).size, reviewers.length);
  const base = frozenSemanticPairPlan(directory, source, frozenAt);
  for (const role of roles) {
    assert.ok(directory !== sources[role].root && !directory.startsWith(sources[role].root + path.sep), 'OUTPUT_OUTSIDE_TARGETS_REQUIRED');
    assert.equal(sources[role].models.knowledgeContract, base.models.knowledgeContract, 'UNSUPPORTED_KNOWLEDGE_CONTRACT');
    assert.equal(sources[role].models.relationContract, base.models.relationContract, 'UNSUPPORTED_RELATION_CONTRACT');
  }
  return { ...base, comparison: 'distinct-source-rehearsal', sources, reviewers };
}
export async function runSemanticDistinctOffline(directory, { checkouts, reviewers, signal } = {}) {
  await assertHarnessRoot(); directory = path.resolve(directory);
  directory = path.join(await realpath(path.dirname(directory)), path.basename(directory));
  const sourceStart = await qualitySources(), sources = await manifests(checkouts, signal);
  const startedAt = new Date().toISOString(), plan = planFor(directory, sourceStart, startedAt, sources, reviewers), freezeDigest = contractDigest(plan);
  await mkdir(directory, { recursive: false, mode: 0o700 }); await write(path.join(directory, 'freeze.json'), plan);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 150000), combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const captures = [], roleSnapshots = []; let ledger, activeRole, errorCode;
  try {
    for (const role of roles) {
      combined.throwIfAborted(); ledger = openSemanticQualityBudget(path.join(directory, 'budget.sqlite'), plan.budget, freezeDigest);
      await mkdir(path.join(directory, role));
      ledger.claimRun({ role, sourceSha: sources[role].source.sha, directory: path.join(directory, role), expectedSnapshot: ledger.snapshot() }); activeRole = role;
      const results = await execute(sources[role].root, { mode: 'capture', manifest: sources[role],
        ledger: path.join(directory, 'budget.sqlite'), budget: plan.budget, freezeDigest,
        entries: specs.map(spec => ({ directory: path.join(directory, `${role}/${spec.sample}-${spec.repetition}`),
          sample: semanticFixtureSample(spec.sample), trialId: `${role}:${spec.sample}:${spec.repetition}` })) }, combined);
      assert.equal(results.length, specs.length);
      for (const [index, spec] of specs.entries()) {
        const relative = `${role}/${spec.sample}-${spec.repetition}`, result = results[index];
        captures.push({ role, ...spec, directory: relative, complete: result.report.complete });
        await write(path.join(directory, relative, 'review.json'), createSemanticReviewTemplate(result.report, { reviewers }));
      }
      ledger.finishRun(role, true); activeRole = null; roleSnapshots.push({ role, snapshot: ledger.snapshot() }); ledger.close(); ledger = null;
    }
    same(await manifests(checkouts, combined), sources);
  } catch { errorCode = combined.aborted ? 'SEMANTIC_PAIR_CANCELLED' : 'SEMANTIC_PAIR_INCOMPLETE'; }
  finally { clearTimeout(timer); if (ledger) { try { if (activeRole) ledger.finishRun(activeRole, false); } finally { ledger.close(); } } }
  let sourceEnd = null;
  try { sourceEnd = await qualitySources(); same(sourceStart, sourceEnd); } catch { errorCode = 'SEMANTIC_SOURCE_CHANGED_OR_UNREADABLE'; }
  const report = { schemaVersion: 1, kind: 'synthetic-semantic-pair', mode: 'offline', comparison: plan.comparison, ...boundary,
    sourceStart, sourceEnd, startedAt, finishedAt: new Date().toISOString(), freezeDigest, complete: !errorCode, errorCode, captures, roleSnapshots };
  await write(path.join(directory, 'paired.json'), report); return report;
}
export async function inspectSemanticDistinctOffline(directory, { checkouts, reviewers, release = false, signal } = {}) {
  directory = path.resolve(directory);
  try {
    await assertHarnessRoot(); directory = await realpath(directory);
    const source = await qualitySources(), sources = await manifests(checkouts, signal), saved = await json(path.join(directory, 'freeze.json'));
    const plan = planFor(directory, source, saved.frozenAt, sources, reviewers), captures = new Map(), reads = new Map();
    const summary = await inspectSemanticPairEvidence(directory, source, { release, expectedPlan: plan,
      roleSources: Object.fromEntries(roles.map(role => [role, sources[role].source])),
      readCapture: async (dir, expected, role) => {
        same(expected, sources[role].source);
        if (!reads.has(role)) {
          const entries = specs.map(spec => ({ directory: path.join(directory, `${role}/${spec.sample}-${spec.repetition}`) }));
          const results = await execute(sources[role].root, { mode: 'read', manifest: sources[role], entries }, signal);
          assert.equal(results.length, entries.length); reads.set(role, new Map(entries.map((entry, i) => [entry.directory, results[i]])));
        }
        const result = reads.get(role).get(dir); assert.ok(result); captures.set(dir, result.report); return result;
      }, verifyPersistence: () => {} }); // The isolated reader already reprojects with its own production parsers.
    if (!summary.infrastructurePassed) return summary;
    const pairs = [], assessments = [];
    for (const spec of specs) {
      const pair = { ...spec, roles: {} };
      for (const role of roles) {
        const dir = path.join(directory, `${role}/${spec.sample}-${spec.repetition}`), capture = captures.get(dir);
        let assessment;
        try { assessment = assessSemanticReview(capture, await json(path.join(dir, 'review.json')), { reviewers }); }
        catch { assessment = { complete: false, contractValid: false, offlineReviewStatus: 'incomplete', metrics: null }; }
        assessments.push(assessment); pair.roles[role] = assessment;
      }
      pair.metricDeltas = null;
      if (roles.every(role => pair.roles[role].contractValid)) {
        assert.equal(pair.roles.baseline.selectedVariantId, pair.roles.candidate.selectedVariantId, 'PAIRED_GOLD_VARIANT_CHANGED');
        pair.metricDeltas = Object.fromEntries(['entity','fact','relation'].map(kind => [kind,
          Object.fromEntries(['precision','recall','falsePositives','falseNegatives'].map(key => {
            const a = pair.roles.baseline.metrics[kind][key], b = pair.roles.candidate.metrics[kind][key];
            return [key, a === null || b === null ? null : b - a];
          }))]));
      }
      pairs.push(pair);
    }
    same(await manifests(checkouts, signal), sources); same(await qualitySources(), source);
    return { ...summary, sources, reviewComplete: assessments.every(a => a.contractValid),
      offlineReviewPassed: assessments.every(a => a.offlineReviewPassed), pairs,
      interpretation: 'Synthetic paired annotation metrics only. No human authentication, real quality acceptance, or release decision.' };
  } catch { return { ...boundary, complete: false, infrastructurePassed: false, errorCode: 'SEMANTIC_DISTINCT_EVIDENCE_REJECTED' }; }
}
