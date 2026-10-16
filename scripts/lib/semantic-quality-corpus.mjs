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
import { createSemanticReviewTemplate, assessSemanticReview } from './semantic-quality-review.mjs';
import { closeServer, stopChild } from '../../test-support/lifecycle.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const boundary={qualityStatus:'not_run',qualityEvaluated:false,fullQualityAcceptance:false,releaseEligible:false,liveCalls:0};
const same=(a,b)=>assert.equal(contractDigest(a),contractDigest(b));
const json=async file=>{const bytes=await readFile(file);assert.ok(bytes.length<=64*1024*1024);return JSON.parse(bytes);};
const write=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
async function harness(){assert.equal(await realpath(process.cwd()),await realpath(root));}
function endpoint(value){const url=new URL(value);assert.ok(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash,'LOOPBACK_ONLY');return url.href;}
async function outputDirectory(value){
  const directory=path.join(await realpath(path.dirname(path.resolve(value))),path.basename(value)),relative=path.relative(await realpath(root),directory);
  if(relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)){
    let ignored=false;try{execFileSync('git',['check-ignore','--quiet','--no-index','--',directory],{cwd:root,stdio:'ignore',timeout:10000});ignored=true;}catch{}
    assert.ok(ignored,'CORPUS_OUTPUT_MUST_BE_OUTSIDE_SOURCE_OR_GIT_IGNORED');
  }return directory;
}
function ledgerRows(file){const db=new DatabaseSync(file,{readOnly:true});try{same(db.prepare('PRAGMA integrity_check').all().map(x=>x.integrity_check),['ok']);return {binding:db.prepare('SELECT digest FROM binding WHERE id=1').get().digest,attempts:db.prepare('SELECT * FROM attempts ORDER BY id').all().map(x=>({...x})),runs:db.prepare('SELECT * FROM runs ORDER BY role').all().map(x=>({...x}))};}finally{db.close();}}
async function execute(directory,plan,url,freezeDigest,runtime,signal){
  await write(path.join(directory,'input.json'),{directory,plan,endpoint:url,freezeDigest,...(runtime?{runtime}:{})});
  const child=spawn(process.execPath,[path.join(root,'scripts/lib/semantic-quality-corpus-worker.mjs'),path.join(directory,'input.json')],{cwd:root,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
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
export async function collectSemanticCorpusOffline(directory,{plan,providerEndpoint,signal}={}){
  await harness();plan=validateSemanticCorpusPlan(plan);const url=endpoint(providerEndpoint);directory=await outputDirectory(directory);
  assert.ok(Date.now()<Date.parse(plan.budget.expiresAt),'BUDGET_APPROVAL_EXPIRED');signal?.throwIfAborted();
  const source=await qualitySources();await mkdir(directory,{recursive:false,mode:0o700});
  const frozen={schemaVersion:1,kind:'offline-semantic-corpus-freeze',plan,source,...boundary},freezeDigest=contractDigest(frozen);
  await write(path.join(directory,'freeze.json'),frozen);
  let errorCode;
  try {await execute(directory,plan,url,freezeDigest,undefined,signal);same(await qualitySources(),source);
    const capture=await json(path.join(directory,'capture/capture.json'));await write(path.join(directory,'review.json'),createSemanticReviewTemplate(capture,{reviewers:plan.reviewers}));}
  catch {errorCode=signal?.aborted?'CORPUS_CANCELLED':'CORPUS_INCOMPLETE';}
  await write(path.join(directory,'run.json'),{schemaVersion:1,freezeDigest,complete:!errorCode,errorCode,...boundary});
  return {complete:!errorCode,errorCode,...boundary};
}
export async function inspectSemanticCorpusOffline(directory,{plan,release=false,signal}={}){
  let scratch,server;
  try {
    await harness();plan=validateSemanticCorpusPlan(plan);directory=await realpath(directory);const source=await qualitySources();if(release)assert.equal(source.dirty,false);
    const frozen=await json(path.join(directory,'freeze.json'));same(frozen,{schemaVersion:1,kind:'offline-semantic-corpus-freeze',plan,source,...boundary});
    const freezeDigest=contractDigest(frozen),run=await json(path.join(directory,'run.json'));same(run,{schemaVersion:1,freezeDigest,complete:true,...boundary});
    const capture=await json(path.join(directory,'capture/capture.json'));same(capture.sourceStart,source);same(capture.sourceEnd,source);same(capture.sample,plan.sample);assert.equal(capture.corpusPlanDigest,contractDigest(plan));
    assert.equal(capture.complete,true);assert.equal(capture.cleanup,true);same(capture.artifacts.map(x=>x.path),['store.sqlite']);
    assert.equal(hashBytes(await readFile(path.join(directory,'capture/store.sqlite'))),capture.artifacts[0].sha256);
    same(semanticDatabase(path.join(directory,'capture/store.sqlite')),capture.after);same(semanticUnits(capture.after),capture.units);
    const runtime=await json(path.join(directory,'runtime.json')),worker=await json(path.join(directory,'worker.json')),rows=ledgerRows(path.join(directory,'budget.sqlite'));
    assert.equal(worker.complete,true);const budget=semanticCorpusBudget(plan);
    same(rows.runs.map(({role,source_sha,directory,state})=>({role,source_sha,directory,state})),[{role:'baseline',source_sha:source.sha,directory,state:'complete'}]);
    same(worker.snapshot,{id:budget.id,currency:budget.currency,binding:rows.binding,freezeDigest,ceilingMicros:budget.ceilingMicros,
      reservedMicros:rows.attempts.reduce((sum,row)=>sum+row.reserved_micros,0),attempts:rows.attempts,runs:rows.runs});
    scratch=await mkdtemp(path.join(os.tmpdir(),'semantic-corpus-replay-'));let position=0,protocolError=false;
    server=http.createServer(async(request,response)=>{
      try {const chunks=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;assert.ok(bytes<=plan.limits.maxRequestBytes);chunks.push(chunk);}
        const call=capture.calls[position++];assert.ok(call);assert.equal(request.method,'POST');assert.equal(request.url,'/');assert.equal(Buffer.concat(chunks).toString(),call.requestWire);
        response.writeHead(call.http.status,{'content-type':'application/json',...(call.http.retryAfter?{'retry-after':call.http.retryAfter}:{})});response.end(call.http.body);
      }catch{protocolError=true;response.writeHead(400);response.end('{}');}
    });server.listen(0,'127.0.0.1');await once(server,'listening');
    await execute(scratch,plan,`http://127.0.0.1:${server.address().port}/`,freezeDigest,runtime,signal);
    assert.equal(protocolError,false);assert.equal(position,capture.calls.length);
    const replay=await json(path.join(scratch,'capture/capture.json'));same(normalized(replay),normalized(capture));
    same(normalizedLedger(ledgerRows(path.join(scratch,'budget.sqlite')),scratch),normalizedLedger(rows,directory));
    same(await json(path.join(scratch,'runtime.json')),runtime);same(await qualitySources(),source);
    let review;try{review=assessSemanticReview(capture,await json(path.join(directory,'review.json')),{reviewers:plan.reviewers});}catch{review={complete:false,contractValid:false,offlineReviewPassed:false};}
    return {complete:true,infrastructurePassed:true,...boundary,review,attempts:rows.attempts.length,reservedMicros:worker.snapshot.reservedMicros,scope:'Offline corpus and actual production response replay. No provider quality or human review certification.'};
  }catch{return {complete:false,infrastructurePassed:false,errorCode:'CORPUS_EVIDENCE_REJECTED',...boundary};}
  finally {if(server)await closeServer(server,'corpus replay provider');if(scratch)await rm(scratch,{recursive:true,force:true});}
}
