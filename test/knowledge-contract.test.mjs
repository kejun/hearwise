import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { CONTRACT_REVISION, LABEL_TYPES, SYSTEM_PROMPT_V2, parseKnowledgeV2, buildRepairTargets,
  parseKnowledgeRepair, repairKnowledge } from '../knowledge.mjs';

const source = 'Atlas 公司宣布建设研发中心，Nova 公司是其合作伙伴。';
const input = (extra = {}) => ({ policy_version: 2, focus_segments: [{ id: 's1', text: source }],
  context_segments: [], existing_candidates: [], observed_candidates: [], ...extra });
const item = (extra = {}) => ({ action: 'create', display_label: 'organization', canonical_name: 'Atlas',
  role: '主体', reason: '本段讨论其研发中心', existing_item_id: null, observed_candidate_id: null,
  correction_reason: null, aliases: [], short_description: '宣布建设研发中心的公司。',
  new_information: 'Atlas 公司宣布建设研发中心。', certainty: 'clear',
  evidence: [{ segment_id: 's1', quote: 'Atlas 公司宣布建设研发中心' }], ...extra });
const parse = (items, value = input()) => parseKnowledgeV2(JSON.stringify({ items }), value);
const codes = rejected => rejected.issues.map(problem => problem.code);
const targetsFor = (items, value = input()) => buildRepairTargets(value, parse(items, value).rejected, 'job', 0);
const correction = (target, value) => ({ rejection_id: target.rejection_id, item: value });
const repair = (corrections, targets, value = input()) => parseKnowledgeRepair(JSON.stringify({ corrections }), value, targets);

test('v2.1 uses one classification source and accepts only compatible legacy types', () => {
  assert.equal(CONTRACT_REVISION, 'v2.1');
  for (const [display_label, type] of Object.entries(LABEL_TYPES)) {
    const derived = parse([item({ display_label })]);
    assert.equal(derived.items[0].type, type);
    assert.equal(derived.accepted[0].sourceIndex, 0);
    assert.equal(derived.normalized[0].code, 'TYPE_DERIVED');
    assert.equal(parse([item({ display_label, type })]).items[0].type, type);
    assert.equal(parse([item({ display_label, type: display_label })]).items[0].type, type);
  }
  for (const type of ['person', 'term', 'unknown', null]) {
    assert.ok(codes(parse([item({ type })]).rejected[0]).includes('TYPE_LABEL_CONFLICT'));
  }
  assert.ok(codes(parse([item({ display_label: 'unknown' })]).rejected[0]).includes('LABEL_INVALID'));
  assert.ok(codes(parse([item({ display_label: '__proto__' })]).rejected[0]).includes('LABEL_INVALID'));
});

test('independent field errors identify paths without returning the model payload in diagnostic text', () => {
  const result = parse([item({ action: 'update', existing_item_id: 'missing', role: '', reason: null,
    new_information: '', short_description: null, certainty: 'likely' })]);
  assert.equal(result.returnedCount, 1);
  assert.deepEqual(new Set(codes(result.rejected[0])), new Set([
    'ROLE_REQUIRED', 'REASON_REQUIRED', 'CERTAINTY_INVALID', 'TARGET_UNKNOWN',
    'DESCRIPTION_REQUIRED', 'NEW_INFORMATION_REQUIRED'
  ]));
  assert.equal(result.rejected[0].sourceIndex, 0);
  assert.ok(!result.rejected[0].reason.includes(source));
  assert.equal(result.rejected[0].rawItem.canonical_name, 'Atlas');
  assert.equal(result.rejected[0].anchor.kind, 'name');
});

