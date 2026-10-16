// Trusted-parent transport. Target checkouts are trusted code, not a sandbox.
// Credentials and per-role capabilities never enter evidence or worker files.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { hashBytes } from './quality-contract.mjs';
import { SEMANTIC_PROVIDER_PROFILE, assertSemanticProviderApproval, assertSemanticProviderRequest, validateSemanticProviderEndpoint } from './semantic-quality-provider-policy.mjs';
import { closeServer, deadline } from '../../test-support/lifecycle.mjs';

function abortable(operation,signal) {
  return new Promise((resolve,reject)=>{
    const cleanup=()=>signal.removeEventListener('abort',stop);
    const stop=()=>{cleanup();reject(new Error('PROVIDER_CANCELLED'));};
    Promise.resolve(operation).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
    if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});
  });
}
function cancelBody(body) {
  try{Promise.resolve(body?.cancel()).catch(()=>{});}catch{}
}
async function boundedBody(body,maximum,signal) {
  if(!body)return Buffer.alloc(0);
  const reader=body.getReader(),chunks=[];let size=0,finished=false;
  try{
    for(;;){
      signal.throwIfAborted();const {done,value}=await abortable(reader.read(),signal);
      if(done){finished=true;break;}
      size+=value.length;assert.ok(size<=maximum,'PROVIDER_RESPONSE_LIMIT');chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }finally{
    // A hostile test stream may also ignore cancellation; never await it.
    if(!finished)try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}
    try{reader.releaseLock();}catch{}
  }
}

