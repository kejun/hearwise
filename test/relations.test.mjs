import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { relationWireEnvelope, relationWireRow, relationSource } from '../test-support/relation-wire-fixture.mjs';
import { buildRelationInput, buildRelationRequest, canonicalizeRelation, extractRelations,
  RELATION_SYSTEM_PROMPT, RELATION_MODEL } from '../relations.mjs';
const hash = t => createHash('sha256').update(t).digest('hex');
const segment = (id, text, translation = null) => ({ id, text, source_revision: hash(text), translation,
  translation_revision: translation ? hash(translation) : null });
const candidate = (id, name, extra = {}) => ({ id, listening_id: 'listening', canonical_name: name, aliases: [], content_version: 1, ...extra });
const inputFor = (text = 'Atlas launched Nova.', extra = {}) => ({ listening_id: 'listening', window_id: 'w1', window_revision: 1,
  focus_segments: [segment('s1', text)], context_segments: [], candidates: [candidate('a', 'Atlas'), candidate('b', 'Nova')], ...extra });
const relation = (text = 'Atlas launched Nova.', extra = {}) => ({ subject_item_id: 'a', object_item_id: 'b', predicate: 'released',
  statement: 'Atlas 推出了 Nova', polarity: 'positive', modality: 'asserted', conditions: null, time_scope: null,
  attribution: null, status: 'active', correction_of: null, supports: [{ segment_id: 's1', quote: text, role: 'relation' }], ...extra });

test('mocked HTTP uses existing model and endpoint and captures only numeric usage', async () => {
  let request;
  const result = await extractRelations('test-key', inputFor(), 'https://local.test/chat', { fetchImpl: async (url, options) => {
    request = { url, ...options };
    const wire = JSON.parse(JSON.parse(options.body).messages[1].content);
    const row = relation(undefined, { subject_item_id: wire.candidates[0].id, object_item_id: wire.candidates[1].id, supports: [{ segment_id: wire.focus_segments[0].id, quote: relationSource(wire, wire.focus_segments[0].id), role: 'relation' }] });
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(relationWireEnvelope(wire, [relationWireRow(wire, row)])) } }],
      usage: { prompt_tokens: 44, completion_tokens: 12, total_tokens: 56, hidden: 'omit' } }) };
  } });
  assert.equal(request.url, 'https://local.test/chat');
  assert.equal(JSON.parse(request.body).model, RELATION_MODEL);
  assert.equal(JSON.parse(request.body).enable_thinking, false);
  assert.equal(JSON.parse(request.body).max_completion_tokens, 6000);
  assert.deepEqual(JSON.parse(request.body).response_format, { type: 'json_object' });
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].subject_item_id, 'a');
  assert.deepEqual(result.usage, { prompt_tokens: 44, completion_tokens: 12, total_tokens: 56 });
});
test('mocked HTTP Retry-After errors never echo response secrets', async () => {
  await assert.rejects(extractRelations('key', inputFor(), 'mock', { fetchImpl: async () => ({ ok: false, status: 429,
    headers: { get: () => '7' }, json: async () => ({ error: { message: 'private transcript/key' } }) }) }), error => {
    assert.equal(error.retryAfterMs, 7000); assert.ok(!error.message.includes('private')); return true;
  });
});
test('paid usage is available on invalid model JSON and only numeric token fields survive', async () => {
  const reported = [];
  await assert.rejects(extractRelations('key', inputFor(), 'mock', {
    onUsage: usage => reported.push(usage), fetchImpl: async () => ({ ok: true, json: async () => ({
      choices: [{ message: { content: '{invalid' } }], usage: { total_tokens: 123, prompt_tokens: 100, completion_tokens: 23, secret: 'omit' }
    }) })
  }), error => {
    assert.equal(error.code, 'RELATION_INVALID_RESPONSE'); assert.equal(error.usage.total_tokens, 123); return true;
  });
  assert.deepEqual(reported, [{ prompt_tokens: 100, completion_tokens: 23, total_tokens: 123 }]);
});
test('cancelled fetch which ignores abort still reports late usage without returning a graph', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; }), reported = [], controller = new AbortController();
  const request = extractRelations('key', inputFor(), 'mock', { signal: controller.signal,
    onUsage: usage => reported.push(usage), fetchImpl: () => pending });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"relations":[]}' } }], usage: { total_tokens: 55 } }) });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(reported, [{ total_tokens: 55 }]);
});
test('request deadline also bounds a stalled response body which ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const request = extractRelations('key', inputFor(), 'mock', { requestTimeoutMs: 30,
    fetchImpl: async () => ({ ok: true, json: () => pending }) });
  const rejected = assert.rejects(request, { name: 'TimeoutError' });
  await Promise.resolve();
  t.mock.timers.tick(30);
  await rejected;
  resolve({ choices: [{ message: { content: '{"relations":[]}' } }] });
});

