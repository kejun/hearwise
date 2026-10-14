import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import path from 'node:path';
import { inspectQualityPlan, freezeQualityPlan, readFrozenQualityPlan } from '../scripts/lib/quality-contract.mjs';
import { writeQualityPlanFixture } from '../test-support/quality-plan-fixture.mjs';
async function fixture(t) { const directory = await mkdtemp(path.join(tmpdir(), 'quality-plan-')); t.after(() => rm(directory, { recursive: true, force: true })); return { directory, ...await writeQualityPlanFixture(directory) }; }
test('published template keeps unknown thresholds, audio, gold and prices explicitly not ready', async () => {
  const plan = await inspectQualityPlan('verification/asr-translation-quality/plan.template.json');
  assert.equal(plan.qualityStatus, 'not_run'); assert.equal(plan.eligibleForFreeze, false);
  for (const code of ['thresholds_not_frozen', 'human_approval_missing', 'budget_approval_missing', 'billing_upper_bound_unknown:mt']) assert.ok(plan.issues.includes(code));
  assert.ok(plan.issues.some(code => code.endsWith('real_audio_missing')));
});
test('freeze binds every approved input and refuses threshold changes, changed audio and expiry', async t => {
  const f = await fixture(t), destination = path.join(f.directory, 'frozen.json');
  const plan = await inspectQualityPlan(f.configFile); assert.deepEqual(plan.issues, []);
  await freezeQualityPlan(f.configFile, destination); const frozen = await readFrozenQualityPlan(destination); assert.equal(frozen.digest, plan.digest);
  f.config.thresholds.asrErrorRateMax = 0.9; await writeFile(f.configFile, JSON.stringify(f.config));
  await assert.rejects(readFrozenQualityPlan(destination), /FREEZE_CHANGED/);
  await assert.rejects(freezeQualityPlan(f.configFile, destination), /EEXIST/);
});
test('budget, review, leakage and actual bytes fail closed before any collection', async t => {
  const f = await fixture(t);
  const check = async (config, corpus) => { await writeFile(f.configFile, JSON.stringify(config)); await writeFile(path.join(f.directory, 'corpus.json'), JSON.stringify(corpus)); return inspectQualityPlan(f.configFile); };
  for (const change of [c => c.repetitions = null, c => c.metrics.normalization = 'new', c => c.budget.ceilingMicros = 1, c => c.budget.bounds.mt.outputLimitEnforcedBy = null, c => c.budget.expiresAt = '2000-01-01T00:00:00Z']) {
    const c = structuredClone(f.config); change(c); assert.equal((await check(c, f.corpus)).eligibleForFreeze, false);
  }
  const overlap = structuredClone(f.corpus); overlap.samples.at(-1).text = overlap.samples[0].text;
  assert.ok((await check(f.config, overlap)).issues.some(code => code.includes('overlap')));
  await check(f.config, f.corpus); await writeFile(path.join(f.directory, f.corpus.samples[0].audio.path), Buffer.alloc(2));
  assert.ok((await inspectQualityPlan(f.configFile)).issues.some(code => code.includes('audio_hash_or_length')));
});
test('billing bounds cover actual connection duration, payload, model and endpoint', async t => {
  const f = await fixture(t);
  for (const [change, code] of [
    [c => c.budget.bounds.asr.inputUnitsUpper = 1000, 'asr_duration_bound_unproven'],
    [c => c.budget.bounds.mt.outputUnitsUpper = 1, 'mt_token_bound_unproven'],
    [c => c.budget.bounds.mt.providerRequestByteLimit = 10, 'mt_request_exceeds_billing_bound'],
    [c => c.roles.candidate.mtModel = 'different-unpriced-model', 'billing_model_or_endpoint_uncovered:mt'],
    [c => c.roles.candidate.asrEndpoint = 'wss://example.invalid/new-rate', 'billing_model_or_endpoint_uncovered:asr'],
    [c => c.roles.candidate.maxConnectionMs = 15000, 'audio_exceeds_connection_cap'],
    [c => c.budget.bounds.asr.appliesTo[0].currency = 'USD', 'billing_model_or_endpoint_uncovered:asr']
  ]) {
    const config = structuredClone(f.config); change(config);
    // Both roles share this offer in the fixture; remove duplicate coverage for the currency case.
    if (code === 'billing_model_or_endpoint_uncovered:asr' && config.roles.candidate.asrEndpoint === f.config.roles.candidate.asrEndpoint) config.budget.bounds.asr.appliesTo.splice(1);
    await writeFile(f.configFile, JSON.stringify(config));
    const plan = await inspectQualityPlan(f.configFile); assert.ok(plan.issues.some(issue => issue.includes(code)), JSON.stringify(plan.issues));
  }
});
test('frozen shared ledger location survives role checkout changes and silence cannot mix positive references', async t => {
  const f = await fixture(t), destination = path.join(f.directory, 'frozen.json');
  const plan = await inspectQualityPlan(f.configFile); assert.equal(plan.config.budget.ledgerFile, path.join(f.directory, 'budget.sqlite'));
  await freezeQualityPlan(f.configFile, destination); assert.equal((await readFrozenQualityPlan(destination)).config.budget.ledgerFile, plan.config.budget.ledgerFile);
  const silence = f.corpus.samples.find(row => row.silence); silence.gold.transcripts = ['', 'invented text'];
  await writeFile(path.join(f.directory, 'corpus.json'), JSON.stringify(f.corpus));
  assert.ok((await inspectQualityPlan(f.configFile)).issues.includes(`sample:${silence.id}:silence_reference_mismatch`));
  await assert.rejects(readFrozenQualityPlan(destination), /FREEZE_CHANGED/);
});
test('human gold must state critical facts and cover each severe-error type before freezing', async t => {
  const f = await fixture(t);
  f.corpus.samples[0].gold.criticalFacts = [];
  for (const sample of f.corpus.samples) sample.gold.criticalFacts = sample.gold.criticalFacts.filter(row => row.type !== 'number');
  await writeFile(path.join(f.directory, 'corpus.json'), JSON.stringify(f.corpus));
  const plan = await inspectQualityPlan(f.configFile);
  assert.ok(plan.issues.includes(`sample:${f.corpus.samples[0].id}:gold_unreviewed`)); assert.ok(plan.issues.includes('critical_fact_coverage:number'));
  assert.equal(plan.eligibleForFreeze, false);
});
