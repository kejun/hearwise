import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
const hash = value => createHash('sha256').update(value).digest('hex');
const recipeKeys = ['version', 'tier', 'listenings', 'segmentsPerBackground', 'graphRecords', 'nodesPerGraph', 'isolatedPerGraph', 'textCharacters', 'seed'];
const inRange = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
export const performanceRecipeDigest = recipe => hash(JSON.stringify(recipeKeys.map(key => [key, recipe[key]])));
export function validatePerformanceRecipe(recipe) {
  return recipe && Object.keys(recipe).length === recipeKeys.length && recipeKeys.every(key => Object.hasOwn(recipe, key)) &&
    recipe.version === 1 && typeof recipe.tier === 'string' && /^[a-z][a-z0-9_-]{0,30}$/.test(recipe.tier) &&
    inRange(recipe.listenings, 1, 2000) && inRange(recipe.graphRecords, 1, 2) && recipe.graphRecords <= recipe.listenings &&
    inRange(recipe.segmentsPerBackground, 1, 10000) && recipe.listenings * recipe.segmentsPerBackground <= 1000000 &&
    inRange(recipe.nodesPerGraph, 3, 1000) && inRange(recipe.isolatedPerGraph, 0, recipe.nodesPerGraph - 3) &&
    inRange(recipe.textCharacters, 120, 1000) && inRange(recipe.seed, 0, 0xffffffff);
}

function text(prefix, size) {
  // Synthetic bilingual content only. No credentials, personal data or provider.
  const filler = ' Synthetic baseline text. 合成历史与图谱规模数据。';
  return (prefix + filler.repeat(Math.ceil(size / filler.length))).slice(0, Math.max(size, prefix.length));
}
const typeAt = index => [
  { type: 'other', display_label: 'organization' }, { type: 'person', display_label: 'person' },
  { type: 'term', display_label: 'method' }, { type: 'event', display_label: 'event' }
][index % 4];
function nodeInput(index, name, segment, itemId = null) {
  return { action: itemId ? 'repeat' : 'create', ...typeAt(index), canonical_name: name,
    existing_item_id: itemId, observed_candidate_id: null, aliases: [], correction_reason: null,
    certainty: 'clear', role: '核心', reason: 'Synthetic reproducible performance fixture',
    short_description: itemId ? null : `${name} is a synthetic benchmark entity.`,
    new_information: itemId ? null : `${name} was introduced in the synthetic record.`,
    evidence: [{ segment_id: segment.id, quote: name }] };
}

export function graphTopology(nodes, relations) {
  const adjacent = new Map(nodes.map(node => [node.id, new Set()]));
  for (const edge of relations) {
    assert.ok(adjacent.has(edge.subject_item_id) && adjacent.has(edge.object_item_id));
    adjacent.get(edge.subject_item_id).add(edge.object_item_id);
    adjacent.get(edge.object_item_id).add(edge.subject_item_id);
  }
  const unseen = new Set(adjacent.keys()), sizes = [], degreeHistogram = {};
  for (const neighbors of adjacent.values()) degreeHistogram[neighbors.size] = (degreeHistogram[neighbors.size] || 0) + 1;
  while (unseen.size) {
    const pending = [unseen.values().next().value]; unseen.delete(pending[0]); let size = 0;
    while (pending.length) {
      const id = pending.pop(); size++;
      for (const next of adjacent.get(id)) if (unseen.delete(next)) pending.push(next);
    }
    sizes.push(size);
  }
  return { kind: 'directed-ring-plus-offset-two-chords-with-isolates', components: sizes.length,
    largestComponent: Math.max(0, ...sizes), isolatedNodes: degreeHistogram[0] || 0, degreeHistogram };
}

