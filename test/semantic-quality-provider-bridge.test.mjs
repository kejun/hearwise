import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticProviderBridge } from '../scripts/lib/semantic-quality-provider-bridge.mjs';
import { collectSemanticProviderPair } from '../scripts/lib/semantic-quality-distinct.mjs';
import { SEMANTIC_PROVIDER_PROFILE as profile } from '../scripts/lib/semantic-quality-provider-policy.mjs';
import { hashBytes } from '../scripts/lib/quality-contract.mjs';
const digest='a'.repeat(64),key='synthetic-test-key-only';
function fixture(send){
  const expiresAt=new Date(Date.now()+60000).toISOString();
  const attempt={id:1,kind:'knowledge',trial_id:'baseline:sample:0',reserved_micros:profile.attemptMicros};
  return {requestDigest:digest,expiresAt,key,approval:{approved:true,planDigest:digest,expiresAt},
    plan:{sample:{id:'sample'},limits:{maxRequestBytes:4096,maxResponseBytes:4096,requestTimeoutMs:1000}},
    source:{source:{sha:'b'.repeat(40)},profile:{knowledgePrompt:'Extract.',knowledgeRepairPrompt:'Repair.',relationPrompt:'Relate.'}},
    role:'baseline',snapshot:()=>({attempts:[attempt],runs:[{role:'baseline',state:'running',source_sha:'b'.repeat(40)}],reservedMicros:profile.attemptMicros,ceilingMicros:profile.attemptMicros}),
    testTransport:{profile:'semantic-provider-test-only-v1',send}};
}
const request=(prompt='Extract.',input={text:'Sample.'})=>JSON.stringify({model:profile.model,enable_thinking:false,messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}]});
async function post(bridge,wire=request(),capability=bridge.capability){return fetch(bridge.endpoint,{method:'POST',headers:{authorization:`Bearer ${capability}`},body:wire});}
test('missing approval fails before directory, source probes or upstream work',async()=>{
  await assert.rejects(collectSemanticProviderPair('/does-not-exist/provider'),/PROVIDER_APPROVAL_REQUIRED/);
});
test('private capability, durable reservation and unique last attempt gate exact wire',async()=>{
  const calls=[],options=fixture(async wire=>{calls.push(wire);return new Response('{"provider":"retry"}',{status:503,headers:{'retry-after':'0'}});});
  const bridge=await createSemanticProviderBridge(options);
  try{
    assert.equal((await post(bridge,request(),'incorrect')).status,502);assert.equal(calls.length,0);
    const response=await post(bridge);assert.equal(response.status,503);assert.equal(await response.text(),'{}');assert.equal(response.headers.get('retry-after'),'0');
    assert.equal((await post(bridge)).status,502);assert.deepEqual(calls,[request()]);
    assert.equal(bridge.rows[0].requestSha256,hashBytes(request()));assert.equal(bridge.rows[0].attemptId,'1');
    assert.ok(!JSON.stringify(bridge.rows).includes(key));assert.ok(!JSON.stringify(bridge.rows).includes(bridge.capability));
  }finally{await bridge.close();}
});
test('repair exact source prompt is admitted, mismatched production prompt denied',async()=>{
  let calls=0;const bridge=await createSemanticProviderBridge(fixture(async()=>{calls++;return new Response('{}');}));
  try{assert.equal((await post(bridge,request('Other.'))).status,502);assert.equal(calls,0);assert.equal((await post(bridge,request('Repair.',{rejected:[]}))).status,200);assert.equal(calls,1);}finally{await bridge.close();}
});
test('expiry, cancellation and shared ceiling are rechecked at forwarding time',async()=>{
  for(const mode of ['expiry','cancel','ceiling']){
    let calls=0;const options=fixture(async()=>{calls++;return new Response('{}');}),abort=new AbortController();options.signal=abort.signal;
    const original=options.snapshot;let exhausted=false;options.snapshot=()=>({...original(),...(exhausted?{ceilingMicros:0}:{})});
    const bridge=await createSemanticProviderBridge(options);
    try{
      if(mode==='expiry')options.approval.expiresAt='2000-01-01T00:00:00.000Z';
      if(mode==='cancel')abort.abort();
      if(mode==='ceiling')exhausted=true;
      assert.equal((await post(bridge)).status,502);assert.equal(calls,0);
    }finally{await bridge.close();}
  }
});
test('redirect and credential-bearing provider bodies never escape',async()=>{
  for(const response of [()=>new Response('',{status:302,headers:{location:'https://example.invalid/'}}),()=>new Response(JSON.stringify({nested:JSON.stringify({value:key})}))]){
    const bridge=await createSemanticProviderBridge(fixture(async()=>response()));
    try{const result=await post(bridge);assert.equal(result.status,502);assert.equal(await result.text(),'{}');assert.equal(bridge.rows[0].status,'failed');assert.ok(!JSON.stringify(bridge.rows).includes(key));}finally{await bridge.close();}
  }
});

