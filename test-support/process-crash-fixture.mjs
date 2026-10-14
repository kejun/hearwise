import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { splitFocusSegments } from '../knowledge.mjs';

export const knowledgeItem = (name, input, patch = {}) => ({ action: 'create', type: 'other', display_label: 'organization', canonical_name: name,
  role: '主体', reason: '本段讨论的公司', existing_item_id: null, observed_candidate_id: null, aliases: [], correction_reason: null,
  short_description: `${name}是本段讨论的公司。`, new_information: `原文正在讨论${name}。`, certainty: 'clear',
  evidence: [{ segment_id: input.focus_segments[0].id, quote: name }], ...patch });

export function seedProcessFixture(store, config) {
  if (config.protocol === 'relation') return seedRelationFixture(store, config);
  assert.equal(config.protocol, 'knowledge');
  assert.ok([1, 2].includes(config.parts));
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Synthetic process crash recovery');
  const first = 'Baseline seed. Atlas 0 and Nova 0 signed a deal. ';
  const text = config.parts === 1 ? first : first.padEnd(2500, 'x') + 'Atlas 1 and Nova 1 signed a deal.';
  const segment = store.addSegment(run.listeningId, run.runId, { id: 'process-fixture-original', text }).segment;
  const job = store.createExtractionJob(run.listeningId, [segment]);
  const input = store.jobInput(job), offsets = new Map();
  const parts = splitFocusSegments(input).map((group, part_no) => ({ part_no, focus_refs: group.focus_segments.map(segment => {
    const start = offsets.get(segment.id) || 0, end = start + segment.text.length;
    offsets.set(segment.id, end); return { segment_id: segment.id, start, end };
  }) }));
  assert.equal(parts.length, config.parts);
  store.initializeKnowledgeParts(job.id, parts, 'v2.1');
  store.applyKnowledgeV2(run.listeningId, [knowledgeItem('Baseline seed', input)]);
  return { ...config, run, jobId: job.id, clock: Date.now() };
}

// Observing a live or killed worker must not call ListeningStore's constructor:
// it performs recovery writes. A native read-only connection preserves the exact
// pre-recovery checkpoint and uses the original database together with its WAL.
export function readProcessDurable(filename, manifest) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (manifest.protocol === 'relation') return readRelationDurable(db, manifest);
    const job = db.prepare('SELECT * FROM extraction_jobs WHERE id=?').get(manifest.jobId);
    const parts = db.prepare('SELECT * FROM extraction_parts WHERE job_id=? ORDER BY part_no').all(manifest.jobId).map(part => ({ ...part,
      ...Object.fromEntries(['focus_refs', 'unresolved', 'results', 'stats', 'input_snapshot'].map(key => [key, part[key] == null ? null : JSON.parse(part[key])])) }));
    const knowledge = db.prepare('SELECT * FROM knowledge_items WHERE listening_id=? ORDER BY id').all(manifest.run.listeningId).map(item => ({ ...item,
      facts: db.prepare('SELECT * FROM knowledge_facts WHERE item_id=? ORDER BY id').all(item.id),
      aliases: db.prepare('SELECT * FROM knowledge_aliases WHERE item_id=? ORDER BY normalized_alias').all(item.id),
      mentions: db.prepare('SELECT * FROM knowledge_mentions WHERE item_id=? ORDER BY segment_id,surface_text').all(item.id) }));
    return { checkpoint: { job, progress: JSON.parse(job.progress_json), parts }, knowledge };
  } finally { db.close(); }
}

export function providerResponse(input, response) {
  const repair = Array.isArray(input.rejected), actor = providerActor(input);
  if (response === 'protocol') return { body: { broken: true } };
  if (['transient', 'auth', 'rate_limit', 'rate_limit_long', 'unexpected'].includes(response)) return {
    status: response === 'auth' ? 401 : response.startsWith('rate_limit') ? 429 : response === 'unexpected' ? 418 : 503,
    retryAfter: response === 'rate_limit' ? '7' : response === 'rate_limit_long' ? '301' : null,
    body: { error: { message: 'Synthetic provider failure' } }
  };
  if (input.contract_version === 'relations-v3') {
    const relations = response === 'empty' ? [] : [{ subject_item_id: input.candidates.find(row => row.canonical_name === `Atlas ${actor}`).id,
      object_item_id: input.candidates.find(row => row.canonical_name === `Nova ${actor}`).id, predicate: 'released',
      ...(response === 'filtered' ? {} : { polarity: 'positive' }), modality: 'asserted', status: 'active',
      evidence_ids: [input.evidence.find(row => row.quote.includes(`Atlas ${actor}`) && row.quote.includes(`Nova ${actor}`)).id] }];
    return { body: { choices: [{ message: { content: JSON.stringify({ contract_version: input.contract_version,
      evidence_version: input.evidence_version, relations }) } }], usage: { total_tokens: 1 } } };
  }
  const valid = knowledgeItem(`Atlas ${actor}`, input), rejected = knowledgeItem(`Nova ${actor}`, input, { role: null });
  const content = repair ? { corrections: response === 'empty' ? [] : input.rejected.map(target => ({ rejection_id: target.rejection_id,
    item: { ...target.item, role: '主体' } })) } : { items: response === 'ok' ? [valid] : response === 'empty' ? [] :
    response === 'partial' ? [valid, rejected] : response === 'rejected' ? [rejected] : [{ ...rejected, canonical_name: null }] };
  return { body: { choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 1 } } };
}