test('short wire IDs preserve all source, translation, identity, qualifiers and authoritative revisions', () => {
  const input = inputFor('Atlas did not launch Nova.', {
    candidates: [candidate('node-very-long-atlas-uuid', 'Atlas', { aliases: ['阿特拉斯'] }), candidate('node-very-long-nova-uuid', 'Nova')],
    focus_segments: [segment('segment-very-long-uuid', 'Atlas did not launch Nova.', 'Atlas 未推出 Nova。')],
    existing_assertions: [{ id: 'assert-long-uuid', subject_item_id: 'node-very-long-atlas-uuid', object_item_id: 'node-very-long-nova-uuid',
      predicate: 'released', statement: 'Atlas launched Nova.', polarity: 'positive', modality: 'asserted', conditions: null, time_scope: null, attribution: null }]
  });
  const request = buildRelationRequest(input), wire = JSON.parse(request.body.messages[1].content);
  assert.equal(relationSource(wire, wire.focus_segments[0].id), input.focus_segments[0].text);
  assert.equal(wire.focus_segments[0].translation, input.focus_segments[0].translation);
  assert.deepEqual(wire.candidates[0].aliases, ['阿特拉斯']);
  assert.equal(wire.existing_assertions[0].subject_item_id, wire.candidates[0].id);
  assert.doesNotMatch(request.body.messages[1].content, /uuid|source_revision|translation_revision|listening_id|window_revision|input_fingerprint/);
  assert.equal(wire.contract_version, 'relations-v3');
  assert.ok(wire.evidence_version);
  assert.ok(wire.evidence.length > 0); assert.equal(wire.mentions, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(request.body)) <= 90000);
  const row = relation(input.focus_segments[0].text, { subject_item_id: wire.candidates[0].id, object_item_id: wire.candidates[1].id,
    polarity: 'negative', supports: [{ segment_id: wire.focus_segments[0].id, quote: input.focus_segments[0].text, role: 'relation' }] });
  const parsed = request.parse(JSON.stringify(relationWireEnvelope(wire, [relationWireRow(wire, row)])));
  assert.equal(parsed.rejected.length, 0); assert.equal(parsed.relations[0].polarity, 'negative');
  assert.equal(parsed.relations[0].subject_item_id, input.candidates[0].id);
  assert.equal(parsed.relations[0].supports[0].segment_id, input.focus_segments[0].id);
  assert.equal(parsed.relations[0].supports[0].source_revision, input.focus_segments[0].source_revision);
  const escaped = { ...relationWireRow(wire, row), subject_item_id: input.candidates[0].id };
  assert.equal(request.parse(JSON.stringify(relationWireEnvelope(wire, [escaped]))).rejected[0].code, 'ENDPOINT_INVALID');
});
test('short wire projection cannot hide cross-listening or needs-review endpoints', () => {
  for (const extra of [{ listening_id: 'other' }, { certainty: 'needs_review' }]) {
    const request = buildRelationRequest(inputFor(undefined, { candidates: [candidate('a', 'Atlas', extra), candidate('b', 'Nova')] }));
    const wire = JSON.parse(request.body.messages[1].content);
    const row = relation(undefined, { subject_item_id: wire.candidates[0].id, object_item_id: wire.candidates[1].id,
      supports: [{ segment_id: wire.focus_segments[0].id, quote: relationSource(wire, wire.focus_segments[0].id), role: 'relation' }] });
    const parsed = request.parse(JSON.stringify(relationWireEnvelope(wire, [relationWireRow(wire, row)])));
    if (extra.listening_id) assert.equal(parsed.rejected[0].code, 'ENDPOINT_LISTENING_MISMATCH');
    else assert.equal(parsed.relations[0].status, 'needs_review');
  }
});
test('output-limit responses retain paid usage and are never accepted as complete JSON', async () => {
  await assert.rejects(extractRelations('key', inputFor(), 'mock', { fetchImpl: async () => ({ ok: true, json: async () => ({
    choices: [{ finish_reason: 'length', message: { content: '{"relations":[]}' } }], usage: { total_tokens: 6001 }
  }) }) }), error => error.code === 'RELATION_OUTPUT_LIMIT' && error.usage.total_tokens === 6001);
});
test('wire projection keeps durable full-source hashes when the saved prompt was bounded', () => {
  const input = inputFor();
  input.focus_segments[0].source_revision = hash('Atlas launched Nova. Additional long original source.');
  const request = buildRelationRequest(input), wire = JSON.parse(request.body.messages[1].content);
  const row = relation(undefined, { subject_item_id: wire.candidates[0].id, object_item_id: wire.candidates[1].id,
    supports: [{ segment_id: wire.focus_segments[0].id, quote: relationSource(wire, wire.focus_segments[0].id), role: 'relation' }] });
  const result = request.parse(JSON.stringify(relationWireEnvelope(wire, [relationWireRow(wire, row)])));
  assert.equal(result.rejected.length, 0);
  assert.equal(result.relations[0].supports[0].source_revision, input.focus_segments[0].source_revision);
});

