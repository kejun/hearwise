import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseNameStatus, selectImpact, inspectChangeRange, historicalEligibility, impactPlan } from '../scripts/lib/verification-impact.mjs';
import { groups, technicalSuites } from '../verification/release/policy.mjs';
const change = file => [{ status: 'M', paths: [file] }];
test('impact policy retains every mandatory CI suite, maps sensitive change families, and treats unknown code conservatively', () => {
  const expected = [
    ['relation-storage.mjs', 'HW-04'], ['knowledge-workflow.mjs', 'HW-04'], ['storage.mjs', 'HW-10'],
    ['knowledge-revision.mjs', 'HW-06'], ['knowledge-name-replacement.mjs', 'HW-07'], ['public/speech-protocol.js', 'HW-08'],
    ['docs/knowledge-extraction-prompt.md', 'HW-05'], ['qwen-tts.mjs', 'HW-08'], ['package-lock.json', 'HW-14'],
    ['scripts/setup-browser.mjs', 'HW-14'], ['public/caption-frontier.js', 'HW-02'], ['server.mjs', 'HW-01']
  ];
  for (const [file, group] of expected) { const plan = selectImpact(change(file)); assert.ok(plan.affectedDomains.includes(group), file); assert.deepEqual(plan.requiredTechnicalSuites, technicalSuites); assert.equal(plan.automaticPaidCalls, false); }
  assert.deepEqual(selectImpact(change('new-critical-domain.mjs')).affectedDomains, groups);
  assert.deepEqual(selectImpact([], { uncertain: true }).affectedDomains, groups);
});
test('ordinary docs and CSS do not schedule all quality or physical-device evaluations', () => {
  for (const file of ['README.md', 'docs/maintainer-notes.md', 'LICENSE']) { const plan = selectImpact(change(file)); assert.deepEqual(plan.affectedDomains, []); assert.deepEqual(plan.externalRequirements, []); assert.deepEqual(plan.requiredTechnicalSuites, technicalSuites); }
  const style = selectImpact(change('public/styles.css'));
  assert.deepEqual(style.affectedDomains, ['HW-11']); assert.ok(style.externalRequirements.every(row => row.automaticPrExecution === false));
  assert.ok(style.externalRequirements.length < selectImpact(change('package-lock.json')).externalRequirements.length);
});
test('Git NUL parser preserves deletion and both rename paths including spaces and rejects malformed input', () => {
  assert.deepEqual(parseNameStatus(Buffer.from('R100\0docs/old name.md\0relation-budget.mjs\0D\0package-lock.json\0')),
    [{ status: 'R100', paths: ['docs/old name.md', 'relation-budget.mjs'] }, { status: 'D', paths: ['package-lock.json'] }]);
  for (const raw of ['M\0x', 'R100\0x\0', 'Q\0x\0', 'M\0../outside\0', 'M\0/absolute\0']) assert.throws(() => parseNameStatus(Buffer.from(raw)));
});
async function repository(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'impact-git-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Synthetic verification']); git(['config', 'user.email', 'fixture@localhost']);
  const commit = async (file, text) => { await mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await writeFile(path.join(cwd, file), text); git(['add', '-A']); git(['commit', '-qm', 'fixture']); return git(['rev-parse', 'HEAD']); };
  return { cwd, git, commit };
}
test('actual complete Git history detects net-zero protocol/dependency changes and nonancestor evidence', async t => {
  const r = await repository(t), base = await r.commit('relation-budget.mjs', 'A\n');
  const changed = await r.commit('relation-budget.mjs', 'B\n'); const restored = await r.commit('relation-budget.mjs', 'A\n');
  assert.equal(r.git(['diff', '--name-only', base, restored]), '');
  const range = inspectChangeRange(base, restored, { cwd: r.cwd });
  assert.equal(range.complete, true); assert.deepEqual(range.commits, [changed, restored]); assert.ok(range.affectedDomains.includes('HW-04'));
  r.git(['checkout', '-qb', 'separate', base]); const sibling = await r.commit('README.md', 'sibling\n');
  const unrelated = inspectChangeRange(changed, sibling, { cwd: r.cwd });
  assert.equal(unrelated.complete, false); assert.deepEqual(unrelated.affectedDomains, groups);
  const missing = inspectChangeRange('f'.repeat(40), sibling, { cwd: r.cwd }); assert.equal(missing.complete, false);
});
test('historical applicability keeps original SHA and requires validated artifacts, full ancestor chain and every frozen binding', async t => {
  const r = await repository(t), base = await r.commit('relation-budget.mjs', 'A\n'); const targetSha = await r.commit('README.md', 'documentation\n');
  const range = inspectChangeRange(base, targetSha, { cwd: r.cwd }), source = { sha: base, dirty: false }, target = { sha: targetSha, dirty: false };
  const bindings = Object.fromEntries(['policy', 'model', 'tools', 'configuration', 'thresholds', 'corpus', 'environment'].map(key => [key, 'a'.repeat(64)]));
  const options = { range, source, target, domains: ['HW-04'], actualBindings: structuredClone(bindings), expectedBindings: structuredClone(bindings), originalVerdict: { ok: true, source, artifactsVerified: true } };
  const verdict = historicalEligibility(options); assert.equal(verdict.eligible, true); assert.equal(verdict.originalSource.sha, base); assert.equal(verdict.sourceMode, 'historical');
  for (const mutate of [x => { x.range.complete = false; }, x => { x.range.ancestor = false; }, x => { x.range.affectedDomains.push('HW-04'); },
    x => { delete x.expectedBindings.thresholds; }, x => { x.actualBindings.tools = 'b'.repeat(64); }, x => { x.source.dirty = true; },
    x => { x.originalVerdict.artifactsVerified = false; }, x => { x.originalVerdict.source.sha = targetSha; }, x => { x.domains = []; }]) {
    const value = structuredClone(options); mutate(value); assert.equal(historicalEligibility(value).eligible, false, mutate.toString());
  }
});
test('profile and cache metadata never alias fast/deep or claim paid execution', async () => {
  const fast = await impactPlan('HEAD'), deep = await impactPlan('HEAD', { profile: 'deep' });
  assert.equal(fast.cache.toolsKey, deep.cache.toolsKey); assert.notEqual(fast.cache.evidenceKey, deep.cache.evidenceKey);
  assert.equal(fast.automaticPaidCalls, false); assert.equal(fast.fullProjectAcceptance, false);
  await assert.rejects(impactPlan('HEAD', { profile: 'unchecked' }));
});

