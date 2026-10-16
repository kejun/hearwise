// Versioned evaluation policy, not a provider invoice guarantee or permission to
// make requests. Production wire parameters are checked, never rewritten here.
import { semanticCorpusBudget, validateSemanticCorpusPlan } from './semantic-quality-corpus-plan.mjs';

const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
function keys(value, expected, code) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const own = Reflect.ownKeys(value);
  check(own.length === expected.length && own.every(key => typeof key === 'string' && expected.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), code);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function timestamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)), 'PROVIDER_EXPIRY_INVALID');
  const result = new Date(value).toISOString();
  check(result === (value.includes('.') ? value : value.replace('Z', '.000Z')), 'PROVIDER_EXPIRY_INVALID');
  return result;
}
// Rates are integer micro-CNY per million tokens, with a single upward rounding.
const numerator = 991808n * 800000n + (131072n + 10n) * 2700000n;
const attemptBound = (numerator + 999999n) / 1000000n;
check(attemptBound > 0n && attemptBound <= BigInt(Number.MAX_SAFE_INTEGER), 'PROVIDER_BUDGET_OVERFLOW');
const attemptMicros = Number(attemptBound);
// Dated published assumptions require fresh caller approval of this complete
// profile. They are not an account-specific cap or an indefinite pricing promise.
export const SEMANTIC_PROVIDER_PROFILE = freeze({
  schemaVersion: 1,
  id: 'qwen3.8-flash-official-text-nonthinking-2026-10-16-v1',
  model: 'qwen3.8-flash',
  enableThinking: false,
  textOnly: true,
  responsesPerRequest: 1,
  endpoint: 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions',
  currency: 'CNY',
  maxInputTokens: 991808,
  maxOutputTokens: 131072,
  outputToleranceTokens: 10,
  inputMicrosPerMillion: 800000,
  outputMicrosPerMillion: 2700000,
  attemptMicros,
  reservation: 'full-input-and-output-caps-for-each-kind-no-refunds',
  invoiceGuarantee: false,
  evidenceCheckedAt: '2026-10-16',
  evidence: {
    model: 'https://www.qianwenai.com/models/qwen3.8-flash',
    limits: 'https://help.aliyun.com/zh/model-studio/qwen3-8-flash',
    protocol: 'https://platform.qianwenai.com/docs/api-reference/chat/openai-chat'
  }
});

/** Accept exactly the published profile, including its evidence and version. */
export function validateSemanticProviderProfile(value) {
  keys(value, Object.keys(SEMANTIC_PROVIDER_PROFILE), 'PROVIDER_PROFILE_INVALID');
  for (const key of Object.keys(SEMANTIC_PROVIDER_PROFILE)) {
    if (key === 'evidence') {
      keys(value.evidence, Object.keys(SEMANTIC_PROVIDER_PROFILE.evidence), 'PROVIDER_PROFILE_INVALID');
      for (const name of Object.keys(SEMANTIC_PROVIDER_PROFILE.evidence))
        check(value.evidence[name] === SEMANTIC_PROVIDER_PROFILE.evidence[name], 'PROVIDER_PROFILE_INVALID');
    } else check(value[key] === SEMANTIC_PROVIDER_PROFILE[key], 'PROVIDER_PROFILE_INVALID');
  }
  return SEMANTIC_PROVIDER_PROFILE;
}

/** Reject aliases rather than allowing URL normalization to expand scope. */
export function validateSemanticProviderEndpoint(value) {
  check(typeof value === 'string' && value === SEMANTIC_PROVIDER_PROFILE.endpoint, 'PROVIDER_ENDPOINT_DENIED');
  const url = new URL(value);
  check(url.href === value && !url.username && !url.password && !url.search && !url.hash && !value.includes('%'), 'PROVIDER_ENDPOINT_DENIED');
  return value;
}

/** Shape check only. The caller must additionally rebuild and compare the
 * complete request from the active production reservation before dispatch. */
