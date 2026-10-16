// Pure comparison of already-validated manual review results. The collector and
// independent reader must establish raw evidence, source and provider identity.
import { contractDigest } from './quality-contract.mjs';
import { semanticSevereErrorTypes } from './semantic-quality-review.mjs';
import { validateSemanticBatchPlan, semanticBatchTrials, validateBatchApprovals } from './semantic-quality-batch-plan.mjs';

const kinds = ['entity', 'fact', 'relation'];
const roles = ['baseline', 'candidate'];
const measures = ['precision', 'recall'];
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const text = value => typeof value === 'string' && value.trim().length > 0;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function keys(value, expected, code) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const own = Reflect.ownKeys(value);
  check(own.length === expected.length && own.every(key => typeof key === 'string' && expected.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), code);
}
function score(outputCount, goldCount, truePositives) {
  return { status: outputCount === 0 && goldCount === 0 ? 'valid_empty' : 'scored',
    outputCount, goldCount, truePositives, falsePositives: outputCount - truePositives, falseNegatives: goldCount - truePositives,
    precision: outputCount === 0 ? null : truePositives / outputCount,
    recall: goldCount === 0 ? null : truePositives / goldCount,
    precisionDenominator: outputCount === 0 ? null : outputCount, recallDenominator: goldCount === 0 ? null : goldCount };
}
function checkedAssessment(row, sample, plan) {
  const assessment = row.assessment;
  check(assessment && assessment.complete === true && assessment.contractValid === true && Array.isArray(assessment.issues) &&
    assessment.issues.length === 0, 'BATCH_REVIEW_INCOMPLETE');
  check(assessment.sampleDigest === contractDigest(sample), 'BATCH_REVIEW_SAMPLE_MISMATCH');
  check(plan.reviewers.includes(assessment.reviewer) && timestamp(assessment.reviewedAt), 'BATCH_REVIEW_IDENTITY_INVALID');
  const variant = sample.gold.variants.find(variant => variant.id === assessment.selectedVariantId);
  check(Boolean(variant), 'BATCH_REVIEW_VARIANT_INVALID');
  keys(assessment.metrics, kinds, 'BATCH_METRICS_INVALID');
  const metrics = Object.fromEntries(kinds.map(kind => {
    const metric = assessment.metrics[kind];
    keys(metric, Object.keys(score(0, 0, 0)), 'BATCH_METRICS_INVALID');
    check(['outputCount', 'goldCount', 'truePositives'].every(key => integer(metric[key])) &&
      metric.goldCount === variant.units.filter(unit => unit.kind === kind).length &&
      metric.truePositives <= Math.min(metric.outputCount, metric.goldCount), 'BATCH_METRICS_INVALID');
    const canonical = score(metric.outputCount, metric.goldCount, metric.truePositives);
    check(Object.entries(canonical).every(([key, value]) => metric[key] === value), 'BATCH_METRICS_INVALID');
    return [kind, canonical];
  }));
  check(Array.isArray(assessment.failures), 'BATCH_FAILURES_INVALID');
  const missing = new Map(), unmatched = new Set(), severeOutputs = new Set();
  const severeErrors = Object.fromEntries(semanticSevereErrorTypes.map(type => [type, 0]));
  for (const failure of assessment.failures) {
    check(failure && ['missing_gold', 'unmatched_output', 'severe_error'].includes(failure.reason), 'BATCH_FAILURES_INVALID');
    if (failure.reason === 'missing_gold') {
      keys(failure, ['reason', 'goldId', 'kind'], 'BATCH_FAILURES_INVALID');
      const unit = variant.units.find(unit => unit.id === failure.goldId);
      check(unit && unit.kind === failure.kind && !missing.has(unit.id), 'BATCH_FAILURES_INVALID'); missing.set(unit.id, unit);
    } else if (failure.reason === 'unmatched_output') {
      keys(failure, ['reason', 'outputId'], 'BATCH_FAILURES_INVALID');
      check(text(failure.outputId) && !unmatched.has(failure.outputId), 'BATCH_FAILURES_INVALID'); unmatched.add(failure.outputId);
    } else {
      keys(failure, ['reason', 'outputId', 'types'], 'BATCH_FAILURES_INVALID');
      check(text(failure.outputId) && !severeOutputs.has(failure.outputId) && Array.isArray(failure.types) && failure.types.length > 0 &&
        failure.types.every(type => semanticSevereErrorTypes.includes(type)) && new Set(failure.types).size === failure.types.length, 'BATCH_FAILURES_INVALID');
      severeOutputs.add(failure.outputId);
      for (const type of failure.types) severeErrors[type]++;
    }
  }
  for (const kind of kinds) check([...missing.values()].filter(unit => unit.kind === kind).length === metrics[kind].falseNegatives, 'BATCH_FAILURES_INVALID');
  check(unmatched.size === kinds.reduce((total, kind) => total + metrics[kind].falsePositives, 0), 'BATCH_FAILURES_INVALID');
  const critical = new Set(plan.assessment.criticalGoldIds[sample.id][variant.id]);
  return { role: row.role, sampleId: row.sampleId, repetition: row.repetition, trialId: row.trialId,
    selectedVariantId: variant.id, metrics, severeErrors, criticalMissingGoldIds: [...missing.keys()].filter(id => critical.has(id)),
    reviewer: assessment.reviewer, reviewedAt: assessment.reviewedAt };
}
function comparison(baseline, candidate, thresholds) {
  const failures = [], metrics = {};
  for (const kind of kinds) {
    const before = baseline[kind], after = candidate[kind];
    // A correct empty candidate can remove baseline false positives. Its
    // null rates are explicit valid-empty evidence, not missing measurements.
    const validEmpty = after.status === 'valid_empty';
    const delta = Object.fromEntries(measures.map(measure => [measure,
      before[measure] === null || after[measure] === null ? null : after[measure] - before[measure]]));
    metrics[kind] = { baseline: before, candidate: after, delta, status: validEmpty ? 'valid_empty' : 'scored' };
    if (validEmpty) continue;
    for (const measure of measures) {
      if (after[measure] === null || before[measure] === null) {
        failures.push({ reason: 'metric_unavailable', kind, measure }); continue;
      }
      const minimum = thresholds[kind][`${measure}Min`], regressionMax = thresholds[kind][`${measure}RegressionMax`];
      if (minimum !== null && after[measure] < minimum) failures.push({ reason: 'minimum_not_met', kind, measure, actual: after[measure], minimum });
      // Compare by adding the tolerance to avoid subtractive rounding at the
      // exact boundary (for example, 0.9 - 0.8 against a 0.1 tolerance).
      if (regressionMax !== null && after[measure] + regressionMax < before[measure])
        failures.push({ reason: 'regression_exceeded', kind, measure, delta: delta[measure], regressionMax });
    }
  }
  return { metrics, failures };
}
function microMetrics(rows) {
  return Object.fromEntries(kinds.map(kind => {
    const total = rows.reduce((sum, row) => {
      for (const key of ['outputCount', 'goldCount', 'truePositives']) sum[key] += row.metrics[kind][key];
      return sum;
    }, { outputCount: 0, goldCount: 0, truePositives: 0 });
    check(Object.values(total).every(integer), 'BATCH_METRIC_OVERFLOW');
    return [kind, score(total.outputCount, total.goldCount, total.truePositives)];
  }));
}
function repeatVariation(plan, rows) {
  return plan.samples.flatMap(sample => roles.map(role => {
    const selected = rows.filter(row => row.sampleId === sample.id && row.role === role);
    return { sampleId: sample.id, role, repetitions: selected.length,
      selectedVariantIds: selected.map(row => row.selectedVariantId),
      metrics: Object.fromEntries(kinds.map(kind => [kind, Object.fromEntries(measures.map(measure => {
        const values = selected.map(row => row.metrics[kind][measure]), numeric = values.filter(value => value !== null);
        const minimum = numeric.length ? Math.min(...numeric) : null, maximum = numeric.length ? Math.max(...numeric) : null;
        return [measure, { values, minimum, maximum, range: minimum === null ? null : maximum - minimum }];
      }))])) };
  }));
}

