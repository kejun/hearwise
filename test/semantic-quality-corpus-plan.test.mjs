import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSemanticCorpusPlan, semanticCorpusBudget, semanticCorpusAttemptBounds } from '../scripts/lib/semantic-quality-corpus-plan.mjs';
import { openSemanticQualityBudget } from '../scripts/lib/quality-budget.mjs';
import { contractDigest } from '../scripts/lib/quality-contract.mjs';
import { ListeningStore } from '../storage.mjs';
import { createKnowledgeWorkflow } from '../knowledge-workflow.mjs';

function planFor(segments = ['Atlas supports Nova.'], ingestionBatchSize = segments.length) {
  return { schemaVersion: 1, kind: 'offline-semantic-corpus-plan', mode: 'offline',
    sample: { id: 'example-corpus', kind: 'offline-text-corpus', segments, ingestionBatchSize,
      gold: { approved: false, variants: [{ id: 'expected', units: [
        { id: 'atlas', kind: 'entity', meaning: 'Atlas is a distinct named entity.', alternatives: [], sourceIndexes: [0] },
        { id: 'nova', kind: 'entity', meaning: 'Nova is a distinct named entity.', alternatives: ['Nova is independently mentioned.'], sourceIndexes: [0] },
        { id: 'support-fact', kind: 'fact', owner: 'atlas', meaning: 'Atlas supports Nova.', alternatives: [], sourceIndexes: [0] },
        { id: 'support', kind: 'relation', subject: 'atlas', object: 'nova', meaning: 'Atlas supports Nova.', alternatives: [], sourceIndexes: [0] }
      ] }] } }, reviewers: ['offline annotation label (not an authenticated reviewer)'],
    budget: { id: 'synthetic-corpus-ledger', currency: 'USD', ceilingMicros: 1000,
      attemptMicros: { knowledge: 2, relation: 3 }, expiresAt: '2099-01-01T00:00:00.000Z' },
    limits: { maxRequestBytes: 128000, maxResponseBytes: 128000, requestTimeoutMs: 5000, totalTimeoutMs: 30000 } };
}
function rejects(change, code) {
  const plan = planFor(); change(plan);
  assert.throws(() => validateSemanticCorpusPlan(plan), error => error.code === code);
}
function deeplyFrozen(value) {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const item of Object.values(value)) deeplyFrozen(item);
  }
}

test('literal corpus plan is detached, canonical, deeply frozen and carries no acceptance or billing claim', () => {
  const input = planFor(), result = validateSemanticCorpusPlan(input);
  assert.deepEqual(result, input); assert.notEqual(result, input); deeplyFrozen(result);
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  reversed.budget = Object.fromEntries(Object.entries(input.budget).reverse());
  assert.equal(JSON.stringify(validateSemanticCorpusPlan(reversed)), JSON.stringify(result));
  input.sample.segments[0] = 'Changed later.';
  input.sample.gold.variants[0].units[0].sourceIndexes.push(1);
  input.reviewers.push('Another label'); input.budget.attemptMicros.knowledge = 100;
  assert.equal(result.sample.segments[0], 'Atlas supports Nova.');
  assert.deepEqual(result.sample.gold.variants[0].units[0].sourceIndexes, [0]);
  assert.equal(result.reviewers.length, 1); assert.equal(result.budget.attemptMicros.knowledge, 2);
  assert.throws(() => { result.sample.gold.approved = true; }, TypeError);
  assert.equal(result.sample.gold.approved, false);
  assert.equal(Object.hasOwn(result, 'qualityEvaluated'), false);
  assert.equal(Object.hasOwn(result.budget, 'approvedBy'), false);
});

