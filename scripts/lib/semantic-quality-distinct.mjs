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
import { contractDigest, hashBytes } from './quality-contract.mjs';
import { openSemanticQualityBudget } from './quality-budget.mjs';
import { frozenSemanticPairPlan, inspectSemanticPairEvidence, semanticPairBoundary as boundary, semanticPairSpecs as specs } from './semantic-quality-paired.mjs';
import { createSemanticReviewTemplate, assessSemanticReview } from './semantic-quality-review.mjs';
import { semanticFixtureSample } from '../../test-support/semantic-quality-fixture.mjs';
import { SEMANTIC_PROVIDER_PROFILE, semanticProviderBudget, assertSemanticProviderApproval, validateSemanticProviderApprovalBinding } from './semantic-quality-provider-policy.mjs';
import { createSemanticProviderBridge, assertSemanticProviderSafeInput } from './semantic-quality-provider-bridge.mjs';
import { validateSemanticBatchPlan, semanticBatchTrials, semanticBatchBudget, validateBatchApprovals } from './semantic-quality-batch-plan.mjs';
import { assessSemanticBatch } from './semantic-quality-batch-assessment.mjs';
const batch = plan => plan?.kind === 'semantic-corpus-batch-plan';
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
async function manifests(checkouts, signal, corpusBatchPlan) {
  assert.ok(checkouts && roles.every(role => typeof checkouts[role] === 'string' && checkouts[role]), 'TWO_EXPLICIT_CHECKOUTS_REQUIRED');
  const roots = Object.fromEntries(await Promise.all(roles.map(async role => [role, await realpath(checkouts[role])])));
  assert.notEqual(roots.baseline, roots.candidate, 'INDEPENDENT_CHECKOUTS_REQUIRED');
  assert.ok(!roots.baseline.startsWith(roots.candidate + path.sep) && !roots.candidate.startsWith(roots.baseline + path.sep));
  const values = {};
  const probes = await Promise.allSettled(roles.map(role => execute(roots[role], { mode: 'probe', ...(corpusBatchPlan?{corpusBatchPlan}:{}) }, signal)));
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
export async function runSemanticDistinctOffline(directory, { checkouts, reviewers, corpusPlan, providerEndpoint, signal, release=false } = {}) {
  if(batch(corpusPlan)) return runBatch(directory,{checkouts,reviewers,corpusPlan,providerEndpoint,signal,release});
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
  if(batch(corpusPlan)) return inspectBatch(directory,{checkouts,reviewers,corpusPlan,release,signal});
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
async function runCorpusPair(directory,{checkouts,reviewers,corpusPlan,providerEndpoint,signal,provider,release=false}) {
  await assertHarnessRoot();corpusPlan=validateSemanticCorpusPlan(corpusPlan);same(reviewers,corpusPlan.reviewers);
  assert.ok(corpusPlan.limits.totalTimeoutMs<=15000,'CORPUS_PAIR_WORKER_BUDGET');
  const endpoint=provider?null:corpusEndpoint(providerEndpoint);assert.ok(Date.now()<Date.parse(corpusPlan.budget.expiresAt),'BUDGET_APPROVAL_EXPIRED');
  directory=await corpusPairOutput(directory);const sourceStart=await qualitySources();
  if(provider&&release)assert.equal(sourceStart.dirty,false,'RELEASE_SOURCE_DIRTY');
  const sources=await manifests(checkouts,signal);
  const base=corpusPairPlan(directory,sourceStart,sources,corpusPlan,reviewers);
  if(provider)same(provider.proposal,providerProposal(base,provider.testTransport));
  const plan=provider?{...base,kind:'semantic-provider-corpus-pair',mode:'provider',provider:{...provider.proposal,requestDigest:provider.requestDigest,approval:provider.approval}}:base,freezeDigest=contractDigest(plan),startedAt=new Date().toISOString();
  await mkdir(directory,{recursive:false,mode:0o700});await write(path.join(directory,'freeze.json'),plan);
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),150000),combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
  let ledger,activeRole,errorCode,bridge;const roleSnapshots=[],providerRows=[];
  try {
    for(const role of roles) {
      combined.throwIfAborted();ledger=openSemanticQualityBudget(path.join(directory,'budget.sqlite'),plan.budget,freezeDigest);
      const roleDirectory=path.join(directory,role);ledger.claimRun({role,sourceSha:sources[role].source.sha,directory:roleDirectory,expectedSnapshot:ledger.snapshot()});activeRole=role;
      const pair={role,ledgerPath:path.join(directory,'budget.sqlite'),budget:plan.budget,freezeDigest,before:ledger.snapshot()};
      if(provider&&release){const current=await qualitySources();assert.equal(current.dirty,false,'RELEASE_SOURCE_DIRTY');same(current,sourceStart);}
      if(provider)bridge=await createSemanticProviderBridge({approval:provider.approval,requestDigest:provider.requestDigest,expiresAt:corpusPlan.budget.expiresAt,key:provider.key,plan:corpusPlan,source:sources[role],role,snapshot:()=>ledger.snapshot(),signal:combined,testTransport:provider.testTransport});
      try{await execute(sources[role].root,{mode:'corpus-capture',manifest:sources[role],directory:roleDirectory,corpusPlan,providerEndpoint:bridge?.endpoint||endpoint,pair,...(provider?{realtime:true,providerCapability:bridge.capability}:{})},combined);}
      finally{if(bridge){await bridge.close();providerRows.push(...bridge.rows);bridge=null;}}
      const worker=await json(path.join(roleDirectory,'worker.json'));assert.equal(worker.complete,true);same(worker.snapshot,ledger.snapshot());
      ledger.finishRun(role,true);activeRole=null;roleSnapshots.push({role,snapshot:ledger.snapshot()});ledger.close();ledger=null;
    }
    same(await manifests(checkouts,combined),sources);
  } catch {errorCode=combined.aborted?'SEMANTIC_PAIR_CANCELLED':'SEMANTIC_PAIR_INCOMPLETE';}
  finally {clearTimeout(timer);if(ledger){try{if(activeRole)ledger.finishRun(activeRole,false);}finally{ledger.close();}}}
  let sourceEnd=null;try{sourceEnd=await qualitySources();same(sourceStart,sourceEnd);}catch{errorCode='SEMANTIC_SOURCE_CHANGED_OR_UNREADABLE';}
  const report={schemaVersion:1,kind:'offline-semantic-corpus-pair-run',mode:'offline',comparison:plan.comparison,...boundary,
    sourceStart,sourceEnd,startedAt,finishedAt:new Date().toISOString(),freezeDigest,complete:!errorCode,errorCode,roleSnapshots};
  if(provider){report.kind='semantic-provider-corpus-pair-run';report.mode='provider';report.provider={requestDigest:provider.requestDigest,evidenceKind:provider.proposal.evidenceKind};report.liveCalls=provider.testTransport?0:providerRows.filter(row=>row.forwarded).length;report.testTransportCalls=provider.testTransport?providerRows.filter(row=>row.forwarded).length:0;await write(path.join(directory,'provider.json'),{schemaVersion:1,requestDigest:provider.requestDigest,evidenceKind:provider.proposal.evidenceKind,rows:providerRows});}
  await write(path.join(directory,'paired.json'),report);return report;
}
async function inspectCorpusPair(directory,{checkouts,reviewers,corpusPlan,release,signal,providerEvidence=false,testTransport}) {
  try {
    await assertHarnessRoot();corpusPlan=validateSemanticCorpusPlan(corpusPlan);same(reviewers,corpusPlan.reviewers);
    directory=await realpath(directory);const source=await qualitySources();if(release)assert.equal(source.dirty,false);
    const saved=await json(path.join(directory,'freeze.json'));same(saved.corpusPlan,corpusPlan);same(saved.reviewers,reviewers);
    const sources=await manifests(checkouts,signal),base=corpusPairPlan(directory,source,sources,corpusPlan,reviewers);
    let provider;
    if(providerEvidence){provider=saved.provider;assert.ok(provider);const proposal=providerProposal(base,testTransport);const requestDigest=contractDigest(proposal);same({...provider,approval:undefined,requestDigest:undefined},{...proposal,approval:undefined,requestDigest:undefined});assert.equal(provider.requestDigest,requestDigest);validateSemanticProviderApprovalBinding({approval:provider.approval,requestDigest,expiresAt:corpusPlan.budget.expiresAt});}
    const plan=provider?{...base,kind:'semantic-provider-corpus-pair',mode:'provider',provider}:base,freezeDigest=contractDigest(plan);
    same(saved,plan);const run=await json(path.join(directory,'paired.json'));
    for(const [key,value] of Object.entries(boundary))if(!provider||key!=='liveCalls')same(run[key],value);
    assert.equal(run.schemaVersion,1);assert.equal(run.kind,provider?'semantic-provider-corpus-pair-run':'offline-semantic-corpus-pair-run');assert.equal(run.mode,provider?'provider':'offline');assert.equal(run.comparison,plan.comparison);
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
    const assessments={},providerCaptures={};
    for(const [index,role] of roles.entries()) {
      const roleDirectory=path.join(directory,role),before=prefixFor(snapshot,index,true),pair={role,ledgerPath:path.join(directory,'budget.sqlite'),budget:plan.budget,freezeDigest,before};
      const worker=await json(path.join(roleDirectory,'worker.json')),after=prefixFor(snapshot,index);after.runs[index].state='running';after.runs[index].finished_at=null;
      same(worker.snapshot,after);
      const result=await execute(sources[role].root,{mode:'corpus-read',manifest:sources[role],directory:roleDirectory,corpusPlan,pair,...(provider?{realtime:true}:{})},signal);assert.equal(result.infrastructurePassed,true);same(result.pair,{role,before,after});
      const capture=await json(path.join(roleDirectory,'capture/capture.json'));same(capture.sourceStart,sources[role].source);same(capture.sourceEnd,sources[role].source);same(capture.sample,corpusPlan.sample);
      providerCaptures[role]=capture;
      const owner=snapshot.runs[index];assert.ok(Date.parse(capture.startedAt)>=Date.parse(owner.started_at)&&Date.parse(capture.finishedAt)<=Date.parse(owner.finished_at));
      const ids=capture.transport.budgetBindings.map(x=>Number(x.attemptId));same(ids,snapshot.attempts.filter(x=>x.trial_id===`${role}:${corpusPlan.sample.id}:0`).map(x=>x.id));
      try{assessments[role]=assessSemanticReview(capture,await json(path.join(roleDirectory,'review.json')),{reviewers});}catch{assessments[role]={complete:false,contractValid:false,offlineReviewPassed:false};}
    }
    let metricDeltas=null;
    if(roles.every(role=>assessments[role].contractValid)) {assert.equal(assessments.baseline.selectedVariantId,assessments.candidate.selectedVariantId);
      metricDeltas=Object.fromEntries(['entity','fact','relation'].map(kind=>[kind,Object.fromEntries(['precision','recall','falsePositives','falseNegatives'].map(key=>{const a=assessments.baseline.metrics[kind][key],b=assessments.candidate.metrics[kind][key];return [key,a===null||b===null?null:b-a];}))]));}
    if(provider)await inspectProviderTranscript(directory,provider,providerCaptures,snapshot,run);
    same(await manifests(checkouts,signal),sources);same(await qualitySources(),source);
    return {schemaVersion:1,...(provider?{provider:{requestDigest:provider.requestDigest,evidenceKind:provider.evidenceKind}}:{}),kind:'semantic-paired-offline-summary',...boundary,complete:true,infrastructurePassed:true,comparison:plan.comparison,sources,
      reviewComplete:roles.every(role=>assessments[role].contractValid),offlineReviewPassed:roles.every(role=>assessments[role].offlineReviewPassed),
      pairs:[{sample:corpusPlan.sample.id,repetition:0,roles:assessments,metricDeltas}],scope:{pairs:1,captures:2,attempts:snapshot.attempts.length,reservedMicros:snapshot.reservedMicros},...(provider?{liveCalls:run.liveCalls,testTransportCalls:run.testTransportCalls}:{})};
  } catch {return {...boundary,complete:false,infrastructurePassed:false,errorCode:'SEMANTIC_CORPUS_PAIR_EVIDENCE_REJECTED'};}
}