test('rejected payload projects protocol fields so unknown credential-shaped keys cannot roll back accepted items', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'contract-payload-'));
  const store = new ListeningStore(path.join(dir, 'data.sqlite'));
  try {
    const run = store.createRun(null, { source: 'zh', targetLang: 'Chinese', audioSource: 'microphone' }, 'payload');
    const segment = store.addSegment(run.listeningId, run.runId, { id: 's1', text: source }).segment;
    const job = store.createExtractionJob(run.listeningId, [segment]);
    const value = store.jobInput(job);
    const valid = item({ evidence: [{ segment_id: segment.id, quote: 'Atlas 公司宣布建设研发中心' }] });
    const invalid = item({ canonical_name: 'Nova', role: { authorization: 'untrusted' }, reason: '',
      authorization: 'untrusted', api_key: 'untrusted', aliases: [{ secret: 'untrusted' }],
      evidence: [{ segment_id: segment.id, quote: 'Nova 公司是其合作伙伴', api_key: 'untrusted' },
        { segment_id: { secret: 'untrusted' }, quote: { access_token: 'untrusted' } }] });
    const parsed = parse([valid, invalid], value);
    const rejected = parsed.rejected[0];
    assert.equal(rejected.anchor.canonical_name, 'Nova');
    assert.ok(codes(rejected).includes('ROLE_REQUIRED'));
    assert.deepEqual(rejected.rawItem.role, { invalid_type: 'object' });
    assert.equal(rejected.rawItem.evidence[0].quote, 'Nova 公司是其合作伙伴');
    assert.ok(!JSON.stringify(rejected.rawItem).includes('untrusted'));
    store.initializeKnowledgeParts(job.id, [{ part_no: 0,
      focus_refs: [{ segment_id: segment.id, start: 0, end: source.length }] }]);
    store.saveKnowledgeCheckpoint(job.id, { part: { part_no: 0, phase: 'repair_pending',
      unresolved: buildRepairTargets(value, parsed.rejected, job.id, 0) } }, parsed.accepted);
    assert.equal(store.knowledge(run.listeningId).length, 1);
    const checkpoint = store.knowledgeCheckpoint(job.id).parts[0];
    assert.equal(checkpoint.results.length, 1);
    assert.equal(checkpoint.unresolved[0].anchor.canonical_name, 'Nova');
    assert.deepEqual(checkpoint.unresolved[0].rawItem.role, { invalid_type: 'object' });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('invalid targets remain errors and action is never silently changed', () => {
  const existing = { id: 'k1', canonical_name: 'Atlas', aliases: [], type: 'other', display_label: 'product' };
  const result = parse([item({ action: 'update', existing_item_id: 'k1' }), item({ action: 'repeat' })],
    input({ existing_candidates: [existing] }));
  assert.equal(result.items.length, 0);
  assert.ok(codes(result.rejected[0]).includes('TARGET_LABEL_MISMATCH'));
  assert.ok(codes(result.rejected[1]).includes('TARGET_REQUIRED'));
  assert.equal(result.rejected[0].rawItem.action, 'update');
});

test('evidence has precise 300/301 boundary; a valid citation preserves the item and reports bad citations', () => {
  const quote = 'Atlas' + 'x'.repeat(295);
  const value = input({ focus_segments: [{ id: 's1', text: `${quote}x` }] });
  assert.equal(parse([item({ evidence: [{ segment_id: 's1', quote }] })], value).items.length, 1);
  const invalid = parse([item({ evidence: [{ segment_id: 's1', quote: `${quote}x` }] })], value);
  const error = invalid.rejected[0].issues.find(e => e.code === 'QUOTE_TOO_LONG');
  assert.deepEqual(error.details, { length: 301, max: 300 });
  assert.equal(invalid.items.length, 0);
  const mixed = parse([item({ evidence: [
    { segment_id: 's1', quote: 'Atlas' }, { segment_id: 's1', quote: `${quote}x` },
    { segment_id: 'history', quote: 'Atlas' }, { segment_id: 's1', quote: 'rewrite' }
  ] })], value);
  assert.equal(mixed.items.length, 1);
  assert.equal(mixed.items[0].evidence.length, 1);
  assert.deepEqual(mixed.evidenceWarnings.map(w => w.code), ['QUOTE_TOO_LONG', 'SEGMENT_NOT_IN_FOCUS', 'QUOTE_NOT_VERBATIM']);
});

test('past-only names, semantic quotations and overlong names are not automatically salvaged', () => {
  const value = input({ focus_segments: [{ id: 's1', text: '它宣布新产品。' }], context_segments: [{ id: 'old', text: 'Atlas' }] });
  const result = parse([item({ evidence: [{ segment_id: 's1', quote: '它宣布新产品。' }] })], value);
  assert.ok(codes(result.rejected[0]).includes('NAME_NOT_IN_FOCUS'));
  assert.equal(result.rejected[0].anchor, null);
  assert.ok(codes(parse([item({ evidence: [{ segment_id: 's1', quote: 'Atlas 已建成研发中心' }] })]).rejected[0]).includes('QUOTE_NOT_VERBATIM'));
  assert.ok(codes(parse([item({ canonical_name: 'A'.repeat(121) })]).rejected[0]).includes('FIELD_TOO_LONG'));
});

test('repair targets keep original indexes and null identity anchors', () => {
  const result = parse([item(), item({ reason: '' }), item({ canonical_name: '', reason: '' })]);
  const targets = buildRepairTargets(input(), result.rejected, 'job', 2);
  assert.deepEqual(targets.map(t => t.rejection_id), ['job/2/1', 'job/2/2']);
  assert.equal(targets[0].anchor.canonical_name, 'Atlas');
  assert.equal(targets[1].anchor, null);
  assert.deepEqual(result.items, [result.accepted[0].item]);
});

test('repair resolves only rejected indexes, keeps omitted items, and rejects additional identities', () => {
  const targets = targetsFor([item({ reason: '' }), item({ canonical_name: 'Nova', reason: '' })]);
  const result = repair([correction(targets[0], item()), { rejection_id: 'unknown', item: item({ canonical_name: 'Nova' }) }], targets);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].sourceIndex, 0);
  assert.equal(result.accepted[0].rejection_id, 'job/0/0');
  assert.equal(result.rejected[0].sourceIndex, 1);
  assert.ok(codes(result.rejected[0]).includes('REPAIR_ITEM_MISSING'));
  assert.equal(result.protocolIssues[0].code, 'REPAIR_ID_UNKNOWN');
  assert.equal(repair([], targets).rejected.length, 2);
});

