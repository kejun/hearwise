// Offline cross-revision rehearsal. Checkouts are caller-selected trusted code,
// not paths loaded from evidence. A process boundary is not a security sandbox.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { validateSemanticCorpusPlan, semanticCorpusBudget } from './semantic-quality-corpus-plan.mjs';
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
const json = async file => {const bytes=await readFile(file);assert.ok(bytes.length<=64*1024*1024,'EVIDENCE_FILE_TOO_LARGE');return JSON.parse(bytes);};
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
export async function runSemanticDistinctOffline(directory, { checkouts, reviewers, corpusPlan, providerEndpoint, signal } = {}) {
  if (corpusPlan) return runCorpusPair(directory, { checkouts, reviewers, corpusPlan, providerEndpoint, signal });
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
export async function inspectSemanticDistinctOffline(directory, { checkouts, reviewers, corpusPlan, release = false, signal } = {}) {
  if (corpusPlan) return inspectCorpusPair(directory, { checkouts, reviewers, corpusPlan, release, signal });
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


// Configurable corpus mode shares the same explicit source worker, commands and
// annotation contracts. One frozen sample is run once per source; no live calls.
function corpusPairPlan(directory, source, sources, corpusPlan, reviewers) {
  corpusPlan = validateSemanticCorpusPlan(corpusPlan); same(reviewers, corpusPlan.reviewers);
  assert.ok(corpusPlan.limits.totalTimeoutMs<=15000,'CORPUS_PAIR_WORKER_BUDGET');
  const single = semanticCorpusBudget(corpusPlan), budget = { ...single,
    maxAttempts: Object.fromEntries(Object.entries(single.maxAttempts).map(([kind,n])=>[kind,2*n])) };
  for(const role of roles) assert.ok(directory !== sources[role].root && !directory.startsWith(sources[role].root+path.sep),'OUTPUT_OUTSIDE_TARGETS_REQUIRED');
  return {schemaVersion:1,kind:'offline-semantic-corpus-pair',mode:'offline',comparison:'distinct-source-corpus',directory,source,sources,corpusPlan,budget,reviewers,...boundary};
}
function corpusEndpoint(value) {const url=new URL(value);assert.ok(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash,'LOOPBACK_ONLY');return url.href;}
async function corpusPairOutput(directory) {
  directory=path.join(await realpath(path.dirname(path.resolve(directory))),path.basename(directory));
  const root=await realpath(process.cwd()),relative=path.relative(root,directory);
  if(relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)) {
    let ignored=false;try{execFileSync('git',['check-ignore','--quiet','--no-index','--',directory],{stdio:'ignore',timeout:10000});ignored=true;}catch{}
    assert.ok(ignored,'CORPUS_OUTPUT_MUST_BE_OUTSIDE_SOURCE_OR_GIT_IGNORED');
  }return directory;
}
function corpusLedger(directory,budget,freezeDigest) {
  const db=new DatabaseSync(path.join(directory,'budget.sqlite'),{readOnly:true});
  try {same(db.prepare('PRAGMA integrity_check').all().map(x=>x.integrity_check),['ok']);
    const attempts=db.prepare('SELECT * FROM attempts ORDER BY id').all().map(x=>({...x})),runs=db.prepare('SELECT * FROM runs ORDER BY role').all().map(x=>({...x}));
    return {id:budget.id,currency:budget.currency,binding:db.prepare('SELECT digest FROM binding WHERE id=1').get().digest,freezeDigest,ceilingMicros:budget.ceilingMicros,
      reservedMicros:attempts.reduce((n,row)=>n+row.reserved_micros,0),attempts,runs};
  } finally {db.close();}
}
function prefixFor(snapshot,index,claimRunning=false) {
  const value=structuredClone(snapshot);value.attempts=value.attempts.filter(row=>index===1||row.trial_id.startsWith('baseline:'));
  value.runs=value.runs.slice(0,index+1);
  if(claimRunning) {value.attempts=value.attempts.filter(row=>!row.trial_id.startsWith(roles[index]+':'));const row=value.runs[index];row.state='running';row.finished_at=null;}
  value.reservedMicros=value.attempts.reduce((sum,row)=>sum+row.reserved_micros,0);return value;
}
async function runCorpusPair(directory,{checkouts,reviewers,corpusPlan,providerEndpoint,signal}) {
  await assertHarnessRoot();corpusPlan=validateSemanticCorpusPlan(corpusPlan);same(reviewers,corpusPlan.reviewers);
  assert.ok(corpusPlan.limits.totalTimeoutMs<=15000,'CORPUS_PAIR_WORKER_BUDGET');
  const endpoint=corpusEndpoint(providerEndpoint);assert.ok(Date.now()<Date.parse(corpusPlan.budget.expiresAt),'BUDGET_APPROVAL_EXPIRED');
  directory=await corpusPairOutput(directory);const sourceStart=await qualitySources(),sources=await manifests(checkouts,signal);
  const plan=corpusPairPlan(directory,sourceStart,sources,corpusPlan,reviewers),freezeDigest=contractDigest(plan),startedAt=new Date().toISOString();
  await mkdir(directory,{recursive:false,mode:0o700});await write(path.join(directory,'freeze.json'),plan);
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),150000),combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
  let ledger,activeRole,errorCode;const roleSnapshots=[];
  try {
    for(const role of roles) {
      combined.throwIfAborted();ledger=openSemanticQualityBudget(path.join(directory,'budget.sqlite'),plan.budget,freezeDigest);
      const roleDirectory=path.join(directory,role);ledger.claimRun({role,sourceSha:sources[role].source.sha,directory:roleDirectory,expectedSnapshot:ledger.snapshot()});activeRole=role;
      const pair={role,ledgerPath:path.join(directory,'budget.sqlite'),budget:plan.budget,freezeDigest,before:ledger.snapshot()};
      await execute(sources[role].root,{mode:'corpus-capture',manifest:sources[role],directory:roleDirectory,corpusPlan,providerEndpoint:endpoint,pair},combined);
      const worker=await json(path.join(roleDirectory,'worker.json'));assert.equal(worker.complete,true);same(worker.snapshot,ledger.snapshot());
      ledger.finishRun(role,true);activeRole=null;roleSnapshots.push({role,snapshot:ledger.snapshot()});ledger.close();ledger=null;
    }
    same(await manifests(checkouts,combined),sources);
  } catch {errorCode=combined.aborted?'SEMANTIC_PAIR_CANCELLED':'SEMANTIC_PAIR_INCOMPLETE';}
  finally {clearTimeout(timer);if(ledger){try{if(activeRole)ledger.finishRun(activeRole,false);}finally{ledger.close();}}}
  let sourceEnd=null;try{sourceEnd=await qualitySources();same(sourceStart,sourceEnd);}catch{errorCode='SEMANTIC_SOURCE_CHANGED_OR_UNREADABLE';}
  const report={schemaVersion:1,kind:'offline-semantic-corpus-pair-run',mode:'offline',comparison:plan.comparison,...boundary,
    sourceStart,sourceEnd,startedAt,finishedAt:new Date().toISOString(),freezeDigest,complete:!errorCode,errorCode,roleSnapshots};
  await write(path.join(directory,'paired.json'),report);return report;
}
async function inspectCorpusPair(directory,{checkouts,reviewers,corpusPlan,release,signal}) {
  try {
    await assertHarnessRoot();corpusPlan=validateSemanticCorpusPlan(corpusPlan);same(reviewers,corpusPlan.reviewers);
    directory=await realpath(directory);const source=await qualitySources();if(release)assert.equal(source.dirty,false);
    const saved=await json(path.join(directory,'freeze.json'));same(saved.corpusPlan,corpusPlan);same(saved.reviewers,reviewers);
    const sources=await manifests(checkouts,signal),plan=corpusPairPlan(directory,source,sources,corpusPlan,reviewers),freezeDigest=contractDigest(plan);
    same(saved,plan);const run=await json(path.join(directory,'paired.json'));
    for(const [key,value] of Object.entries(boundary))same(run[key],value);
    assert.equal(run.schemaVersion,1);assert.equal(run.kind,'offline-semantic-corpus-pair-run');assert.equal(run.mode,'offline');assert.equal(run.comparison,plan.comparison);
    same(run.sourceStart,source);same(run.sourceEnd,source);assert.equal(run.freezeDigest,freezeDigest);assert.equal(run.complete,true);assert.equal(run.errorCode,undefined);
    assert.ok(Date.parse(run.startedAt)<=Date.parse(run.finishedAt)&&Date.parse(run.finishedAt)<=Date.now());
    const snapshot=corpusLedger(directory,plan.budget,freezeDigest);
    same(snapshot.runs.map(({role,source_sha,directory,state})=>({role,source_sha,directory,state})),roles.map(role=>({role,source_sha:sources[role].source.sha,directory:path.join(directory,role),state:'complete'})));
    assert.ok(snapshot.reservedMicros<=plan.budget.ceilingMicros&&Number.isSafeInteger(snapshot.reservedMicros));
    const [baseline,candidate]=snapshot.runs;
    assert.ok(Date.parse(baseline.started_at)>=Date.parse(run.startedAt)&&Date.parse(candidate.started_at)>=Date.parse(baseline.finished_at)&&Date.parse(candidate.finished_at)<=Date.parse(run.finishedAt));
    snapshot.attempts.forEach((row,index)=>{assert.equal(row.id,index+1);assert.ok(['knowledge','relation'].includes(row.kind));assert.ok(roles.some(role=>row.trial_id===`${role}:${corpusPlan.sample.id}:0`));assert.equal(row.reserved_micros,plan.budget.attemptMicros[row.kind]);assert.equal(row.observation_json,null);});
    for(const kind of ['knowledge','relation'])assert.ok(snapshot.attempts.filter(x=>x.kind===kind).length<=plan.budget.maxAttempts[kind]);
    same(run.roleSnapshots,roles.map((role,index)=>({role,snapshot:prefixFor(snapshot,index)})));
    const assessments={};
    for(const [index,role] of roles.entries()) {
      const roleDirectory=path.join(directory,role),before=prefixFor(snapshot,index,true),pair={role,ledgerPath:path.join(directory,'budget.sqlite'),budget:plan.budget,freezeDigest,before};
      const worker=await json(path.join(roleDirectory,'worker.json')),after=prefixFor(snapshot,index);after.runs[index].state='running';after.runs[index].finished_at=null;
      same(worker.snapshot,after);
      const result=await execute(sources[role].root,{mode:'corpus-read',manifest:sources[role],directory:roleDirectory,corpusPlan,pair},signal);assert.equal(result.infrastructurePassed,true);same(result.pair,{role,before,after});
      const capture=await json(path.join(roleDirectory,'capture/capture.json'));same(capture.sourceStart,sources[role].source);same(capture.sourceEnd,sources[role].source);same(capture.sample,corpusPlan.sample);
      const owner=snapshot.runs[index];assert.ok(Date.parse(capture.startedAt)>=Date.parse(owner.started_at)&&Date.parse(capture.finishedAt)<=Date.parse(owner.finished_at));
      const ids=capture.transport.budgetBindings.map(x=>Number(x.attemptId));same(ids,snapshot.attempts.filter(x=>x.trial_id===`${role}:${corpusPlan.sample.id}:0`).map(x=>x.id));
      try{assessments[role]=assessSemanticReview(capture,await json(path.join(roleDirectory,'review.json')),{reviewers});}catch{assessments[role]={complete:false,contractValid:false,offlineReviewPassed:false};}
    }
    let metricDeltas=null;
    if(roles.every(role=>assessments[role].contractValid)) {assert.equal(assessments.baseline.selectedVariantId,assessments.candidate.selectedVariantId);
      metricDeltas=Object.fromEntries(['entity','fact','relation'].map(kind=>[kind,Object.fromEntries(['precision','recall','falsePositives','falseNegatives'].map(key=>{const a=assessments.baseline.metrics[kind][key],b=assessments.candidate.metrics[kind][key];return [key,a===null||b===null?null:b-a];}))]));}
    same(await manifests(checkouts,signal),sources);same(await qualitySources(),source);
    return {schemaVersion:1,kind:'semantic-paired-offline-summary',...boundary,complete:true,infrastructurePassed:true,comparison:plan.comparison,sources,
      reviewComplete:roles.every(role=>assessments[role].contractValid),offlineReviewPassed:roles.every(role=>assessments[role].offlineReviewPassed),
      pairs:[{sample:corpusPlan.sample.id,repetition:0,roles:assessments,metricDeltas}],scope:{pairs:1,captures:2,attempts:snapshot.attempts.length,reservedMicros:snapshot.reservedMicros}};
  } catch {return {...boundary,complete:false,infrastructurePassed:false,errorCode:'SEMANTIC_CORPUS_PAIR_EVIDENCE_REJECTED'};}
}
