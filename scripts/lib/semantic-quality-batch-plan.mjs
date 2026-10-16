// A bounded evaluation contract. Approval records are operator declarations;
// neither this validator nor its digests authenticate a person or grant spend.
import { contractDigest } from './quality-contract.mjs';
import { validateSemanticCorpusPlan, semanticCorpusBudget } from './semantic-quality-corpus-plan.mjs';
import { semanticSevereErrorTypes } from './semantic-quality-review.mjs';

const kinds = ['entity', 'fact', 'relation'];
const thresholdKeys = ['precisionMin', 'recallMin', 'precisionRegressionMax', 'recallRegressionMax'];
const approvalKeys = ['approved', 'reviewedBy', 'reviewedAt', 'reference'];
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const integer = (value, low, high) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= low && value <= high;
function keys(value, expected, code) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const own = Reflect.ownKeys(value);
  check(own.length === expected.length && own.every(key => typeof key === 'string' && expected.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), code);
}
function array(value, minimum, maximum, code) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && integer(value.length, minimum, maximum), code);
  check(Reflect.ownKeys(value).length === value.length + 1, code);
  // Inspect descriptors before reading values, including accessors and holes.
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    check(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), code);
  }
  return value;
}
function text(value, maximum, code) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), code);
  check(!/\bauthorization\s*["':=]|\bbearer\s+[a-z0-9._~+/-]+|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?\S|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i.test(value), 'BATCH_CREDENTIAL_TEXT_DENIED');
  return value;
}
function timestamp(value, code) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)), code);
  const result = new Date(value).toISOString();
  check(result === (value.includes('.') ? value : value.replace('Z', '.000Z')), code);
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}
function approval(value, additional = []) {
  keys(value, [...approvalKeys, ...additional], 'BATCH_APPROVAL_KEYS_INVALID');
  check(typeof value.approved === 'boolean', 'BATCH_APPROVAL_INVALID');
  if (!value.approved) {
    check(value.reviewedBy === null && value.reviewedAt === null && value.reference === null, 'BATCH_UNAPPROVED_FIELDS_INVALID');
    return { approved: false, reviewedBy: null, reviewedAt: null, reference: null };
  }
  return { approved: true, reviewedBy: text(value.reviewedBy, 100, 'BATCH_APPROVER_INVALID'),
    reviewedAt: timestamp(value.reviewedAt, 'BATCH_APPROVAL_TIME_INVALID'), reference: text(value.reference, 2000, 'BATCH_APPROVAL_REFERENCE_INVALID') };
}
function digest(value) { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'BATCH_APPROVAL_DIGEST_INVALID'); return value; }
function singlePlan(value, sample) {
  return validateSemanticCorpusPlan({ schemaVersion: 1, kind: 'offline-semantic-corpus-plan', mode: 'offline',
    sample, reviewers: value.reviewers, budget: value.budget, limits: value.limits });
}

/** Structural validation does not invent a collection timestamp. In particular,
 * a preview cannot make a later approval count as pre-generation approval. */
