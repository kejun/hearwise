// Offline-only child. Record real wall time during collection; replay never opens
// the original ledger. Parent enforces a separate real-time deadline.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { qualitySources } from './quality-collector.mjs';
import { contractDigest } from './quality-contract.mjs';
import { validateSemanticCorpusPair } from './semantic-quality-corpus.mjs';
const root=await realpath(process.cwd());
const local=async name=>{const file=await realpath(path.join(root,name));assert.ok(file.startsWith(root+path.sep),'ESCAPING_CORPUS_SOURCE');return import(pathToFileURL(file).href);};
const input=JSON.parse(await readFile(process.argv[2]));
assert.ok(input.realtime===undefined||typeof input.realtime==='boolean','CORPUS_REALTIME_INVALID');
const realtime=input.realtime===true;
let providerCapability;
if(input.providerCapabilityRequired){
  assert.equal(input.providerCapabilityRequired,true);
  let bytes=0;const chunks=[];for await(const chunk of process.stdin){bytes+=chunk.length;assert.ok(bytes<=256);chunks.push(chunk);}
  providerCapability=Buffer.concat(chunks).toString('utf8');
  assert.match(providerCapability,/^[A-Za-z0-9_-]{32,256}$/,'CORPUS_PROVIDER_CAPABILITY_INVALID');
}
const url=new URL(input.endpoint);
assert.ok(url.protocol==='http:' && url.hostname==='127.0.0.1' && url.port && url.pathname==='/' && !url.username && !url.password && !url.search && !url.hash);
const {validateSemanticCorpusPlan,semanticCorpusBudget}=await import('./semantic-quality-corpus-plan.mjs');
const plan=validateSemanticCorpusPlan(input.plan),source=await qualitySources();
const pair=input.pair===undefined?undefined:validateSemanticCorpusPair(input.pair,plan,{directory:input.claimedDirectory,source});
const budget=pair?.budget||semanticCorpusBudget(plan);
const originalDate=Date, originalUUID=crypto.randomUUID, replay=input.runtime!==undefined;
const tape=replay?input.runtime:[], identifiers=new Set();let cursor=0,lastTime=0;
assert.ok(Array.isArray(tape)&&tape.length<=50000);
const tick=(kind,read)=>{
  let value;
  if(replay){const row=tape[cursor++];assert.equal(row?.kind,kind,'RUNTIME_SEQUENCE_CHANGED');value=row.value;}
  else {value=read();assert.ok(tape.length<50000);tape.push({kind,value});}
  if(kind==='uuid'){assert.match(value,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.ok(!identifiers.has(value));identifiers.add(value);}
  else if(kind==='wait'){assert.ok(Number.isSafeInteger(value)&&value>=0,'RUNTIME_WAIT_INVALID');}
  else {assert.ok(Number.isSafeInteger(value)&&value>=lastTime&&value<=originalDate.now());lastTime=value;}
  return value;
};
// Realtime replay skips elapsed waits. Node/Undici completion callbacks can run
// on either side of those waits, so their clocks must not consume business ticks.
// Bind direct callers to source modules in the execution root or trusted harness;
// never skip, reorder or synthesize recorded production/validation clock reads.
const harnessRoot=new URL('../../',import.meta.url);
const clockSources=new Set(Object.keys(source.files).filter(name=>/^(?:[^/]+|scripts\/lib\/[^/]+)\.mjs$/.test(name))
  .flatMap(name=>[pathToFileURL(path.join(root,name)).href,new URL(name,harnessRoot).href]));
const readTime=kind=>{
  if(realtime){
    const caller=new Error().stack?.split('\n')[3]||'',location=caller.match(/(file:\/\/.*):\d+:\d+\)?$/)?.[1];
    if(!clockSources.has(location))return originalDate.now();
  }
  return tick(kind,()=>originalDate.now());
};
globalThis.Date=class extends originalDate {constructor(...args){super(...(args.length?args:[readTime('date')]));}static now(){return readTime('now');}};
// Only persisted production IDs are recorded. Transport capabilities stay random
// and are never written into the runtime tape.
crypto.randomUUID=(...args)=>{
  const caller=new Error().stack?.split('\n')[2]||'';
  return ['storage.mjs','relation-storage.mjs','knowledge-name.mjs','knowledge-edit.mjs','knowledge-name-replacement.mjs'].some(file=>caller.includes(`(${path.join(root,file)}:`)||caller.includes(`file://${path.join(root,file)}:`))
    ?tick('uuid',()=>originalUUID(...args)):originalUUID(...args);
};
syncBuiltinESMExports();
const {captureSemanticOffline,semanticRealtimeSchedulerVersion}=await local('scripts/lib/semantic-quality-capture.mjs');
if(realtime)assert.equal(semanticRealtimeSchedulerVersion,1,'CORPUS_REALTIME_CAPABILITY_REQUIRED');
const scheduler=realtime?{kind:'realtime',async waitUntil(deadline,signal){
  signal?.throwIfAborted();
  assert.equal(tick('wait',()=>deadline),deadline,'RUNTIME_WAIT_TARGET_CHANGED');
  if(replay)return;
  // Original wall time is never accelerated. Timers are abortable and no extra
  // Date reads enter the tape; replay consumes the workflow's recorded reads.
  for(let remaining=deadline-originalDate.now();remaining>0;remaining=deadline-originalDate.now()){
    await delay(Math.min(remaining,2147483647),undefined,{signal});
  }
  signal?.throwIfAborted();
}}:undefined;
const {openSemanticQualityBudget}=await import('./quality-budget.mjs');
const ledger=openSemanticQualityBudget(pair?.ledgerPath||path.join(input.directory,'budget.sqlite'),budget,pair?.freezeDigest||input.freezeDigest);
let report;
try {
  if(pair)assert.equal(contractDigest(ledger.snapshot()),contractDigest(pair.before),'CORPUS_PAIR_SNAPSHOT_CHANGED');
  else ledger.claimRun({role:'baseline',sourceSha:source.sha,directory:input.directory,expectedSnapshot:ledger.snapshot()});
  report=await captureSemanticOffline({directory:path.join(input.directory,'capture'),sample:plan.sample,corpusPlan:plan,...(scheduler?{scheduler}:{}),
    pairedBudget:{ledger,trialId:`${pair?.role||'baseline'}:${plan.sample.id}:0`,expiresAt:budget.expiresAt,maxCalls:budget.maxTrialAttempts.knowledge+budget.maxTrialAttempts.relation},
    response:async ({requestWire,signal})=>{
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...(providerCapability?{authorization:`Bearer ${providerCapability}`}:{})},body:requestWire,redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(plan.limits.requestTimeoutMs)]):AbortSignal.timeout(plan.limits.requestTimeoutMs)});
      assert.ok(response.status<300||response.status>=400,'REDIRECT_DENIED');
      const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;assert.ok(length<=plan.limits.maxResponseBytes);chunks.push(chunk);}
      const body=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));
      const retryAfter=response.headers.get('retry-after');
      return {status:response.status,body,...(retryAfter?{retryAfter}: {})};
    }});
  if(!pair)ledger.finishRun('baseline',report.complete);
  const snapshot=ledger.snapshot();ledger.close();
  if(replay)assert.equal(cursor,tape.length,'RUNTIME_TAPE_NOT_CONSUMED');
  globalThis.Date=originalDate;crypto.randomUUID=originalUUID;syncBuiltinESMExports();
  await writeFile(path.join(input.directory,'runtime.json'),JSON.stringify(tape),{flag:'wx',mode:0o600});
  await writeFile(path.join(input.directory,'worker.json'),JSON.stringify({complete:report.complete,snapshot}),{flag:'wx',mode:0o600});
  process.exitCode=report.complete?0:1;
}catch{try{ledger.close();}catch{}process.exitCode=1;}