test('duplicate repair ID rejects the whole slot, even when one duplicate is valid', () => {
  const targets = targetsFor([item({ reason: '' })]);
  const result = repair([correction(targets[0], item()), correction(targets[0], item())], targets);
  assert.equal(result.items.length, 0);
  assert.ok(codes(result.rejected[0]).includes('REPAIR_ID_DUPLICATE'));
});

test('repair cannot replace an anchored company with another source-supported company', () => {
  const targets = targetsFor([item({ reason: '' })]);
  const result = repair([correction(targets[0], item({ canonical_name: 'Nova' }))], targets);
  assert.equal(result.items.length, 0);
  assert.ok(codes(result.rejected[0]).includes('REPAIR_IDENTITY_CHANGED'));
});

test('target anchor locks known identity, category and ID instead of falling back to create', () => {
  const known = { id: 'k1', canonical_name: 'Atlas', aliases: [], type: 'other', display_label: 'organization' };
  const value = input({ existing_candidates: [known, { ...known, id: 'k2' }] });
  const original = item({ action: 'update', existing_item_id: 'k1', reason: '' });
  const targets = targetsFor([original], value);
  assert.equal(targets[0].anchor.kind, 'target');
  for (const changed of [item(), item({ action: 'update', existing_item_id: 'k2' }),
    item({ action: 'observe', display_label: 'product' })]) {
    assert.ok(codes(repair([correction(targets[0], changed)], targets, value).rejected[0]).includes('REPAIR_IDENTITY_CHANGED'));
  }
  assert.equal(repair([correction(targets[0], { ...original, reason: '新增事实' })], targets, value).items.length, 1);
});