function secretScanner(key,capability) {
  const secret=(value,depth=0)=>{
    if(depth>24)return true;
    if(Array.isArray(value))return value.some(x=>secret(x,depth+1));
    if(value&&typeof value==='object')return Object.entries(value).some(([k,v])=>secret(k,depth+1)||secret(v,depth+1));
    if(typeof value!=='string')return false;
    if(value.includes(key)||(capability&&value.includes(capability))||/authorization\s*[":=]|bearer\s+[a-z0-9._~-]+/i.test(value))return true;
    try{const parsed=JSON.parse(value);if(parsed!==value)return secret(parsed,depth+1);}catch{}
    const decoded=value.replace(/\\u([0-9a-f]{4})/gi,(_,x)=>String.fromCharCode(parseInt(x,16))).replace(/\\\//g,'/');
    return decoded!==value&&secret(decoded,depth+1);
  };
  return secret;
}
export function assertSemanticProviderSafeInput(key,value) {
  assert.ok(typeof key==='string'&&/^[a-zA-Z0-9._~+/-]{8,4096}=*$/.test(key),'PROVIDER_KEY_REQUIRED');
  assert.ok(!secretScanner(key)(value),'PROVIDER_INPUT_CONTAINS_SECRET');
}

export async function createSemanticProviderBridge({ approval, requestDigest, expiresAt, key, plan, source, role, snapshot, signal, testTransport }) {
  assertSemanticProviderApproval({ approval, requestDigest, expiresAt });
  assert.ok(!process.env.CI || testTransport, 'LIVE_PROVIDER_DISABLED_IN_CI');
  assert.ok(typeof key === 'string' && /^[a-zA-Z0-9._~+/-]{8,4096}=*$/.test(key), 'PROVIDER_KEY_REQUIRED');
  if(testTransport)assert.ok(testTransport.profile==='semantic-provider-test-only-v1'&&typeof testTransport.send==='function','TEST_TRANSPORT_INVALID');
  validateSemanticProviderEndpoint(SEMANTIC_PROVIDER_PROFILE.endpoint);
  const capability=randomBytes(32).toString('hex'), rows=[], used=new Set(), operations=new Set(), controllers=new Set();
  let closed=false;
  const secret=secretScanner(key,capability);
  assert.ok(!secret(JSON.stringify({plan,source,approval})), 'PROVIDER_INPUT_CONTAINS_SECRET');
  const check=()=>{assert.ok(!closed,'PROVIDER_BRIDGE_CLOSED');signal?.throwIfAborted();assertSemanticProviderApproval({approval,requestDigest,expiresAt});};
  async function handle(request,reply){
    const controller=new AbortController();controllers.add(controller);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const timer=setTimeout(()=>{controller.abort();if(!request.complete)request.destroy();},plan.limits.requestTimeoutMs);
    const disconnected=()=>{if(!reply.writableEnded)controller.abort();};reply.once('close',disconnected);
    let row;
    const send=(status,body,retryAfter)=>{if(!reply.destroyed&&!reply.writableEnded){reply.writeHead(status,{'content-type':'application/json',...(retryAfter?{'retry-after':retryAfter}:{})});reply.end(body);}};
    try{
      check();assert.equal(request.method,'POST');assert.equal(request.url,'/');assert.equal(request.headers.authorization,`Bearer ${capability}`);
      const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;assert.ok(size<=plan.limits.maxRequestBytes);chunks.push(chunk);}
      combined.throwIfAborted();const wire=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));assert.ok(!secret(wire));
      const body=JSON.parse(wire),kind=Object.hasOwn(body,'response_format')?'relation':'knowledge';assertSemanticProviderRequest(kind,body);
      const input=JSON.parse(body.messages[1].content);
      assert.equal(body.messages[0].content,source.profile[kind==='relation'?'relationPrompt':Object.hasOwn(input,'rejected')?'knowledgeRepairPrompt':'knowledgePrompt']);
      // The production collector validates the complete request against its
      // active reservation before durably reserving. Recheck the original shared
      // ledger here; a repeated or unclaimed local request cannot spend again.
      const state=snapshot(),last=state.attempts.at(-1),run=state.runs.find(x=>x.role===role);
      assert.ok(run?.state==='running'&&run.source_sha===source.source.sha);
      assert.ok(last&&last.kind===kind&&last.trial_id===`${role}:${plan.sample.id}:0`&&!used.has(last.id));
      assert.equal(last.reserved_micros,SEMANTIC_PROVIDER_PROFILE.attemptMicros);assert.ok(state.reservedMicros<=state.ceilingMicros);
      check();combined.throwIfAborted();used.add(last.id);
      row={role,kind,attemptId:String(last.id),trialId:last.trial_id,requestWire:wire,requestSha256:hashBytes(wire),startedAt:new Date().toISOString(),forwarded:false};rows.push(row);
      const operation=Promise.resolve().then(()=>{
        check();combined.throwIfAborted();row.forwarded=true;
        return testTransport?testTransport.send(wire,{signal:combined}):fetch(SEMANTIC_PROVIDER_PROFILE.endpoint,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:wire,redirect:'manual',signal:combined});
      }).then(response=>{if(combined.aborted){cancelBody(response.body);combined.throwIfAborted();}return response;});
      const response=await abortable(operation,combined);
      if(response.status>=300&&response.status<400){cancelBody(response.body);throw new Error('PROVIDER_REDIRECT_DENIED');}
      let text='{}';
      if(response.status>=200&&response.status<300){
        const output=await boundedBody(response.body,plan.limits.maxResponseBytes,combined);
        text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(output);assert.ok(!secret(text),'PROVIDER_SECRET_RESPONSE');
      }else cancelBody(response.body); // Error diagnostics may echo private input; never retain or relay them.
      combined.throwIfAborted();
      const retry=response.headers.get('retry-after'),retryAfter=typeof retry==='string'&&/^\d+(?:\.\d+)?$/.test(retry)&&retry.length<=10&&!secret(retry)?retry:undefined;
      row.http={status:response.status,body:text,...(retryAfter?{retryAfter}:{})};row.responseSha256=hashBytes(text);row.status='delivered';send(response.status,text,retryAfter);
    }catch{
      if(row){row.status='failed';row.errorCode='PROVIDER_TRANSPORT_FAILED';row.http={status:502,body:'{}'};row.responseSha256=hashBytes('{}');}
      send(502,'{}');
    }finally{if(row)row.finishedAt=new Date().toISOString();clearTimeout(timer);controller.abort();controllers.delete(controller);reply.removeListener('close',disconnected);}
  }
  const server=http.createServer((request,reply)=>{const operation=handle(request,reply);operations.add(operation);operation.finally(()=>operations.delete(operation));});
  check();server.listen(0,'127.0.0.1');await once(server,'listening');
  return {endpoint:`http://127.0.0.1:${server.address().port}/`,capability,rows,
    async close(){closed=true;for(const controller of controllers)controller.abort();await closeServer(server,'semantic provider bridge');await deadline(()=>Promise.all(operations),1500,'semantic provider operations shutdown');}};
}