function inspectSemanticBatchPlan(value) {
  keys(value, ['schemaVersion', 'kind', 'samples', 'repetitions', 'reviewers', 'budget', 'limits',
    'batchTimeoutMs', 'corpus', 'assessment', 'approvals'], 'BATCH_PLAN_KEYS_INVALID');
  check(value.schemaVersion === 2 && value.kind === 'semantic-corpus-batch-plan', 'BATCH_PLAN_REQUIRED');
  const rawSamples = array(value.samples, 1, 4, 'BATCH_SAMPLES_INVALID');
  check(integer(value.repetitions, 1, 3) && rawSamples.length * value.repetitions * 2 <= 16, 'BATCH_TRIAL_LIMIT');
  check(integer(value.batchTimeoutMs, 1, 300000), 'BATCH_TIMEOUT_INVALID');
  const singlePlans = rawSamples.map(sample => singlePlan(value, sample)), first = singlePlans[0];
  const sampleBudgets = singlePlans.map(plan => semanticCorpusBudget(plan));
  const worstCase = singlePlans.map((plan, index) => {
    const bounds = sampleBudgets[index].maxAttempts;
    return (bounds.knowledge * plan.budget.attemptMicros.knowledge + bounds.relation * plan.budget.attemptMicros.relation) * value.repetitions * 2;
  });
  check(worstCase.every(Number.isSafeInteger) && Number.isSafeInteger(worstCase.reduce((sum, amount) => sum + amount, 0)), 'BATCH_BUDGET_OVERFLOW');
  check(first.limits.totalTimeoutMs <= 15000 && first.limits.totalTimeoutMs <= value.batchTimeoutMs, 'BATCH_TRIAL_TIMEOUT_INVALID');
  const samples = singlePlans.map(plan => plan.sample);
  check(new Set(samples.map(sample => sample.id)).size === samples.length, 'BATCH_SAMPLE_IDS_INVALID');
  keys(value.corpus, ['id', 'version', 'sourceKind', 'acceptanceSplitFrozen'], 'BATCH_CORPUS_KEYS_INVALID');
  check(integer(value.corpus.version, 1, Number.MAX_SAFE_INTEGER) && ['synthetic', 'operator-supplied'].includes(value.corpus.sourceKind) &&
    typeof value.corpus.acceptanceSplitFrozen === 'boolean', 'BATCH_CORPUS_INVALID');
  const corpus = { id: text(value.corpus.id, 160, 'BATCH_CORPUS_ID_INVALID'), version: value.corpus.version,
    sourceKind: value.corpus.sourceKind, acceptanceSplitFrozen: value.corpus.acceptanceSplitFrozen };
  const raw = value.assessment;
  keys(raw, ['method', 'matchingPolicy', 'aggregation', 'directions', 'emptyPolicy', 'thresholds', 'severeErrorTypes', 'severeErrorMax', 'criticalGoldIds'], 'BATCH_ASSESSMENT_KEYS_INVALID');
  check(raw.method === 'manual-unit-matches-v1' && raw.matchingPolicy === 'one-complete-variant-same-pair-v1' &&
    raw.aggregation === 'all-pairs-and-micro-global-v1' && raw.emptyPolicy === 'valid-empty-null-v1', 'BATCH_ASSESSMENT_POLICY_INVALID');
  keys(raw.directions, ['precision', 'recall', 'severeErrors'], 'BATCH_DIRECTIONS_INVALID');
  check(raw.directions.precision === 'higher-is-better' && raw.directions.recall === 'higher-is-better' &&
    raw.directions.severeErrors === 'lower-is-better', 'BATCH_DIRECTIONS_INVALID');
  keys(raw.thresholds, kinds, 'BATCH_THRESHOLDS_INVALID');
  const thresholds = Object.fromEntries(kinds.map(kind => {
    keys(raw.thresholds[kind], thresholdKeys, 'BATCH_THRESHOLDS_INVALID');
    const row = Object.fromEntries(thresholdKeys.map(key => {
      const number = raw.thresholds[kind][key];
      check(number === null || typeof number === 'number' && Number.isFinite(number) && !Object.is(number, -0) && number >= 0 && number <= 1, 'BATCH_THRESHOLDS_INVALID');
      return [key, number];
    }));
    return [kind, row];
  }));
  const severe = array(raw.severeErrorTypes, semanticSevereErrorTypes.length, semanticSevereErrorTypes.length, 'BATCH_SEVERE_POLICY_INVALID');
  check(severe.every((type, index) => type === semanticSevereErrorTypes[index]) && raw.severeErrorMax === 0 && !Object.is(raw.severeErrorMax, -0), 'BATCH_SEVERE_POLICY_INVALID');
  keys(raw.criticalGoldIds, samples.map(sample => sample.id), 'BATCH_CRITICAL_GOLD_INVALID');
  const criticalGoldIds = Object.fromEntries(samples.map(sample => {
    const variants = raw.criticalGoldIds[sample.id];
    keys(variants, sample.gold.variants.map(variant => variant.id), 'BATCH_CRITICAL_GOLD_INVALID');
    return [sample.id, Object.fromEntries(sample.gold.variants.map(variant => {
      const ids = array(variants[variant.id], 0, variant.units.length, 'BATCH_CRITICAL_GOLD_INVALID');
      check(ids.every(id => typeof id === 'string' && variant.units.some(unit => unit.id === id)) && new Set(ids).size === ids.length, 'BATCH_CRITICAL_GOLD_INVALID');
      return [variant.id, [...ids]];
    }))];
  }));
  const assessment = { method: raw.method, matchingPolicy: raw.matchingPolicy, aggregation: raw.aggregation,
    directions: { precision: raw.directions.precision, recall: raw.directions.recall, severeErrors: raw.directions.severeErrors },
    emptyPolicy: raw.emptyPolicy, thresholds, severeErrorTypes: [...semanticSevereErrorTypes], severeErrorMax: 0, criticalGoldIds };
  const input = value.approvals;
  keys(input, ['corpusRights', 'acceptanceSplit', 'gold', 'rules'], 'BATCH_APPROVAL_KEYS_INVALID');
  const corpusRights = approval(input.corpusRights), acceptanceSplit = approval(input.acceptanceSplit);
  const gold = array(input.gold, samples.length, samples.length, 'BATCH_GOLD_APPROVALS_INVALID').map(row => {
    const fields = approval(row, ['sampleId', 'sampleDigest', 'goldDigest']);
    check(samples.some(sample => sample.id === row.sampleId), 'BATCH_GOLD_APPROVALS_INVALID');
    return { sampleId: row.sampleId, sampleDigest: digest(row.sampleDigest), goldDigest: digest(row.goldDigest), ...fields };
  });
  check(new Set(gold.map(row => row.sampleId)).size === samples.length, 'BATCH_GOLD_APPROVALS_INVALID');
  const rulesApproval = approval(input.rules, ['rulesDigest']);
  const approvals = { corpusRights, acceptanceSplit, gold: samples.map(sample => gold.find(row => row.sampleId === sample.id)),
    rules: { rulesDigest: digest(input.rules.rulesDigest), ...rulesApproval } };
  // Keep the v1 synthetic marker unchanged. Approval is a separate, bound record.
  const plan = freeze({ schemaVersion: 2, kind: 'semantic-corpus-batch-plan', samples, repetitions: value.repetitions,
    reviewers: first.reviewers, budget: first.budget, limits: first.limits, batchTimeoutMs: value.batchTimeoutMs, corpus, assessment, approvals });
  return { plan, singlePlans, sampleBudgets };
}

