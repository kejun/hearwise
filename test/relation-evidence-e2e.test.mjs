// Full synthetic pipeline, including the formerly skipped node extraction and
// mention-storage boundary. IDs alone are bound from a request; source wording,
// candidate names, proposed meanings and expected results live in an independent
// hand-authored corpus. This tests contract behavior, not live-model compliance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListeningStore } from '../storage.mjs';
import { parseKnowledgeV2 } from '../knowledge.mjs';
import { buildRelationRequest, extractRelations, RELATION_SYSTEM_PROMPT } from '../relations.mjs';
import { createRelationWorkflow } from '../relation-workflow.mjs';
import { filterGraph } from '../public/knowledge-graph.js';
import { relationEvidenceCorpus } from './fixtures/relation-evidence-corpus.mjs';

function seed(t, probe) {
  const store = new ListeningStore(':memory:');
  t.after(() => store.close());
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Synthetic evidence contract');
  const texts = probe.segments || [probe.text];
  const segments = texts.map((text, index) => store.addSegment(run.listeningId, run.runId, { id: `source-${index}`, text }).segment);
  if (probe.translation) store.setTranslation(segments.at(-1).id, probe.translation);
  const knowledgeJob = store.createExtractionJob(run.listeningId, segments);
  const input = store.jobInput(knowledgeJob);
  const nodes = [{ name: probe.subject || 'Atlas', label: 'organization', surface: probe.subjectSurface, aliases: probe.subjectAliases },
    { name: probe.object || 'Nova', label: 'product' }, ...(probe.extraCandidates || [])];
  const items = nodes.map(({ name, label, surface, aliases = [] }) => {
    const segment = segments.find(s => s.original_text.includes(surface || name)) || segments[0];
    return { action: 'create', display_label: label, canonical_name: name, role: '讨论主体', reason: '明确提及的具体对象',
      existing_item_id: null, observed_candidate_id: null, correction_reason: null, aliases, certainty: 'clear',
      short_description: `${name}是本段讨论的对象。`, new_information: `讲者提及${name}。`,
      evidence: [{ segment_id: segment.id, quote: segment.original_text }] };
  });
  const extracted = parseKnowledgeV2(JSON.stringify({ items }), input);
  assert.equal(extracted.items.length, nodes.length, `Upstream extraction failed: ${JSON.stringify(extracted.rejected)}`);
  store.applyKnowledgeV2(run.listeningId, extracted.items);
  const persisted = store.knowledge(run.listeningId);
  assert.equal(persisted.length, nodes.length, 'All fixture nodes must pass the real node parser and persistence path');
  for (const node of persisted) assert.ok(node.mentions.length, 'A real stored mention, not a hand-inserted node, must reach relation input');
  store.finishRun(run.runId);
  store.enableRelations(run.listeningId);
  return { store, id: run.listeningId, segments, persisted };
}

function outputFor(wire, probe) {
  assert.equal(wire.contract_version, 'relations-v3');
  assert.equal(typeof wire.evidence_version, 'string');
  assert.equal(wire.mentions, undefined, 'The model no longer fills redundant mention IDs');
  const envelope = relations => ({ contract_version: wire.contract_version, evidence_version: wire.evidence_version, relations });
  if (!probe.accepted) return envelope([]);
  const subject = wire.candidates.find(c => c.canonical_name === (probe.subject || 'Atlas') && c.display_label === 'organization');
  const object = wire.candidates.find(c => c.canonical_name === (probe.object || 'Nova') && c.display_label === 'product');
  const evidence = wire.evidence.find(e => e.quote.includes(probe.quote || probe.text));
  assert.ok(subject && object && evidence);
  return envelope([{ subject_item_id: subject.id, object_item_id: object.id, predicate: probe.predicate,
    polarity: 'positive', modality: 'asserted', status: probe.status || 'active', evidence_ids: [evidence.id],
    ...(probe.fields || {}) }]);
}

async function executeOne(h, probe, mutate = value => value) {
  let parsed, wire, sent, requests = 0;
  const workflow = createRelationWorkflow({ store: h.store, endpoint: 'mock://synthetic-evidence-only',
    extract: (key, input, endpoint, options) => extractRelations(key, input, endpoint, { ...options, fetchImpl: async (_url, req) => {
      requests++;
      const body = JSON.parse(req.body);
      assert.equal(body.model, 'qwen3.8-flash');
      assert.equal(body.enable_thinking, false);
      wire = JSON.parse(body.messages[1].content);
      sent = mutate(outputFor(wire, probe), wire);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(sent) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) };
    } }).then(result => { parsed = result; return result; }) });
  const job = h.store.nextRelationJob(h.id, { quietMs: 0 });
  assert.ok(job, 'The real relation scheduler must produce a runnable job');
  const outcome = await workflow.execute(job, 'synthetic-not-a-key');
  assert.equal(requests, 1, 'No synthetic fixture may implicitly retry a completed response');
  assert.ok(parsed, `Response did not reach row validation: ${JSON.stringify(outcome)}`);
  return { parsed, wire, sent, job, outcome, graph: h.store.graph(h.id) };
}

