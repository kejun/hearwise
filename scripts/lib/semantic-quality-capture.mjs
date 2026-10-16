// Offline preparation only. No live endpoint or credential is accepted here.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ListeningStore } from '../../storage.mjs';
import { createKnowledgeWorkflow, repairInput } from '../../knowledge-workflow.mjs';
import { createRelationWorkflow } from '../../relation-workflow.mjs';
import { KNOWLEDGE_MODEL, CONTRACT_REVISION, knowledgeRequestMessages, knowledgeRepairRequestMessages } from '../../knowledge.mjs';
import { RELATION_MODEL, RELATION_CONTRACT_VERSION, buildRelationRequest } from '../../relations.mjs';
import { closeServer, deadline } from '../../test-support/lifecycle.mjs';
import { hashBytes, contractDigest } from './quality-contract.mjs';
import { qualitySources } from './quality-collector.mjs';
import { writeJson } from './verification-evidence.mjs';
import { createSemanticGateway } from './semantic-quality-gateway.mjs';

// Callers must verify this capability before requesting realtime collection.
export const semanticRealtimeSchedulerVersion = 1;

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

export async function captureSemanticOffline({ directory, sample, response, signal, pairedBudget, corpusPlan, scheduler }) {
  // Scheduler is a trusted caller hook, never provider-controlled plan data.
  assert.ok(scheduler === undefined || scheduler?.kind === 'realtime' && typeof scheduler.waitUntil === 'function', 'SEMANTIC_SCHEDULER_INVALID');
  const realtime = scheduler !== undefined;
  const sourceStart = await qualitySources();
  const maxCalls = corpusPlan ? pairedBudget.maxCalls : 24, requestBytes = corpusPlan?.limits.maxRequestBytes || 128000;
  const dispatchLimit = corpusPlan ? maxCalls * 3 : 24;
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const filename = path.join(directory, 'store.sqlite'), startedAt = new Date().toISOString();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), corpusPlan?.limits.totalTimeoutMs || 12000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let store, server, gateway, active, run, clock = Date.now(), before, after, visible, errorCode, cleanup = false;
  const calls = [], results = [], errors = [], diagnostics = [], budgetBindings = [];
  const reportDiagnostic = code => (corpusPlan ? diagnostics : errors).push(code);
  const workflowNow = () => realtime ? Date.now() : clock;
  const waitForDue = async due => {
    await scheduler.waitUntil(due, combined);
    combined.throwIfAborted();
    clock = Date.now();
    assert.ok(clock >= due, 'SEMANTIC_SCHEDULER_EARLY_RETURN');
  };
  const reservationFor = domain => domain === 'relation' ? store.getRelationJob(active.id) : store.knowledgeCheckpoint(active.id);
  try {
    assert.equal(sample.kind, corpusPlan ? 'offline-text-corpus' : 'synthetic-contract-fixture'); assert.ok(sample.segments.length > 0 && sample.segments.length <= (corpusPlan ? 24 : 6));
    assert.ok(sample.segments.every(text => typeof text === 'string' && text.length > 0 && text.length <= 6000));
    store = new ListeningStore(filename);
    run = store.createRun(null, { source: 'en', targetLang: 'English', audioSource: 'microphone' }, 'Synthetic semantic contract');
    server = http.createServer(async (request, reply) => {
      try {
        const chunks = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; assert.ok(length <= requestBytes); chunks.push(chunk); }
        assert.ok(calls.length < maxCalls); assert.equal(request.method, 'POST');
        assert.equal(request.headers.authorization, 'Bearer synthetic-semantic-fixture');
        const wire = Buffer.concat(chunks).toString(), body = JSON.parse(wire), input = JSON.parse(body.messages.at(-1).content);
        const kind = input.candidates ? 'relation' : input.rejected ? 'repair' : 'knowledge';
        assert.equal(kind === 'relation' ? 'relation' : 'knowledge', active.domain);
        const reservation = reservationFor(active.domain);
        if (pairedBudget) {
          const binding = budgetBindings.at(-1);
          assert.equal(binding.requestSha256, hashBytes(wire)); assert.equal(binding.jobId, active.id);
          assert.equal(binding.reservationDigest, contractDigest(reservation));
          assert.ok(pairedBudget.ledger.snapshot().attempts.some(row => String(row.id) === binding.attemptId));
        }
        if (kind === 'relation') assert.ok(reservation.state === 'running' && reservation.request_count >= 1);
        else assert.ok(reservation.parts.some(part => part.phase === (kind === 'repair' ? 'repair_inflight' : 'extract_inflight')));
        const output = await response({ kind, input, sample, calls, request: body, requestWire: wire, reservation, signal: combined });
        const http = corpusPlan ? output : { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
        assert.ok(Number.isInteger(http.status) && http.status >= 200 && http.status <= 599 && typeof http.body === 'string' && Buffer.byteLength(http.body) <= (corpusPlan?.limits.maxResponseBytes || 128000));
        assert.ok(http.retryAfter === undefined || typeof http.retryAfter === 'string' && /^\d+(?:\.\d+)?$/.test(http.retryAfter) && http.retryAfter.length <= 10);
        const row = { kind, jobId: active.id, mode: 'offline', endpoint: `http://127.0.0.1:${server.address().port}`,
          request: body, requestWire: wire, requestBytes: length, requestSha256: hashBytes(wire), response: output, ...(corpusPlan ? { http } : {}), reservation, at: new Date().toISOString() };
        calls.push(row);
        reply.writeHead(http.status, { 'content-type': 'application/json', ...(http.retryAfter ? { 'retry-after': http.retryAfter } : {}) });
        reply.end(http.body);
      } catch { errors.push('OFFLINE_PROVIDER_CONTRACT'); reply.writeHead(400); reply.end('{}'); }
    });
    server.listen(0, '127.0.0.1'); await deadline(() => once(server, 'listening'), 3000, 'Semantic stub startup');
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    if (pairedBudget) {
      let authorized;
      gateway = await createSemanticGateway({ mode: 'offline', upstream: { endpoint, key: 'synthetic-semantic-fixture' },
        expected: { knowledgeModel: KNOWLEDGE_MODEL, relationModel: RELATION_MODEL, maxRequests: maxCalls,
          maxRequestBytes: requestBytes, maxResponseBytes: corpusPlan?.limits.maxResponseBytes || 128000, timeoutMs: corpusPlan?.limits.requestTimeoutMs || 5000, expiresAt: pairedBudget.expiresAt }, signal: combined,
        authorize: context => {
          assert.equal(context.kind, active.domain);
          const reservation = reservationFor(active.domain);
          if (active.domain === 'relation') {
            assert.ok(reservation.state === 'running' && reservation.request_count >= 1);
            assert.equal(contractDigest(context.request), contractDigest(buildRelationRequest(reservation.input).body));
          } else {
            // Rebuild from the active durable production part, including pinned repair input.
            const parts = reservation.parts.filter(part => part.phase === 'extract_inflight' || corpusPlan && part.phase === 'repair_inflight'); assert.equal(parts.length, 1);
            const base = store.jobInput(reservation.job), byId = new Map(base.focus_segments.map(row => [row.id, row.text]));
            const focus = parts[0].focus_refs.map(ref => {
              const text = byId.get(ref.segment_id); assert.ok(typeof text === 'string' && ref.start >= 0 && ref.end <= text.length && ref.end > ref.start);
              return { id: ref.segment_id, text: text.slice(ref.start, ref.end) };
            });
            let input = store.jobInput(reservation.job, focus);
            const repairing = parts[0].phase === 'repair_inflight';
            if (repairing) input = repairInput(input, parts[0].input_snapshot || {}, parts[0].unresolved, store.knowledgeCandidateIds(reservation.job.listening_id));
            assert.equal(contractDigest(context.request), contractDigest({ model: KNOWLEDGE_MODEL, enable_thinking: false,
              messages: repairing ? knowledgeRepairRequestMessages(input, parts[0].unresolved) : knowledgeRequestMessages(input) }));
          }
          authorized = { requestSha256: context.requestSha256, jobId: active.id, reservationDigest: contractDigest(reservation) };
          return true;
        },
        reserve: context => {
          assert.equal(context.requestSha256, authorized.requestSha256); assert.equal(active.id, authorized.jobId);
          assert.equal(contractDigest(reservationFor(active.domain)), authorized.reservationDigest);
          const attemptId = String(pairedBudget.ledger.reserve({ kind: context.kind, trialId: pairedBudget.trialId }));
          budgetBindings.push({ ...authorized, attemptId, kind: context.kind, trialId: pairedBudget.trialId }); return attemptId;
        } });
    }
    const credential = gateway?.token || 'synthetic-semantic-fixture';
    const knowledge = createKnowledgeWorkflow({ store, endpoint: gateway?.knowledgeEndpoint || endpoint, now: workflowNow, onError: () => reportDiagnostic('KNOWLEDGE_ERROR') });
    let dispatches = 0;
    const batchSize = sample.ingestionBatchSize ?? sample.segments.length;
    assert.ok(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= (corpusPlan ? 24 : 6));
    for (let start = 0; start < sample.segments.length; start += batchSize) {
      for (let index = start; index < Math.min(start + batchSize, sample.segments.length); index++) {
        const segment = store.addSegment(run.listeningId, run.runId, { id: `source-${index}`, text: sample.segments[index] }).segment;
        store.setTranslation(segment.id, sample.segments[index]);
      }
    while (store.extractionRange(run.listeningId).length) {
      const job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
      for (;;) {
        combined.throwIfAborted(); assert.ok(++dispatches <= dispatchLimit);
        const next = store.nextJob(run.listeningId); assert.equal(next.id, job.id);
        if (realtime) await waitForDue(Math.max(next.ready_at || 0, Date.parse(next.retry_at) || 0));
        else clock = Math.max(clock, next.ready_at || 0, Date.parse(next.retry_at) || 0);
        active = { domain: 'knowledge', id: job.id };
        const result = await knowledge.execute(store.markJob(job.id, 'running'), credential, { signal: combined });
        results.push({ domain: 'knowledge', jobId: job.id, result });
        if (result.kind === 'terminal') { assert.ok((corpusPlan ? ['ok','empty','partial','invalid'] : ['ok','empty']).includes(result.outcome)); break; }
      }
    }
    }
    store.finishRun(run.runId);
    if (realtime) clock = Date.now();
    store.enableRelations(run.listeningId, { now: clock });
    const relations = createRelationWorkflow({ store, endpoint: gateway?.relationEndpoint || endpoint, now: workflowNow, requestTimeoutMs: corpusPlan?.limits.requestTimeoutMs || 5000, onError: () => reportDiagnostic('RELATION_ERROR') });
    for (let index = 0; index < dispatchLimit; index++) {
      combined.throwIfAborted();
      if (realtime) await waitForDue(store.relationProcessing(run.listeningId).nextReadyAt || 0);
      else clock = Math.max(clock, store.relationProcessing(run.listeningId).nextReadyAt || 0);
      const job = store.nextRelationJob(run.listeningId, { now: clock, quietMs: 0 });
      if (!job) { const status = store.relationProcessing(run.listeningId); assert.equal(status.pendingJobs + status.runningJobs, 0); break; }
      active = { domain: 'relation', id: job.id };
      const result = await relations.execute(job, credential, combined);
      results.push({ domain: 'relation', jobId: job.id, result }); assert.ok(index < dispatchLimit - 1);
    }
    assert.deepEqual(errors, []);
    if (corpusPlan) assert.ok(gateway.observations().every(row => row.reservationStatus === 'confirmed' && row.forwardedAt && row.attemptId), 'CORPUS_UNACCOUNTED_REQUEST');
    visible = { knowledge: store.knowledge(run.listeningId), graph: store.graph(run.listeningId) };
    if (!corpusPlan) assert.ok(['empty','complete'].includes(visible.graph.status.state));
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
    if (gateway) { try { await gateway.close(); } catch { errorCode ||= 'SEMANTIC_GATEWAY_CLEANUP'; } }
    const clean = await Promise.allSettled([server && closeServer(server, 'semantic provider'), Promise.resolve().then(() => store?.close())]);
    cleanup = clean.every(row => row.status === 'fulfilled');
  }
  let sourceEnd = null;
  try { sourceEnd = await qualitySources(); } catch { errorCode = 'SEMANTIC_SOURCE_UNREADABLE'; }
  if (sourceEnd && contractDigest(sourceStart) !== contractDigest(sourceEnd)) errorCode = 'SEMANTIC_SOURCE_CHANGED';
  const artifacts = [];
  try { artifacts.push({ path: 'store.sqlite', sha256: hashBytes(await readFile(filename)) }); }
  catch { errorCode ||= 'SEMANTIC_DATABASE_MISSING'; }
  const report = { schemaVersion: 1, kind: 'offline-semantic-capture', mode: 'offline', evidenceKind: corpusPlan ? 'offline-corpus-provider-output' : 'synthetic-provider-output',
    pipeline: 'knowledge-then-relation-cascade', sample, sampleDigest: contractDigest(sample), startedAt, finishedAt: new Date().toISOString(),
    complete: !errorCode && cleanup, cleanup, errorCode, qualityEvaluated: false, fullQualityAcceptance: false, qualityStatus: 'not_run', liveCalls: 0,
    ...(corpusPlan ? { corpusPlanDigest: contractDigest(corpusPlan), diagnostics } : {}),
    models: { knowledge: KNOWLEDGE_MODEL, relation: RELATION_MODEL, knowledgeContract: CONTRACT_REVISION, relationContract: RELATION_CONTRACT_VERSION },
    clock: realtime ? 'realtime workflow wall time; local provider bridge' : 'offline workflow logical time; no latency measurement', sourceStart, sourceEnd, run, calls, results, errors, visible, before, after,
    units: after ? semanticUnits(after) : [], artifacts,
    ...(pairedBudget ? { transport: { trialId: pairedBudget.trialId, budgetBindings, observations: gateway?.observations() || [] } } : {}) };
  if (corpusPlan) assert.ok(Buffer.byteLength(JSON.stringify(report, null, 2) + '\n') <= 64 * 1024 * 1024, 'CORPUS_SERIALIZED_EVIDENCE_LIMIT');
  await writeJson(path.join(directory, 'capture.json'), report); return report;
}