export function assertSemanticProviderRequest(kind, request) {
  check(['knowledge', 'relation'].includes(kind), 'PROVIDER_REQUEST_KIND_INVALID');
  keys(request, kind === 'knowledge' ? ['model', 'enable_thinking', 'messages'] :
    ['model', 'enable_thinking', 'temperature', 'max_completion_tokens', 'response_format', 'messages'], 'PROVIDER_REQUEST_KEYS_INVALID');
  check(request.model === SEMANTIC_PROVIDER_PROFILE.model && request.enable_thinking === false, 'PROVIDER_REQUEST_POLICY_INVALID');
  if (kind === 'relation') {
    check(request.temperature === 0 && !Object.is(request.temperature, -0) && request.max_completion_tokens === 6000, 'PROVIDER_REQUEST_POLICY_INVALID');
    keys(request.response_format, ['type'], 'PROVIDER_REQUEST_KEYS_INVALID');
    check(request.response_format.type === 'json_object', 'PROVIDER_REQUEST_POLICY_INVALID');
  }
  const messages = request.messages;
  check(Array.isArray(messages) && Object.getPrototypeOf(messages) === Array.prototype && messages.length === 2, 'PROVIDER_MESSAGES_INVALID');
  const own = Reflect.ownKeys(messages);
  check(own.length === 3 && own.every(key => ['0', '1', 'length'].includes(key)) && ['0', '1'].every(key =>
    Object.getOwnPropertyDescriptor(messages, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(messages, key), 'value')), 'PROVIDER_MESSAGES_INVALID');
  for (let index = 0; index < messages.length; index++) {
    keys(messages[index], ['role', 'content'], 'PROVIDER_MESSAGE_KEYS_INVALID');
    check(messages[index].role === (index === 0 ? 'system' : 'user') && typeof messages[index].content === 'string' &&
      messages[index].content.length > 0, 'PROVIDER_TEXT_ONLY_REQUIRED');
  }
  return true;
}

/** Single-role ledger config. Pair orchestration must multiply attempt counts,
 * keep this same shared ceiling, and check overflow before opening a ledger. */
export function semanticProviderBudget(value) {
  const plan = validateSemanticCorpusPlan(value);
  check(plan.budget.currency === 'CNY' && ['knowledge', 'relation'].every(kind =>
    plan.budget.attemptMicros[kind] === attemptMicros), 'PROVIDER_BUDGET_PRICE_INVALID');
  return semanticCorpusBudget(plan);
}

/** Require a separate approval supplied by the current caller. requestDigest
 * must cover immutable source manifests, corpus plan, endpoint, pricing profile,
 * resolved output directory, shared budget and expiry. Artifacts cannot approve
 * themselves; this validator neither discovers nor creates approval objects. */
export function validateSemanticProviderApprovalBinding(options) {
  keys(options, ['approval', 'requestDigest', 'expiresAt'], 'PROVIDER_APPROVAL_OPTIONS_INVALID');
  keys(options.approval, ['planDigest', 'approved', 'expiresAt'], 'PROVIDER_APPROVAL_REQUIRED');
  const { approval, requestDigest } = options;
  check(typeof requestDigest === 'string' && /^[a-f0-9]{64}$/.test(requestDigest) &&
    typeof approval.planDigest === 'string' && approval.planDigest === requestDigest && approval.approved === true,
  'PROVIDER_APPROVAL_MISMATCH');
  const expiresAt = timestamp(options.expiresAt), approvalExpiry = timestamp(approval.expiresAt);
  check(Date.parse(approvalExpiry) <= Date.parse(expiresAt), 'PROVIDER_APPROVAL_EXPIRY_MISMATCH');
  return freeze({ planDigest: requestDigest, approved: true, expiresAt: approvalExpiry });
}

export function assertSemanticProviderApproval(options) {
  const expected = ['approval', 'requestDigest', 'expiresAt'];
  // Inspect descriptors before accessing the optional clock or any other field.
  const own = options && typeof options === 'object' ? Reflect.ownKeys(options) : [];
  keys(options, own.includes('now') ? [...expected, 'now'] : expected, 'PROVIDER_APPROVAL_OPTIONS_INVALID');
  const approval = validateSemanticProviderApprovalBinding({ approval: options.approval,
    requestDigest: options.requestDigest, expiresAt: options.expiresAt });
  const now = own.includes('now') ? options.now : Date.now();
  check(Number.isSafeInteger(now) && now >= 0 && !Object.is(now, -0) && Number.isFinite(new Date(now).getTime()), 'PROVIDER_CLOCK_INVALID');
  check(now < Date.parse(approval.expiresAt), 'PROVIDER_APPROVAL_EXPIRED');
  return true;
}