test('corpus limits include 24 segments, 6000 characters each and 60000 total characters', () => {
  // Large corpora remain supported with a response cap that fits the combined
  // evidence bound; corpus size does not implicitly grant unbounded output.
  const many = planFor(Array(24).fill('x'.repeat(2500)));
  many.limits.maxRequestBytes = 16384; many.limits.maxResponseBytes = 4096;
  assert.equal(validateSemanticCorpusPlan(many).sample.segments.length, 24);
  const long = planFor(Array(10).fill('x'.repeat(6000)));
  long.limits.maxRequestBytes = 16384; long.limits.maxResponseBytes = 4096;
  assert.equal(validateSemanticCorpusPlan(long).sample.segments[0].length, 6000);
  assert.throws(() => validateSemanticCorpusPlan(planFor(Array(25).fill('x'))), /CORPUS_SEGMENTS_INVALID/);
  assert.throws(() => validateSemanticCorpusPlan(planFor(['x'.repeat(6001)])), /CORPUS_SEGMENT_INVALID/);
  assert.throws(() => validateSemanticCorpusPlan(planFor([...Array(10).fill('x'.repeat(6000)), 'x'])), /CORPUS_TEXT_LIMIT/);
  assert.throws(() => validateSemanticCorpusPlan(planFor([])), /CORPUS_SEGMENTS_INVALID/);
  for (const text of ['', ' \n\t ', 'x\0y']) assert.throws(() => validateSemanticCorpusPlan(planFor([text])), /CORPUS_SEGMENT_INVALID/);
});

test('bound follows production extraction ranges, long-segment splits and each ingestion batch', () => {
  const bound = (lengths, batch = lengths.length) => semanticCorpusAttemptBounds(planFor(lengths.map(length => 'x'.repeat(length)), batch).sample);
  assert.deepEqual(bound([1]), { knowledge: 4, relation: 3 });
  assert.deepEqual(bound([2500]), { knowledge: 4, relation: 3 });
  assert.deepEqual(bound([2501]), { knowledge: 6, relation: 3 });
  assert.deepEqual(bound([6000]), { knowledge: 8, relation: 3 });
  assert.deepEqual(bound([2600, 1]), { knowledge: 10, relation: 3 });
  assert.deepEqual(bound([1000, 1000, 1000, 1000, 1000]), { knowledge: 12, relation: 3 });
  assert.deepEqual(bound([1000, 1000, 1000, 1000, 1000], 1), { knowledge: 20, relation: 3 });
  assert.deepEqual(bound(Array(7).fill(1), 7), { knowledge: 12, relation: 6 });
  assert.deepEqual(bound(Array(7).fill(1), 2), { knowledge: 16, relation: 6 });
  assert.deepEqual(bound(Array(24).fill(2500)), { knowledge: 96, relation: 12 });
});

test('bound matches parts actually initialized by the production workflow without a provider', async () => {
  const sample = planFor(['x'.repeat(6000), 'a', 'b', 'c', 'd', 'e', 'f'], 4).sample;
  const store = new ListeningStore(':memory:');
  let now = Date.now(), requests = 0, jobs = 0, parts = 0;
  try {
    const run = store.createRun(null, { source: 'en', targetLang: 'English', audioSource: 'microphone' }, 'In-memory plan contract');
    const workflow = createKnowledgeWorkflow({ store, now: () => now,
      extract: async () => { requests++; return { accepted: [], rejected: [], normalized: [], returnedCount: 0 }; },
      repair: async () => { assert.fail('An empty extraction cannot require repair'); } });
    for (let start = 0; start < sample.segments.length; start += sample.ingestionBatchSize) {
      for (let index = start; index < Math.min(start + sample.ingestionBatchSize, sample.segments.length); index++)
        store.addSegment(run.listeningId, run.runId, { id: `segment-${index}`, text: sample.segments[index] });
      for (let range = store.extractionRange(run.listeningId); range.length; range = store.extractionRange(run.listeningId)) {
        const job = store.createExtractionJob(run.listeningId, range); jobs++;
        for (let dispatch = 0; ; dispatch++) {
          assert.ok(dispatch < 20); now += 10000;
          const result = await workflow.execute(store.markJob(job.id, 'running'), 'unused-offline-fixture');
          if (result.kind === 'terminal') { assert.equal(result.outcome, 'empty'); break; }
        }
        parts += store.knowledgeCheckpoint(job.id).parts.length;
      }
    }
    assert.equal(requests, parts);
    assert.deepEqual(semanticCorpusAttemptBounds(sample), { knowledge: 2 * parts + 2 * jobs, relation: 6 });
    assert.equal(parts, 5); assert.equal(jobs, 3);
  } finally { store.close(); }
});

