// Two physical synthetic source/dependency trees; no borrowed modules or fake SHAs.
import {mkdir,cp,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
export async function createSemanticBatchCheckouts(checkouts){
  const files=git(process.cwd(),['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
  for(const role of ['baseline','candidate']){const target=checkouts[role];await mkdir(target);
    for(const file of files){await mkdir(path.dirname(path.join(target,file)),{recursive:true});await cp(file,path.join(target,file));}
    await cp('node_modules',path.join(target,'node_modules'),{recursive:true,verbatimSymlinks:true});
    git(target,['init','-q']);git(target,['config','user.name','Synthetic fixture']);git(target,['config','user.email','fixture@example.invalid']);
    if(role==='candidate'){const file=path.join(target,'docs/knowledge-extraction-prompt-v2.md');await writeFile(file,(await readFile(file,'utf8')).replace('```text\n','```text\nDistinct batch candidate prompt.\n'));}
    git(target,['add','.']);git(target,['commit','-qm',`Synthetic batch ${role}`]);execFileSync(process.execPath,['scripts/build.mjs'],{cwd:target,timeout:20000,stdio:'pipe'});
  }
}
