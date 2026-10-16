// Configurable offline corpus collection and independent response-tape replay.
// No external endpoint, credential, paid billing claim or quality approval.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { qualitySources } from './quality-collector.mjs';
import { contractDigest, hashBytes } from './quality-contract.mjs';
import { semanticDatabase, semanticUnits } from './semantic-quality-capture.mjs';
import { validateSemanticCorpusPlan, semanticCorpusBudget } from './semantic-quality-corpus-plan.mjs';
import { semanticBatchTrials, semanticBatchBudget } from './semantic-quality-batch-plan.mjs';
import { openSemanticQualityBudget } from './quality-budget.mjs';
import { createSemanticReviewTemplate, assessSemanticReview } from './semantic-quality-review.mjs';
import { closeServer, stopChild } from '../../test-support/lifecycle.mjs';
export const semanticCorpusBatchProtocolVersion=1;
const root=fileURLToPath(new URL('../../',import.meta.url));
const boundary={qualityStatus:'not_run',qualityEvaluated:false,fullQualityAcceptance:false,releaseEligible:false,liveCalls:0};
const same=(a,b)=>assert.equal(contractDigest(a),contractDigest(b));
const json=async file=>{const bytes=await readFile(file);assert.ok(bytes.length<=64*1024*1024);return JSON.parse(bytes);};
const write=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
async function harness(executionRoot){
  executionRoot=await realpath(executionRoot);assert.equal(await realpath(process.cwd()),executionRoot,'CORPUS_EXECUTION_ROOT_MISMATCH');
  assert.equal(await realpath(execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',timeout:10000}).trim()),executionRoot,'CORPUS_GIT_ROOT_MISMATCH');
  return executionRoot;
}
function endpoint(value){const url=new URL(value);assert.ok(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash,'LOOPBACK_ONLY');return url.href;}
async function outputDirectory(value,executionRoot){
  const directory=path.join(await realpath(path.dirname(path.resolve(value))),path.basename(value)),relative=path.relative(executionRoot,directory);
  if(relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)){
    let ignored=false;try{execFileSync('git',['check-ignore','--quiet','--no-index','--',directory],{cwd:executionRoot,stdio:'ignore',timeout:10000});ignored=true;}catch{}
    assert.ok(ignored,'CORPUS_OUTPUT_MUST_BE_OUTSIDE_SOURCE_OR_GIT_IGNORED');
  }return directory;
}
function ledgerRows(file){const db=new DatabaseSync(file,{readOnly:true});try{same(db.prepare('PRAGMA integrity_check').all().map(x=>x.integrity_check),['ok']);return {binding:db.prepare('SELECT digest FROM binding WHERE id=1').get().digest,attempts:db.prepare('SELECT * FROM attempts ORDER BY id').all().map(x=>({...x})),runs:db.prepare('SELECT * FROM runs ORDER BY role').all().map(x=>({...x}))};}finally{db.close();}}
async function execute(directory,plan,url,freezeDigest,runtime,signal,executionRoot,pair,claimedDirectory=directory,realtime=false,providerCapability){
  await write(path.join(directory,'input.json'),{directory,plan,endpoint:url,freezeDigest,...(providerCapability?{providerCapabilityRequired:true}:{}),...(realtime?{realtime:true}:{}),...(runtime?{runtime}:{}),...(pair?{pair,claimedDirectory}:{})});
  const child=spawn(process.execPath,[path.join(root,'scripts/lib/semantic-quality-corpus-worker.mjs'),path.join(directory,'input.json')],{cwd:executionRoot,env:{PATH:process.env.PATH},stdio:[providerCapability?'pipe':'ignore','pipe','pipe']});
  if(providerCapability){child.stdin.on('error',()=>{});child.stdin.end(providerCapability);}
  let bytes=0,overflow=false;const cap=chunk=>{bytes+=chunk.length;if(bytes>1024*1024){overflow=true;child.kill('SIGTERM');}};child.stdout.on('data',cap);child.stderr.on('data',cap);
  let timedOut=false;const stop=()=>{timedOut=true;child.kill('SIGTERM');};const timeout=setTimeout(stop,plan.limits.totalTimeoutMs+5000);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  const kill=setInterval(()=>{if(timedOut)child.kill('SIGKILL');},1500);
  try {const [code]=await once(child,'exit');assert.equal(code,0,'CORPUS_WORKER_FAILED');assert.ok(!overflow&&!timedOut&&!signal?.aborted);}
  finally {clearTimeout(timeout);clearInterval(kill);signal?.removeEventListener('abort',stop);await stopChild(child);}
}
function normalized(report){const value=structuredClone(report);delete value.artifacts;
  for(const call of value.calls){endpoint(call.endpoint);call.endpoint='http://127.0.0.1:1/';}
  for(const row of value.transport?.observations||[]){endpoint(row.endpoint);row.endpoint='http://127.0.0.1:1/';}
  return value;
}
function normalizedLedger(value,directory){value=structuredClone(value);for(const row of value.runs)if(row.directory===directory)row.directory='<capture-root>';return value;}
function objectKeys(value,expected){
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),'CORPUS_PAIR_INVALID');
  const keys=Reflect.ownKeys(value);assert.equal(keys.length,expected.length,'CORPUS_PAIR_INVALID');
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);assert.ok(expected.includes(key)&&descriptor.enumerable&&Object.hasOwn(descriptor,'value'),'CORPUS_PAIR_INVALID');}
}
function timestamp(value){assert.equal(typeof value,'string');assert.ok(Number.isFinite(Date.parse(value)));assert.equal(new Date(value).toISOString(),value);return Date.parse(value);}
function batchContext(pair,plan){
  if(!Object.hasOwn(pair,'batch'))return undefined;
  objectKeys(pair.batch,['plan','trialIndex','roleDirectory']);
  const trials=semanticBatchTrials(pair.batch.plan);
  assert.ok(Number.isSafeInteger(pair.batch.trialIndex)&&!Object.is(pair.batch.trialIndex,-0)&&pair.batch.trialIndex>=0&&pair.batch.trialIndex<trials.length,'CORPUS_PAIR_TRIAL_INVALID');
  const trial=trials[pair.batch.trialIndex];assert.equal(trial.role,pair.role);same(trial.plan,plan);
  const roleDirectory=pair.batch.roleDirectory;
  assert.equal(typeof roleDirectory,'string');assert.ok(path.isAbsolute(roleDirectory));assert.equal(path.resolve(roleDirectory),roleDirectory);
  return {trials,trial,budget:semanticBatchBudget(pair.batch.plan)};
}
function snapshotRows(snapshot,pair,plan,batch){
  objectKeys(snapshot,['id','currency','binding','freezeDigest','ceilingMicros','reservedMicros','attempts','runs']);
  const ledger=openSemanticQualityBudget(':memory:',pair.budget,pair.freezeDigest);
  try {const empty=ledger.snapshot();same({...snapshot,reservedMicros:0,attempts:[],runs:[]},empty);}finally{ledger.close();}
  assert.ok(Array.isArray(snapshot.attempts)&&snapshot.attempts.length<=pair.budget.maxAttempts.knowledge+pair.budget.maxAttempts.relation);
  assert.ok(Array.isArray(snapshot.runs)&&snapshot.runs.length===(pair.role==='baseline'?1:2));
  same(snapshot.runs.map(row=>row.role),pair.role==='baseline'?['baseline']:['baseline','candidate']);
  const roster=batch?.trials||['baseline','candidate'].map((role,index)=>({role,index,trialId:`${role}:${plan.sample.id}:0`}));
  const trialById=new Map(roster.map(row=>[row.trialId,row]));
  const counts={knowledge:0,relation:0},trials={};let reserved=0,lastTrial=-1;
  for(const [index,row] of snapshot.attempts.entries()){
    objectKeys(row,['id','kind','trial_id','reserved_micros','reserved_at','observation_json']);
    assert.equal(row.id,index+1);assert.ok(['knowledge','relation'].includes(row.kind));
    const trial=trialById.get(row.trial_id);assert.ok(trial,'CORPUS_PAIR_TRIAL_INVALID');
    if(batch){assert.ok(trial.index>=lastTrial,'CORPUS_PAIR_TRIAL_ORDER_INVALID');lastTrial=trial.index;}
    const role=trial.role,run=snapshot.runs.find(value=>value.role===role);assert.ok(run);
    assert.equal(row.reserved_micros,pair.budget.attemptMicros[row.kind]);reserved+=row.reserved_micros;
    assert.ok(++counts[row.kind]<=pair.budget.maxAttempts[row.kind]);const key=`${row.trial_id}:${row.kind}`;trials[key]=(trials[key]||0)+1;assert.ok(trials[key]<=(batch?pair.budget.trialLimits[row.trial_id][row.kind]:pair.budget.maxTrialAttempts[row.kind]));
    assert.ok(timestamp(row.reserved_at)>=timestamp(run.started_at));if(run.finished_at!==null)assert.ok(timestamp(row.reserved_at)<=timestamp(run.finished_at));
    assert.ok(row.observation_json===null||typeof row.observation_json==='string'&&row.observation_json.length<=10000);
    if(row.observation_json!==null)JSON.parse(row.observation_json);
  }
  for(const row of snapshot.runs){
    objectKeys(row,['role','source_sha','directory','state','started_at','finished_at']);
    assert.match(row.source_sha,/^[a-f0-9]{40}$/);assert.equal(typeof row.directory,'string');assert.ok(path.isAbsolute(row.directory));assert.equal(path.resolve(row.directory),row.directory);
    timestamp(row.started_at);if(row.role===pair.role){assert.equal(row.state,'running');assert.equal(row.finished_at,null);}else{assert.equal(row.role,'baseline');assert.equal(row.state,'complete');assert.ok(timestamp(row.finished_at)>=timestamp(row.started_at));}
  }
  assert.ok(Number.isSafeInteger(reserved)&&reserved<=pair.budget.ceilingMicros);assert.equal(snapshot.reservedMicros,reserved);
}
// Internal coordinator contract. Executable paths never come from evidence.
export function validateSemanticCorpusPair(pair,plan,{directory,source}={}){
  const isBatch=Object.hasOwn(pair||{},'batch');
  objectKeys(pair,['role','ledgerPath','budget','freezeDigest','before',...(isBatch?['batch']:[])]);assert.ok(['baseline','candidate'].includes(pair.role));
  assert.equal(typeof pair.ledgerPath,'string');assert.ok(path.isAbsolute(pair.ledgerPath));assert.equal(path.resolve(pair.ledgerPath),pair.ledgerPath);assert.match(pair.freezeDigest,/^[a-f0-9]{64}$/);
  const batch=batchContext(pair,plan);
  objectKeys(pair.budget,['id','currency','ceilingMicros','maxAttempts','attemptMicros','maxTrialAttempts','expiresAt',...(batch?['trialLimits']:[])]);
  for(const field of ['maxAttempts','attemptMicros','maxTrialAttempts'])objectKeys(pair.budget[field],['knowledge','relation']);
  const single=batch?undefined:semanticCorpusBudget(plan),expected=batch?.budget||{...single,maxAttempts:Object.fromEntries(Object.entries(single.maxAttempts).map(([kind,count])=>[kind,count*2]))};
  if(batch){
    objectKeys(pair.budget.trialLimits,Object.keys(expected.trialLimits));
    for(const limits of Object.values(pair.budget.trialLimits))objectKeys(limits,['knowledge','relation']);
    assert.equal(directory,path.join(pair.batch.roleDirectory,path.basename(batch.trial.directory)),'CORPUS_PAIR_DIRECTORY_INVALID');
  }
  same(pair.budget,expected);pair=structuredClone(pair);snapshotRows(pair.before,pair,plan,batch);
  const roleDirectory=batch?pair.batch.roleDirectory:directory;
  const current=pair.before.runs.find(row=>row.role===pair.role);assert.equal(current.directory,roleDirectory);assert.equal(current.source_sha,source.sha);
  const prior=new Set(batch?.trials.filter(row=>row.index<batch.trial.index).map(row=>row.trialId));
  assert.ok(pair.before.attempts.every(row=>batch?prior.has(row.trial_id):row.trial_id===`baseline:${plan.sample.id}:0`&&pair.role==='candidate'),'CORPUS_PAIR_PREFIX_INVALID');
  if(pair.role==='candidate'){const previous=pair.before.runs[0];assert.notEqual(previous.directory,roleDirectory);assert.ok(timestamp(previous.finished_at)<=timestamp(current.started_at));}
  return pair;
}
function pairBinding(pair){const {ledgerPath,...binding}=pair;return binding;}
function validatePairAfter(snapshot,pair,plan){
  const batch=batchContext(pair,plan),trialId=batch?.trial.trialId||`${pair.role}:${plan.sample.id}:0`;
  snapshotRows(snapshot,pair,plan,batch);same(snapshot.runs,pair.before.runs);same(snapshot.attempts.slice(0,pair.before.attempts.length),pair.before.attempts);
  assert.ok(snapshot.attempts.slice(pair.before.attempts.length).every(row=>row.trial_id===trialId),'CORPUS_PAIR_SUFFIX_INVALID');
}
function restorePairPrefix(filename,pair){
  // Only called with a new scratch path. Initialize the trusted schema/binding,
  // then restore validated accounting rows; semantic SQLite always starts empty.
  let ledger=openSemanticQualityBudget(filename,pair.budget,pair.freezeDigest);ledger.close();
  const db=new DatabaseSync(filename);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const attempt=db.prepare('INSERT INTO attempts(id,kind,trial_id,reserved_micros,reserved_at,observation_json) VALUES(?,?,?,?,?,?)');
      for(const row of pair.before.attempts)attempt.run(row.id,row.kind,row.trial_id,row.reserved_micros,row.reserved_at,row.observation_json);
      const run=db.prepare('INSERT INTO runs(role,source_sha,directory,state,started_at,finished_at) VALUES(?,?,?,?,?,?)');
      for(const row of pair.before.runs)run.run(row.role,row.source_sha,row.directory,row.state,row.started_at,row.finished_at);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();}
  ledger=openSemanticQualityBudget(filename,pair.budget,pair.freezeDigest);try{same(ledger.snapshot(),pair.before);}finally{ledger.close();}
}
export async function collectSemanticCorpusOffline(directory,{plan,providerEndpoint,signal,executionRoot=root,pair,realtime=false,providerCapability}={}){
  assert.ok(providerCapability===undefined||typeof providerCapability==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(providerCapability),'CORPUS_PROVIDER_CAPABILITY_INVALID');
  assert.equal(typeof realtime,'boolean','CORPUS_REALTIME_INVALID');executionRoot=await harness(executionRoot);plan=validateSemanticCorpusPlan(plan);const url=endpoint(providerEndpoint);directory=await outputDirectory(directory,executionRoot);
  assert.ok(Date.now()<Date.parse(plan.budget.expiresAt),'BUDGET_APPROVAL_EXPIRED');signal?.throwIfAborted();
  const source=await qualitySources();if(pair!==undefined)pair=validateSemanticCorpusPair(pair,plan,{directory,source});await mkdir(directory,{recursive:false,mode:0o700});
  const frozen={schemaVersion:1,kind:'offline-semantic-corpus-freeze',plan,source,...(realtime?{realtime:true}:{}),...(pair?{pair:pairBinding(pair)}:{}),...boundary},freezeDigest=contractDigest(frozen);
  await write(path.join(directory,'freeze.json'),frozen);
  let errorCode;
  try {await execute(directory,plan,url,freezeDigest,undefined,signal,executionRoot,pair,directory,realtime,providerCapability);same(await qualitySources(),source);
    const capture=await json(path.join(directory,'capture/capture.json'));await write(path.join(directory,'review.json'),createSemanticReviewTemplate(capture,{reviewers:plan.reviewers}));}
  catch {errorCode=signal?.aborted?'CORPUS_CANCELLED':'CORPUS_INCOMPLETE';}
  await write(path.join(directory,'run.json'),{schemaVersion:1,freezeDigest,complete:!errorCode,errorCode,...boundary});
  return {complete:!errorCode,errorCode,...boundary};
}
export async function inspectSemanticCorpusOffline(directory,{plan,release=false,signal,executionRoot=root,pair,realtime=false}={}){
  let scratch,server;
  try {
    assert.equal(typeof realtime,'boolean','CORPUS_REALTIME_INVALID');executionRoot=await harness(executionRoot);plan=validateSemanticCorpusPlan(plan);directory=await realpath(directory);const source=await qualitySources();if(release)assert.equal(source.dirty,false);
    if(pair!==undefined)pair=validateSemanticCorpusPair(pair,plan,{directory,source});
    const frozen=await json(path.join(directory,'freeze.json'));same(frozen,{schemaVersion:1,kind:'offline-semantic-corpus-freeze',plan,source,...(realtime?{realtime:true}:{}),...(pair?{pair:pairBinding(pair)}:{}),...boundary});
    const freezeDigest=contractDigest(frozen),run=await json(path.join(directory,'run.json'));same(run,{schemaVersion:1,freezeDigest,complete:true,...boundary});
    const capture=await json(path.join(directory,'capture/capture.json'));same(capture.sourceStart,source);same(capture.sourceEnd,source);same(capture.sample,plan.sample);assert.equal(capture.corpusPlanDigest,contractDigest(plan));
    assert.equal(capture.complete,true);assert.equal(capture.cleanup,true);same(capture.artifacts.map(x=>x.path),['store.sqlite']);
    assert.equal(hashBytes(await readFile(path.join(directory,'capture/store.sqlite'))),capture.artifacts[0].sha256);
    same(semanticDatabase(path.join(directory,'capture/store.sqlite')),capture.after);same(semanticUnits(capture.after),capture.units);
    const runtime=await json(path.join(directory,'runtime.json')),worker=await json(path.join(directory,'worker.json'));
    assert.equal(worker.complete,true);let rows;
    if(pair)validatePairAfter(worker.snapshot,pair,plan);
    else {
      rows=ledgerRows(path.join(directory,'budget.sqlite'));const budget=semanticCorpusBudget(plan);
      same(rows.runs.map(({role,source_sha,directory,state})=>({role,source_sha,directory,state})),[{role:'baseline',source_sha:source.sha,directory,state:'complete'}]);
      same(worker.snapshot,{id:budget.id,currency:budget.currency,binding:rows.binding,freezeDigest,ceilingMicros:budget.ceilingMicros,
        reservedMicros:rows.attempts.reduce((sum,row)=>sum+row.reserved_micros,0),attempts:rows.attempts,runs:rows.runs});
    }
    scratch=await mkdtemp(path.join(os.tmpdir(),'semantic-corpus-replay-'));let position=0,protocolError=false;
    let replayPair;if(pair){replayPair={...pair,ledgerPath:path.join(scratch,'budget.sqlite')};restorePairPrefix(replayPair.ledgerPath,replayPair);}
    server=http.createServer(async(request,response)=>{
      try {const chunks=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;assert.ok(bytes<=plan.limits.maxRequestBytes);chunks.push(chunk);}
        const call=capture.calls[position++];assert.ok(call);assert.equal(request.method,'POST');assert.equal(request.url,'/');assert.equal(Buffer.concat(chunks).toString(),call.requestWire);
        response.writeHead(call.http.status,{'content-type':'application/json',...(call.http.retryAfter?{'retry-after':call.http.retryAfter}:{})});response.end(call.http.body);
      }catch{protocolError=true;response.writeHead(400);response.end('{}');}
    });server.listen(0,'127.0.0.1');await once(server,'listening');
    await execute(scratch,plan,`http://127.0.0.1:${server.address().port}/`,freezeDigest,runtime,signal,executionRoot,replayPair,directory,realtime);
    assert.equal(protocolError,false);assert.equal(position,capture.calls.length);
    const replay=await json(path.join(scratch,'capture/capture.json'));same(normalized(replay),normalized(capture));
    if(pair)same(await json(path.join(scratch,'worker.json')),worker);
    else same(normalizedLedger(ledgerRows(path.join(scratch,'budget.sqlite')),scratch),normalizedLedger(rows,directory));
    same(await json(path.join(scratch,'runtime.json')),runtime);same(await qualitySources(),source);
    let review;try{review=assessSemanticReview(capture,await json(path.join(directory,'review.json')),{reviewers:plan.reviewers});}catch{review={complete:false,contractValid:false,offlineReviewPassed:false};}
    return {complete:true,infrastructurePassed:true,...boundary,review,attempts:worker.snapshot.attempts.length-(pair?.before.attempts.length||0),reservedMicros:worker.snapshot.reservedMicros,
      ...(pair?{pair:{role:pair.role,before:pair.before,after:worker.snapshot}}:{}),scope:'Offline corpus and actual production response replay. No provider quality or human review certification.'};
  }catch{return {complete:false,infrastructurePassed:false,errorCode:'CORPUS_EVIDENCE_REJECTED',...boundary};}
  finally {if(server)await closeServer(server,'corpus replay provider');if(scratch)await rm(scratch,{recursive:true,force:true});}
}