for (const [name, target] of [
  ['root', p => p], ['sample', p => p.sample], ['gold', p => p.sample.gold],
  ['variant', p => p.sample.gold.variants[0]], ['entity', p => p.sample.gold.variants[0].units[0]],
  ['fact', p => p.sample.gold.variants[0].units[2]], ['relation', p => p.sample.gold.variants[0].units[3]],
  ['budget', p => p.budget], ['attempt prices', p => p.budget.attemptMicros], ['limits', p => p.limits]
]) test(`unknown ${name} fields cannot smuggle live endpoints or credentials`, () => {
  const plan = planFor(); target(plan).endpoint = 'https://example.invalid/provider';
  assert.throws(() => validateSemanticCorpusPlan(plan), /KEYS_INVALID/);
});

test('strict literal validation rejects accessors, hidden fields, symbols, prototypes and nonliteral arrays', () => {
  const input = planFor(); let called = false;
  Object.defineProperty(input, 'sample', { enumerable: true, get() { called = true; throw new Error('Getter executed'); } });
  assert.throws(() => validateSemanticCorpusPlan(input), /CORPUS_PLAN_KEYS_INVALID/); assert.equal(called, false);
  for (const mutate of [
    p => Object.defineProperty(p, 'hidden', { value: true }),
    p => { p[Symbol('hidden')] = true; },
    p => Object.setPrototypeOf(p, { endpoint: 'https://example.invalid' }),
    p => { delete p.sample.segments[0]; },
    p => { p.sample.segments.extra = 'secret'; },
    p => { p.sample.gold.variants[0].units[0].sourceIndexes[Symbol('hidden')] = 1; },
    p => Object.defineProperty(p.reviewers, '0', { enumerable: true, get() { throw new Error('Getter executed'); } })
  ]) {
    const plan = planFor(); mutate(plan);
    assert.throws(() => validateSemanticCorpusPlan(plan), error => error.code?.startsWith('CORPUS_'));
  }
});

test('mode, synthetic gold and reviewer declarations remain fail-closed', () => {
  rejects(p => { p.mode = 'live'; }, 'OFFLINE_CORPUS_PLAN_REQUIRED');
  rejects(p => { p.schemaVersion = 2; }, 'OFFLINE_CORPUS_PLAN_REQUIRED');
  rejects(p => { p.sample.kind = 'real-recording'; }, 'OFFLINE_CORPUS_REQUIRED');
  rejects(p => { p.sample.gold.approved = true; }, 'UNAPPROVED_CORPUS_GOLD_REQUIRED');
  rejects(p => { p.reviewers = []; }, 'CORPUS_REVIEWERS_INVALID');
  rejects(p => { p.reviewers = ['same', 'same']; }, 'CORPUS_REVIEWERS_INVALID');
  rejects(p => { p.reviewers = [' ']; }, 'CORPUS_REVIEWERS_INVALID');
  rejects(p => { p.reviewers = ['x'.repeat(101)]; }, 'CORPUS_REVIEWERS_INVALID');
  rejects(p => { p.reviewers = Array.from({ length: 21 }, (_, i) => String(i)); }, 'CORPUS_REVIEWERS_INVALID');
});

test('gold variants preserve references and reject duplicate, unknown or noninteger source IDs', () => {
  rejects(p => { p.sample.gold.variants = []; }, 'CORPUS_GOLD_VARIANTS_INVALID');
  rejects(p => { p.sample.gold.variants.push(structuredClone(p.sample.gold.variants[0])); }, 'CORPUS_GOLD_VARIANTS_INVALID');
  rejects(p => { p.sample.gold.variants[0].units.push(structuredClone(p.sample.gold.variants[0].units[0])); }, 'CORPUS_GOLD_IDS_INVALID');
  rejects(p => { p.sample.gold.variants[0].units[2].owner = 'absent'; }, 'CORPUS_GOLD_OWNER_INVALID');
  rejects(p => { p.sample.gold.variants[0].units[3].subject = 'absent'; }, 'CORPUS_GOLD_ENDPOINT_INVALID');
  rejects(p => { p.sample.gold.variants[0].units[3].object = 'support-fact'; }, 'CORPUS_GOLD_ENDPOINT_INVALID');
  for (const indexes of [[], [0, 0], [-1], [-0], [1], [0.5], [Number.MAX_SAFE_INTEGER + 1]])
    rejects(p => { p.sample.gold.variants[0].units[0].sourceIndexes = indexes; }, 'CORPUS_GOLD_SOURCES_INVALID');
  const empty = planFor(); empty.sample.gold.variants[0].units = [];
  assert.deepEqual(validateSemanticCorpusPlan(empty).sample.gold.variants[0].units, []);
  const alternate = planFor(), variant = structuredClone(alternate.sample.gold.variants[0]); variant.id = 'alternate';
  alternate.sample.gold.variants.push(variant); assert.equal(validateSemanticCorpusPlan(alternate).sample.gold.variants.length, 2);
});

