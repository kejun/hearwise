import test from 'node:test';
import assert from 'node:assert/strict';
import { SEMANTIC_PROVIDER_PROFILE as profile, validateSemanticProviderProfile, validateSemanticProviderEndpoint,
  assertSemanticProviderRequest, semanticProviderBudget, assertSemanticProviderApproval,
  validateSemanticProviderApprovalBinding } from '../scripts/lib/semantic-quality-provider-policy.mjs';

const expiry = '2099-01-01T00:00:00.000Z';
const digest = 'a'.repeat(64);
function plan() {
  return { schemaVersion: 1, kind: 'offline-semantic-corpus-plan', mode: 'offline',
    sample: { id: 'corpus', kind: 'offline-text-corpus', segments: ['Atlas supports Nova.'], ingestionBatchSize: 1,
      gold: { approved: false, variants: [{ id: 'empty', units: [] }] } }, reviewers: ['offline label'],
    budget: { id: 'caller-budget', currency: 'CNY', ceilingMicros: 20000000,
      attemptMicros: { knowledge: 1147368, relation: 1147368 }, expiresAt: expiry },
    limits: { maxRequestBytes: 128000, maxResponseBytes: 128000, requestTimeoutMs: 5000, totalTimeoutMs: 30000 } };
}
function request(kind = 'knowledge') {
  return { model: 'qwen3.8-flash', enable_thinking: false,
    ...(kind === 'relation' ? { temperature: 0, max_completion_tokens: 6000, response_format: { type: 'json_object' } } : {}),
    messages: [{ role: 'system', content: 'Extract source facts.' }, { role: 'user', content: '{"source":"Atlas"}' }] };
}
const approval = () => ({ approval: { planDigest: digest, approved: true, expiresAt: expiry }, requestDigest: digest, expiresAt: expiry, now: 1792116000000 });

test('official versioned conservative profile uses integer ceil and is deeply immutable', () => {
  assert.equal(profile.attemptMicros, 1147368);
  assert.equal(BigInt(profile.attemptMicros), (991808n * 800000n + 131082n * 2700000n + 999999n) / 1000000n);
  assert.equal(profile.currency, 'CNY'); assert.equal(profile.invoiceGuarantee, false);
  assert.ok(Object.isFrozen(profile)); assert.ok(Object.isFrozen(profile.evidence));
  assert.equal(validateSemanticProviderProfile(structuredClone(profile)), profile);
  for (const field of ['id', 'maxInputTokens', 'maxOutputTokens', 'outputToleranceTokens', 'inputMicrosPerMillion',
    'outputMicrosPerMillion', 'attemptMicros', 'currency', 'evidenceCheckedAt']) {
    const changed = structuredClone(profile); changed[field] = 'changed';
    assert.throws(() => validateSemanticProviderProfile(changed), /PROVIDER_PROFILE_INVALID/);
  }
  const changed = structuredClone(profile); changed.evidence.model += '?unverified';
  assert.throws(() => validateSemanticProviderProfile(changed), /PROVIDER_PROFILE_INVALID/);
});

test('only exact official endpoint is accepted, including rejecting normalized aliases', () => {
  assert.equal(validateSemanticProviderEndpoint(profile.endpoint), profile.endpoint);
  for (const value of [null, {}, profile.endpoint + '?', profile.endpoint + '#', profile.endpoint + '/',
    profile.endpoint.replace('https:', 'http:'), profile.endpoint.replace('maas.', 'evil@maas.'),
    profile.endpoint.replace('/v1/', '/%76%31/'), profile.endpoint.replace('maas.', 'MAAS.'),
    profile.endpoint.replace('.com/', '.com:443/'), profile.endpoint.replace('/v1/', '/a/../v1/'),
    ' ' + profile.endpoint, profile.endpoint + '\n', 'https://example.com/compatible-mode/v1/chat/completions'])
    assert.throws(() => validateSemanticProviderEndpoint(value), /PROVIDER_ENDPOINT_DENIED/);
});

test('request policy keeps exact existing knowledge and relation shapes without rewriting', () => {
  for (const kind of ['knowledge', 'relation']) {
    const wire = request(kind), before = structuredClone(wire);
    assert.equal(assertSemanticProviderRequest(kind, wire), true); assert.deepEqual(wire, before);
    for (const field of ['tools', 'n', 'stream', 'max_tokens', 'audio', 'modalities', 'store', 'metadata']) {
      const extra = request(kind); extra[field] = 1;
      assert.throws(() => assertSemanticProviderRequest(kind, extra), /PROVIDER_REQUEST_KEYS_INVALID/);
    }
    for (const mutate of [r => { r.enable_thinking = true; }, r => { r.model = 'qwen3.8-plus'; },
      r => { r.messages[1].content = [{ type: 'image_url', image_url: { url: 'https://example.com' } }]; },
      r => { r.messages[0].role = 'developer'; }, r => { r.messages[0].tool_calls = []; },
      r => { r.messages.push({ role: 'user', content: 'extra' }); }]) {
      const invalid = request(kind); mutate(invalid);
      assert.throws(() => assertSemanticProviderRequest(kind, invalid), /PROVIDER_/);
    }
  }
  for (const mutate of [r => { r.temperature = 1; }, r => { r.max_completion_tokens = 131072; },
    r => { r.response_format.type = 'json_schema'; }]) {
    const invalid = request('relation'); mutate(invalid);
    assert.throws(() => assertSemanticProviderRequest('relation', invalid), /PROVIDER_REQUEST_POLICY_INVALID/);
  }
  assert.throws(() => assertSemanticProviderRequest('repair', request()), /PROVIDER_REQUEST_KIND_INVALID/);
});