test('noncooperative transport and response streams remain abortable and close within bounds',async()=>{
  for(const mode of ['send','body']){
    const options=fixture(async()=>mode==='send'?new Promise(()=>{}):new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}})));
    options.plan.limits.requestTimeoutMs=40;
    const bridge=await createSemanticProviderBridge(options);
    try{
      const response=await post(bridge);assert.equal(response.status,502);assert.equal(await response.text(),'{}');assert.equal(bridge.rows[0].status,'failed');
    }finally{await bridge.close();}
  }
},{timeout:5000});
test('close aborts a noncooperative active transport without waiting for its promise',async()=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});
  const options=fixture(()=>{started();return new Promise(()=>{});});options.plan.limits.requestTimeoutMs=10000;
  const bridge=await createSemanticProviderBridge(options),request=post(bridge).then(()=>{},()=>{});
  await ready;await bridge.close();await request;assert.equal(bridge.rows[0].status,'failed');
},{timeout:5000});

test('provider errors retain only status and safe retry hint, never echoed diagnostics',async()=>{
  for(const status of [400,401,429,500,503]){
    const diagnostic='private echoed corpus '+key;
    const bridge=await createSemanticProviderBridge(fixture(async()=>new Response(diagnostic,{status,headers:{'retry-after':'2'}})));
    try{
      const response=await post(bridge);assert.equal(response.status,status);assert.equal(await response.text(),'{}');assert.equal(response.headers.get('retry-after'),'2');
      assert.deepEqual(bridge.rows[0].http,{status,body:'{}',retryAfter:'2'});assert.equal(bridge.rows[0].responseSha256,hashBytes('{}'));
      assert.ok(!JSON.stringify(bridge.rows).includes(diagnostic));assert.ok(!JSON.stringify(bridge.rows).includes(key));
    }finally{await bridge.close();}
  }
});

test('numeric credential echoed as retry hint is omitted from response and evidence',async()=>{
  const options=fixture(async()=>new Response('error',{status:429,headers:{'retry-after':'12345678'}}));options.key='12345678';
  const bridge=await createSemanticProviderBridge(options);
  try{const response=await post(bridge);assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),null);assert.deepEqual(bridge.rows[0].http,{status:429,body:'{}'});assert.ok(!JSON.stringify(bridge.rows).includes(options.key));}finally{await bridge.close();}
});

test('an explicit batch trial admits only its current reservation, never a different repetition',async()=>{
  const calls=[],options=fixture(async wire=>{calls.push(wire);return new Response('{}');});
  const base=options.snapshot();let trial='baseline:sample:0';options.trialId='baseline:sample:2';
  options.snapshot=()=>({...base,attempts:[{...base.attempts[0],trial_id:trial}]});
  const bridge=await createSemanticProviderBridge(options);
  try{
    assert.equal((await post(bridge)).status,502);assert.equal(calls.length,0);
    trial='baseline:sample:2';assert.equal((await post(bridge)).status,200);assert.equal(calls.length,1);
    assert.equal(bridge.rows[0].trialId,trial);assert.equal((await post(bridge)).status,502);assert.equal(calls.length,1);
  }finally{await bridge.close();}
});

test('explicit trial IDs must match the approved role, sample and canonical repetition',async()=>{
  for(const trialId of ['candidate:sample:0','baseline:another:0','baseline:sample:01','baseline:sample:-1','baseline:sample:9007199254740992','baseline:sample:1:0',null]){
    await assert.rejects(createSemanticProviderBridge({...fixture(async()=>{throw new Error('must not send');}),trialId}),/PROVIDER_TRIAL_INVALID/);
  }
});
