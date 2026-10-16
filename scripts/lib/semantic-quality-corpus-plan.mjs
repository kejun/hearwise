// Offline text-corpus contract only. No endpoint, credential, live execution,
// approved gold, authenticated reviewer or provider price is configured here.
import { ListeningStore } from '../../storage.mjs';
import { splitFocusSegments } from '../../knowledge.mjs';
import { RELATION_WINDOW_SIZE } from '../../relation-storage.mjs';
import { RELATION_MAX_REQUESTS } from '../../relation-workflow.mjs';

const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const integer = (value, low, high) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= low && value <= high;
const positive = value => integer(value, 1, Number.MAX_SAFE_INTEGER);
function keys(value, expected, code) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const own = Reflect.ownKeys(value);
  check(own.length === expected.length && own.every(key => typeof key === 'string' && expected.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), code);
}
function array(value, maximum, code, minimum = 0) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
    integer(value.length, minimum, maximum), code);
  const own = Reflect.ownKeys(value);
  check(own.length === value.length + 1 && own.every(key => key === 'length' ||
    typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), code);
  return value;
}
function text(value, maximum, code) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), code);
  // Defense in depth for recognizable credential material. This is not a
  // secret scanner and cannot certify that arbitrary prose is non-sensitive.
  check(!/\bauthorization\s*["':=]|\bbearer\s+[a-z0-9._~+/-]+|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?\S|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i.test(value),
    'CORPUS_CREDENTIAL_TEXT_DENIED');
  return value;
}
function id(value) {
  text(value, 160, 'CORPUS_ID_INVALID');
  check(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value), 'CORPUS_ID_INVALID');
  return value;
}
function unique(rows, code) { check(new Set(rows).size === rows.length, code); }
function freeze(value) {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}
function sampleFor(value) {
  keys(value, ['id', 'kind', 'segments', 'ingestionBatchSize', 'gold'], 'CORPUS_SAMPLE_KEYS_INVALID');
  check(value.kind === 'offline-text-corpus', 'OFFLINE_CORPUS_REQUIRED');
  const segments = array(value.segments, 24, 'CORPUS_SEGMENTS_INVALID', 1)
    .map(segment => text(segment, 6000, 'CORPUS_SEGMENT_INVALID'));
  check(segments.reduce((sum, segment) => sum + segment.length, 0) <= 60000, 'CORPUS_TEXT_LIMIT');
  check(integer(value.ingestionBatchSize, 1, segments.length), 'CORPUS_BATCH_SIZE_INVALID');
  keys(value.gold, ['approved', 'variants'], 'CORPUS_GOLD_KEYS_INVALID');
  check(value.gold.approved === false, 'UNAPPROVED_CORPUS_GOLD_REQUIRED');
  const variants = array(value.gold.variants, 8, 'CORPUS_GOLD_VARIANTS_INVALID', 1).map(variant => {
    keys(variant, ['id', 'units'], 'CORPUS_GOLD_VARIANT_KEYS_INVALID');
    const units = array(variant.units, 300, 'CORPUS_GOLD_UNITS_INVALID').map(unit => {
      // Check descriptors before accessing kind, including on hostile JS inputs.
      check(unit !== null && typeof unit === 'object' && Object.hasOwn(Object.getOwnPropertyDescriptor(unit, 'kind') || {}, 'value'), 'CORPUS_GOLD_UNIT_INVALID');
      const additional = unit.kind === 'fact' ? ['owner'] : unit.kind === 'relation' ? ['subject', 'object'] : [];
      keys(unit, ['id', 'kind', 'meaning', 'alternatives', 'sourceIndexes', ...additional], 'CORPUS_GOLD_UNIT_KEYS_INVALID');
      check(['entity', 'fact', 'relation'].includes(unit.kind), 'CORPUS_GOLD_UNIT_INVALID');
      const sourceIndexes = array(unit.sourceIndexes, segments.length, 'CORPUS_GOLD_SOURCES_INVALID', 1).map(index => {
        check(integer(index, 0, segments.length - 1), 'CORPUS_GOLD_SOURCES_INVALID'); return index;
      });
      unique(sourceIndexes, 'CORPUS_GOLD_SOURCES_INVALID');
      return { id: id(unit.id), kind: unit.kind, ...Object.fromEntries(additional.map(key => [key, id(unit[key])])),
        meaning: text(unit.meaning, 6000, 'CORPUS_GOLD_MEANING_INVALID'),
        alternatives: array(unit.alternatives, 12, 'CORPUS_GOLD_ALTERNATIVES_INVALID').map(item => text(item, 6000, 'CORPUS_GOLD_ALTERNATIVES_INVALID')),
        sourceIndexes };
    });
    unique(units.map(unit => unit.id), 'CORPUS_GOLD_IDS_INVALID');
    const entities = new Set(units.filter(unit => unit.kind === 'entity').map(unit => unit.id));
    check(units.every(unit => unit.kind !== 'fact' || entities.has(unit.owner)), 'CORPUS_GOLD_OWNER_INVALID');
    check(units.every(unit => unit.kind !== 'relation' || entities.has(unit.subject) && entities.has(unit.object)), 'CORPUS_GOLD_ENDPOINT_INVALID');
    return { id: id(variant.id), units };
  });
  unique(variants.map(variant => variant.id), 'CORPUS_GOLD_VARIANTS_INVALID');
  return { id: id(value.id), kind: 'offline-text-corpus', segments, ingestionBatchSize: value.ingestionBatchSize,
    gold: { approved: false, variants } };
}

