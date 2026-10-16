import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Exercise an actually dirty Git harness without changing the test runner's
// source identity. No source workers, providers or real credentials are needed.
test('release provider preview and collection reject dirty harness before probes or dispatch',async()=>{
  const scratch=await mkdtemp(path.join(os.tmpdir(),'semantic-provider-release-')),harness=path.join(scratch,'harness');
  const git=(args)=>execFileSync('git',args,{cwd:harness,stdio:'pipe',timeout:10000});
  try{
    await mkdir(harness);
    const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8',timeout:10000}).split('\0').filter(Boolean);
    for(const file of files){await mkdir(path.dirname(path.join(harness,file)),{recursive:true});await cp(file,path.join(harness,file));}
    await mkdir(path.join(harness,'dist/server'),{recursive:true});await cp('dist/server/index.js',path.join(harness,'dist/server/index.js'));
    await symlink(path.resolve('node_modules'),path.join(harness,'node_modules'),'dir');
    git(['init','-q']);await writeFile(path.join(harness,'.git/info/exclude'),'\n/node_modules\n');git(['config','user.name','Synthetic fixture']);git(['config','user.email','fixture@example.invalid']);git(['add','.']);git(['commit','-qm','Clean fixture baseline']);
    await writeFile(path.join(harness,'dirty-release-fixture.txt'),'Uncommitted change.\n');
    const script=`
      import assert from 'node:assert/strict';
      import { access } from 'node:fs/promises';
      import { planSemanticProviderPair, collectSemanticProviderPair } from './scripts/lib/semantic-quality-distinct.mjs';
      let forwards=0;
      const options={release:true,testTransport:{profile:'semantic-provider-test-only-v1',send(){forwards++;throw new Error('Unexpected dispatch');}},
        key:'synthetic-release-test-key',approval:{approved:true,planDigest:'a'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()}};
      // Missing checkouts would fail later. The clean-source guard must win.
      for(const run of [planSemanticProviderPair,collectSemanticProviderPair]){
        await assert.rejects(run(${JSON.stringify(path.join(scratch,'output'))},options),/RELEASE_SOURCE_DIRTY/);
      }
      assert.equal(forwards,0);
      await assert.rejects(access(${JSON.stringify(path.join(scratch,'output'))}),{code:'ENOENT'});
      console.log('dirty-release-denied-before-dispatch');
    `;
    const output=execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:harness,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH}});
    assert.match(output,/dirty-release-denied-before-dispatch/);
  }finally{await rm(scratch,{recursive:true,force:true});}
},{timeout:30000});