test('a single same-name candidate is insufficient to redirect a name anchor to an existing ID', () => {
  const targets = targetsFor([item({ action: 'update', existing_item_id: 'missing', reason: '' })]);
  const value = input({ existing_candidates: [{ id: 'k1', canonical_name: 'Atlas', aliases: [], type: 'other', display_label: 'organization' }] });
  const result = repair([correction(targets[0], item({ action: 'update', existing_item_id: 'k1' }))], targets, value);
  assert.ok(codes(result.rejected[0]).includes('REPAIR_IDENTITY_CHANGED'));
});

test('previously confirmed alias permits a name anchor to target its known object', () => {
  const value = input({ existing_candidates: [{ id: 'k1', canonical_name: 'Atlas Corporation', aliases: ['Atlas'], type: 'other', display_label: 'organization' }] });
  const targets = targetsFor([item({ action: 'update', existing_item_id: 'missing', reason: '' })], value);
  const result = repair([correction(targets[0], item({ action: 'update', existing_item_id: 'k1' }))], targets, value);
  assert.equal(result.items.length, 1);
});

test('repair exclusions are tracked separately and no identity anchor remains unresolved', () => {
  const targets = targetsFor([item({ reason: '' }), item({ canonical_name: '' })]);
  const result = repair([correction(targets[0], item({ action: 'exclude', short_description: null, new_information: null,
    reason: '仅为信息来源', evidence: [] })), correction(targets[1], item())], targets);
  assert.equal(result.repairExcluded, 1);
  assert.equal(result.rejected.length, 1);
  assert.ok(codes(result.rejected[0]).includes('REPAIR_IDENTITY_UNRESOLVED'));
});

test('valid empty extraction stays empty; malformed top-level protocols throw a bounded error', () => {
  assert.deepEqual(parse([]).items, []);
  for (const raw of ['not json', '{"corrections":{}}', JSON.stringify({ corrections: Array(13).fill({}) })]) {
    assert.throws(() => parseKnowledgeRepair(raw, input(), []), { code: 'KNOWLEDGE_INVALID_RESPONSE' });
  }
});

test('repair sends one request with a 15 second deadline and only eligible rejected entries', async t => {
  const targets = targetsFor([item({ reason: '' }), item({ canonical_name: '' })]);
  let calls = 0, timeout;
  t.mock.method(AbortSignal, 'timeout', value => { timeout = value; return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body), content = JSON.parse(body.messages[1].content);
    assert.equal(body.model, 'qwen3.8-flash');
    assert.equal(content.contract_revision, 'v2.1');
    assert.equal(content.rejected.length, 1);
    assert.equal(content.rejected[0].rejection_id, targets[0].rejection_id);
    assert.equal(content.rejected[0].item.reason, '');
    assert.equal(body.messages.length, 2);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ corrections: [correction(targets[0], item())] }) } }] }));
  });
  const result = await repairKnowledge('test-key', input(), 'https://model.invalid', targets);
  assert.equal(calls, 1); assert.equal(timeout, 15000);
  assert.equal(result.accepted.length, 1); assert.equal(result.rejected.length, 1);
  await repairKnowledge('test-key', input(), 'https://model.invalid', [targets[1]]);
  assert.equal(calls, 1);
});

test('repair surfaces HTTP retry metadata and never internally retries', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { 'retry-after': '2' } });
  });
  await assert.rejects(repairKnowledge('test-key', input(), 'https://model.invalid', targetsFor([item({ reason: '' })])),
    error => error.status === 429 && error.retryAfterMs === 2000);
  assert.equal(calls, 1);
});

test('prompt documents one classification, evidence limits and journalist-as-subject exception', () => {
  assert.match(SYSTEM_PROMPT_V2, /不输出旧字段 type/);
  assert.match(SYSTEM_PROMPT_V2, /300 字符/);
  assert.match(SYSTEM_PROMPT_V2, /不要按职业一律排除人物/);
  assert.match(SYSTEM_PROMPT_V2, /example-k1/);
});
