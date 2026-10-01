// Synthetic model-shaped v3 JSON through the evidence-ID extractor, source validation,
// workflow, SQLite commit, diagnostics, and graph filtering. Stub transport only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListeningStore } from '../storage.mjs';
import { createRelationWorkflow } from '../relation-workflow.mjs';
import { extractRelations } from '../relations.mjs';
import { filterGraph } from '../public/knowledge-graph.js';
import { relationWireEnvelope, relationWireRow } from '../test-support/relation-wire-fixture.mjs';

const probes = [
  { label: 'baseline grounded edge', text: 'Atlas launched Nova.', accepted: 1 },
  { label: 'unrelated negation', text: 'Atlas launched Nova. Delta did not acquire Echo.', quote: 'Atlas launched Nova.', accepted: 1 },
  { label: 'unrelated future', text: 'Atlas launched Nova. Delta will acquire Echo.', quote: 'Atlas launched Nova.', accepted: 1 },
  { label: 'unrelated past', text: 'Atlas launched Nova. Delta acquired Echo in 2020.', quote: 'Atlas launched Nova.', accepted: 1 },
  { label: 'product introduction', text: 'Atlas introduced Nova.', accepted: 1 },
  { label: 'Chinese launch synonym', text: 'Atlas 上线了 Nova。', accepted: 1 },
  { label: 'server-generated exact offsets need no model character counts', text: 'Atlas launched Nova.', accepted: 1 },
  { label: 'unknown evidence span never guesses a replacement', text: 'Atlas launched Nova.', unknownEvidence: true, reason: 'EVIDENCE_ID_INVALID' },
  { label: 'omitted nullable qualifiers', text: 'Atlas launched Nova.', fields: { conditions: undefined, attribution: undefined, time_scope: undefined }, accepted: 1 },
  { label: 'true negation retained', text: 'Atlas did not launch Nova.', fields: { polarity: 'negative' }, accepted: 1 },
  { label: 'true plan retained', text: 'Atlas will launch Nova.', fields: { modality: 'planned' }, accepted: 1 },
  { label: 'repeated exact clauses have deterministic distinct evidence IDs', text: 'Atlas launched Nova. Atlas launched Nova.', quote: 'Atlas launched Nova.', repeatedEvidence: true, accepted: 1 },
  { label: 'mandatory polarity never guessed', text: 'Atlas launched Nova.', fields: { polarity: undefined }, reason: 'QUALIFICATION_INVALID' },
];
for (const probe of probes) test(`full relation pipeline: ${probe.label}`, async () => {
  const store = new ListeningStore(':memory:');
  try {
    const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Synthetic regression');
    const seg = store.addSegment(run.listeningId, run.runId, { id: 'source', text: probe.text }).segment;
    for (const [id, name, type] of [['atlas', 'Atlas', 'organization'], ['nova', 'Nova', 'product']]) {
      store.db.prepare("INSERT INTO knowledge_items(id,listening_id,type,display_label,canonical_name,normalized_name,dialogue_summary,certainty,created_at,updated_at) VALUES(?,?,'other',?,?,?,?,'clear',?,?)")
        .run(id, run.listeningId, type, name, name.toLowerCase(), name, new Date().toISOString(), new Date().toISOString());
      store.db.prepare('INSERT INTO knowledge_mentions(item_id,segment_id,surface_text) VALUES(?,?,?)').run(id, seg.id, name);
    }
    store.enableRelations(run.listeningId);
    let parsed, requests = 0;
    const workflow = createRelationWorkflow({ store, endpoint: 'mock://no-network', extract: async (key, input, endpoint, options) => {
      parsed = await extractRelations(key, input, endpoint, { ...options, fetchImpl: async (_url, req) => {
        requests++;
        const body = JSON.parse(req.body), wire = JSON.parse(body.messages[1].content);
        assert.equal(body.model, 'qwen3.8-flash'); assert.equal(body.enable_thinking, false);
        const proposal = { subject_item_id: wire.candidates.find(c => c.canonical_name === 'Atlas').id,
          object_item_id: wire.candidates.find(c => c.canonical_name === 'Nova').id,
          predicate: 'released', statement: 'Atlas 推出了 Nova', polarity: 'positive', modality: 'asserted',
          conditions: null, time_scope: null, attribution: null, status: 'active', correction_of: null,
          supports: [{ segment_id: wire.focus_segments[0].id, quote: probe.quote || probe.text, role: 'relation' }], ...(probe.fields || {}) };
        const row = relationWireRow(wire, proposal);
        if (probe.unknownEvidence) row.evidence_ids = ['evidence-not-in-this-request'];
        if (probe.repeatedEvidence) {
          assert.equal(wire.evidence[0].quote, probe.text, 'Whole segment retains repeated wording without ambiguity');
        }
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(relationWireEnvelope(wire, [row])) }, finish_reason: 'stop' }], usage: { total_tokens: 100 } }) };
      } });
      return parsed;
    } });
    await workflow.execute(store.nextRelationJob(run.listeningId, { quietMs: 0 }), 'synthetic-not-a-key');
    const graph = store.graph(run.listeningId), visible = filterGraph(graph.nodes, graph.relations), accepted = probe.accepted || 0;
    assert.equal(requests, 1); assert.equal(parsed.returnedCount, 1);
    assert.equal(parsed.relations.length, accepted, JSON.stringify(parsed.rejected));
    assert.equal(graph.relations.length, accepted); assert.equal(visible.relations.length, accepted);
    assert.equal(graph.status.diagnostics.returnedCount, 1); assert.equal(graph.status.diagnostics.acceptedCount, accepted);
    assert.equal(graph.status.diagnostics.rejectedCount, 1 - accepted);
    assert.equal(graph.status.diagnostics.insertedRelationCount, accepted);
    assert.equal(graph.status.diagnostics.visibleRelationCount, accepted);
    assert.equal(graph.status.progress.completedWindows, 1); assert.equal(graph.status.progress.remainingWindows, 0);
    assert.equal(store.nextRelationJob(run.listeningId, { quietMs: 0 }), null, 'no implicit replay even when all rows rejected');
    if (probe.reason) {
      assert.equal(parsed.rejected[0].code, probe.reason);
      assert.equal(graph.status.diagnostics.rejectionReasons[0].code, probe.reason);
      assert.equal(graph.status.state, 'empty');
    } else {
      const support = graph.relations[0].assertions[0].supports[0];
      assert.equal(probe.text.slice(support.start, support.end), support.quote);
      assert.equal(graph.status.state, 'complete');
    }
  } finally { store.close(); }
});
