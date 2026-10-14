// Synthetic contract data only. It does not assert audio/text quality or rights.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashBytes } from '../scripts/lib/quality-contract.mjs';
export async function writeQualityPlanFixture(directory) {
  const config = JSON.parse(await readFile(new URL('../verification/asr-translation-quality/plan.template.json', import.meta.url)));
  const corpus = JSON.parse(await readFile(new URL('../verification/asr-translation-quality/corpus.template.json', import.meta.url)));
  const now = Date.now(), past = new Date(now - 10000).toISOString(), future = new Date(now + 3600000).toISOString();
  config.corpusFile = 'corpus.json'; config.repetitions = 2;
  config.approval = { reviewer: 'synthetic-test-reviewer', at: past, reference: 'offline-contract-fixture-not-authorization', beforeCandidateGeneration: true };
  config.reviewers = ['synthetic-test-reviewer'];
  config.thresholds = { asrErrorRateMax: 0.2, asrOmissionRateMax: 0.1, asrRegressionMax: 0.02, asrSilenceHallucinationsMax: 0, mtMeaningRetentionMin: 0.9, mtRegressionMax: 0.05, seriousErrorMax: 0 };
  for (const role of Object.values(config.roles)) role.sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  Object.assign(config.budget, { id: 'synthetic-test-budget', approvedBy: 'synthetic-test-reviewer', approvalReference: 'offline-contract-fixture', approvedAt: past, expiresAt: future, ceilingMicros: 100000000, ledgerFile: 'budget.sqlite' });
  for (const [kind, bound] of Object.entries(config.budget.bounds)) Object.assign(bound, { reviewed: true, reviewedBy: 'synthetic-test-reviewer', sourceUrl: 'https://example.invalid/offline-billing-fixture', sourceDocumentSha256: 'a'.repeat(64), checkedAt: past, validUntil: future, rationale: 'Synthetic units, not real pricing', coversRetriesAndHiddenCharges: true, inputUnitsUpper: 1, outputUnitsUpper: 1, inputUnitMicros: 1, outputUnitMicros: 1, fixedMicros: 1,
    ...(kind === 'asr' ? { includesWallClockCap: true } : { outputLimitEnforcedBy: 'documented-provider-hard-limit' }) });
  for (const [kind, bound] of Object.entries(config.budget.bounds)) bound.appliesTo = Object.values(config.roles).map(role => ({ model: role[`${kind}Model`], endpoint: role[`${kind}Endpoint`], currency: config.budget.currency }));
  await writeFile(path.join(directory, 'offline-billing.txt'), 'offline synthetic billing fixture');
  for (const bound of Object.values(config.budget.bounds)) { bound.sourceDocumentFile = 'offline-billing.txt'; bound.sourceDocumentSha256 = hashBytes('offline synthetic billing fixture'); }
  Object.assign(config.budget.bounds.asr, { durationBasis: 'received-pcm-duration', providerChargesOnlyReceivedAudio: true, inputUnit: 'millisecond', inputUnitsUpper: 121000, outputUnitsUpper: 0, billingQuantumMs: 1000, billingTailMs: 1000, minimumBillableMs: 1000 });
  Object.assign(config.budget.bounds.mt, { inputUnit: 'token', outputUnit: 'token', inputUnitsUpper: 5000, outputUnitsUpper: 5000, providerInputTokenLimit: 5000, providerOutputTokenLimit: 5000, providerRequestByteLimit: 12000, tokenUpperBoundMethod: 'provider-hard-input-and-output-limits' });
  for (const [index, sample] of corpus.samples.entries()) {
    sample.kind = 'real-recording-and-human-text'; sample.provenance.redistributionApproved = true;
    Object.assign(sample.gold, { approved: true, reviewer: 'synthetic-test-reviewer', reviewedAt: past, translations: ['Synthetic reference only.'],
      criticalFacts: ['number','negation','condition','attribution','omission'].map(type => ({ type, meaning: 'Synthetic contract fact, not reviewed real gold.' })) });
    const audio = Buffer.alloc(640); audio.writeInt16LE(index, 0);
    const name = `offline-${index}.pcm`; await writeFile(path.join(directory, name), audio);
    sample.audio = { path: name, format: 'pcm-s16le-mono-16000', bytes: audio.length, durationMs: 20, sha256: hashBytes(audio), transform: 'offline synthetic zeros, not real audio' };
  }
  await writeFile(path.join(directory, 'corpus.json'), JSON.stringify(corpus)); await writeFile(path.join(directory, 'plan.json'), JSON.stringify(config));
  return { config, corpus, configFile: path.join(directory, 'plan.json') };
}
