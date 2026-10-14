// Offline preparation only. No live endpoint or credential is accepted here.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ListeningStore } from '../../storage.mjs';
import { createKnowledgeWorkflow } from '../../knowledge-workflow.mjs';
import { createRelationWorkflow } from '../../relation-workflow.mjs';
import { KNOWLEDGE_MODEL, CONTRACT_REVISION } from '../../knowledge.mjs';
import { RELATION_MODEL, RELATION_CONTRACT_VERSION } from '../../relations.mjs';
import { closeServer, deadline } from '../../test-support/lifecycle.mjs';
import { hashBytes, contractDigest } from './quality-contract.mjs';
import { qualitySources } from './quality-collector.mjs';
import { writeJson } from './verification-evidence.mjs';

export function semanticDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    const tables = Object.fromEntries(names.map(name => {
      assert.match(name, /^[a-z_]+$/);
      return [name, db.prepare(`SELECT * FROM "${name}"`).all().map(row => ({ ...row })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))];
    }));
    return { schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      integrity: db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), foreignKeys: db.prepare('PRAGMA foreign_key_check').all(), tables };
  } finally { db.close(); }
}

export function semanticUnits(snapshot) {
  const t = snapshot.tables, segments = new Map(t.segments.map(row => [row.id, row]));
  const references = rows => rows.map(row => ({ ...row, original: segments.get(row.segment_id)?.original_text }));
  return [
    ...t.knowledge_items.map(row => ({ id: `entity:${row.id}`, kind: 'entity', value: row,
      sources: references(t.knowledge_mentions.filter(ref => ref.item_id === row.id)), aliases: t.knowledge_aliases.filter(ref => ref.item_id === row.id) })),
    ...t.knowledge_facts.map(row => ({ id: `fact:${row.id}`, kind: 'fact', value: row,
      owner: t.knowledge_items.find(item => item.id === row.item_id), sources: references([{ segment_id: row.segment_id, quote: row.surface_text }]) })),
    ...t.relation_assertions.map(row => ({ id: `relation:${row.id}`, kind: 'relation', value: row,
      relation: t.relations.find(item => item.id === row.relation_id),
      sources: references(t.relation_supports.filter(ref => ref.assertion_id === row.id)) }))
  ];
}