test('actual UI layout and provider history cannot reuse stale performance or security evidence', async t => {
  const bindings = Object.fromEntries(['policy', 'model', 'tools', 'configuration', 'thresholds', 'corpus', 'environment'].map(key => [key, 'a'.repeat(64)]));
  for (const [file, domain] of [['public/styles.css', 'HW-13'], ['public/knowledge-graph-layout.js', 'HW-13'], ['qwen-tts.mjs', 'HW-12']]) {
    const r = await repository(t), base = await r.commit(file, 'before\n'), head = await r.commit(file, 'after\n');
    const source = { sha: base, dirty: false }, target = { sha: head, dirty: false };
    const verdict = historicalEligibility({ range: inspectChangeRange(base, head, { cwd: r.cwd }), source, target, domains: [domain],
      actualBindings: bindings, expectedBindings: bindings, originalVerdict: { ok: true, source, artifactsVerified: true } });
    assert.equal(verdict.eligible, false, `${file} changes ${domain}`);
  }
});
test('complete merge history preserves a changed and restored side-branch dependency', async t => {
  const r = await repository(t), base = await r.commit('package-lock.json', 'A\n');
  r.git(['checkout', '-qb', 'side']); const changed = await r.commit('package-lock.json', 'B\n'); await r.commit('package-lock.json', 'A\n');
  r.git(['checkout', '-qb', 'target', base]); await r.commit('README.md', 'main side\n');
  r.git(['merge', '--no-ff', '-m', 'fixture merge', 'side']); const head = r.git(['rev-parse', 'HEAD']);
  const range = inspectChangeRange(base, head, { cwd: r.cwd });
  assert.equal(range.complete, true); assert.ok(range.commits.includes(changed)); assert.deepEqual(range.affectedDomains, groups);
});