for (const probe of relationEvidenceCorpus) test(`evidence contract end-to-end: ${probe.name}`, async t => {
  const h = seed(t, probe);
  const { parsed, wire, graph } = await executeOne(h, probe);
  assert.equal(parsed.returnedCount, probe.accepted);
  assert.equal(parsed.relations.length, probe.accepted, JSON.stringify(parsed.rejected));
  assert.equal(graph.relations.length, probe.accepted);
  assert.equal(filterGraph(graph.nodes, graph.relations).relations.length, probe.accepted);
  const d = graph.status.diagnostics;
  assert.equal(d.returnedCount, probe.accepted); assert.equal(d.validatorAcceptedCount, probe.accepted);
  assert.equal(d.acceptedCount, probe.accepted); assert.equal(d.rejectedCount, 0);
  assert.equal(d.insertedRelationCount, probe.accepted); assert.equal(d.storedRelationCount, probe.accepted);
  assert.equal(d.visibleRelationCount, probe.accepted);
  assert.equal(graph.status.progress.completedWindows, 1);
  assert.equal(graph.status.progress.remainingWindows, 0);
  assert.equal(h.store.nextRelationJob(h.id, { quietMs: 0 }), null, 'Terminal results must not silently create another paid request');
  if (probe.accepted) {
    const edge = graph.relations[0], assertion = edge.assertions[0];
    assert.equal(graph.nodes.find(n => n.id === edge.subject_item_id).canonical_name, probe.subject || 'Atlas');
    assert.equal(graph.nodes.find(n => n.id === edge.object_item_id).canonical_name, probe.object || 'Nova');
    assert.equal(edge.predicate, probe.predicate);
    for (const [key, value] of Object.entries(probe.fields || {})) assert.equal(assertion[key], value);
    if (probe.status) assert.equal(assertion.status, probe.status);
    for (const support of assertion.supports) {
      const source = h.segments.find(s => s.id === support.segment_id);
      assert.ok(source, 'Every persisted support must name an actual source segment');
      assert.equal(source.original_text.slice(support.start, support.end), support.quote);
    }

  } else {
    assert.equal(graph.status.state, 'empty');
    assert.equal(graph.assertions.length, 0, 'An invalid relation must not be stored as a hidden assertion');
  }
});

const baseline = relationEvidenceCorpus[0];
const malformedRows = [
  ['unknown evidence ID', row => { row.evidence_ids = ['e-does-not-exist']; }],
  ['empty evidence list', row => { row.evidence_ids = []; }],
  ['evidence IDs are not an array', row => { row.evidence_ids = 'e0'; }],
  ['unknown endpoint', row => { row.subject_item_id = 'n-does-not-exist'; }],
  ['identical endpoints', row => { row.object_item_id = row.subject_item_id; }],
  ['unknown predicate', row => { row.predicate = 'related_to'; }],
  ['missing polarity', row => { delete row.polarity; }],
  ['legacy quote payload cannot replace evidence selectors', row => {
    delete row.evidence_ids; delete row.subject_mention_id; delete row.object_mention_id;
    row.supports = [{ segment_id: 's0', role: 'relation', quote: 'Atlas developed Nova.' }];
  }],
];
for (const [name, corrupt] of malformedRows) test(`evidence contract rejects malformed row: ${name}`, async t => {
  const h = seed(t, baseline);
  const { parsed, graph } = await executeOne(h, baseline, value => { corrupt(value.relations[0]); return value; });
  assert.equal(parsed.returnedCount, 1); assert.equal(parsed.relations.length, 0);
  assert.equal(parsed.rejected.length, 1); assert.equal(graph.relations.length, 0);
  assert.equal(graph.status.diagnostics.acceptedCount, 0);
});

