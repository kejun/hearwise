import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openSemanticQualityBudget } from '../scripts/lib/quality-budget.mjs';
import { validateSemanticCorpusPair, semanticCorpusBatchProtocolVersion } from '../scripts/lib/semantic-quality-corpus.mjs';
import { semanticBatchTrials, semanticBatchBudget } from '../scripts/lib/semantic-quality-batch-plan.mjs';
import { semanticBatchPlanFixture } from '../test-support/semantic-batch-plan-fixture.mjs';
const source = { sha: 'a'.repeat(40) }, freezeDigest = 'b'.repeat(64), root = '/tmp/synthetic-batch-pair';
function context(trial) { return { directory: path.join(root, trial.directory), source }; }
function envelope(ledger, plan, trial, budget) {
  return { role: trial.role, ledgerPath: path.join(root, 'budget.sqlite'), budget, freezeDigest, before: ledger.snapshot(),
    batch: { plan, trialIndex: trial.index, roleDirectory: path.join(root, trial.role) } };
}
test('batch pair validates the full roster and binds each trial to the single role claim', () => {
  const plan = semanticBatchPlanFixture(), budget = semanticBatchBudget(plan), trials = semanticBatchTrials(plan);
  const ledger = openSemanticQualityBudget(':memory:', budget, freezeDigest);
  try {
    assert.equal(semanticCorpusBatchProtocolVersion, 1);
    for (const role of ['baseline', 'candidate']) {
      ledger.claimRun({ role, sourceSha: source.sha, directory: path.join(root, role), expectedSnapshot: ledger.snapshot() });
      for (const trial of trials.filter(row => row.role === role)) {
        const pair = envelope(ledger, plan, trial, budget);
        assert.deepEqual(validateSemanticCorpusPair(pair, trial.plan, context(trial)), pair);
        ledger.reserve({ kind: 'knowledge', trialId: trial.trialId });
        const currentInPrefix = { ...pair, before: ledger.snapshot() };
        assert.throws(() => validateSemanticCorpusPair(currentInPrefix, trial.plan, context(trial)), /CORPUS_PAIR_PREFIX_INVALID/);
      }
      ledger.finishRun(role, true);
    }
    assert.equal(ledger.snapshot().runs.length, 2);
    assert.deepEqual(ledger.snapshot().attempts.map(row => row.trial_id), trials.map(row => row.trialId));
  } finally { ledger.close(); }
});

test('batch pairs reject wrong plan, roster, source, role root, index, prefix ordering and extra keys', () => {
  const plan = semanticBatchPlanFixture(), budget = semanticBatchBudget(plan), trials = semanticBatchTrials(plan);
  const ledger = openSemanticQualityBudget(':memory:', budget, freezeDigest);
  try {
    ledger.claimRun({ role: 'baseline', sourceSha: source.sha, directory: path.join(root, 'baseline'), expectedSnapshot: ledger.snapshot() });
    for (const trial of trials.slice(0, 2)) ledger.reserve({ kind: 'knowledge', trialId: trial.trialId });
    const trial = trials[2], pair = envelope(ledger, plan, trial, budget);
    assert.deepEqual(validateSemanticCorpusPair(pair, trial.plan, context(trial)), pair);
    for (const mutate of [
      value => value.batch.trialIndex = -0, value => value.batch.trialIndex = trials.length,
      value => value.batch.trialIndex = 0, value => value.batch.trialIndex = 6,
      value => value.batch.roleDirectory = path.join(root, 'other'), value => value.batch.extra = true,
      value => value.before.runs[0].directory = context(trial).directory,
      value => value.before.runs[0].source_sha = '0'.repeat(40),
      value => value.before.attempts[0].trial_id = trials[3].trialId,
      value => value.before.attempts[0].trial_id = 'baseline:unknown:0',
      value => { [value.before.attempts[0].trial_id, value.before.attempts[1].trial_id] = [value.before.attempts[1].trial_id, value.before.attempts[0].trial_id]; },
      value => value.budget.trialLimits[trials[0].trialId].knowledge++,
      value => delete value.budget.trialLimits[trials.at(-1).trialId],
      value => value.batch.plan.repetitions = 1,
      value => value.batch.plan.samples[1].segments[0] += ' altered'
    ]) {
      const changed = structuredClone(pair); mutate(changed);
      assert.throws(() => validateSemanticCorpusPair(changed, trial.plan, context(trial)), mutate.toString());
    }
    assert.throws(() => validateSemanticCorpusPair(pair, trial.plan, { ...context(trial), directory: path.join(root, 'baseline/trial-0003') }));
    const oldShape = structuredClone(pair); delete oldShape.batch;
    assert.throws(() => validateSemanticCorpusPair(oldShape, trial.plan, context(trial)), /CORPUS_PAIR_INVALID/);
  } finally { ledger.close(); }
});
