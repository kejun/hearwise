import { speechFixture } from './speech-fixture.mjs';
import { relationWireEnvelope, relationWireRow } from './relation-wire-fixture.mjs';

// Deterministic archived transcript; relation evidence is deliberately beyond page 1.
export function seedGraphListening(store, { title = '柯达相机的故事', extraNodes = 9 } = {}) {
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, title);
  const segments = [];
  for (let i = 1; i <= 103; i++) segments.push(store.addSegment(run.listeningId, run.runId,
    { id: String(i), text: `Transcript background sentence ${i}.` }).segment);
  const evidence = store.addSegment(run.listeningId, run.runId,
    { id: 'evidence', text: 'Eastman Kodak released the Brownie camera in 1900.' }).segment;
  store.setTranslation(evidence.id, '伊士曼柯达公司于 1900 年推出了 Brownie 相机。', false);
  const names = ['Eastman Kodak', 'Brownie camera', ...Array.from({ length: extraNodes }, (_, i) => `Independent concept ${i + 1}`)];
  const types = ['other', 'term', 'person', 'term', 'event'];
  for (const [i, name] of names.entries()) {
    const segment = i < 2 ? evidence : store.addSegment(run.listeningId, run.runId,
      { id: `node-${i}`, text: `${name} is mentioned independently.` }).segment;
    const description = i === 0 ? '对话介绍的相机制造公司，推出了面向大众的 Brownie 相机。' :
      i === 1 ? '对话提到的早期大众相机，由柯达公司推出。' : `对话中的独立知识条目 ${i - 1}，尚无明确关系。`;
    store.applyKnowledge(run.listeningId, [{ type: types[i % types.length], canonical_name: name,
      aliases: i === 0 ? ['Kodak'] : [], dialogue_summary: description, background_note: null,
      certainty: 'clear', decision: 'create', existing_item_id: null, correction_reason: null,
      evidence: [{ segment_id: segment.id, quote: name }] }]);
  }
  // Prevent archived knowledge extraction from being resumed accidentally by unrelated tests.
  const all = store.detail(run.listeningId, 1, 200).segments;
  for (const segment of all) if (segment.translation_state !== 'complete') store.setTranslation(segment.id, segment.original_text, false);
  const job = store.createExtractionJob(run.listeningId, all);
  if (job) store.markJob(job.id, 'complete');
  store.finishRun(run.runId);
  const nodes = store.knowledge(run.listeningId);
  return { ...run, nodes, evidence };
}

export async function graphFixture({ modelResponse, ...options } = {}) {
  return speechFixture({ ...options,
    seed: store => ({ first: seedGraphListening(store), second: seedGraphListening(store, { title: '另一段收听', extraNodes: 0 }) }),
    modelResponse: modelResponse || ((body) => {
      if (body.model === 'qwen-mt-flash') return undefined;
      const input = JSON.parse(body.messages.at(-1).content);
      if (!input.candidates) return { items: [] };
      const subject = input.candidates.find(item => item.canonical_name === 'Eastman Kodak');
      const object = input.candidates.find(item => item.canonical_name === 'Brownie camera');
      const segment = input.focus_segments.find(item => item.text.includes('Eastman Kodak released'));
      if (!subject || !object || !segment) return relationWireEnvelope(input);
      return relationWireEnvelope(input, [relationWireRow(input, { subject_item_id: subject.id, object_item_id: object.id, predicate: 'released',
        statement: 'Eastman Kodak released the Brownie camera in 1900.', polarity: 'positive', modality: 'asserted',
        conditions: null, time_scope: '1900', attribution: null, status: 'active', correction_of: null,
        supports: [{ segment_id: segment.id, quote: segment.text, role: 'relation' }] })]);
    }) });
}