test('evidence contract keeps valid rows when an independent row is invalid', async t => {
  const h = seed(t, baseline);
  const { parsed, graph } = await executeOne(h, baseline, value => {
    value.relations.push({ ...value.relations[0], evidence_ids: ['foreign-evidence'] });
    return value;
  });
  assert.equal(parsed.returnedCount, 2); assert.equal(parsed.relations.length, 1); assert.equal(parsed.rejected.length, 1);
  assert.equal(graph.relations.length, 1); assert.equal(graph.status.diagnostics.returnedCount, 2);
  assert.equal(graph.status.diagnostics.acceptedCount, 1); assert.equal(graph.status.diagnostics.rejectedCount, 1);
});

test('evidence snapshot/version mismatch cannot write relations', t => {
  const h = seed(t, baseline), job = h.store.nextRelationJob(h.id, { quietMs: 0 });
  const request = buildRelationRequest(job.input), wire = JSON.parse(request.body.messages[1].content);
  const proposal = outputFor(wire, baseline);
  for (const field of ['contract_version', 'evidence_version']) {
    const malformed = { ...proposal, [field]: 'foreign-request' };
    assert.throws(() => request.parse(JSON.stringify(malformed)), { code: 'RELATION_INVALID_RESPONSE' });
  }
  assert.equal(h.store.graph(h.id).relations.length, 0);
});

test('same-name node collision stays distinct and cannot manufacture an identity mention', async t => {
  const probe = { ...baseline, extraCandidates: [{ name: 'Atlas', label: 'person' }], expectedUnanchored: true };
  const h = seed(t, probe);
  assert.equal(h.persisted.filter(n => n.canonical_name === 'Atlas').length, 2);
  const { parsed, wire, graph } = await executeOne(h, probe);
  assert.equal(parsed.relations.length, 0); assert.equal(graph.relations.length, 0);
  assert.equal(graph.nodes.filter(n => n.canonical_name === 'Atlas').length, 2);
});

test('context-only fact cannot be repeated as a new focus relation', async t => {
  const probe = { ...baseline, segments: ['Background one.', 'Background two.', 'Background three.',
    'Atlas developed Nova.', 'Background five.', 'Background six.', 'We are changing the topic.'] };
  const h = seed(t, probe);
  const first = await executeOne(h, probe, value => ({ ...value, relations: [] }));
  assert.equal(first.parsed.returnedCount, 0);
  const second = await executeOne(h, probe);
  const selected = second.sent.relations[0].evidence_ids;
  assert.ok(selected.every(id => second.wire.evidence.find(e => e.id === id).scope === 'context'));
  assert.equal(second.parsed.relations.length, 0);
  assert.equal(second.graph.relations.length, 0);
  assert.equal(second.graph.status.progress.completedWindows, 2);
  assert.equal(h.store.nextRelationJob(h.id, { quietMs: 0 }), null);
});

test('repeated source wording uses one exact server-owned segment with no ambiguous character counts', async t => {
  const probe = { ...baseline, text: '😀Atlas developed Nova. Atlas developed Nova.', quote: 'Atlas developed Nova.' };
  const h = seed(t, probe), { parsed, graph } = await executeOne(h, probe);
  assert.equal(parsed.relations.length, 1);
  const support = graph.relations[0].assertions[0].supports[0];
  assert.equal(support.quote, probe.text); assert.equal(support.start, 0); assert.equal(support.end, probe.text.length);
});

test('model statement cannot inject displayed facts beyond validated canonical fields', async t => {
  const h = seed(t, baseline);
  const injected = 'Atlas did not develop Nova; Atlas acquired Nova for $999 million. UNGROUNDED_EXTRA_CLAIM';
  const { parsed, graph } = await executeOne(h, baseline, value => {
    value.relations[0].statement = injected;
    return value;
  });
  assert.equal(parsed.relations.length, 1, JSON.stringify(parsed.rejected));
  const statement = graph.relations[0].assertions[0].statement;
  assert.match(statement, /Atlas.*(?:开发|研发).*Nova/u);
  assert.doesNotMatch(statement, /UNGROUNDED_EXTRA_CLAIM|999|acquired|did not|没有|未/u);
  assert.equal(graph.relations[0].assertions[0].polarity, 'positive');
  assert.ok(!JSON.stringify(graph.relations).includes(injected));
});

test('model need not invent a duplicate display statement for grounded fields', async t => {
  const h = seed(t, baseline);
  const { parsed, graph } = await executeOne(h, baseline, value => {
    delete value.relations[0].statement;
    return value;
  });
  assert.equal(parsed.relations.length, 1, JSON.stringify(parsed.rejected));
  assert.match(graph.relations[0].assertions[0].statement, /Atlas.*(?:开发|研发).*Nova/u);
});
