// Offline-only child. Record real wall time during collection; replay never opens
// the original ledger. Parent enforces a separate real-time deadline.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
assert.equal(path.resolve(process.cwd())+path.sep,root);
const input=JSON.parse(await readFile(process.argv[2]));
const url=new URL(input.endpoint);
assert.ok(url.protocol==='http:' && url.hostname==='127.0.0.1' && url.port && url.pathname==='/' && !url.username && !url.password && !url.search && !url.hash);
const {validateSemanticCorpusPlan,semanticCorpusBudget}=await import('./semantic-quality-corpus-plan.mjs');
const plan=validateSemanticCorpusPlan(input.plan), budget=semanticCorpusBudget(plan);
const originalDate=Date, originalUUID=crypto.randomUUID, replay=input.runtime!==undefined;
const tape=replay?input.runtime:[], identifiers=new Set();let cursor=0,lastTime=0;
assert.ok(Array.isArray(tape)&&tape.length<=50000);
const tick=(kind,read)=>{
  let value;
  if(replay){const row=tape[cursor++];assert.equal(row?.kind,kind,'RUNTIME_SEQUENCE_CHANGED');value=row.value;}
  else {value=read();assert.ok(tape.length<50000);tape.push({kind,value});}
  if(kind==='uuid'){assert.match(value,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.ok(!identifiers.has(value));identifiers.add(value);}
  else {assert.ok(Number.isSafeInteger(value)&&value>=lastTime&&value<=originalDate.now());lastTime=value;}
  return value;
};
globalThis.Date=class extends originalDate {constructor(...args){super(...(args.length?args:[tick('date',()=>originalDate.now())]));}static now(){return tick('now',()=>originalDate.now());}};
// Only persisted production IDs are recorded. Transport capabilities stay random
// and are never written into the runtime tape.
crypto.randomUUID=(...args)=>{
  const caller=new Error().stack?.split('\n')[2]||'';
  return ['storage.mjs','relation-storage.mjs','knowledge-name.mjs','knowledge-edit.mjs','knowledge-name-replacement.mjs'].some(file=>caller.includes(`(${path.join(root,file)}:`)||caller.includes(`file://${path.join(root,file)}:`))
    ?tick('uuid',()=>originalUUID(...args)):originalUUID(...args);
};
syncBuiltinESMExports();
const {captureSemanticOffline}=await import('./semantic-quality-capture.mjs');
const {qualitySources}=await import('./quality-collector.mjs');
const {openSemanticQualityBudget}=await import('./quality-budget.mjs');
const source=await qualitySources(),ledger=openSemanticQualityBudget(path.join(input.directory,'budget.sqlite'),budget,input.freezeDigest);
let report;
try {
  ledger.claimRun({role:'baseline',sourceSha:source.sha,directory:input.directory,expectedSnapshot:ledger.snapshot()});
  report=await captureSemanticOffline({directory:path.join(input.directory,'capture'),sample:plan.sample,corpusPlan:plan,
    pairedBudget:{ledger,trialId:`baseline:${plan.sample.id}:0`,expiresAt:budget.expiresAt,maxCalls:budget.maxAttempts.knowledge+budget.maxAttempts.relation},
    response:async ({requestWire,signal})=>{
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:requestWire,redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(plan.limits.requestTimeoutMs)]):AbortSignal.timeout(plan.limits.requestTimeoutMs)});
      assert.ok(response.status<300||response.status>=400,'REDIRECT_DENIED');
      const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;assert.ok(length<=plan.limits.maxResponseBytes);chunks.push(chunk);}
      const body=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));
      const retryAfter=response.headers.get('retry-after');
      return {status:response.status,body,...(retryAfter?{retryAfter}: {})};
    }});
  ledger.finishRun('baseline',report.complete);
  const snapshot=ledger.snapshot();ledger.close();
  if(replay)assert.equal(cursor,tape.length,'RUNTIME_TAPE_NOT_CONSUMED');
  globalThis.Date=originalDate;crypto.randomUUID=originalUUID;syncBuiltinESMExports();
  await writeFile(path.join(input.directory,'runtime.json'),JSON.stringify(tape),{flag:'wx',mode:0o600});
  await writeFile(path.join(input.directory,'worker.json'),JSON.stringify({complete:report.complete,snapshot}),{flag:'wx',mode:0o600});
  process.exitCode=report.complete?0:1;
}catch{try{ledger.close();}catch{}process.exitCode=1;}