function decode(text, fields = {}, extra = {}) {
  const request = buildRelationRequest(inputFor(text, extra)), wire = JSON.parse(request.body.messages[1].content);
  const row = { subject_item_id: 'n0', object_item_id: 'n1', predicate: 'released', polarity: 'positive',
    modality: 'asserted', status: 'active', evidence_ids: wire.evidence.map(e => e.id), ...fields };
  return { request, wire, row, parsed: request.parse(JSON.stringify(relationWireEnvelope(wire, [row]))) };
}

test('normalizes protocol tokens and source qualifiers without altering evidence or identities', () => {
  const text = 'According to Mira, ＡＴＬＡＳ will launch Nova.';
  const { parsed } = decode(text, { subject_item_id: ' N0 ', object_item_id: 'N1', predicate: ' RELEASED ',
    polarity: 'POSITIVE', modality: ' Planned ', status: 'ACTIVE', evidence_ids: [' E0 '], attribution: 'according TO mira' });
  assert.deepEqual(parsed.rejected, []);
  const row = parsed.relations[0];
  assert.equal(row.subject_item_id, 'a'); assert.equal(row.modality, 'planned');
  assert.equal(row.attribution, 'According to Mira'); assert.equal(row.supports[0].quote, text);
  assert.equal(row.supports[0].source_revision, hash(text));
});

test('semantic synonyms, languages and clear cross-sentence references need no lexical or mention-ID proof', () => {
  for (const text of ['Atlas shipped Nova.', 'Atlas が Nova を発売した。', 'Atlas is a company. It launched Nova.',
    'Atlas, whose founder is Delta, released Nova.', 'Atlas launched Nova. Delta did not acquire Echo.']) {
    const { parsed } = decode(text);
    assert.deepEqual(parsed.rejected, [], text); assert.equal(parsed.relations[0].status, 'active');
  }
});

test('context identity evidence is retained when the semantic model resolves a reference', () => {
  const { parsed } = decode('It launched Nova.', {}, { context_segments: [segment('c1', 'Atlas is a company.')] });
  assert.equal(parsed.relations.length, 1, JSON.stringify(parsed));
  assert.equal(parsed.relations[0].supports.length, 2);
});

test('empty model decision is a valid completed result, with no required explanation or edge', () => {
  const { request, wire } = decode('Atlas and Nova were mentioned.');
  assert.deepEqual(request.parse(JSON.stringify(relationWireEnvelope(wire))), { relations: [], rejected: [], returnedCount: 0 });
});

