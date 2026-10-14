// Full local HTTP -> parser -> file SQLite fixture. Hand-authored model proposals
// exercise result contracts, never measure a real model's semantic quality.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { speechFixture } from './speech-fixture.mjs';
import { parseKnowledgeV2 } from '../knowledge.mjs';
import { buildRelationRequest } from '../relations.mjs';
import { relationWireEnvelope } from './relation-wire-fixture.mjs';

export const resultScenarios = [
  { name: 'shortage', title: '候选不足', nodes: 1, edges: 0, requests: 0, state: 'empty' },
  { name: 'empty', title: '正常空关系', nodes: 3, edges: 0, requests: 1, state: 'empty' },
  { name: 'filtered', title: '候选全部过滤', nodes: 3, edges: 0, requests: 1, state: 'empty' },
  { name: 'qualified', title: '否定与条件计划', nodes: 3, edges: 1, requests: 1, state: 'complete' },
  { name: 'partial', title: '输入覆盖受限', nodes: 3, edges: 0, requests: 1, state: 'partial' },
  { name: 'error', title: '失败保留既有图谱', nodes: 3, edges: 1, requests: 1, state: 'failed' }
];
const names = ['Atlas’s Lab', 'Nova', 'Independent'];
const qualifiedText = '😀 Atlas’s Lab did not develop Nova. If approved, Atlas’s Lab will develop Nova. Independent is mentioned separately.';
export const sourceHash = text => createHash('sha256').update(text).digest('hex');
export function resultOutput(wire, name) {
  if (name === 'error') return 'not JSON';
  if (['shortage', 'empty', 'partial'].includes(name)) return relationWireEnvelope(wire);
  const subject = wire.candidates.find(c => c.canonical_name === names[0]);
  const object = wire.candidates.find(c => c.canonical_name === names[1]);
  const evidence = wire.evidence.find(e => e.quote.includes('did not develop'));
  assert.ok(subject && object && evidence, 'Fixture must use actual request-scoped candidates/evidence');
  const row = { subject_item_id: subject.id, object_item_id: object.id, predicate: 'developed',
    polarity: 'negative', modality: 'asserted', status: 'active', evidence_ids: [evidence.id] };
  if (name === 'filtered') return relationWireEnvelope(wire, [{ ...row, evidence_ids: ['foreign-source'] }]);
  return relationWireEnvelope(wire, [row, { ...row, polarity: 'positive', modality: 'planned', conditions: 'If approved' }]);
}
export function seedResultListening(store, scenario) {
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, scenario.title);
  const text = `[fixture:${scenario.name}] ` + (scenario.name === 'shortage' ? 'Atlas’s Lab was mentioned.' : qualifiedText + (scenario.name === 'partial' ? ' x'.repeat(8000) : ''));
  const segment = store.addSegment(run.listeningId, run.runId, { id: 'source', text }).segment;
  store.setTranslation(segment.id, text);
  const extraction = store.createExtractionJob(run.listeningId, [segment]);
  const parsed = parseKnowledgeV2(JSON.stringify({ items: names.slice(0, scenario.nodes).map((name, i) => ({
    action: 'create', display_label: i === 0 ? 'organization' : 'product', canonical_name: name,
    role: '讨论主体', reason: '明确提及', existing_item_id: null, observed_candidate_id: null,
    correction_reason: null, aliases: [], certainty: 'clear', short_description: `${name} 是本段讨论的对象。`,
    new_information: `提及 ${name}。`, evidence: [{ segment_id: segment.id, quote: name }]
  })) }), store.jobInput(extraction));
  assert.equal(parsed.items.length, scenario.nodes, JSON.stringify(parsed.rejected));
  store.applyKnowledgeV2(run.listeningId, parsed.items); store.markJob(extraction.id, 'complete');
  let prior;
  if (scenario.name === 'error') {
    // This window already has one recorded successful request. Its subsequent
    // malformed response reaches the existing two-attempt protocol ceiling.
    store.enableRelations(run.listeningId);
    const job = store.beginRelationRequest(store.nextRelationJob(run.listeningId, { quietMs: 0 }).id);
    const request = buildRelationRequest(job.input), wire = JSON.parse(request.body.messages.at(-1).content);
    store.commitRelationJob(job.id, request.parse(JSON.stringify(resultOutput(wire, 'qualified'))));
    prior = JSON.parse(JSON.stringify(store.graph(run.listeningId)));
    assert.equal(prior.relations.length, 1);
    const next = store.addSegment(run.listeningId, run.runId, { id: 'later', text: 'Atlas’s Lab and Nova were mentioned again.' }).segment;
    store.setTranslation(next.id, next.original_text);
    const completed = store.createExtractionJob(run.listeningId, [next]);
    if (completed) store.markJob(completed.id, 'complete');
  }
  store.finishRun(run.runId);
  return { ...scenario, ...run, segment, prior };
}
export async function relationResultFixture() {
  const calls = [];
  const fixture = await speechFixture({ seed: store => resultScenarios.map(s => seedResultListening(store, s)),
    modelResponse(body, _stats, records) {
      if (body.model === 'qwen-mt-flash') return undefined;
      const wire = JSON.parse(body.messages.at(-1).content);
      assert.ok(wire.candidates, 'No unrelated extraction request is expected');
      const record = records.find(r => wire.evidence.some(s => s.quote.includes(`[fixture:${r.name}]`)));
      assert.ok(record, 'Every provider request must belong to one fixture listening');
      const output = resultOutput(wire, record.name);
      calls.push({ name: record.name, wire, output });
      return output;
    } });
  return { ...fixture, calls };
}
export async function readResult(fixture, record) {
  const response = await fetch(`${fixture.base}/api/listenings/${record.listeningId}/graph`);
  assert.equal(response.status, 200); return response.json();
}
export async function startResult(fixture, record) {
  const response = await fetch(`${fixture.base}/api/listenings/${record.listeningId}/graph`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'fixture-only' })
  });
  assert.equal(response.status, 202, await response.text());
}
export async function settledResult(fixture, record) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const graph = await readResult(fixture, record);
    if (graph.status.state === record.state && !graph.status.runningJobs && !graph.status.pendingJobs) return graph;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`${record.name} failed to settle: ${JSON.stringify(await readResult(fixture, record))}\n${fixture.logs()}`);
}
export function assertResult(fixture, record, graph) {
  assert.equal(graph.listeningId, record.listeningId);
  assert.equal(graph.nodes.length, record.nodes); assert.equal(graph.relations.length, record.edges);
  assert.equal(graph.status.state, record.state);
  assert.equal(fixture.calls.filter(call => call.name === record.name).length, record.requests);
  const d = graph.status.diagnostics;
  assert.equal(d.visibleRelationCount, record.edges); assert.equal(d.storedRelationCount, record.edges);
  if (record.name === 'qualified') {
    assert.equal(d.returnedCount, 2); assert.equal(d.validatorAcceptedCount, 2); assert.equal(d.acceptedCount, 2); assert.equal(d.rejectedCount, 0);
    assert.equal(graph.assertions.length, 2);
    assert.ok(graph.assertions.some(a => a.polarity === 'negative' && a.modality === 'asserted'));
    assert.ok(graph.assertions.some(a => a.modality === 'planned' && a.conditions === 'If approved'));
  }
  if (['empty', 'filtered', 'partial'].includes(record.name)) {
    assert.equal(d.returnedCount, record.name === 'filtered' ? 1 : 0);
    assert.equal(d.validatorAcceptedCount, 0); assert.equal(d.acceptedCount, 0);
    assert.equal(d.rejectedCount, record.name === 'filtered' ? 1 : 0);
  }
  for (const support of graph.supports) {
    assert.equal(support.segment_id, record.segment.id);
    assert.equal(support.source_revision, sourceHash(record.segment.original_text));
    assert.equal(record.segment.original_text.slice(support.start, support.end), support.quote, 'Persisted UTF-16 range must reproduce exact source');
  }
  if (record.name === 'error') {
    assert.deepEqual(graph.relations, record.prior.relations);
    assert.deepEqual(graph.assertions, record.prior.assertions);
    assert.deepEqual(graph.supports, record.prior.supports);
    assert.ok(d.failureReasons.length > 0);
  }
}
