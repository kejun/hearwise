import { randomUUID } from 'node:crypto';

export function seedNameReplacement(store, { graph = false } = {}) {
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, '名称纠正测试');
  const segment = store.addSegment(run.listeningId, run.runId, { id: 'first',
    text: 'Deebo released Camera. Camera belongs to Deebo. Deeboverse is unrelated.' }).segment;
  const other = store.addSegment(run.listeningId, run.runId, { id: 'unlinked', text: 'Deebo was mentioned elsewhere.' }).segment;
  for (const row of [segment, other]) store.setTranslation(row.id, '介绍了相机。', false);
  const [item, camera] = store.applyKnowledge(run.listeningId, ['Deebo', 'Camera'].map(name => ({
    type: name === 'Deebo' ? 'person' : 'term', canonical_name: name, aliases: name === 'Deebo' ? ['DEEBO', 'D-man'] : [],
    dialogue_summary: `${name} appeared with Deebo.`, background_note: null, certainty: 'clear', decision: 'create',
    existing_item_id: null, correction_reason: null, evidence: [{ segment_id: segment.id, quote: segment.original_text }]
  })));
  const factId = randomUUID();
  store.db.prepare('INSERT INTO knowledge_facts VALUES (?,?,?,?,?,?,?)')
    .run(factId, item.id, segment.id, segment.original_text, 'Deebo released Camera.', 'clear', new Date().toISOString());
  const extraction = store.createExtractionJob(run.listeningId, [segment, other]);
  store.markJob(extraction.id, 'complete');
  if (graph) {
    store.enableRelations(run.listeningId);
    const job = store.beginRelationRequest(store.nextRelationJob(run.listeningId, { quietMs: 0 }).id);
    const row = job.input.focus_segments.find(row => row.id === segment.id);
    const anchors = [[0, row.text.length, 'relation'], [0, 5, 'subject_reference'],
      [row.text.indexOf('Camera'), row.text.indexOf('Camera') + 6, 'object_reference'],
      [row.text.lastIndexOf('Deebo.'), row.text.lastIndexOf('Deebo.') + 5, 'subject_reference']];
    const result = store.commitRelationJob(job.id, { relations: [{ subject_item_id: item.id, object_item_id: camera.id,
      predicate: 'released', statement: 'Deebo released Camera.', polarity: 'positive', modality: 'asserted',
      conditions: null, time_scope: null, attribution: null, correction_of: null, status: 'active',
      supports: anchors.map(([start, end, role]) => ({ segment_id: row.id, source_revision: row.source_revision,
        start, end, quote: row.text.slice(start, end), role })) }] });
    if (result.state !== 'complete' || result.accepted !== 1) throw new Error(JSON.stringify(result.rejected));
  }
  store.finishRun(run.runId);
  return { ...run, item, camera, segment, other, factId };
}