test('decoder preserves explicit negation, plans, attribution, conditions and model uncertainty', () => {
  const { parsed } = decode('According to Mira, if approved, Atlas will not launch Nova in 2027.', {
    polarity: 'negative', modality: 'planned', status: 'needs_review', conditions: 'if approved',
    attribution: 'According to Mira', time_scope: 'in 2027' });
  assert.deepEqual(parsed.rejected, []);
  const row = parsed.relations[0]; assert.equal(row.polarity, 'negative'); assert.equal(row.modality, 'planned');
  assert.equal(row.status, 'needs_review'); assert.equal(row.conditions, 'if approved'); assert.equal(row.time_scope, 'in 2027');
});

test('server never invents missing qualifiers, endpoints, evidence or relations from co-occurrence', () => {
  for (const [fields, code] of [
    [{ polarity: undefined }, 'QUALIFICATION_INVALID'], [{ predicate: 'related_to' }, 'PREDICATE_INVALID'],
    [{ subject_item_id: 'Atlas' }, 'ENDPOINT_INVALID'], [{ object_item_id: 'n0' }, 'ENDPOINT_INVALID'],
    [{ evidence_ids: ['e99'] }, 'EVIDENCE_ID_INVALID'], [{ evidence_ids: [] }, 'SUPPORT_COUNT_INVALID'],
    [{ conditions: 'if funded' }, 'QUALIFIER_NOT_IN_SOURCE']
  ]) {
    const { parsed } = decode('Atlas launched Nova.', fields);
    assert.equal(parsed.relations.length, 0); assert.equal(parsed.rejected[0].code, code);
  }
  const { parsed } = decode('Another Team launched Nova.');
  assert.equal(parsed.rejected[0].code, 'IDENTITY_REFERENCE_UNANCHORED');
});

test('protocol failures remain distinct from filtered candidate rows', () => {
  const { request, wire, row } = decode('Atlas launched Nova.');
  for (const raw of ['{invalid', '[]', JSON.stringify({ ...relationWireEnvelope(wire), evidence_version: 'old' }),
    JSON.stringify({ ...relationWireEnvelope(wire), contract_version: 'relations-v2' }),
    JSON.stringify(relationWireEnvelope(wire, Array(25).fill(row))), 'x'.repeat(50001)]) {
    assert.throws(() => request.parse(raw), { code: 'RELATION_INVALID_RESPONSE' });
  }
  const result = request.parse(JSON.stringify(relationWireEnvelope(wire, [row, { ...row, evidence_ids: ['unknown'] }])));
  assert.equal(result.relations.length, 1); assert.equal(result.rejected.length, 1);
});

test('explicit corrections are same-relation scoped and require source wording', () => {
  const extra = { existing_assertions: [{ id: 'prior', subject_item_id: 'a', object_item_id: 'b', predicate: 'released', statement: 'old' }] };
  assert.equal(decode('Correction: Atlas did not launch Nova.', { polarity: 'negative', correction_of: 'a0' }, extra).parsed.relations[0].correction_of, 'prior');
  assert.equal(decode('Atlas did not launch Nova.', { polarity: 'negative', correction_of: 'a0' }, extra).parsed.rejected[0].code, 'CORRECTION_NOT_EXPLICIT');
  assert.equal(decode('Correction: Atlas developed Nova.', { predicate: 'developed', correction_of: 'a0' }, extra).parsed.rejected[0].code, 'CORRECTION_TARGET_MISMATCH');
  assert.deepEqual(canonicalizeRelation('b', 'a', ' RELEASED_BY '), { subject_item_id: 'a', object_item_id: 'b', predicate: 'released' });
});

test('source budgets reject before dispatch and prompt excludes node background as evidence', () => {
  assert.throws(() => buildRelationInput(inputFor('a'.repeat(14001))), { code: 'RELATION_INVALID_RESPONSE' });
  const input = inputFor(undefined, { candidates: [candidate('a', 'Atlas', { short_description: 'PRIVATE BACKGROUND' }), candidate('b', 'Nova')] });
  assert.ok(!JSON.stringify(buildRelationRequest(input).body).includes('PRIVATE BACKGROUND'));
});
