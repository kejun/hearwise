// Synthetic contract inputs only. These helpers never assert real approvals.
import { contractDigest } from '../scripts/lib/quality-contract.mjs';
import { semanticSevereErrorTypes } from '../scripts/lib/semantic-quality-review.mjs';
import { semanticFixtureSample, semanticFixtureReviewers } from './semantic-quality-fixture.mjs';
const unapproved = () => ({ approved: false, reviewedBy: null, reviewedAt: null, reference: null });
export function refreshSemanticBatchFixtureDigests(plan) {
  plan.approvals.gold = plan.samples.map(sample => ({ sampleId: sample.id, sampleDigest: contractDigest(sample),
    goldDigest: contractDigest(sample.gold), ...unapproved() }));
  plan.approvals.rules = { rulesDigest: contractDigest(plan.assessment), ...unapproved() };
  return plan;
}
export function semanticBatchPlanFixture({ sampleIds = ['qualified', 'empty'], repetitions = 2, thresholds = null,
  attemptMicros = { knowledge: 1, relation: 1 } } = {}) {
  const samples = sampleIds.map(id => {
    const sample = semanticFixtureSample(id);
    return { id: sample.id, kind: 'offline-text-corpus', segments: sample.segments, ingestionBatchSize: 1, gold: sample.gold };
  });
  const plan = { schemaVersion: 2, kind: 'semantic-corpus-batch-plan', samples, repetitions, reviewers: [...semanticFixtureReviewers],
    budget: { id: 'synthetic-batch-ledger', currency: 'USD', ceilingMicros: 100000, attemptMicros,
      expiresAt: '2099-01-01T00:00:00.000Z' },
    limits: { maxRequestBytes: 32768, maxResponseBytes: 16384, requestTimeoutMs: 3000, totalTimeoutMs: 15000 },
    batchTimeoutMs: 180000,
    corpus: { id: 'synthetic-batch-corpus', version: 1, sourceKind: 'synthetic', acceptanceSplitFrozen: false },
    assessment: { method: 'manual-unit-matches-v1', matchingPolicy: 'one-complete-variant-same-pair-v1',
      aggregation: 'all-pairs-and-micro-global-v1', directions: { precision: 'higher-is-better', recall: 'higher-is-better', severeErrors: 'lower-is-better' },
      emptyPolicy: 'valid-empty-null-v1', thresholds: Object.fromEntries(['entity', 'fact', 'relation'].map(kind => [kind,
        { precisionMin: thresholds, recallMin: thresholds, precisionRegressionMax: thresholds === null ? null : 0,
          recallRegressionMax: thresholds === null ? null : 0 }])),
      severeErrorTypes: [...semanticSevereErrorTypes], severeErrorMax: 0,
      criticalGoldIds: Object.fromEntries(samples.map(sample => [sample.id, Object.fromEntries(sample.gold.variants.map(variant => [variant.id, []]))])) },
    approvals: { corpusRights: unapproved(), acceptanceSplit: unapproved(), gold: [], rules: null } };
  return refreshSemanticBatchFixtureDigests(plan);
}