export const providerActor = input => Number((input.evidence?.find(row => row.scope === 'focus')?.quote || input.focus_segments[0].text).match(/Atlas (\d+)/)?.[1] ?? 0);

function seedRelationFixture(store, config) {
  assert.ok([1, 3].includes(config.actors)); assert.ok([1, 2].includes(config.capacity));
  const tasks = [], sessions = [], clock = Date.now();
  for (let session = 0; session < (config.actors === 1 ? 1 : 2); session++) {
    const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Synthetic process relation crash');
    sessions.push(run);
    const actors = session === 0 ? (config.actors === 1 ? [0] : [0, 2]) : [1];
    for (const [window, actor] of actors.entries()) {
      const names = [`Atlas ${actor}`, `Nova ${actor}`], nodes = names.map((_, index) => `process-${actor}-${index}`);
      const segments = Array.from({ length: 6 }, (_, index) => {
        const segment = store.addSegment(run.listeningId, run.runId, { id: `process-asr-${actor}-${index}`, text: `${names[0]} launched ${names[1]}.` }).segment;
        store.setTranslation(segment.id, `${names[0]} 推出了 ${names[1]}。`); return segment;
      });
      for (const [index, name] of names.slice(0, config.mode === 'no_candidates' ? 1 : 2).entries()) {
        store.db.prepare(`INSERT INTO knowledge_items(id,listening_id,type,canonical_name,normalized_name,dialogue_summary,certainty,created_at,updated_at)
          VALUES(?,?,'other',?,?,?,'clear',?,?)`).run(nodes[index], run.listeningId, name, name.toLowerCase(), name, new Date().toISOString(), new Date().toISOString());
        for (const segment of segments) store.db.prepare('INSERT INTO knowledge_mentions(item_id,segment_id,surface_text) VALUES(?,?,?)').run(nodes[index], segment.id, name);
      }
      tasks[actor] = { actor, session, window, listeningId: run.listeningId, windowId: `${run.listeningId}:${window}`, nodes, names };
    }
    store.enableRelations(run.listeningId, { now: clock });
  }
  return { ...config, tasks, sessions, clock };
}

function readRelationDurable(db, manifest) {
  return { actors: manifest.tasks.map(task => {
    const jobs = db.prepare(`SELECT j.* FROM relation_jobs j JOIN listenings l ON l.id=j.listening_id WHERE j.window_id=? AND j.epoch=l.relation_epoch ORDER BY j.created_at`).all(task.windowId);
    const journal = db.prepare(`SELECT q.* FROM relation_requests q JOIN relation_jobs j ON j.id=q.job_id JOIN listenings l ON l.id=j.listening_id WHERE j.window_id=? AND j.epoch=l.relation_epoch ORDER BY j.created_at,q.attempt`).all(task.windowId);
    const relations = db.prepare('SELECT * FROM relations WHERE subject_item_id=? AND object_item_id=? ORDER BY id').all(...task.nodes).map(relation => ({ ...relation,
      assertions: db.prepare('SELECT * FROM relation_assertions WHERE relation_id=? ORDER BY id').all(relation.id).map(assertion => ({ ...assertion,
        supports: db.prepare('SELECT * FROM relation_supports WHERE assertion_id=? ORDER BY id').all(assertion.id) })) }));
    return { ...task, jobs, journal, budget: jobs.reduce((sum, job) => sum + job.request_count, 0),
      window: db.prepare('SELECT * FROM relation_windows WHERE id=?').get(task.windowId), relations,
      knowledge: db.prepare('SELECT * FROM knowledge_items WHERE listening_id=? ORDER BY id').all(task.listeningId) };
  }) };
}