export function validateSemanticBatchPlan(value) { return inspectSemanticBatchPlan(value).plan; }

// These inputs were validated together in this call. Reusing their detached,
// frozen per-sample plans never bypasses validation of a later caller input.
function trialsFromValidatedPlan(plan, singlePlans) {
  const rows = [];
  for (const role of ['baseline', 'candidate']) {
    let roleIndex = 0;
    for (const single of singlePlans) for (let repetition = 0; repetition < plan.repetitions; repetition++) {
      const sample = single.sample;
      rows.push({ role, sampleId: sample.id, repetition, trialId: `${role}:${sample.id}:${repetition}`, index: rows.length,
        roleIndex, directory: `${role}/trial-${String(roleIndex).padStart(4, '0')}`, plan: single });
      roleIndex++;
    }
  }
  return freeze(rows);
}

export function semanticBatchTrials(value) {
  const { plan, singlePlans } = inspectSemanticBatchPlan(value);
  return trialsFromValidatedPlan(plan, singlePlans);
}

export function semanticBatchBudget(value) {
  const { plan, singlePlans, sampleBudgets } = inspectSemanticBatchPlan(value);
  const trials = trialsFromValidatedPlan(plan, singlePlans);
  const boundsBySample = new Map(singlePlans.map((single, index) => [single.sample.id, sampleBudgets[index].maxAttempts]));
  const maxAttempts = { knowledge: 0, relation: 0 }, maxTrialAttempts = { knowledge: 0, relation: 0 };
  const trialLimits = Object.fromEntries(trials.map(trial => {
    const bounds = boundsBySample.get(trial.sampleId);
    for (const kind of ['knowledge', 'relation']) {
      maxAttempts[kind] += bounds[kind]; maxTrialAttempts[kind] = Math.max(maxTrialAttempts[kind], bounds[kind]);
    }
    return [trial.trialId, { ...bounds }];
  }));
  const amounts = ['knowledge', 'relation'].map(kind => maxAttempts[kind] * plan.budget.attemptMicros[kind]);
  check(amounts.every(Number.isSafeInteger) && Number.isSafeInteger(amounts[0] + amounts[1]), 'BATCH_BUDGET_OVERFLOW');
  return freeze({ id: plan.budget.id, currency: plan.budget.currency, ceilingMicros: plan.budget.ceilingMicros,
    maxAttempts, attemptMicros: { ...plan.budget.attemptMicros }, maxTrialAttempts, trialLimits, expiresAt: plan.budget.expiresAt });
}

/** Verify declared approvals against the actual, persisted pre-collection time.
 * These records bind corpus/split through the frozen plan, and gold/rules through
 * their explicit digests; names and references are not identity authentication. */
export function validateBatchApprovals(value, frozenAt) {
  const plan = validateSemanticBatchPlan(value), issues = [];
  let frozen = null;
  try { frozen = timestamp(frozenAt, 'BATCH_FREEZE_TIME_INVALID'); } catch (error) { issues.push(error.code); }
  const inspect = (row, label, bound = true) => {
    const failures = [];
    if (!row.approved) failures.push(`${label}:approval_missing`);
    if (row.approved && (!frozen || Date.parse(row.reviewedAt) > Date.parse(frozen))) failures.push(`${label}:approval_after_freeze`);
    if (!bound) failures.push(`${label}:digest_mismatch`);
    issues.push(...failures);
    return { status: failures.length ? 'not_run' : 'approved', issues: failures };
  };
  const details = {
    corpusRights: inspect(plan.approvals.corpusRights, 'corpusRights'),
    acceptanceSplit: inspect(plan.approvals.acceptanceSplit, 'acceptanceSplit'),
    gold: plan.approvals.gold.map(row => {
      const sample = plan.samples.find(sample => sample.id === row.sampleId);
      return { sampleId: row.sampleId, ...inspect(row, `gold:${row.sampleId}`,
        row.sampleDigest === contractDigest(sample) && row.goldDigest === contractDigest(sample.gold)) };
    }),
    rules: inspect(plan.approvals.rules, 'rules', plan.approvals.rules.rulesDigest === contractDigest(plan.assessment))
  };
  if (plan.corpus.sourceKind !== 'operator-supplied') issues.push('operator_corpus_required');
  if (!plan.corpus.acceptanceSplitFrozen) issues.push('acceptance_split_not_frozen');
  return freeze({ status: issues.length ? 'not_run' : 'approved', complete: issues.length === 0, issues, details });
}