function seedRecord(store, recipe, ordinal) {
  const title = `Performance ${recipe.seed} ${recipe.tier} record ${String(ordinal).padStart(4, '0')}`;
  const run = store.createRun(null, settings, title), segments = [], edgeSources = new Map(), nodes = [];
  const append = prefix => {
    const segment = store.addSegment(run.listeningId, run.runId, { id: `fixture-${segments.length}`, text: text(prefix, recipe.textCharacters), beginMs: segments.length * 3000, endMs: (segments.length + 1) * 3000 }).segment;
    store.setTranslation(segment.id, `合成译文 ${segment.original_text}`, false); segments.push(segment); return segment;
  };
  if (ordinal < recipe.graphRecords) {
    for (let index = 0; index < recipe.nodesPerGraph; index++) {
      const name = `Fixture${recipe.seed}Record${ordinal}Node${String(index).padStart(6, '0')}`;
      const segment = append(`${name} is an independently introduced entity.`);
      const changed = store.applyKnowledgeV2(run.listeningId, [nodeInput(index, name, segment)]);
      assert.equal(changed.length, 1); nodes.push(changed[0]);
    }
    const connected = nodes.length - recipe.isolatedPerGraph;
    for (let index = 0; index < connected; index++) for (const [offset, predicate] of [[1, 'uses'], [2, 'based_on']]) {
      const other = (index + offset) % connected, subject = nodes[index], object = nodes[other];
      const segment = append(`${subject.canonical_name} ${predicate === 'uses' ? 'uses' : 'is based on'} ${object.canonical_name}.`);
      store.applyKnowledgeV2(run.listeningId, [nodeInput(index, subject.canonical_name, segment, subject.id), nodeInput(other, object.canonical_name, segment, object.id)]);
      edgeSources.set(segment.id, { subject_item_id: subject.id, object_item_id: object.id, predicate });
    }
    store.enableRelations(run.listeningId);
    let completed = 0;
    for (;;) {
      const pending = store.nextRelationJob(run.listeningId, { quietMs: 0 });
      if (!pending) break;
      assert.ok(completed++ <= Math.ceil(segments.length / 6) + 1, 'Unexpected repeated relation work during fixture preparation');
      const job = store.beginRelationRequest(pending.id); assert.ok(job);
      const relations = job.input.focus_segments.flatMap(segment => {
        const edge = edgeSources.get(segment.id);
        if (!edge) return [];
        return [{ ...edge, statement: segment.text, polarity: 'positive', modality: 'asserted', conditions: null,
          time_scope: null, attribution: null, status: 'active', correction_of: null,
          supports: [{ segment_id: segment.id, source_revision: segment.source_revision, start: 0, end: segment.text.length, quote: segment.text, role: 'relation' }] }];
      });
      const committed = store.commitRelationJob(job.id, { relations });
      assert.equal(committed.rejected.length, 0, JSON.stringify(committed));
    }
  } else for (let index = 0; index < recipe.segmentsPerBackground; index++) append(`Archived record ${ordinal}, sentence ${index}, seed ${recipe.seed}.`);
  // Archived fixtures are settled. Opening history or an import must not enqueue
  // paid extraction or translation. This is the existing graph fixture contract.
  const extraction = store.createExtractionJob(run.listeningId, segments);
  if (extraction) store.markJob(extraction.id, 'complete');
  store.finishRun(run.runId);
  // Fixed archived ordering is fixture data, outside every measured operation.
  const stamp = new Date(Date.UTC(2026, 0, 1) - ordinal * 60000).toISOString();
  store.db.prepare('UPDATE listenings SET created_at=?,updated_at=?,notes=? WHERE id=?').run(stamp, stamp, `Synthetic archive ${ordinal}.`, run.listeningId);
  const graph = store.graph(run.listeningId), typeCounts = {};
  for (const node of graph.nodes) typeCounts[node.type] = (typeCounts[node.type] || 0) + 1;
  return { id: run.listeningId, title, nodeIds: graph.nodes.map(node => node.id), edgeIds: graph.relations.map(edge => edge.id),
    segmentIds: segments.map(segment => segment.id), nodeCount: graph.nodes.length, edgeCount: graph.relations.length,
    segmentCount: segments.length, searchToken: 'Node000000', typeCounts, topology: graphTopology(graph.nodes, graph.relations) };
}