function attemptsFor(sample) {
  // Model the collector's sequential drain after EVERY ingestion batch using
  // the production range selector, rather than splitting the corpus globally.
  // All storage is in memory; there are no requests, output files or credentials.
  const store = new ListeningStore(':memory:');
  let knowledge = 0;
  try {
    const run = store.createRun(null, { source: 'en', targetLang: 'English', audioSource: 'microphone' }, 'Offline corpus bounds');
    for (let start = 0; start < sample.segments.length; start += sample.ingestionBatchSize) {
      for (let index = start; index < Math.min(start + sample.ingestionBatchSize, sample.segments.length); index++) {
        store.addSegment(run.listeningId, run.runId, { id: `source-${index}`, text: sample.segments[index] });
      }
      for (let rows = store.extractionRange(run.listeningId); rows.length; rows = store.extractionRange(run.listeningId)) {
        const job = store.createExtractionJob(run.listeningId, rows);
        const parts = splitFocusSegments(store.jobInput(job)).length;
        // Each part permits one extraction and one repair; extraction retries
        // share two additional requests across the entire job, not each part.
        check(positive(parts), 'CORPUS_ATTEMPTS_INVALID');
        knowledge += 2 * parts + 2;
        // The real collector finishes this job before creating another, so it
        // cannot be coalesced with a pending job from the next range or batch.
        store.markJob(job.id, 'complete');
      }
    }
  } finally { store.close(); }
  const relation = RELATION_MAX_REQUESTS * Math.ceil(sample.segments.length / RELATION_WINDOW_SIZE);
  check(positive(knowledge) && positive(relation) && integer(knowledge + relation, 1, 200), 'CORPUS_ATTEMPTS_INVALID');
  return { knowledge, relation };
}

/** Worst-case HTTP attempts for one sequential offline corpus capture. */
export function semanticCorpusAttemptBounds(sample) { return freeze(attemptsFor(sampleFor(sample))); }

function timestamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)), 'CORPUS_EXPIRY_INVALID');
  const canonical = new Date(value).toISOString();
  check(canonical === (value.includes('.') ? value : value.replace('Z', '.000Z')), 'CORPUS_EXPIRY_INVALID');
  return canonical;
}

/** Validate and detach a literal plan. Expiry is structural here: historical
 * replay remains readable; the gateway and ledger reject expired execution. */
