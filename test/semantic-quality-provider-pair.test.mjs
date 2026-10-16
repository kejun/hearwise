import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { planSemanticProviderPair, collectSemanticProviderPair, inspectSemanticProviderPair } from '../scripts/lib/semantic-quality-distinct.mjs';
import { SEMANTIC_PROVIDER_PROFILE } from '../scripts/lib/semantic-quality-provider-policy.mjs';
import { semanticFixtureResponse } from '../test-support/semantic-quality-fixture.mjs';
const roles=['baseline','candidate'],marker='Distinct provider candidate prompt.';
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
let root,directory,checkouts,plan,options,preview,result,seen=[];
function corpusPlan() {
  return {
    schemaVersion: 1, kind: 'offline-semantic-corpus-plan', mode: 'offline',
    sample: {
      id: 'board-approval-notes', kind: 'offline-text-corpus', ingestionBatchSize: 4,
      segments: Array.from({ length: 4 }, (_, index) =>
        `Board note ${index + 1}: Atlas also called AtlasCo, Nova, Orion and Vale are independent organizations. ` +
        'Orion reports that Atlas did not acquire Nova for 15 dollars. If approved, Atlas plans to acquire Nova for 20 dollars.'),
      gold: { approved: false, variants: [{ id: 'unreviewed', units: [] }] }
    },
    reviewers: ['synthetic corpus annotation label (not a human)'],
    budget: {
      id: 'distinct-corpus-synthetic-only', currency: 'CNY', ceilingMicros: 100000000,
      attemptMicros: { knowledge: SEMANTIC_PROVIDER_PROFILE.attemptMicros, relation: SEMANTIC_PROVIDER_PROFILE.attemptMicros }, expiresAt: new Date(Date.now() + 600000).toISOString()
    },
    limits: { maxRequestBytes: 32768, maxResponseBytes: 16384, requestTimeoutMs: 3000, totalTimeoutMs: 15000 }
  };
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'semantic-distinct-corpus-')); directory = path.join(root, 'run');
  checkouts = Object.fromEntries(roles.map(role => [role, path.join(root, role)]));
  const files = git(process.cwd(), ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const role of roles) {
    const target = checkouts[role]; await mkdir(target);
    for (const file of files) {
      await mkdir(path.dirname(path.join(target, file)), { recursive: true }); await cp(file, path.join(target, file));
    }
    // Independent physical module trees, including locally contained bin links.
    await cp('node_modules', path.join(target, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    assert.equal((await lstat(path.join(target, 'node_modules'))).isSymbolicLink(), false);
    git(target, ['init', '-q']); git(target, ['config', 'user.name', 'Synthetic fixture']);
    git(target, ['config', 'user.email', 'fixture@example.invalid']);
    if (role === 'candidate') {
      const file = path.join(target, 'docs/knowledge-extraction-prompt-v2.md');
      await writeFile(file, (await readFile(file, 'utf8')).replace('```text\n', `\`\`\`text\n${marker}\n`));
    }
    git(target, ['add', '.']); git(target, ['commit', '-qm', `Synthetic corpus ${role}`]);
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: target, timeout: 20000, stdio: 'pipe' });
  }
  assert.notEqual(await realpath(path.join(checkouts.baseline, 'node_modules')), await realpath(path.join(checkouts.candidate, 'node_modules')));
  plan=corpusPlan();
  const response=semanticFixtureResponse();
  const testTransport={profile:'semantic-provider-test-only-v1',async send(wire){
    seen.push(wire);const body=JSON.parse(wire),input=JSON.parse(body.messages[1].content),kind=input.candidates?'relation':'knowledge';
    const output=response({input,kind,sample:{id:'qualified',names:['Atlas','Nova','Orion','Vale']}});
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));
  }};
  options={checkouts,reviewers:plan.reviewers,corpusPlan:plan,testTransport};
  preview=await planSemanticProviderPair(directory,options);
  result=await collectSemanticProviderPair(directory,{...options,key:'synthetic-provider-test-only',approval:{approved:true,planDigest:preview.requestDigest,expiresAt:plan.budget.expiresAt}});
}, {timeout:100000});
after(()=>root&&rm(root,{recursive:true,force:true}));
test('authorized test transport completes distinct source corpus with truthful separate evidence',async()=>{
  assert.equal(result.complete,true,result.errorCode);assert.equal(result.mode,'provider');assert.equal(result.liveCalls,0);assert.equal(result.testTransportCalls,seen.length);assert.ok(seen.length>=2);assert.equal(result.qualityStatus,'not_run');
  const summary=await inspectSemanticProviderPair(directory,options);assert.equal(summary.infrastructurePassed,true,JSON.stringify(summary));assert.equal(summary.liveCalls,0);assert.equal(summary.testTransportCalls,seen.length);
},{timeout:60000});
test('transcript response and request tampering fail independent inspection',async()=>{
  assert.equal(result.complete,true,result.errorCode);
  const file=path.join(directory,'provider.json'),raw=await readFile(file,'utf8'),tape=JSON.parse(raw);tape.rows[0].http.body='{}';await writeFile(file,JSON.stringify(tape));
  try{assert.equal((await inspectSemanticProviderPair(directory,options)).infrastructurePassed,false);}finally{await writeFile(file,raw);}
},{timeout:60000});
