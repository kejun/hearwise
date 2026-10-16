import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createSemanticBatchCheckouts} from '../test-support/semantic-batch-checkouts.mjs';
import {planSemanticProviderPair,collectSemanticProviderPair,inspectSemanticProviderPair,runSemanticDistinctOffline} from '../scripts/lib/semantic-quality-distinct.mjs';
import {semanticBatchPlanFixture} from '../test-support/semantic-batch-plan-fixture.mjs';
import {semanticFixtureSample,semanticFixtureResponse} from '../test-support/semantic-quality-fixture.mjs';
import {SEMANTIC_PROVIDER_PROFILE} from '../scripts/lib/semantic-quality-provider-policy.mjs';
const read=async file=>JSON.parse(await readFile(file));
let root,plan,options,testTransport,seen=[];
before(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'semantic-batch-failure-'));
 const checkouts=Object.fromEntries(['baseline','candidate'].map(role=>[role,path.join(root,role)]));await createSemanticBatchCheckouts(checkouts);
 const price=SEMANTIC_PROVIDER_PROFILE.attemptMicros;plan=semanticBatchPlanFixture({attemptMicros:{knowledge:price,relation:price}});
 plan.budget.currency='CNY';plan.budget.ceilingMicros=100000000;plan.budget.expiresAt=new Date(Date.now()+600000).toISOString();
 const respond=semanticFixtureResponse();testTransport={profile:'semantic-provider-test-only-v1',async send(wire){seen.push(wire);const body=JSON.parse(wire),input=JSON.parse(body.messages[1].content),kind=input.candidates?'relation':'knowledge';const sample=semanticFixtureSample(kind==='relation'||input.focus_segments.some(s=>s.text.includes('Atlas'))?'qualified':'empty');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(respond({input,kind,sample}))}}]}));}};
 options={checkouts,reviewers:plan.reviewers,corpusPlan:plan,release:true};
});
after(()=>root&&rm(root,{recursive:true,force:true}));
test('exhausting the single shared budget preserves the paid attempt and prevents candidate dispatch',async()=>{
  const low=structuredClone(plan);low.budget.ceilingMicros=SEMANTIC_PROVIDER_PROFILE.attemptMicros;low.repetitions=1;
  const out=path.join(root,'budget-exhausted'),args={...options,corpusPlan:low,testTransport},approved=await planSemanticProviderPair(out,args),count=seen.length;
  const report=await collectSemanticProviderPair(out,{...args,key:'synthetic-batch-only-key',approval:{approved:true,planDigest:approved.requestDigest,expiresAt:low.budget.expiresAt}});
  assert.equal(report.complete,false);assert.equal(seen.length-count,1);
  for(let reopen=0;reopen<2;reopen++){const db=new DatabaseSync(path.join(out,'budget.sqlite'),{readOnly:true});try{
    assert.equal(db.prepare('SELECT SUM(reserved_micros) n FROM attempts').get().n,low.budget.ceilingMicros);
    assert.deepEqual(db.prepare('SELECT role,state FROM runs').all().map(r=>({...r})),[{role:'baseline',state:'incomplete'}]);
  }finally{db.close();}}
  assert.equal((await inspectSemanticProviderPair(out,args)).infrastructurePassed,false);
},{timeout:30000});

test('batch deadline leaves durable incomplete baseline and no candidate dispatch',async()=>{
  const short=structuredClone(plan);short.batchTimeoutMs=1;short.limits.requestTimeoutMs=1;short.limits.totalTimeoutMs=1;
  const out=path.join(root,'deadline'),count=seen.length;
  const report=await runSemanticDistinctOffline(out,{...options,corpusPlan:short,providerEndpoint:'http://127.0.0.1:1/'});
  assert.equal(report.complete,false);assert.equal(report.errorCode,'SEMANTIC_BATCH_CANCELLED');assert.equal(seen.length,count);
  const db=new DatabaseSync(path.join(out,'budget.sqlite'),{readOnly:true});try{assert.equal(db.prepare("SELECT COUNT(*) n FROM runs WHERE role='candidate'").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM runs WHERE state='complete'").get().n,0);}finally{db.close();}
  assert.equal((await read(path.join(out,'paired.json'))).complete,false);
});