export async function captureSemanticOffline({ directory, sample, response, signal }) {
  const sourceStart = await qualitySources();
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const filename = path.join(directory, 'store.sqlite'), startedAt = new Date().toISOString();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let store, server, active, run, clock = Date.now(), before, after, visible, errorCode, cleanup = false;
  const calls = [], results = [], errors = [];
  try {
    assert.equal(sample.kind, 'synthetic-contract-fixture'); assert.ok(sample.segments.length > 0 && sample.segments.length <= 6);
    assert.ok(sample.segments.every(text => typeof text === 'string' && text.length > 0 && text.length <= 6000));
    store = new ListeningStore(filename);
    run = store.createRun(null, { source: 'en', targetLang: 'English', audioSource: 'microphone' }, 'Synthetic semantic contract');
    server = http.createServer(async (request, reply) => {
      try {
        const chunks = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; assert.ok(length <= 128000); chunks.push(chunk); }
        assert.ok(calls.length < 24); assert.equal(request.method, 'POST');
        assert.equal(request.headers.authorization, 'Bearer synthetic-semantic-fixture');
        const wire = Buffer.concat(chunks).toString(), body = JSON.parse(wire), input = JSON.parse(body.messages.at(-1).content);
        const kind = input.candidates ? 'relation' : input.rejected ? 'repair' : 'knowledge';
        assert.equal(kind === 'relation' ? 'relation' : 'knowledge', active.domain);
        const reservation = kind === 'relation' ? store.getRelationJob(active.id) : store.knowledgeCheckpoint(active.id);
        if (kind === 'relation') assert.ok(reservation.state === 'running' && reservation.request_count >= 1);
        else assert.ok(reservation.parts.some(part => part.phase === (kind === 'repair' ? 'repair_inflight' : 'extract_inflight')));
        const output = response({ kind, input, sample, calls });
        const row = { kind, jobId: active.id, mode: 'offline', endpoint: `http://127.0.0.1:${server.address().port}`,
          request: body, requestWire: wire, requestBytes: length, requestSha256: hashBytes(wire), response: output, reservation, at: new Date().toISOString() };
        calls.push(row);
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      } catch { errors.push('OFFLINE_PROVIDER_CONTRACT'); reply.writeHead(400); reply.end('{}'); }
    });
    server.listen(0, '127.0.0.1'); await deadline(() => once(server, 'listening'), 3000, 'Semantic stub startup');
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const knowledge = createKnowledgeWorkflow({ store, endpoint, now: () => clock, onError: () => errors.push('KNOWLEDGE_ERROR') });
    let dispatches = 0;
    const batchSize = sample.ingestionBatchSize ?? sample.segments.length;
    assert.ok(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 6);
    for (let start = 0; start < sample.segments.length; start += batchSize) {
      for (let index = start; index < Math.min(start + batchSize, sample.segments.length); index++) {
        const segment = store.addSegment(run.listeningId, run.runId, { id: `source-${index}`, text: sample.segments[index] }).segment;
        store.setTranslation(segment.id, sample.segments[index]);
      }
    while (store.extractionRange(run.listeningId).length) {
      const job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
      for (;;) {
        combined.throwIfAborted(); assert.ok(++dispatches <= 24);
        const next = store.nextJob(run.listeningId); assert.equal(next.id, job.id);
        clock = Math.max(clock, next.ready_at || 0, Date.parse(next.retry_at) || 0);
        active = { domain: 'knowledge', id: job.id };
        const result = await knowledge.execute(store.markJob(job.id, 'running'), 'synthetic-semantic-fixture', { signal: combined });
        results.push({ domain: 'knowledge', jobId: job.id, result });
        if (result.kind === 'terminal') { assert.ok(['ok','empty'].includes(result.outcome)); break; }
      }
    }
    }
    store.finishRun(run.runId); store.enableRelations(run.listeningId, { now: clock });
    const relations = createRelationWorkflow({ store, endpoint, now: () => clock, requestTimeoutMs: 5000, onError: () => errors.push('RELATION_ERROR') });
    for (let index = 0; index < 24; index++) {
      combined.throwIfAborted(); clock = Math.max(clock, store.relationProcessing(run.listeningId).nextReadyAt || 0);
      const job = store.nextRelationJob(run.listeningId, { now: clock, quietMs: 0 });
      if (!job) { const status = store.relationProcessing(run.listeningId); assert.equal(status.pendingJobs + status.runningJobs, 0); break; }
      active = { domain: 'relation', id: job.id };
      const result = await relations.execute(job, 'synthetic-semantic-fixture', combined);
      results.push({ domain: 'relation', jobId: job.id, result }); assert.ok(index < 23);
    }
    assert.deepEqual(errors, []);
    visible = { knowledge: store.knowledge(run.listeningId), graph: store.graph(run.listeningId) };
    assert.ok(['empty','complete'].includes(visible.graph.status.state));
    before = semanticDatabase(filename); store.close(); store = new ListeningStore(filename);
    after = semanticDatabase(filename);
    // Reopening intentionally restores the key-required marker; semantic rows
    // and every other persisted field must remain unchanged.
    const expectedAfter = structuredClone(before);
    for (const row of expectedAfter.tables.listenings) row.relation_waiting_key = row.relation_enabled;
    assert.deepEqual(after, expectedAfter);
    assert.deepEqual(store.knowledge(run.listeningId), visible.knowledge);
    assert.deepEqual(store.graph(run.listeningId), visible.graph);
    assert.deepEqual(after.integrity, ['ok']); assert.deepEqual(after.foreignKeys, []);
  } catch (error) { errorCode = combined.aborted ? 'TIMEOUT_OR_CANCELLED' : 'SEMANTIC_CAPTURE_INCOMPLETE'; }
  finally {
    clearTimeout(timer);
    const clean = await Promise.allSettled([server && closeServer(server, 'semantic provider'), Promise.resolve().then(() => store?.close())]);
    cleanup = clean.every(row => row.status === 'fulfilled');
  }
  let sourceEnd = null;
  try { sourceEnd = await qualitySources(); } catch { errorCode = 'SEMANTIC_SOURCE_UNREADABLE'; }
  if (sourceEnd && contractDigest(sourceStart) !== contractDigest(sourceEnd)) errorCode = 'SEMANTIC_SOURCE_CHANGED';
  const artifacts = [];
  try { artifacts.push({ path: 'store.sqlite', sha256: hashBytes(await readFile(filename)) }); }
  catch { errorCode ||= 'SEMANTIC_DATABASE_MISSING'; }
  const report = { schemaVersion: 1, kind: 'offline-semantic-capture', mode: 'offline', evidenceKind: 'synthetic-provider-output',
    pipeline: 'knowledge-then-relation-cascade', sample, sampleDigest: contractDigest(sample), startedAt, finishedAt: new Date().toISOString(),
    complete: !errorCode && cleanup, cleanup, errorCode, qualityEvaluated: false, fullQualityAcceptance: false, qualityStatus: 'not_run', liveCalls: 0,
    models: { knowledge: KNOWLEDGE_MODEL, relation: RELATION_MODEL, knowledgeContract: CONTRACT_REVISION, relationContract: RELATION_CONTRACT_VERSION },
    clock: 'offline workflow logical time; no latency measurement', sourceStart, sourceEnd, run, calls, results, errors, visible, before, after,
    units: after ? semanticUnits(after) : [], artifacts };
  await writeJson(path.join(directory, 'capture.json'), report); return report;
}
