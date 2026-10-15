import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { symlink } from 'node:fs/promises';
import { semanticDatabase, semanticUnits } from '../scripts/lib/semantic-quality-capture.mjs';
import { hashBytes } from '../scripts/lib/quality-contract.mjs';
import { DatabaseSync } from 'node:sqlite';
import { runSemanticDistinctOffline, inspectSemanticDistinctOffline } from '../scripts/lib/semantic-quality-distinct.mjs';
let root, directory, checkouts, options;
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 10000 }).trim();
const read = async file => JSON.parse(await readFile(file));
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'semantic-distinct-')); directory = path.join(root, 'run');
  checkouts = { baseline: path.join(root, 'baseline'), candidate: path.join(root, 'candidate') };
  const files = git(process.cwd(), ['ls-files','--cached','--others','--exclude-standard']).split('\n');
  for (const role of ['baseline','candidate']) {
    const dir = checkouts[role]; await mkdir(dir);
    for (const file of files) { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await cp(file, path.join(dir, file)); }
    // Physical independent installs, never borrowed symlinks or a shared module tree.
    await cp('node_modules', path.join(dir, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    git(dir, ['init','-q']); git(dir, ['config','user.name','Synthetic fixture']); git(dir, ['config','user.email','fixture@example.invalid']);
    if (role === 'candidate') {
      const file = path.join(dir, 'docs/knowledge-extraction-prompt-v2.md');
      await writeFile(file, (await readFile(file, 'utf8')).replace('```text\n', '```text\nSynthetic candidate prompt marker.\n'));
    }
    git(dir, ['add','.']); git(dir, ['commit','-qm',`Synthetic ${role} code`]);
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, timeout: 20000, stdio: 'pipe' });
  }
  options = { checkouts, reviewers: ['fixture-reviewer (not a human)'] };
  await writeFile(path.join(root, 'reviewers.json'), JSON.stringify(options.reviewers));
  const run = await runSemanticDistinctOffline(directory, options); assert.equal(run.complete, true, run.errorCode);
}, { timeout: 80000 });
after(() => rm(root, { recursive: true, force: true }));
test('two real Git revisions execute their own production prompt and reopen shared budget', async () => {
  const a = await read(path.join(directory,'baseline/qualified-0/capture.json')), b = await read(path.join(directory,'candidate/qualified-0/capture.json'));
  assert.notEqual(a.sourceStart.sha, b.sourceStart.sha); assert.notEqual(a.sourceStart.tree, b.sourceStart.tree);
  assert.notEqual(a.calls[0].request.messages[0].content, b.calls[0].request.messages[0].content); assert.match(b.calls[0].request.messages[0].content, /Synthetic candidate prompt marker/); assert.doesNotMatch(a.calls[0].request.messages[0].content, /Synthetic candidate prompt marker/);
  const db = new DatabaseSync(path.join(directory, 'budget.sqlite'), { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT source_sha FROM runs ORDER BY role').all().map(r=>r.source_sha), [a.sourceStart.sha,b.sourceStart.sha]); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,12); } finally { db.close(); }
  const cli = spawnSync(process.execPath, ['scripts/evaluate-semantic-quality.mjs','check-distinct-offline',
    '--baseline',checkouts.baseline,'--candidate',checkouts.candidate,'--reviewers',path.join(root,'reviewers.json'),'--out',directory],
    { encoding:'utf8', timeout:25000, maxBuffer:8*1024*1024 });
  assert.equal(cli.status,0,cli.stderr); const r=JSON.parse(cli.stdout);
  assert.equal(r.infrastructurePassed,true,JSON.stringify(r)); assert.equal(r.reviewComplete,false); assert.equal(r.qualityStatus,'not_run');
  assert.equal(r.fullQualityAcceptance,false); assert.equal(r.liveCalls,0); assert.equal(r.pairs.length,4);
  assert.ok(r.pairs.every(p=>p.metricDeltas===null));
});
test('explicit roots required; same checkout and aliases cannot fake two sources', async () => {
  assert.equal((await inspectSemanticDistinctOffline(directory, { ...options, checkouts: {} })).infrastructurePassed,false);
  await assert.rejects(runSemanticDistinctOffline(path.join(root,'same'), { ...options, checkouts: { baseline:checkouts.baseline,candidate:checkouts.baseline } }),/INDEPENDENT_CHECKOUTS/);
});
test('changed source or installed dependency bytes invalidate frozen identity', async () => {
  for (const file of ['knowledge.mjs','node_modules/ws/index.js']) {
    const full = path.join(checkouts.candidate,file), bytes = await readFile(full); await writeFile(full, Buffer.concat([bytes,Buffer.from('\n// changed\n')]));
    try { assert.equal((await inspectSemanticDistinctOffline(directory,options)).infrastructurePassed,false); }
    finally { await writeFile(full,bytes); }
  }
});
test('changed role source and missing candidate are rejected before acceptance', async () => {
  const file = path.join(directory,'paired.json'), bytes=await readFile(file), value=JSON.parse(bytes); value.captures.pop(); await writeFile(file,JSON.stringify(value));
  try { assert.equal((await inspectSemanticDistinctOffline(directory,options)).infrastructurePassed,false); } finally { await writeFile(file,bytes); }
});

test('declared review contracts chain into paired deltas without human or quality acceptance', async () => {
  for (const role of ['baseline','candidate']) for (const sample of ['qualified','empty']) for (const repetition of [0,1]) {
    const file = path.join(directory, `${role}/${sample}-${repetition}/review.json`), review = await read(file);
    review.reviewer=options.reviewers[0]; review.reviewedAt=new Date().toISOString(); review.selectedVariantId='expected';
    for (const row of review.rows) { row.reviewer=review.reviewer; row.reviewedAt=review.reviewedAt;
      row.severe=Object.fromEntries(Object.keys(row.severe).map(key=>[key,false])); row.notes='Synthetic unmatched annotation, not human review.'; }
    review.missingGoldIds=review.sample.gold.variants.find(v=>v.id==='expected').units.map(u=>u.id);
    await writeFile(file,JSON.stringify(review));
  }
  const cli=spawnSync(process.execPath,['scripts/evaluate-semantic-quality.mjs','assess-distinct-offline',
    '--baseline',checkouts.baseline,'--candidate',checkouts.candidate,'--reviewers',path.join(root,'reviewers.json'),'--out',directory],
    {encoding:'utf8',timeout:25000,maxBuffer:8*1024*1024});
  assert.equal(cli.status,1,cli.stderr); const r=JSON.parse(cli.stdout);
  assert.equal(r.infrastructurePassed,true); assert.equal(r.reviewComplete,true); assert.equal(r.offlineReviewPassed,false);
  assert.equal(r.qualityStatus,'not_run'); assert.ok(r.pairs.every(pair=>pair.metricDeltas));
  assert.ok(r.pairs.every(pair=>pair.metricDeltas.entity.falseNegatives===0));
});
test('abort after real child reservation retains spend and blocks candidate', async () => {
  const dir=path.join(root,'cancelled'), abort=new AbortController(); let observed=false;
  const poll=setInterval(()=>{
    let db;
    try { db=new DatabaseSync(path.join(dir,'budget.sqlite'),{readOnly:true});
      if(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n>0) { observed=true; abort.abort(); }
    } catch {} finally { db?.close(); }
  },5);
  let run; try { run=await runSemanticDistinctOffline(dir,{...options,signal:abort.signal}); } finally { clearInterval(poll); }
  assert.equal(observed,true); assert.equal(run.complete,false); assert.equal(run.errorCode,'SEMANTIC_PAIR_CANCELLED');
  for(let i=0;i<3;i++) { const db=new DatabaseSync(path.join(dir,'budget.sqlite'),{readOnly:true});
    try { assert.ok(db.prepare('SELECT SUM(reserved_micros) AS n FROM attempts').get().n>0);
      assert.deepEqual(db.prepare('SELECT role,state FROM runs ORDER BY role').all().map(r=>({...r})),[{role:'baseline',state:'incomplete'}]); } finally {db.close();} }
});

test('source symlinks cannot execute another checkout under candidate identity', async () => {
  const file=path.join(checkouts.candidate,'scripts/lib/semantic-quality-capture.mjs'), bytes=await readFile(file);
  await rm(file); await symlink(path.join(checkouts.baseline,'scripts/lib/semantic-quality-capture.mjs'),file);
  try { assert.equal((await inspectSemanticDistinctOffline(directory,options)).infrastructurePassed,false); }
  finally { await rm(file); await writeFile(file,bytes); }
});
test('trusted independent projection rejects coordinated database and snapshot forgery', async () => {
  const dir=path.join(directory,'baseline/qualified-0'), dbfile=path.join(dir,'store.sqlite'), file=path.join(dir,'capture.json');
  const dbbytes=await readFile(dbfile), bytes=await readFile(file), report=JSON.parse(bytes);
  const db=new DatabaseSync(dbfile); db.exec("UPDATE relation_assertions SET conditions='FORGED unconditional purchase'"); db.close();
  report.after=semanticDatabase(dbfile); report.before.tables.relation_assertions=structuredClone(report.after.tables.relation_assertions);
  report.units=semanticUnits(report.after); report.artifacts[0].sha256=hashBytes(await readFile(dbfile)); await writeFile(file,JSON.stringify(report));
  try { assert.equal((await inspectSemanticDistinctOffline(directory,options)).infrastructurePassed,false); }
  finally { await writeFile(dbfile,dbbytes); await writeFile(file,bytes); }
});
