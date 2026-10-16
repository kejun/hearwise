import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {collectSemanticCorpusOffline,inspectSemanticCorpusOffline} from '../scripts/lib/semantic-quality-corpus.mjs';
import {semanticFixtureSample,semanticFixtureResponse} from '../test-support/semantic-quality-fixture.mjs';
import {semanticDatabase,semanticUnits} from '../scripts/lib/semantic-quality-capture.mjs';
import {hashBytes} from '../scripts/lib/quality-contract.mjs';
const json=async file=>JSON.parse(await readFile(file));let root,plan,run,capture;
const text='Atlas also called AtlasCo, Nova, Orion and Vale are independent organizations. Skip is merely mentioned. Atlas did not acquire Nova for 15 dollars. If approved, Atlas plans to acquire Nova for 20 dollars.';
function makePlan(segments=Array(14).fill(text),batch=3){return {schemaVersion:1,kind:'offline-semantic-corpus-plan',mode:'offline',sample:{id:'qualified',kind:'offline-text-corpus',segments,ingestionBatchSize:batch,gold:{approved:false,variants:[{id:'unreviewed',units:[]}]}},reviewers:['synthetic test label'],budget:{id:'synthetic-only',currency:'USD',ceilingMicros:100000,attemptMicros:{knowledge:2,relation:3},expiresAt:new Date(Date.now()+600000).toISOString()},limits:{maxRequestBytes:128000,maxResponseBytes:128000,requestTimeoutMs:3000,totalTimeoutMs:30000}};}
async function provider(fn){const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));const input=JSON.parse(body.messages[1].content),kind=input.candidates?'relation':input.rejected?'repair':'knowledge';const value=await fn({input,kind,body});if(value.status){res.writeHead(value.status,{'content-type':'application/json',...(value.retryAfter?{'retry-after':value.retryAfter}:{})});res.end(value.body);}else{res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));}}catch{res.writeHead(400);res.end('{}');}});server.listen(0,'127.0.0.1');await once(server,'listening');return {url:`http://127.0.0.1:${server.address().port}/`,close:()=>new Promise(resolve=>server.close(resolve))};}
before(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'semantic-corpus-test-'));plan=makePlan();run=path.join(root,'run');let first=true,initial=0;
 const base=semanticFixtureResponse();const upstream=await provider(({input,kind})=>{
  if(first){first=false;return {status:503,body:'{"synthetic":"temporary failure"}',retryAfter:'0'};}
  if(kind==='repair')return {corrections:input.rejected.map(row=>({rejection_id:row.rejection_id,item:{...row.item,certainty:'clear'}}))};
  const sample={...plan.sample,names:['Atlas','Nova','Orion','Vale','Skip']};const value=base({input,kind,sample,calls:[]});
  if(kind==='knowledge'){
   initial++;const atlas=value.items.find(x=>x.canonical_name==='Atlas');atlas.aliases=['AtlasCo'];if(initial===1)atlas.certainty='invalid';
   const vale=value.items.find(x=>x.canonical_name==='Vale');if(initial===1){vale.action='observe';vale.role='incidental';vale.reason='Insufficient evidence initially.';}else{const old=input.observed_candidates?.find(x=>x.canonical_name==='Vale');if(old)vale.observed_candidate_id=old.id;}
   const skip=value.items.find(x=>x.canonical_name==='Skip');skip.action='exclude';skip.reason='Incidental only.';
  }return value;
 });
 try {assert.equal((await collectSemanticCorpusOffline(run,{plan,providerEndpoint:upstream.url})).complete,true);}
 finally{await upstream.close();}
 capture=await json(path.join(run,'capture/capture.json'));
}, {timeout:40000});
after(()=>rm(root,{recursive:true,force:true}));
test('arbitrary corpus runs batches, repair, HTTP retry and multiple real relation windows',async()=>{
 assert.equal(capture.sample.segments.length,14);assert.ok(capture.after.tables.relation_windows.length>=3);
 assert.ok(capture.calls.some(x=>x.kind==='repair'));assert.ok(capture.calls.some(x=>x.http.status===503));
 assert.ok(capture.after.tables.knowledge_aliases.some(x=>x.alias==='AtlasCo'));
 assert.ok(capture.after.tables.knowledge_items.some(x=>x.canonical_name==='Vale'));
 assert.ok(capture.after.tables.knowledge_candidates.some(x=>x.canonical_name==='Skip'&&x.state==='exclude'));
 const result=await inspectSemanticCorpusOffline(run,{plan});assert.equal(result.infrastructurePassed,true,JSON.stringify(result));assert.equal(result.review.contractValid,false);assert.equal(result.qualityStatus,'not_run');assert.ok(result.attempts>capture.calls.length-1);
});
test('same complex raw response tape replays repeatedly without changing original evidence',async()=>{
 const files=['runtime.json','worker.json','budget.sqlite','capture/store.sqlite','capture/capture.json'];const before=await Promise.all(files.map(async f=>hashBytes(await readFile(path.join(run,f)))));
 for(let i=0;i<3;i++)assert.equal((await inspectSemanticCorpusOffline(run,{plan})).infrastructurePassed,true);
 assert.deepEqual(await Promise.all(files.map(async f=>hashBytes(await readFile(path.join(run,f))))),before);
});
test('caller plan, raw response and runtime edits cannot bless self-consistent artifacts',async()=>{
 const other=structuredClone(plan);other.sample.segments[0]+=' Changed.';assert.equal((await inspectSemanticCorpusOffline(run,{plan:other})).infrastructurePassed,false);
 for(const file of ['runtime.json','capture/capture.json']){
  const full=path.join(run,file),bytes=await readFile(full),value=JSON.parse(bytes);
  if(file==='runtime.json')value.pop();else value.calls[0].http.body='{"changed":true}';
  await writeFile(full,JSON.stringify(value));try{assert.equal((await inspectSemanticCorpusOffline(run,{plan})).infrastructurePassed,false);}finally{await writeFile(full,bytes);}
 }
});
test('coordinated SQLite snapshot and checksum forgery is rejected by production replay',async()=>{
 const file=path.join(run,'capture/capture.json'),dbfile=path.join(run,'capture/store.sqlite'),bytes=await readFile(file),dbbytes=await readFile(dbfile);
 const report=JSON.parse(bytes),db=new DatabaseSync(dbfile);db.exec("UPDATE knowledge_items SET dialogue_summary='FORGED unsupported fact'");db.close();
 report.after=semanticDatabase(dbfile);report.before.tables.knowledge_items=structuredClone(report.after.tables.knowledge_items);report.units=semanticUnits(report.after);report.artifacts[0].sha256=hashBytes(await readFile(dbfile));await writeFile(file,JSON.stringify(report));
 try{assert.equal((await inspectSemanticCorpusOffline(run,{plan})).infrastructurePassed,false);}finally{await writeFile(dbfile,dbbytes);await writeFile(file,bytes);}
});
test('actual CLI check succeeds and assessment fails for unfilled declared review',async()=>{
 const file=path.join(root,'plan.json');await writeFile(file,JSON.stringify(plan));
 for(const [command,status] of [['check-corpus-offline',0],['assess-corpus-offline',1]]){
  const r=spawnSync(process.execPath,['scripts/evaluate-semantic-quality.mjs',command,'--plan',file,'--out',run],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});assert.equal(r.status,status,r.stderr);assert.equal(JSON.parse(r.stdout).infrastructurePassed,true);
 }
});
test('live and non-loopback providers are rejected before a corpus is sent',async()=>{
 await assert.rejects(collectSemanticCorpusOffline(path.join(root,'bad'),{plan,providerEndpoint:'https://example.com/'}),/LOOPBACK_ONLY/);
 const expired=structuredClone(plan);expired.budget.expiresAt='2020-01-01T00:00:00.000Z';await assert.rejects(collectSemanticCorpusOffline(path.join(root,'expired'),{plan:expired,providerEndpoint:'http://127.0.0.1:1/'}),/EXPIRED/);
 const r=spawnSync(process.execPath,['scripts/evaluate-semantic-quality.mjs','collect','--live'],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/NOT_IMPLEMENTED_OR_AUTHORIZED/);
});
test('long source really splits into production parts and preserves UUID-looking prose',async()=>{
 const paragraph='The identifier 123e4567-e89b-42d3-a456-426614174000 is quoted as ordinary text. ';
 const samplePlan=makePlan([paragraph.repeat(65)],1),dir=path.join(root,'long');const upstream=await provider(()=>({items:[]}));
 try{assert.equal((await collectSemanticCorpusOffline(dir,{plan:samplePlan,providerEndpoint:upstream.url})).complete,true);}finally{await upstream.close();}
 const r=await json(path.join(dir,'capture/capture.json'));assert.ok(r.after.tables.extraction_parts.length>=2);
 assert.equal(r.after.tables.segments[0].original_text,samplePlan.sample.segments[0]);
 assert.equal((await inspectSemanticCorpusOffline(dir,{plan:samplePlan})).infrastructurePassed,true);
});
test('protocol retry and terminal provider failure are recorded without manufacturing quality',async()=>{
 for(const scenario of ['malformed-then-empty','permanent']){
  const p=makePlan(['A source without named entities.'],1),dir=path.join(root,scenario);let count=0;
  const upstream=await provider(()=>scenario==='permanent'?{status:403,body:'{"denied":true}'}:count++===0?{status:200,body:'not JSON'}:{items:[]});
  try{assert.equal((await collectSemanticCorpusOffline(dir,{plan:p,providerEndpoint:upstream.url})).complete,true);}finally{await upstream.close();}
  const r=await json(path.join(dir,'capture/capture.json'));assert.ok(r.diagnostics.length>0);assert.equal(r.calls.length,scenario==='permanent'?1:2);
  assert.equal((await inspectSemanticCorpusOffline(dir,{plan:p})).infrastructurePassed,true);
  if(scenario==='permanent')assert.equal(r.after.tables.extraction_jobs[0].state,'failed');
 }
});
test('budget exhaustion never forwards an unreserved attempt or refunds previous cost',async()=>{
 const p=makePlan(['A source without named entities.'],1);p.budget.ceilingMicros=2;const dir=path.join(root,'budget');let requests=0;
 const upstream=await provider(()=>{requests++;return {status:503,body:'{}'};});
 try{assert.equal((await collectSemanticCorpusOffline(dir,{plan:p,providerEndpoint:upstream.url})).complete,false);}finally{await upstream.close();}
 assert.equal(requests,1);
 for(let i=0;i<3;i++){const db=new DatabaseSync(path.join(dir,'budget.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT SUM(reserved_micros) AS n FROM attempts').get().n,2);}finally{db.close();}}
 assert.equal((await inspectSemanticCorpusOffline(dir,{plan:p})).infrastructurePassed,false);
});
test('cancel after actual durable reservation preserves evidence and rejects completeness',async()=>{
 const p=makePlan(['A source without named entities.'],1),dir=path.join(root,'cancelled'),abort=new AbortController();let forwarded=false;
 const upstream=await provider(async()=>{forwarded=true;abort.abort();return {items:[]};});
 try{const result=await collectSemanticCorpusOffline(dir,{plan:p,providerEndpoint:upstream.url,signal:abort.signal});assert.equal(result.complete,false);assert.equal(result.errorCode,'CORPUS_CANCELLED');}finally{await upstream.close();}
 assert.equal(forwarded,true);const db=new DatabaseSync(path.join(dir,'budget.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT SUM(reserved_micros) AS n FROM attempts').get().n,2);}finally{db.close();}
 assert.equal((await inspectSemanticCorpusOffline(dir,{plan:p})).infrastructurePassed,false);
});
test('reported fee totals cannot be edited while retaining the real ledger',async()=>{
 const file=path.join(run,'worker.json'),bytes=await readFile(file),value=JSON.parse(bytes);value.snapshot.reservedMicros=0;await writeFile(file,JSON.stringify(value));
 try{assert.equal((await inspectSemanticCorpusOffline(run,{plan})).infrastructurePassed,false);}finally{await writeFile(file,bytes);}
});
test('aliases, excluded candidates and relation conditions remain tied to raw responses',async()=>{
 for(const [table,column,value] of [['knowledge_aliases','alias','ForgedAlias'],['knowledge_candidates','reason','ForgedReason'],['relation_assertions','conditions','ForgedCondition']]){
  const file=path.join(run,'capture/capture.json'),dbfile=path.join(run,'capture/store.sqlite'),bytes=await readFile(file),dbbytes=await readFile(dbfile),report=JSON.parse(bytes);
  const db=new DatabaseSync(dbfile);const changed=db.prepare(`UPDATE ${table} SET ${column}=?`).run(value);db.close();assert.ok(changed.changes>0);
  report.after=semanticDatabase(dbfile);report.before.tables[table]=structuredClone(report.after.tables[table]);report.units=semanticUnits(report.after);report.artifacts[0].sha256=hashBytes(await readFile(dbfile));await writeFile(file,JSON.stringify(report));
  try{assert.equal((await inspectSemanticCorpusOffline(run,{plan})).infrastructurePassed,false);}finally{await writeFile(dbfile,dbbytes);await writeFile(file,bytes);}
 }
});
test('actual corpus collection CLI reaches independent readback',async()=>{
 const p=makePlan(['A source without named entities.'],1),dir=path.join(root,'cli-collect'),file=path.join(root,'cli-plan.json');await writeFile(file,JSON.stringify(p));
 const upstream=await provider(()=>({items:[]}));try{
  const {stdout}=await promisify(execFile)(process.execPath,['scripts/evaluate-semantic-quality.mjs','corpus-offline','--plan',file,'--provider',upstream.url,'--out',dir],{timeout:15000,maxBuffer:1024*1024});assert.equal(JSON.parse(stdout).infrastructurePassed,true);
 }finally{await upstream.close();}
});

test('endpoint labels cannot bypass the loopback boundary through normalization',async()=>{
 const file=path.join(run,'capture/capture.json'),bytes=await readFile(file);
 for(const target of ['calls','observations']){
  const value=JSON.parse(bytes);(target==='calls'?value.calls:value.transport.observations)[0].endpoint='https://example.com/';
  await writeFile(file,JSON.stringify(value));try{assert.equal((await inspectSemanticCorpusOffline(run,{plan})).infrastructurePassed,false);}finally{await writeFile(file,bytes);}
 }
});
test('ledger directory must bind the original capture before scratch normalization',async()=>{
 const file=path.join(run,'worker.json'),dbfile=path.join(run,'budget.sqlite'),bytes=await readFile(file),dbbytes=await readFile(dbfile),value=JSON.parse(bytes);
 const db=new DatabaseSync(dbfile);db.prepare('UPDATE runs SET directory=?').run('<capture-root>');db.close();value.snapshot.runs[0].directory='<capture-root>';await writeFile(file,JSON.stringify(value));
 try{assert.equal((await inspectSemanticCorpusOffline(run,{plan})).infrastructurePassed,false);}finally{await writeFile(file,bytes);await writeFile(dbfile,dbbytes);}
});