function providerProposal(base,testTransport) {
  if(testTransport)assert.equal(testTransport.profile,'semantic-provider-test-only-v1','TEST_TRANSPORT_INVALID');
  if(batch(base.corpusPlan))for(const trial of semanticBatchTrials(base.corpusPlan))semanticProviderBudget(trial.plan);
  else semanticProviderBudget(base.corpusPlan);
  for(const role of roles)for(const kind of ['knowledge','relation'])assert.equal(base.sources[role].models[kind],SEMANTIC_PROVIDER_PROFILE.model,'PROVIDER_SOURCE_MODEL_MISMATCH');
  return {schemaVersion:1,kind:'semantic-provider-pair-proposal',evidenceKind:testTransport?'test-only':'actual-upstream',
    profile:SEMANTIC_PROVIDER_PROFILE,directory:base.directory,source:base.source,sources:base.sources,corpusPlan:base.corpusPlan,sharedBudget:base.budget,reviewers:base.reviewers};
}
export async function planSemanticProviderPair(directory,{checkouts,reviewers,corpusPlan,signal,testTransport,release=false}={}) {
  await assertHarnessRoot();directory=await corpusPairOutput(directory);
  const source=await qualitySources();
  if(release)assert.equal(source.dirty,false,'RELEASE_SOURCE_DIRTY');
  const sources=await manifests(checkouts,signal,batch(corpusPlan)?corpusPlan:undefined);
  const proposal=providerProposal((batch(corpusPlan)?batchBase:corpusPairPlan)(directory,source,sources,corpusPlan,reviewers),testTransport);
  return {requestDigest:contractDigest(proposal),proposal,qualityStatus:'not_run',qualityEvaluated:false,releaseEligible:false,liveCalls:0,invoiceGuarantee:false};
}
export async function collectSemanticProviderPair(directory,options={}) {
  // Fail before probes, directories, bridges, or requests when authority is absent.
  assert.ok(options.approval&&options.approval.approved===true,'PROVIDER_APPROVAL_REQUIRED');
  assert.ok(!process.env.CI||options.testTransport,'LIVE_PROVIDER_DISABLED_IN_CI');
  assertSemanticProviderSafeInput(options.key,{});
  const {requestDigest,proposal}=await planSemanticProviderPair(directory,options);
  assertSemanticProviderSafeInput(options.key,proposal);
  assertSemanticProviderApproval({approval:options.approval,requestDigest,expiresAt:proposal.corpusPlan.budget.expiresAt});
  const approval=validateSemanticProviderApprovalBinding({approval:options.approval,requestDigest,expiresAt:proposal.corpusPlan.budget.expiresAt});
  return (batch(options.corpusPlan)?runBatch:runCorpusPair)(directory,{...options,provider:{proposal,requestDigest,approval,key:options.key,testTransport:options.testTransport}});
}
export async function inspectSemanticProviderPair(directory,options={}) {
  return (batch(options.corpusPlan)?inspectBatch:inspectCorpusPair)(directory,{...options,providerEvidence:true});
}
async function inspectProviderTranscript(directory,provider,captures,snapshot,run) {
  const tape=await json(path.join(directory,'provider.json'));
  same({schemaVersion:tape.schemaVersion,requestDigest:tape.requestDigest,evidenceKind:tape.evidenceKind},{schemaVersion:1,requestDigest:provider.requestDigest,evidenceKind:provider.evidenceKind});
  same(run.provider,{requestDigest:provider.requestDigest,evidenceKind:provider.evidenceKind});
  const entries=Array.isArray(captures)?captures:roles.map(role=>({role,capture:captures[role]}));
  const calls=entries.flatMap(({role,capture})=>capture.calls.map((call,index)=>({role,call,binding:capture.transport.budgetBindings[index]})));
  assert.equal(tape.rows.length,calls.length);assert.equal(tape.rows.length,snapshot.attempts.length);
  for(const [index,row]of tape.rows.entries()){
    const {role,call,binding}=calls[index],attempt=snapshot.attempts[index];
    assert.equal(row.role,role);assert.equal(row.kind,call.kind==='relation'?'relation':'knowledge');
    assert.equal(row.attemptId,String(attempt.id));assert.equal(row.attemptId,binding.attemptId);assert.equal(row.trialId,attempt.trial_id);
    assert.equal(row.requestWire,call.requestWire);assert.equal(row.requestSha256,hashBytes(call.requestWire));assert.equal(row.requestSha256,binding.requestSha256);
    assert.equal(row.forwarded,true);assert.ok(['delivered','failed'].includes(row.status));same(row.http,call.http);assert.equal(row.responseSha256,hashBytes(call.http.body));
    assert.ok(Date.parse(row.startedAt)>=Date.parse(attempt.reserved_at)&&Date.parse(row.finishedAt)>=Date.parse(row.startedAt));
  }
  assert.equal(run.liveCalls,provider.evidenceKind==='actual-upstream'?tape.rows.length:0);
  assert.equal(run.testTransportCalls,provider.evidenceKind==='test-only'?tape.rows.length:0);
}

