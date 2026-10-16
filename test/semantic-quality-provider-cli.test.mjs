import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const args of [
  ['collect'], ['collect','--live'], ['collect','--approve','a'.repeat(64)],
  ['collect','--live','--approve','a'.repeat(64)],
  ['offline','--live'], ['plan','--live'], ['plan','--approve','a'.repeat(64)],
  ['offline','--provider-evidence'], ['check-distinct-offline','--provider-evidence'],
  ['collect','--live','--approve','a'.repeat(64),'--provider','https://example.invalid/']
]) test(`provider CLI refuses missing authority/scope: ${args.join(' ')}`, () => {
  const result=spawnSync(process.execPath,['scripts/evaluate-semantic-quality.mjs',...args],{
    encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH,HEARWISE_SEMANTIC_API_KEY:'synthetic-private-key-not-an-authorization'}});
  assert.equal(result.status,1);assert.match(result.stderr,/REQUIRED|DENIED|NOT_IMPLEMENTED_OR_AUTHORIZED/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('synthetic-private-key'));
});

test('provider CLI help describes explicit preview, approval and keyless historical readback',()=>{
  const result=spawnSync(process.execPath,['scripts/evaluate-semantic-quality.mjs','--help'],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0);assert.match(result.stdout,/--approve SHA/);assert.match(result.stdout,/--provider-evidence/);
  assert.match(result.stdout,/No default spending limit or approval/);
});
