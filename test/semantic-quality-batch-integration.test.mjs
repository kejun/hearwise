import test,{before,after} from 'node:test';
import {createSemanticBatchCheckouts} from '../test-support/semantic-batch-checkouts.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {closeServer} from '../test-support/lifecycle.mjs';
import {DatabaseSync} from 'node:sqlite';
import {runSemanticDistinctOffline,inspectSemanticDistinctOffline} from '../scripts/lib/semantic-quality-distinct.mjs';
import {assessSemanticBatch} from '../scripts/lib/semantic-quality-batch-assessment.mjs';
import {assessSemanticReview,createSemanticReviewTemplate} from '../scripts/lib/semantic-quality-review.mjs';
import {semanticBatchTrials} from '../scripts/lib/semantic-quality-batch-plan.mjs';
import {semanticFixtureSample,semanticFixtureResponse,semanticFixtureReview,semanticFixtureReviewers} from '../test-support/semantic-quality-fixture.mjs';
import {SEMANTIC_PROVIDER_PROFILE} from '../scripts/lib/semantic-quality-provider-policy.mjs';
import {hashBytes} from '../scripts/lib/quality-contract.mjs';
import {semanticBatchPlanFixture,refreshSemanticBatchFixtureDigests} from '../test-support/semantic-batch-plan-fixture.mjs';
import {semanticDatabase,semanticUnits} from '../scripts/lib/semantic-quality-capture.mjs';
const read=async file=>JSON.parse(await readFile(file)),roles=['baseline','candidate'];
const cli=command=>spawnSync(process.execPath,['scripts/evaluate-semantic-quality.mjs',command,'--out',directory,'--baseline',checkouts.baseline,'--candidate',checkouts.candidate,'--plan',path.join(root,'plan.json'),'--reviewers',path.join(root,'reviewers.json'),'--release'],{encoding:'utf8',timeout:85000,maxBuffer:16*1024*1024,env:{PATH:process.env.PATH}});
function batchPlan(){
  const price=SEMANTIC_PROVIDER_PROFILE.attemptMicros;
  const plan=semanticBatchPlanFixture({thresholds:1,attemptMicros:{knowledge:price,relation:price}});
  plan.budget.currency='CNY';plan.budget.ceilingMicros=100000000;plan.budget.expiresAt=new Date(Date.now()+600000).toISOString();
  plan.assessment.criticalGoldIds=Object.fromEntries(plan.samples.map(s=>[s.id,{expected:s.gold.variants[0].units.map(u=>u.id)}]));
  return refreshSemanticBatchFixtureDigests(plan);
}
let root,directory,checkouts,plan,options,result,server,testTransport,seen=[];
before(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),'semantic-batch-'));directory=path.join(root,'run');checkouts=Object.fromEntries(roles.map(role=>[role,path.join(root,role)]));
  await createSemanticBatchCheckouts(checkouts);
  plan=batchPlan();await writeFile(path.join(root,'plan.json'),JSON.stringify(plan));await writeFile(path.join(root,'reviewers.json'),JSON.stringify(plan.reviewers));const respond=semanticFixtureResponse();
  testTransport={profile:'semantic-provider-test-only-v1',async send(wire){seen.push(wire);const body=JSON.parse(wire),input=JSON.parse(body.messages[1].content),kind=input.candidates?'relation':'knowledge';
    const sample=semanticFixtureSample(kind==='relation'||input.focus_segments.some(s=>s.text.includes('Atlas'))?'qualified':'empty');
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(respond({input,kind,sample}))}}]}));}};
  server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const response=await testTransport.send(Buffer.concat(chunks).toString());res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  options={checkouts,reviewers:plan.reviewers,corpusPlan:plan,release:true};
  result=await runSemanticDistinctOffline(directory,{...options,providerEndpoint:`http://127.0.0.1:${server.address().port}/`});
  assert.equal(result.complete,true,result.errorCode);
  for(const trial of semanticBatchTrials(plan)){const folder=path.join(directory,trial.directory),capture=await read(path.join(folder,'capture/capture.json'));await writeFile(path.join(folder,'review.json'),JSON.stringify(await semanticFixtureReview(capture)));}
},{timeout:85000});
after(async()=>{if(server)await closeServer(server,'batch fixture');if(root)await rm(root,{recursive:true,force:true});});
test('two samples and two repetitions execute both real source trees with one ledger and frozen rule decision',async()=>{
  assert.equal(result.captures.length,8);assert.equal(result.roleSnapshots.length,2);assert.equal(result.liveCalls,0);
  assert.ok(seen.some(w=>w.includes('Distinct batch candidate prompt.')));assert.ok(seen.some(w=>!w.includes('Distinct batch candidate prompt.')));
  const db=new DatabaseSync(path.join(directory,'budget.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n,2);assert.equal(db.prepare('SELECT COUNT(DISTINCT trial_id) n FROM attempts').get().n,8);}finally{db.close();}
  const checked=cli('assess-distinct-offline');assert.equal(checked.status,0,checked.stderr);const summary=JSON.parse(checked.stdout);assert.equal(summary.infrastructurePassed,true,JSON.stringify(summary));assert.equal(summary.ruleDecision,'passed',JSON.stringify(summary));assert.equal(summary.qualityStatus,'not_run');assert.equal(summary.releaseEligible,false);assert.equal(summary.scope.captures,8);
},{timeout:85000});
test('missing or duplicated matrix entries reject before any replay or provider call',async()=>{
  const file=path.join(directory,'paired.json'),raw=await readFile(file,'utf8'),count=seen.length;
  for(const mode of ['missing','duplicate']){const run=JSON.parse(raw);if(mode==='missing')run.captures.pop();else run.captures[1]=run.captures[0];await writeFile(file,JSON.stringify(run));const checked=cli('check-distinct-offline');assert.equal(checked.status,1,checked.stderr);assert.equal(JSON.parse(checked.stdout).infrastructurePassed,false);}
  await writeFile(file,raw);assert.equal(seen.length,count);
});
test('synchronized SQLite, snapshot, unit and hash edits still fail fresh production replay',async()=>{
  const folder=path.join(directory,'baseline/trial-0000/capture'),file=path.join(folder,'capture.json'),raw=await readFile(file,'utf8'),database=path.join(folder,'store.sqlite'),bytes=await readFile(database);
  const db=new DatabaseSync(database);db.exec("UPDATE relation_assertions SET conditions='forged unconditional purchase'");db.close();
  const capture=JSON.parse(raw);capture.after=semanticDatabase(database);capture.units=semanticUnits(capture.after);capture.artifacts[0].sha256=hashBytes(await readFile(database));await writeFile(file,JSON.stringify(capture));
  try{const checked=cli('check-distinct-offline');assert.equal(checked.status,1,checked.stderr);assert.equal(JSON.parse(checked.stdout).infrastructurePassed,false);}finally{await writeFile(database,bytes);await writeFile(file,raw);}
},{timeout:30000});
test('validated captures feed severe veto and missing-review batch decisions',async()=>{
  const rows=[];let candidateCapture;
  for(const trial of semanticBatchTrials(plan)){
    const folder=path.join(directory,trial.directory),capture=await read(path.join(folder,'capture/capture.json'));
    const assessment=assessSemanticReview(capture,await read(path.join(folder,'review.json')),{reviewers:plan.reviewers});
    rows.push({role:trial.role,sampleId:trial.sampleId,repetition:trial.repetition,trialId:trial.trialId,assessment});
    if(trial.role==='candidate'&&trial.sampleId==='qualified'&&trial.repetition===0)candidateCapture=capture;
  }
  const frozenAt=(await read(path.join(directory,'freeze.json'))).frozenAt,index=rows.findIndex(row=>row.trialId==='candidate:qualified:0');
  rows[index].assessment=assessSemanticReview(candidateCapture,await semanticFixtureReview(candidateCapture,'condition'),{reviewers:plan.reviewers});
  const failed=assessSemanticBatch(plan,rows,{frozenAt,evidenceKind:'offline',infrastructurePassed:true});
  assert.equal(failed.ruleDecision,'failed');assert.ok(failed.failures.some(row=>row.reason==='severe_error'&&row.type==='condition'));assert.equal(failed.qualityStatus,'not_run');
  rows[index].assessment=assessSemanticReview(candidateCapture,createSemanticReviewTemplate(candidateCapture,{reviewers:plan.reviewers}),{reviewers:plan.reviewers});
  const missing=assessSemanticBatch(plan,rows,{frozenAt,evidenceKind:'offline',infrastructurePassed:true});assert.equal(missing.ruleDecision,'incomplete');assert.equal(missing.qualityStatus,'not_run');
});
