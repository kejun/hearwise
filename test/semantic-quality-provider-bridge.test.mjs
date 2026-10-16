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
    const response=await post(bridge);assert.equal(response.status,503);assert.equal(await response.text(),'{"provider":"retry"}');assert.equal(response.headers.get('retry-after'),'0');
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