test('provider budget preserves corpus bounds and explicit ceiling with exact prices', () => {
  const input = plan(), budget = semanticProviderBudget(input);
  assert.deepEqual(budget.maxAttempts, { knowledge: 4, relation: 3 });
  assert.deepEqual(budget.maxTrialAttempts, budget.maxAttempts);
  assert.equal(budget.ceilingMicros, 20000000); assert.equal(budget.currency, 'CNY');
  assert.ok(Object.isFrozen(budget.attemptMicros)); assert.equal(input.budget.ceilingMicros, 20000000);
  input.budget.ceilingMicros = 1; assert.equal(semanticProviderBudget(input).ceilingMicros, 1);
  for (const value of [0, -0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = plan(); invalid.budget.ceilingMicros = value;
    assert.throws(() => semanticProviderBudget(invalid), /CORPUS_BUDGET_INVALID/);
  }
  for (const kind of ['knowledge', 'relation']) {
    for (const value of [1, 1147367, 1147369, Number.MAX_SAFE_INTEGER]) {
      const invalid = plan(); invalid.budget.attemptMicros[kind] = value;
      assert.throws(() => semanticProviderBudget(invalid), /PROVIDER_BUDGET_PRICE_INVALID|CORPUS_BUDGET_OVERFLOW/);
    }
  }
  const invalid = plan(); invalid.budget.currency = 'USD';
  assert.throws(() => semanticProviderBudget(invalid), /PROVIDER_BUDGET_PRICE_INVALID/);
});

test('approval is explicit, exact-digest bound, separate and fresh at dispatch', () => {
  assert.equal(assertSemanticProviderApproval(approval()), true);
  for (const mutate of [a => { a.approval = undefined; }, a => { a.approval.approved = false; },
    a => { a.approval.approved = 'true'; }, a => { a.approval.planDigest = 'b'.repeat(64); },
    a => { a.requestDigest = 'A'.repeat(64); a.approval.planDigest = a.requestDigest; },
    a => { a.approval.extra = true; }, a => { delete a.approval; }]) {
    const input = approval(); mutate(input);
    assert.throws(() => assertSemanticProviderApproval(input), /PROVIDER_APPROVAL_/);
  }
  const early = approval(); early.approval.expiresAt = '2030-01-01T00:00:00Z';
  assert.equal(assertSemanticProviderApproval(early), true);
  early.now = Date.parse(early.approval.expiresAt);
  assert.throws(() => assertSemanticProviderApproval(early), /PROVIDER_APPROVAL_EXPIRED/);
  const late = approval(); late.approval.expiresAt = '2099-01-02T00:00:00Z';
  assert.throws(() => assertSemanticProviderApproval(late), /PROVIDER_APPROVAL_EXPIRY_MISMATCH/);
  for (const badTime of ['2099-02-29T00:00:00Z', '2099-01-01', '', Infinity]) {
    const invalid = approval(); invalid.approval.expiresAt = badTime;
    assert.throws(() => assertSemanticProviderApproval(invalid), /PROVIDER_EXPIRY_INVALID/);
  }
  for (const now of [NaN, Infinity, -1, -0, 1.5, '2026', Number.MAX_SAFE_INTEGER]) {
    const invalid = approval(); invalid.now = now;
    assert.throws(() => assertSemanticProviderApproval(invalid), /PROVIDER_CLOCK_INVALID/);
  }
});

test('historical approval binding is detached and readable without authorizing new calls', () => {
  const input = approval(); delete input.now;
  input.expiresAt = input.approval.expiresAt = '2020-01-01T00:00:00Z';
  const result = validateSemanticProviderApprovalBinding(input);
  assert.equal(result.expiresAt, '2020-01-01T00:00:00.000Z'); assert.ok(Object.isFrozen(result));
  assert.notEqual(result, input.approval);
  assert.throws(() => assertSemanticProviderApproval(input), /PROVIDER_APPROVAL_EXPIRED/);
});

test('all public object entry points reject hidden fields, prototypes, symbols and accessors before reads', () => {
  const cases = [
    [() => structuredClone(profile), validateSemanticProviderProfile, 'model'],
    [() => request(), value => assertSemanticProviderRequest('knowledge', value), 'model'],
    [approval, assertSemanticProviderApproval, 'approval'],
    [() => { const value = approval(); delete value.now; return value; }, validateSemanticProviderApprovalBinding, 'approval']
  ];
  for (const [make, validate, field] of cases) {
    for (const mutate of [value => Object.defineProperty(value, 'hidden', { value: 1 }),
      value => { value[Symbol('hidden')] = 1; }, value => Object.setPrototypeOf(value, { inherited: 1 }),
      value => Object.defineProperty(value, field, { enumerable: true, get() { assert.fail('Accessor ran'); } })]) {
      const input = make(); mutate(input); assert.throws(() => validate(input), /PROVIDER_/);
    }
  }
  const input = request(); Object.defineProperty(input.messages, '0', { enumerable: true, get() { assert.fail('Accessor ran'); } });
  assert.throws(() => assertSemanticProviderRequest('knowledge', input), /PROVIDER_MESSAGES_INVALID/);
  const nested = approval(); Object.defineProperty(nested.approval, 'approved', { enumerable: true, get() { assert.fail('Accessor ran'); } });
  assert.throws(() => assertSemanticProviderApproval(nested), /PROVIDER_APPROVAL_REQUIRED/);
});