/** Exact finite matrix, all-pair gates, and count-weighted global comparison.
 * A failed offline review is still a valid annotation input: its false positives
 * and omissions are assessed against the explicitly frozen batch tolerances. */
export function assessSemanticBatch(value, rows, { frozenAt, evidenceKind, infrastructurePassed = false } = {}) {
  const base = { schemaVersion: 2, kind: 'semantic-batch-assessment', evidenceKind,
    evidenceScope: 'offline-simulation', qualityStatus: 'not_run', qualityEvaluated: false,
    fullQualityAcceptance: false, releaseEligible: false,
    boundary: 'Finite declared corpus only. Offline simulation is not model-quality acceptance; operator approval records do not authenticate human identities.' };
  try {
    const plan = validateSemanticBatchPlan(value), expected = semanticBatchTrials(plan);
    if (evidenceKind === 'actual-upstream' && plan.corpus.sourceKind === 'operator-supplied') base.evidenceScope = 'finite-operator-corpus';
    const approvals = validateBatchApprovals(plan, frozenAt);
    check(Array.isArray(rows) && rows.length === expected.length, 'BATCH_MATRIX_INCOMPLETE');
    const remaining = new Map(expected.map(trial => [trial.trialId, trial])), ordered = new Map();
    for (const row of rows) {
      keys(row, ['role', 'sampleId', 'repetition', 'trialId', 'assessment'], 'BATCH_ROW_KEYS_INVALID');
      const trial = remaining.get(row.trialId);
      check(trial && row.role === trial.role && row.sampleId === trial.sampleId && row.repetition === trial.repetition, 'BATCH_MATRIX_IDENTITY_INVALID');
      remaining.delete(row.trialId);
      ordered.set(row.trialId, checkedAssessment(row, trial.plan.sample, plan));
    }
    const normalized = expected.map(trial => ordered.get(trial.trialId));
    const issues = [], failures = [], pairs = [];
    for (const baseline of normalized.filter(row => row.role === 'baseline')) {
      const candidate = ordered.get(`candidate:${baseline.sampleId}:${baseline.repetition}`);
      check(baseline.selectedVariantId === candidate.selectedVariantId, 'BATCH_PAIR_VARIANT_MISMATCH');
      const compared = comparison(baseline.metrics, candidate.metrics, plan.assessment.thresholds);
      const vetoes = [];
      for (const [type, count] of Object.entries(candidate.severeErrors)) if (count > 0) vetoes.push({ reason: 'severe_error', type, count });
      for (const goldId of candidate.criticalMissingGoldIds) vetoes.push({ reason: 'critical_gold_missing', goldId });
      const pairFailures = [...compared.failures, ...vetoes];
      const pair = { sampleId: baseline.sampleId, repetition: baseline.repetition, selectedVariantId: baseline.selectedVariantId,
        baselineTrialId: baseline.trialId, candidateTrialId: candidate.trialId, metrics: compared.metrics,
        severeErrors: candidate.severeErrors, criticalMissingGoldIds: candidate.criticalMissingGoldIds, failures: pairFailures };
      pairs.push(pair);
      failures.push(...pairFailures.map(failure => ({ scope: 'pair', sampleId: pair.sampleId, repetition: pair.repetition, ...failure })));
    }
    const totals = Object.fromEntries(roles.map(role => [role, microMetrics(normalized.filter(row => row.role === role))]));
    const micro = comparison(totals.baseline, totals.candidate, plan.assessment.thresholds);
    failures.push(...micro.failures.map(failure => ({ scope: 'micro-global', ...failure })));
    const thresholdsComplete = kinds.every(kind => Object.values(plan.assessment.thresholds[kind]).every(value => value !== null));
    if (!thresholdsComplete) issues.push('BATCH_THRESHOLDS_NOT_FROZEN');
    const ruleDecision = !thresholdsComplete ? 'not_run' : failures.length ? 'failed' : 'passed';
    const realEvidence = evidenceKind === 'actual-upstream' && plan.corpus.sourceKind === 'operator-supplied';
    const allHumanComplete = normalized.every(row => timestamp(frozenAt) && Date.parse(row.reviewedAt) >= Date.parse(frozenAt));
    const coverageComplete = kinds.every(kind => totals.baseline[kind].goldCount > 0 && totals.candidate[kind].goldCount > 0);
    if (!infrastructurePassed) issues.push('BATCH_INFRASTRUCTURE_NOT_PASSED');
    if (!allHumanComplete) issues.push('BATCH_REVIEW_PRECEDES_FREEZE');
    if (realEvidence && !coverageComplete) issues.push('BATCH_GOLD_KIND_COVERAGE_MISSING');
    const qualityEvaluated = realEvidence && approvals.complete && infrastructurePassed === true && allHumanComplete && coverageComplete && thresholdsComplete;
    return { ...base, evidenceScope: realEvidence ? 'finite-operator-corpus' : 'offline-simulation',
      complete: true, contractValid: true, ruleDecision, qualityStatus: qualityEvaluated ? ruleDecision : 'not_run', qualityEvaluated,
      issues, failures, approvals, pairs, micro, repeatVariation: repeatVariation(plan, normalized),
      trialCount: expected.length, sampleCount: plan.samples.length, repetitions: plan.repetitions,
      allHumanComplete, coverageComplete, infrastructurePassed: infrastructurePassed === true };
  } catch (error) {
    return { ...base, complete: false, contractValid: false, ruleDecision: 'incomplete', issues: [error.code || 'BATCH_ASSESSMENT_INVALID'],
      failures: [], approvals: null, pairs: [], micro: null, repeatVariation: [] };
  }
}