export async function seedPerformanceDatabase(filename, recipe) {
  assert.equal(validatePerformanceRecipe(recipe), true, 'Invalid performance fixture recipe');
  await mkdir(path.dirname(filename), { recursive: true });
  const exclusive = await open(filename, 'wx'); await exclusive.close();
  const started = performance.now(), store = new ListeningStore(filename), records = [];
  try {
    for (let ordinal = 0; ordinal < recipe.listenings; ordinal++) records.push(seedRecord(store, recipe, ordinal));
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { store.close(); }
  const actual = await inspectPerformanceDataset(filename);
  return { schemaVersion: 1, recipe, recipeDigest: performanceRecipeDigest(recipe),
    ...actual, primary: records[0], secondary: records[1] || null, records,
    preparation: { durationMs: performance.now() - started, paidProviderCalls: 0, method: 'actual ListeningStore business methods; no provider requests; fixed archived ordering' } };
}

// Stable business-content digest deliberately excludes generated UUIDs and wall
// timestamps. Concrete database bytes have a separate artifact hash in the runner.
export async function inspectPerformanceDataset(filename) {
  const db = new DatabaseSync(filename, { readOnly: true }), fingerprint = createHash('sha256');
  try {
    const counts = {};
    for (const [name, table] of Object.entries({ listenings: 'listenings', runs: 'listening_runs', segments: 'segments', nodes: 'knowledge_items', relations: 'relations', assertions: 'relation_assertions', supports: 'relation_supports', facts: 'knowledge_facts' })) counts[name] = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
    for (const [name, table, column] of [['originalText', 'segments', 'original_text'], ['translationText', 'segments', 'translation_text'], ['notesText', 'listenings', 'notes'], ['nameText', 'knowledge_items', 'canonical_name'], ['summaryText', 'knowledge_items', 'short_description']]) {
      const totals = db.prepare(`SELECT COALESCE(SUM(LENGTH(${column})),0) characters,COALESCE(SUM(LENGTH(CAST(${column} AS BLOB))),0) bytes FROM ${table}`).get();
      counts[`${name}CodePoints`] = totals.characters; counts[`${name}Utf8Bytes`] = totals.bytes;
    }
    const projections = [
      ['listenings', 'SELECT title,notes FROM listenings ORDER BY title'],
      ['runs', 'SELECT l.title,r.run_no,r.state,r.audio_source,r.source_lang,r.target_lang FROM listening_runs r JOIN listenings l ON l.id=r.listening_id ORDER BY l.title,r.run_no'],
      ['segments', 'SELECT l.title,s.sequence_no,s.original_text,s.translation_text,s.translation_state,s.begin_ms,s.end_ms FROM segments s JOIN listenings l ON l.id=s.listening_id ORDER BY l.title,s.sequence_no'],
      ['nodes', 'SELECT l.title,k.type,k.display_label,k.canonical_name,k.short_description,k.dialogue_summary,k.certainty,k.content_version FROM knowledge_items k JOIN listenings l ON l.id=k.listening_id ORDER BY l.title,k.canonical_name'],
      ['facts', 'SELECT l.title,k.canonical_name,s.sequence_no,f.surface_text,f.content,f.certainty FROM knowledge_facts f JOIN knowledge_items k ON k.id=f.item_id JOIN listenings l ON l.id=k.listening_id JOIN segments s ON s.id=f.segment_id ORDER BY l.title,k.canonical_name,s.sequence_no,f.content'],
      ['relations', 'SELECT l.title,subject.canonical_name subject,object.canonical_name object,r.predicate,a.statement,a.polarity,a.modality,a.status,s.sequence_no,p.quote FROM relations r JOIN listenings l ON l.id=r.listening_id JOIN knowledge_items subject ON subject.id=r.subject_item_id JOIN knowledge_items object ON object.id=r.object_item_id JOIN relation_assertions a ON a.relation_id=r.id JOIN relation_supports p ON p.assertion_id=a.id JOIN segments s ON s.id=p.segment_id ORDER BY l.title,subject.canonical_name,object.canonical_name,r.predicate,a.statement,s.sequence_no,p.quote']
    ];
    for (const [name, sql] of projections) { fingerprint.update(`${name}\n`); for (const row of db.prepare(sql).iterate()) fingerprint.update(`${JSON.stringify(row)}\n`); }
    return { counts, semanticDigest: fingerprint.digest('hex'), databaseVersion: db.prepare('PRAGMA user_version').get().user_version };
  } finally { db.close(); }
}