// Batch v2 reuses the single-trial production collector and empty-database replay.
// One ledger owns both role claims and every sample/repetition; no per-item purse.
function batchBase(directory,source,sources,corpusPlan,reviewers) {
  corpusPlan=validateSemanticBatchPlan(corpusPlan);same(reviewers,corpusPlan.reviewers);
  for(const role of roles){
    assert.equal(sources[role].semanticCorpusBatchProtocolVersion,1,'BATCH_SOURCE_PROTOCOL_REQUIRED');
    assert.ok(directory!==sources[role].root&&!directory.startsWith(sources[role].root+path.sep),'OUTPUT_OUTSIDE_TARGETS_REQUIRED');
  }
  return {schemaVersion:2,kind:'semantic-corpus-batch-freeze',mode:'offline',comparison:'distinct-source-batch',directory,source,sources,corpusPlan,budget:semanticBatchBudget(corpusPlan),reviewers,...boundary};
}
function batchPrefix(snapshot,trials,trial,after=false) {
  const value=structuredClone(snapshot),limit=trial.index+(after?1:0),allowed=new Set(trials.slice(0,limit).map(x=>x.trialId));
  value.attempts=value.attempts.filter(row=>allowed.has(row.trial_id));
  value.runs=value.runs.slice(0,roles.indexOf(trial.role)+1);
  const current=value.runs.at(-1);current.state='running';current.finished_at=null;
  value.reservedMicros=value.attempts.reduce((n,row)=>n+row.reserved_micros,0);return value;
}
function batchPair(directory,plan,trial,before) {
  return {role:trial.role,ledgerPath:path.join(directory,'budget.sqlite'),budget:plan.budget,freezeDigest:contractDigest(plan),before,
    batch:{plan:plan.corpusPlan,trialIndex:trial.index,roleDirectory:path.join(directory,trial.role)}};
}
function batchCaptureRow(trial,complete) {return {role:trial.role,sampleId:trial.sampleId,repetition:trial.repetition,trialId:trial.trialId,directory:trial.directory,complete};}
async function runBatch(directory,{checkouts,reviewers,corpusPlan,providerEndpoint,signal,provider,release=false}) {
  await assertHarnessRoot();corpusPlan=validateSemanticBatchPlan(corpusPlan);same(reviewers,corpusPlan.reviewers);
  const endpoint=provider?null:corpusEndpoint(providerEndpoint);assert.ok(Date.now()<Date.parse(corpusPlan.budget.expiresAt),'BUDGET_APPROVAL_EXPIRED');
  directory=await corpusPairOutput(directory);const sourceStart=await qualitySources();if(release)assert.equal(sourceStart.dirty,false,'RELEASE_SOURCE_DIRTY');
  const sources=await manifests(checkouts,signal,corpusPlan),base=batchBase(directory,sourceStart,sources,corpusPlan,reviewers);
  if(provider)same(provider.proposal,providerProposal(base,provider.testTransport));
  const frozenAt=new Date().toISOString();
  if(provider&&!provider.testTransport)assert.equal(validateBatchApprovals(corpusPlan,frozenAt).complete,true,'BATCH_PRE_APPROVALS_REQUIRED');
  const plan={...base,frozenAt,...(provider?{mode:'provider',provider:{...provider.proposal,requestDigest:provider.requestDigest,approval:provider.approval}}:{})};
  const freezeDigest=contractDigest(plan),trials=semanticBatchTrials(corpusPlan);
  await mkdir(directory,{recursive:false,mode:0o700});await write(path.join(directory,'freeze.json'),plan);
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),corpusPlan.batchTimeoutMs),combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
  let ledger,activeRole,errorCode,bridge;const roleSnapshots=[],providerRows=[],captures=[];
  try {
    ledger=openSemanticQualityBudget(path.join(directory,'budget.sqlite'),plan.budget,freezeDigest);
    for(const role of roles){
      combined.throwIfAborted();const roleDirectory=path.join(directory,role);await mkdir(roleDirectory,{mode:0o700});
      ledger.claimRun({role,sourceSha:sources[role].source.sha,directory:roleDirectory,expectedSnapshot:ledger.snapshot()});activeRole=role;
      for(const trial of trials.filter(x=>x.role===role)){
        combined.throwIfAborted();const trialDirectory=path.join(directory,trial.directory),pair=batchPair(directory,plan,trial,ledger.snapshot());
        if(release){const current=await qualitySources();assert.equal(current.dirty,false,'RELEASE_SOURCE_DIRTY');same(current,sourceStart);}
        if(provider)bridge=await createSemanticProviderBridge({approval:provider.approval,requestDigest:provider.requestDigest,expiresAt:corpusPlan.budget.expiresAt,key:provider.key,plan:trial.plan,source:sources[role],role,trialId:trial.trialId,snapshot:()=>ledger.snapshot(),signal:combined,testTransport:provider.testTransport});
        try{await execute(sources[role].root,{mode:'corpus-capture',manifest:sources[role],directory:trialDirectory,corpusPlan:trial.plan,pair,providerEndpoint:bridge?.endpoint||endpoint,...(provider?{realtime:true,providerCapability:bridge.capability}:{})},combined);}
        finally{if(bridge){await bridge.close();providerRows.push(...bridge.rows);bridge=null;}}
        const item=await json(path.join(trialDirectory,'worker.json'));assert.equal(item.complete,true);same(item.snapshot,ledger.snapshot());captures.push(batchCaptureRow(trial,true));
      }
      ledger.finishRun(role,true);activeRole=null;roleSnapshots.push({role,snapshot:ledger.snapshot()});
    }
    same(await manifests(checkouts,combined,corpusPlan),sources);
  }catch{errorCode=combined.aborted?'SEMANTIC_BATCH_CANCELLED':'SEMANTIC_BATCH_INCOMPLETE';}
  finally{clearTimeout(timer);if(ledger){try{if(activeRole)ledger.finishRun(activeRole,false);}finally{ledger.close();}}}
  let sourceEnd=null;try{sourceEnd=await qualitySources();same(sourceStart,sourceEnd);}catch{errorCode='SEMANTIC_SOURCE_CHANGED_OR_UNREADABLE';}
  const report={schemaVersion:2,kind:'semantic-corpus-batch-run',mode:provider?'provider':'offline',comparison:base.comparison,...boundary,
    sourceStart,sourceEnd,startedAt:frozenAt,finishedAt:new Date().toISOString(),freezeDigest,complete:!errorCode,errorCode,captures,roleSnapshots};
  if(provider){report.provider={requestDigest:provider.requestDigest,evidenceKind:provider.proposal.evidenceKind};report.liveCalls=provider.testTransport?0:providerRows.filter(x=>x.forwarded).length;report.testTransportCalls=provider.testTransport?providerRows.filter(x=>x.forwarded).length:0;await write(path.join(directory,'provider.json'),{schemaVersion:1,...report.provider,rows:providerRows});}
  await write(path.join(directory,'paired.json'),report);return report;
}
async function inspectBatch(directory,{checkouts,reviewers,corpusPlan,release=false,signal,providerEvidence=false,testTransport}) {
  let timer;
  try{
    await assertHarnessRoot();corpusPlan=validateSemanticBatchPlan(corpusPlan);same(reviewers,corpusPlan.reviewers);directory=await realpath(directory);
    const abort=new AbortController();timer=setTimeout(()=>abort.abort(),corpusPlan.batchTimeoutMs);signal=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    // Reject an incomplete matrix before spawning either trusted source worker.
    const trials=semanticBatchTrials(corpusPlan),run=await json(path.join(directory,'paired.json'));
    assert.equal(run.complete,true);same(run.captures,trials.map(x=>batchCaptureRow(x,true)));
    const source=await qualitySources();if(release)assert.equal(source.dirty,false,'RELEASE_SOURCE_DIRTY');
    const saved=await json(path.join(directory,'freeze.json')),sources=await manifests(checkouts,signal,corpusPlan),base=batchBase(directory,source,sources,corpusPlan,reviewers);
    assert.equal(new Date(saved.frozenAt).toISOString(),saved.frozenAt);assert.ok(Date.parse(saved.frozenAt)<=Date.now());let provider;
    if(providerEvidence){provider=saved.provider;assert.ok(provider);const proposal=providerProposal(base,testTransport),requestDigest=contractDigest(proposal);same({...provider,approval:undefined,requestDigest:undefined},{...proposal,approval:undefined,requestDigest:undefined});assert.equal(provider.requestDigest,requestDigest);validateSemanticProviderApprovalBinding({approval:provider.approval,requestDigest,expiresAt:corpusPlan.budget.expiresAt});}
    const plan={...base,frozenAt:saved.frozenAt,...(provider?{mode:'provider',provider}:{})};same(saved,plan);
    const freezeDigest=contractDigest(plan);
    assert.equal(run.schemaVersion,2);assert.equal(run.kind,'semantic-corpus-batch-run');assert.equal(run.mode,provider?'provider':'offline');assert.equal(run.comparison,base.comparison);
    for(const [key,value]of Object.entries(boundary))if(!provider||key!=='liveCalls')same(run[key],value);
    same(run.sourceStart,source);same(run.sourceEnd,source);assert.equal(run.freezeDigest,freezeDigest);assert.equal(run.complete,true);assert.equal(run.errorCode,undefined);
    assert.equal(run.startedAt,plan.frozenAt);assert.ok(Date.parse(run.finishedAt)>=Date.parse(run.startedAt)&&Date.parse(run.finishedAt)<=Date.now());
    same(run.captures,trials.map(x=>batchCaptureRow(x,true)));
    const snapshot=corpusLedger(directory,plan.budget,freezeDigest),trialIndex=new Map(trials.map(x=>[x.trialId,x.index]));
    same(snapshot.runs.map(({role,source_sha,directory,state})=>({role,source_sha,directory,state})),roles.map(role=>({role,source_sha:sources[role].source.sha,directory:path.join(directory,role),state:'complete'})));
    const [baseline,candidate]=snapshot.runs;assert.ok(Date.parse(baseline.started_at)>=Date.parse(plan.frozenAt)&&Date.parse(candidate.started_at)>=Date.parse(baseline.finished_at)&&Date.parse(candidate.finished_at)<=Date.parse(run.finishedAt));
    let position=-1;const counts={knowledge:0,relation:0},byTrial={};
    for(const [index,row]of snapshot.attempts.entries()){
      assert.equal(row.id,index+1);assert.ok(trialIndex.has(row.trial_id));const current=trialIndex.get(row.trial_id);assert.ok(current>=position);position=current;
      assert.ok(['knowledge','relation'].includes(row.kind));assert.equal(row.reserved_micros,plan.budget.attemptMicros[row.kind]);assert.equal(row.observation_json,null);
      assert.ok(++counts[row.kind]<=plan.budget.maxAttempts[row.kind]);const key=`${row.trial_id}:${row.kind}`;byTrial[key]=(byTrial[key]||0)+1;assert.ok(byTrial[key]<=plan.budget.trialLimits[row.trial_id][row.kind]);
    }
    assert.ok(Number.isSafeInteger(snapshot.reservedMicros)&&snapshot.reservedMicros<=plan.budget.ceilingMicros);
    same(run.roleSnapshots,roles.map((role,index)=>({role,snapshot:prefixFor(snapshot,index)})));
    const assessments=[],providerCaptures=[];let previousFinish=Date.parse(plan.frozenAt);
    for(const trial of trials){
      signal?.throwIfAborted();const trialDirectory=path.join(directory,trial.directory),before=batchPrefix(snapshot,trials,trial),after=batchPrefix(snapshot,trials,trial,true),pair=batchPair(directory,plan,trial,before);
      const item=await json(path.join(trialDirectory,'worker.json'));same(item.snapshot,after);
      const result=await execute(sources[trial.role].root,{mode:'corpus-read',manifest:sources[trial.role],directory:trialDirectory,corpusPlan:trial.plan,pair,...(provider?{realtime:true}:{})},signal);assert.equal(result.infrastructurePassed,true);same(result.pair,{role:trial.role,before,after});
      const capture=await json(path.join(trialDirectory,'capture/capture.json'));same(capture.sourceStart,sources[trial.role].source);same(capture.sourceEnd,sources[trial.role].source);same(capture.sample,trial.plan.sample);
      const owner=snapshot.runs[roles.indexOf(trial.role)];assert.ok(Date.parse(capture.startedAt)>=Math.max(previousFinish,Date.parse(owner.started_at))&&Date.parse(capture.finishedAt)<=Date.parse(owner.finished_at));previousFinish=Date.parse(capture.finishedAt);
      same(capture.transport.budgetBindings.map(x=>Number(x.attemptId)),snapshot.attempts.filter(x=>x.trial_id===trial.trialId).map(x=>x.id));providerCaptures.push({role:trial.role,capture});
      let assessment;try{assessment=assessSemanticReview(capture,await json(path.join(trialDirectory,'review.json')),{reviewers});}catch{assessment={contractValid:false,complete:false};}
      assessments.push({role:trial.role,sampleId:trial.sampleId,repetition:trial.repetition,trialId:trial.trialId,assessment});
    }
    if(provider)await inspectProviderTranscript(directory,provider,providerCaptures,snapshot,run);
    same(await manifests(checkouts,signal,corpusPlan),sources);same(await qualitySources(),source);
    const assessment=assessSemanticBatch(corpusPlan,assessments,{frozenAt:plan.frozenAt,evidenceKind:provider?.evidenceKind||'offline',infrastructurePassed:true});
    return {schemaVersion:2,kind:'semantic-batch-summary',...boundary,...assessment,complete:true,infrastructurePassed:true,comparison:base.comparison,sources,
      scope:{pairs:trials.length/2,captures:trials.length,attempts:snapshot.attempts.length,reservedMicros:snapshot.reservedMicros},liveCalls:run.liveCalls,testTransportCalls:run.testTransportCalls||0};
  }catch{return {...boundary,complete:false,infrastructurePassed:false,ruleDecision:'incomplete',errorCode:'SEMANTIC_BATCH_EVIDENCE_REJECTED'};}finally{clearTimeout(timer);}
}