export function validateSemanticCorpusPlan(value) {
  keys(value, ['schemaVersion', 'kind', 'mode', 'sample', 'reviewers', 'budget', 'limits'], 'CORPUS_PLAN_KEYS_INVALID');
  check(value.schemaVersion === 1 && value.kind === 'offline-semantic-corpus-plan' && value.mode === 'offline', 'OFFLINE_CORPUS_PLAN_REQUIRED');
  const sample = sampleFor(value.sample), attempts = attemptsFor(sample);
  const reviewers = array(value.reviewers, 20, 'CORPUS_REVIEWERS_INVALID', 1).map(label => text(label, 100, 'CORPUS_REVIEWERS_INVALID'));
  unique(reviewers, 'CORPUS_REVIEWERS_INVALID');
  const budget = value.budget;
  keys(budget, ['id', 'currency', 'ceilingMicros', 'attemptMicros', 'expiresAt'], 'CORPUS_BUDGET_KEYS_INVALID');
  keys(budget.attemptMicros, ['knowledge', 'relation'], 'CORPUS_BUDGET_KEYS_INVALID');
  check(['USD', 'CNY'].includes(budget.currency) && positive(budget.ceilingMicros) &&
    positive(budget.attemptMicros.knowledge) && positive(budget.attemptMicros.relation), 'CORPUS_BUDGET_INVALID');
  const amounts = ['knowledge', 'relation'].map(kind => attempts[kind] * budget.attemptMicros[kind]);
  check(amounts.every(Number.isSafeInteger) && Number.isSafeInteger(amounts[0] + amounts[1]), 'CORPUS_BUDGET_OVERFLOW');
  const limits = value.limits;
  keys(limits, ['maxRequestBytes', 'maxResponseBytes', 'requestTimeoutMs', 'totalTimeoutMs'], 'CORPUS_LIMIT_KEYS_INVALID');
  check(integer(limits.maxRequestBytes, 256, 1024 * 1024) && integer(limits.maxResponseBytes, 256, 1024 * 1024) &&
    integer(limits.requestTimeoutMs, 1, 60000) && integer(limits.totalTimeoutMs, 1, 60000) &&
    limits.requestTimeoutMs <= limits.totalTimeoutMs, 'CORPUS_LIMITS_INVALID');
  check((attempts.knowledge + attempts.relation) * (limits.maxRequestBytes + 3 * limits.maxResponseBytes) <= 32 * 1024 * 1024, 'CORPUS_EVIDENCE_BYTE_BUDGET');
  return freeze({ schemaVersion: 1, kind: 'offline-semantic-corpus-plan', mode: 'offline', sample, reviewers,
    budget: { id: id(budget.id), currency: budget.currency, ceilingMicros: budget.ceilingMicros,
      attemptMicros: { knowledge: budget.attemptMicros.knowledge, relation: budget.attemptMicros.relation }, expiresAt: timestamp(budget.expiresAt) },
    limits: { maxRequestBytes: limits.maxRequestBytes, maxResponseBytes: limits.maxResponseBytes,
      requestTimeoutMs: limits.requestTimeoutMs, totalTimeoutMs: limits.totalTimeoutMs } });
}

/** Configuration for openSemanticQualityBudget. Micros are synthetic accounting
 * units only, never prices, provider charges or spending authorization. A lower
 * ceiling is allowed and deliberately exhausts before the worst-case bound. */
export function semanticCorpusBudget(value) {
  const plan = validateSemanticCorpusPlan(value), attempts = attemptsFor(plan.sample);
  return freeze({ id: plan.budget.id, currency: plan.budget.currency, ceilingMicros: plan.budget.ceilingMicros,
    maxAttempts: { ...attempts }, attemptMicros: { ...plan.budget.attemptMicros }, maxTrialAttempts: { ...attempts }, expiresAt: plan.budget.expiresAt });
}
