import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {collectSemanticCorpusOffline,inspectSemanticCorpusOffline} from '../scripts/lib/semantic-quality-corpus.mjs';
import {semanticCorpusBudget} from '../scripts/lib/semantic-quality-corpus-plan.mjs';
import {openSemanticQualityBudget} from '../scripts/lib/quality-budget.mjs';
import {contractDigest,hashBytes} from '../scripts/lib/quality-contract.mjs';
const json=async file=>JSON.parse(await readFile(file));
const sourceSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
let root,plan,budget,ledgerPath,freezeDigest,pairs={},snapshots={};
function makePlan(ceilingMicros=100){return {schemaVersion:1,kind:'offline-semantic-corpus-plan',mode:'offline',sample:{id:'shared-corpus',kind:'offline-text-corpus',segments:['A source without named entities.'],ingestionBatchSize:1,gold:{approved:false,variants:[{id:'unreviewed',units:[]}]}},reviewers:['synthetic test label'],budget:{id:'shared-synthetic-only',currency:'USD',ceilingMicros,attemptMicros:{knowledge:2,relation:3},expiresAt:new Date(Date.now()+600000).toISOString()},limits:{maxRequestBytes:32768,maxResponseBytes:16384,requestTimeoutMs:3000,totalTimeoutMs:10000}};}
function pairBudget(plan){const single=semanticCorpusBudget(plan);return {...single,maxAttempts:Object.fromEntries(Object.entries(single.maxAttempts).map(([kind,count])=>[kind,count*2]))};}
async function provider(fail=false){let requests=0;const server=http.createServer(async(req,res)=>{for await(const chunk of req)void chunk;requests++;res.writeHead(fail?503:200,{'content-type':'application/json'});res.end(fail?'{}':JSON.stringify({choices:[{message:{content:'{"items":[]}'}}]}));});server.listen(0,'127.0.0.1');await once(server,'listening');return {url:`http://127.0.0.1:${server.address().port}/`,requests:()=>requests,close:()=>new Promise(resolve=>server.close(resolve))};}
before(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),'semantic-corpus-shared-'));plan=makePlan();budget=pairBudget(plan);ledgerPath=path.join(root,'shared.sqlite');freezeDigest=contractDigest({plan,comparison:'shared-test'});
  const ledger=openSemanticQualityBudget(ledgerPath,budget,freezeDigest),upstream=await provider();
  try {
    for(const role of ['baseline','candidate']){
      const directory=path.join(root,role);ledger.claimRun({role,sourceSha,directory,expectedSnapshot:ledger.snapshot()});
      pairs[role]={role,ledgerPath,budget,freezeDigest,before:ledger.snapshot()};
      assert.equal((await collectSemanticCorpusOffline(directory,{plan,providerEndpoint:upstream.url,pair:pairs[role]})).complete,true);
      const worker=await json(path.join(directory,'worker.json'));assert.deepEqual(worker.snapshot,ledger.snapshot());assert.equal(worker.snapshot.runs.find(row=>row.role===role).state,'running');
      snapshots[role]=worker.snapshot;ledger.finishRun(role,true);
    }
  }finally{ledger.close();await upstream.close();}
},{timeout:30000});
after(()=>rm(root,{recursive:true,force:true}));
test('pair roles reserve one shared prefix and only coordinator finishes them',async()=>{
  assert.equal(snapshots.baseline.reservedMicros,2);assert.equal(snapshots.candidate.reservedMicros,4);
  assert.deepEqual(snapshots.candidate.attempts.map(row=>row.trial_id),['baseline:shared-corpus:0','candidate:shared-corpus:0']);
  for(const role of ['baseline','candidate']){
    await assert.rejects(readFile(path.join(root,role,'budget.sqlite')),/ENOENT/);
    const frozen=await json(path.join(root,role,'freeze.json'));assert.equal(frozen.pair.role,role);assert.equal(Object.hasOwn(frozen.pair,'ledgerPath'),false);
    const result=await inspectSemanticCorpusOffline(path.join(root,role),{plan,pair:pairs[role]});assert.equal(result.infrastructurePassed,true,JSON.stringify(result));assert.equal(result.attempts,1);assert.deepEqual(result.pair.after,snapshots[role]);
  }
});
test('pair replay never reads or mutates original shared ledger',async()=>{
  const before=hashBytes(await readFile(ledgerPath));await rename(ledgerPath,`${ledgerPath}.hidden`);
  try {for(const role of ['baseline','candidate'])for(let i=0;i<2;i++)assert.equal((await inspectSemanticCorpusOffline(path.join(root,role),{plan,pair:pairs[role]})).infrastructurePassed,true);await assert.rejects(readFile(ledgerPath),/ENOENT/);}
  finally{await rename(`${ledgerPath}.hidden`,ledgerPath);}
  assert.equal(hashBytes(await readFile(ledgerPath)),before);
});
test('pair inspection needs explicit trusted context and rejects malformed prefix',async()=>{
  const directory=path.join(root,'candidate');assert.equal((await inspectSemanticCorpusOffline(directory,{plan})).infrastructurePassed,false);
  for(const mutate of [pair=>pair.role='baseline',pair=>pair.before.runs[0].state='running',pair=>pair.before.runs[1].directory=path.join(root,'other'),pair=>pair.before.runs[1].source_sha='0'.repeat(40),pair=>pair.before.reservedMicros=0,pair=>pair.before.binding='0'.repeat(64),pair=>pair.before.attempts[0].id=2,pair=>pair.budget.maxAttempts.knowledge++]){
    const pair=structuredClone(pairs.candidate);mutate(pair);assert.equal((await inspectSemanticCorpusOffline(directory,{plan,pair})).infrastructurePassed,false);
  }
});
test('pair replay rejects altered runtime and after snapshot while preserving original ledger',async()=>{
  const directory=path.join(root,'candidate'),before=hashBytes(await readFile(ledgerPath));
  for(const filename of ['runtime.json','worker.json','freeze.json']){
    const file=path.join(directory,filename),bytes=await readFile(file),value=JSON.parse(bytes);
    if(filename==='runtime.json')value.pop();else if(filename==='worker.json')value.snapshot.attempts.at(-1).observation_json='{"forged":true}';else value.pair.before.runs[0].finished_at=value.pair.before.runs[0].started_at;
    await writeFile(file,JSON.stringify(value));try{assert.equal((await inspectSemanticCorpusOffline(directory,{plan,pair:pairs.candidate})).infrastructurePassed,false);}finally{await writeFile(file,bytes);}
  }
  assert.equal(hashBytes(await readFile(ledgerPath)),before);
});
test('failed pair calls stay reserved and worker does not finish a failed role',async()=>{
  const p=makePlan(4),b=pairBudget(p),directory=path.join(root,'failed'),file=path.join(root,'failed.sqlite'),digest=contractDigest({p,failed:true});
  const ledger=openSemanticQualityBudget(file,b,digest),upstream=await provider(true);
  try {
    ledger.claimRun({role:'baseline',sourceSha,directory,expectedSnapshot:ledger.snapshot()});const pair={role:'baseline',ledgerPath:file,budget:b,freezeDigest:digest,before:ledger.snapshot()};
    assert.equal((await collectSemanticCorpusOffline(directory,{plan:p,providerEndpoint:upstream.url,pair})).complete,false);
    const snapshot=ledger.snapshot();assert.equal(snapshot.reservedMicros,4);assert.equal(snapshot.attempts.length,2);assert.equal(upstream.requests(),2);assert.equal(snapshot.runs[0].state,'running');assert.equal(snapshot.runs[0].finished_at,null);
    assert.equal((await inspectSemanticCorpusOffline(directory,{plan:p,pair})).infrastructurePassed,false);ledger.finishRun('baseline',false);assert.equal(ledger.snapshot().reservedMicros,4);
  }finally{ledger.close();await upstream.close();}
});