test('bounded integer limits reject zero, floats, unsafe numbers, excess time and inverted deadlines', () => {
  for (const value of [0, -1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    rejects(p => { p.sample.ingestionBatchSize = value; }, 'CORPUS_BATCH_SIZE_INVALID');
    rejects(p => { p.budget.ceilingMicros = value; }, 'CORPUS_BUDGET_INVALID');
    rejects(p => { p.budget.attemptMicros.knowledge = value; }, 'CORPUS_BUDGET_INVALID');
    rejects(p => { p.limits.requestTimeoutMs = value; }, 'CORPUS_LIMITS_INVALID');
  }
  rejects(p => { p.sample.ingestionBatchSize = 2; }, 'CORPUS_BATCH_SIZE_INVALID');
  rejects(p => { p.budget.currency = 'EUR'; }, 'CORPUS_BUDGET_INVALID');
  for (const field of ['maxRequestBytes', 'maxResponseBytes']) {
    rejects(p => { p.limits[field] = 255; }, 'CORPUS_LIMITS_INVALID');
    rejects(p => { p.limits[field] = 1024 * 1024 + 1; }, 'CORPUS_LIMITS_INVALID');
  }
  rejects(p => { p.limits.totalTimeoutMs = 60001; }, 'CORPUS_LIMITS_INVALID');
  rejects(p => { p.limits.requestTimeoutMs = 60001; }, 'CORPUS_LIMITS_INVALID');
  rejects(p => { p.limits.totalTimeoutMs = 4999; }, 'CORPUS_LIMITS_INVALID');
  const maximum = planFor(); maximum.limits = { maxRequestBytes: 1024 * 1024, maxResponseBytes: 1024 * 1024, requestTimeoutMs: 60000, totalTimeoutMs: 60000 };
  assert.throws(() => validateSemanticCorpusPlan(maximum), /CORPUS_EVIDENCE_BYTE_BUDGET/);
});

test('synthetic budget rejects multiplication and sum overflow, including otherwise safe integer rates', () => {
  rejects(p => { p.budget.attemptMicros.knowledge = Number.MAX_SAFE_INTEGER; }, 'CORPUS_BUDGET_OVERFLOW');
  rejects(p => { p.budget.attemptMicros = { knowledge: Math.floor(Number.MAX_SAFE_INTEGER / 4), relation: 2 }; }, 'CORPUS_BUDGET_OVERFLOW');
  const exact = planFor(); exact.budget.ceilingMicros = Number.MAX_SAFE_INTEGER;
  exact.budget.attemptMicros = { knowledge: Math.floor(Number.MAX_SAFE_INTEGER / 4), relation: 1 };
  assert.deepEqual(validateSemanticCorpusPlan(exact).budget, exact.budget);
  const lowCeiling = planFor(); lowCeiling.budget.ceilingMicros = 1;
  assert.equal(semanticCorpusBudget(lowCeiling).ceilingMicros, 1);
});

test('ledger-ready budget has independent bounds, enforces reservations and still requires a run claim', () => {
  const plan = validateSemanticCorpusPlan(planFor()), settings = semanticCorpusBudget(plan);
  assert.deepEqual(settings, { id: plan.budget.id, currency: 'USD', ceilingMicros: 1000,
    maxAttempts: { knowledge: 4, relation: 3 }, attemptMicros: { knowledge: 2, relation: 3 },
    maxTrialAttempts: { knowledge: 4, relation: 3 }, expiresAt: plan.budget.expiresAt });
  deeplyFrozen(settings); assert.notEqual(settings.maxAttempts, settings.maxTrialAttempts);
  const ledger = openSemanticQualityBudget(':memory:', settings, contractDigest(plan));
  try {
    assert.throws(() => ledger.reserve({ kind: 'knowledge', trialId: 'baseline:example:0' }), /RUN_CLAIM_MISSING/);
    ledger.claimRun({ role: 'baseline', sourceSha: 'a'.repeat(40), directory: '/offline-plan-fixture', expectedSnapshot: ledger.snapshot() });
    for (let index = 0; index < 4; index++) ledger.reserve({ kind: 'knowledge', trialId: 'baseline:example:0' });
    assert.throws(() => ledger.reserve({ kind: 'knowledge', trialId: 'baseline:example:0' }), /TRIAL_ATTEMPT_LIMIT/);
    for (let index = 0; index < 3; index++) ledger.reserve({ kind: 'relation', trialId: 'baseline:example:0' });
    assert.equal(ledger.snapshot().attempts.length, 7); assert.equal(ledger.snapshot().reservedMicros, 17);
    ledger.finishRun('baseline', true);
  } finally { ledger.close(); }
});

test('invalid expiry dates are rejected; valid historical plans remain readable but cannot execute', () => {
  for (const value of ['', 'tomorrow', 0, '2099-02-29T00:00:00.000Z', '2099-01-01', '2099-01-01T24:00:00.000Z',
    '2099-01-01T00:00:00+00:00', '2099-01-01T00:00:00.0000Z'])
    rejects(p => { p.budget.expiresAt = value; }, 'CORPUS_EXPIRY_INVALID');
  const input = planFor(); input.budget.expiresAt = '2020-01-01T00:00:00Z';
  const plan = validateSemanticCorpusPlan(input); assert.equal(plan.budget.expiresAt, '2020-01-01T00:00:00.000Z');
  const ledger = openSemanticQualityBudget(':memory:', semanticCorpusBudget(plan), contractDigest(plan));
  try {
    assert.throws(() => ledger.claimRun({ role: 'baseline', sourceSha: 'a'.repeat(40), directory: '/offline-plan-fixture', expectedSnapshot: ledger.snapshot() }), /BUDGET_APPROVAL_EXPIRED/);
    assert.equal(ledger.snapshot().attempts.length, 0);
  } finally { ledger.close(); }
});

test('obvious credential text is rejected without claiming arbitrary prose is secret-free', () => {
  for (const value of ['Authorization: secret', 'Bearer opaque-value', 'api_key = example-secret',
    '"access_token":"example-secret"', 'password: example-secret', '-----BEGIN RSA PRIVATE KEY-----'])
    assert.throws(() => validateSemanticCorpusPlan(planFor([value])), /CORPUS_CREDENTIAL_TEXT_DENIED/);
  assert.equal(validateSemanticCorpusPlan(planFor(['The API key must remain private.'])).sample.segments[0], 'The API key must remain private.');
});
test('combined request and response evidence budget is bounded before collection', () => {
  const plan = planFor(Array(24).fill('A source segment.'), 1);
  plan.limits.maxRequestBytes = 1024 * 1024;
  plan.limits.maxResponseBytes = 1024 * 1024;
  assert.throws(() => validateSemanticCorpusPlan(plan), /CORPUS_EVIDENCE_BYTE_BUDGET/);
});

test('evidence bounds include worst-case JSON control-byte expansion', () => {
 const p=planFor(Array(24).fill('A source segment.'),1);p.limits.maxRequestBytes=16384;p.limits.maxResponseBytes=65536;
 const attempts=semanticCorpusAttemptBounds(p.sample),raw=(attempts.knowledge+attempts.relation)*(p.limits.maxRequestBytes+3*p.limits.maxResponseBytes);
 assert.ok(raw<=32*1024*1024);assert.ok(raw*6>32*1024*1024);
 assert.equal(JSON.stringify('\0'.repeat(100)).length-2,600);
 assert.throws(()=>validateSemanticCorpusPlan(p),/CORPUS_EVIDENCE_BYTE_BUDGET/);
});
