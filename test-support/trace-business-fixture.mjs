import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ListeningStore } from '../storage.mjs';
import { createKnowledgeWorkflow } from '../knowledge-workflow.mjs';
import { createRelationWorkflow } from '../relation-workflow.mjs';
import { buildRelationRequest } from '../relations.mjs';
import { createTaskRuntime, parseTraceInput, buildTraceReport, buildBusinessOverview } from '../dist/server/index.js';
import { closeServer, deadline } from './lifecycle.mjs';

export const TRACE_SENTINEL = 'HW_TEST_ONLY_TRACE_SENTINEL_84_secret';
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export const traceReport = input => buildTraceReport(parseTraceInput(typeof input === 'string' ? input : JSON.stringify(input)));
export const knowledgeItem = (name, input, patch = {}) => ({ action: 'create', display_label: 'organization', canonical_name: name,
  role: '主体', reason: '本段讨论的公司', existing_item_id: null, observed_candidate_id: null, aliases: [], correction_reason: null,
  short_description: `${name} 是本段公司。`, new_information: `本段提到 ${name}。`, certainty: 'clear',
  evidence: [{ segment_id: input.focus_segments[0].id, quote: name }], ...patch });

// Real workflow, HTTP adapter, Effect runtime and file-backed SQLite. The only
// virtual time is the workflow's existing clock seam, advanced to durable due times.
export async function traceBusinessFixture({ domain = 'knowledge', sinkThrows = false, notifyThrows = false, coverageLimited = false } = {}) {
  assert.ok(['knowledge', 'relation'].includes(domain));
  const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-trace-business-'));
  const filename = path.join(directory, 'business.sqlite');
  let store = new ListeningStore(filename), clock = Date.now(), reply = () => ({ items: [] }), closing;
  const calls = [], adapterCalls = [], notifications = { attempted: 0, delivered: 0, errors: 0 }, held = new Set();
  const runtime = createTaskRuntime({ onEvent: sinkThrows ? () => { throw new Error(TRACE_SENTINEL); } : undefined });
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()), input = JSON.parse(body.messages.at(-1).content);
      calls.push({ model: body.model, authorized: req.headers.authorization === `Bearer ${TRACE_SENTINEL}` });
      held.add(res); res.once('close', () => held.delete(res));
      const value = await reply(input, body, res);
      if (value === undefined || res.destroyed) return;
      const status = value.httpStatus || 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: JSON.stringify(value) } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } : { error: { message: TRACE_SENTINEL } }));
    } catch { if (!res.destroyed) { res.writeHead(500); res.end('{}'); } }
  });
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Synthetic Trace business comparison');
  const segment = store.addSegment(run.listeningId, run.runId, { id: 'one', text: 'Atlas launched Nova.' + (coverageLimited ? ' x'.repeat(8000) : '') }).segment;
  store.setTranslation(segment.id, 'Atlas 推出了 Nova。'); store.finishRun(run.runId);
  let job;
  if (domain === 'knowledge') job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
  else {
    for (const name of ['Atlas', 'Nova']) store.applyKnowledge(run.listeningId, [{ type: 'other', canonical_name: name, aliases: [],
      dialogue_summary: name, background_note: null, certainty: 'clear', decision: 'create', existing_item_id: null,
      correction_reason: null, evidence: [{ segment_id: segment.id, quote: name }] }]);
    store.enableRelations(run.listeningId, { now: clock });
    job = store.nextRelationJob(run.listeningId, { quietMs: 0, now: clock });
    reply = input => ({ contract_version: input.contract_version, evidence_version: input.evidence_version, relations: [] });
  }
  const notify = () => { notifications.attempted++; if (notifyThrows) throw new Error(TRACE_SENTINEL); notifications.delivered++; };
  const onError = () => { notifications.errors++; if (notifyThrows) throw new Error(TRACE_SENTINEL); };
  let endpoint;
  try {
    server.listen(0, '127.0.0.1'); await deadline(() => once(server, 'listening'), 2000, 'Trace provider startup');
    endpoint = `http://127.0.0.1:${server.address().port}`;
  } catch (error) { await close(); throw error; }
  const query = () => domain === 'knowledge' ? {
    kind: 'sqlite-knowledge', listeningId: run.listeningId, jobId: job.id,
    checkpoint: store.knowledgeCheckpoint(job.id), detail: store.detail(run.listeningId), next: store.nextJob(run.listeningId) || null
  } : {
    kind: 'sqlite-relation', listeningId: run.listeningId, jobId: job.id,
    job: store.getRelationJob(job.id), processing: store.relationProcessing(run.listeningId), graph: store.graph(run.listeningId),
    ledger: store.db.prepare('SELECT attempt,outcome,usage_json FROM relation_requests WHERE job_id=? ORDER BY attempt').all(job.id)
  };
  function capture(label) {
    const snapshot = runtime.diagnostics(), report = traceReport(snapshot), business = buildBusinessOverview(report, run.listeningId);
    assert.ok(!JSON.stringify({ snapshot, report, business }).includes(TRACE_SENTINEL), 'Credential reached Trace output');
    return { label, snapshot, report, business, query: query(), calls: structuredClone(calls), adapterCalls: structuredClone(adapterCalls),
      notifications: { ...notifications }, activeCount: runtime.activeCount };
  }
  function start({ extract, context: transform = x => x } = {}) {
    const current = domain === 'knowledge' ? store.nextJob(run.listeningId) : store.getRelationJob(job.id);
    assert.ok(current, 'Business query must still admit the task');
    clock = Math.max(clock, current.ready_at || 0, current.retry_at ? Date.parse(current.retry_at) : 0);
    if (domain === 'knowledge') store.markJob(job.id, 'running');
    const override = extract ? { extract: (...args) => { adapterCalls.push({ domain, jobId: current.id }); return extract(...args); } } : {};
    const workflow = domain === 'knowledge' ? createKnowledgeWorkflow({ store, endpoint, now: () => clock,
      onItems: notify, onProgress: notify, onRejected: notify, onDiagnostic: notify, onError, ...override }) :
      createRelationWorkflow({ store, endpoint, now: () => clock, onChange: notify, onError, ...override });
    const operation = context => domain === 'knowledge' ? workflow.execute(current, TRACE_SENTINEL, transform(context)) :
      workflow.execute(current, TRACE_SENTINEL, context.signal, transform(context));
    if (domain === 'knowledge') return runtime.start(`knowledge:${job.id}`, { listening_id: run.listeningId, job_id: job.id,
      attempt: (store.knowledgeCheckpoint(job.id)?.parts?.[0]?.initial_requests || 0) + 1 }, operation);
    const controller = new AbortController();
    const promise = runtime.run('relation.execute', { listening_id: run.listeningId, job_id: job.id, attempt: current.request_count + 1 }, operation, controller.signal);
    return { promise, cancel: () => controller.abort() };
  }
  async function close() {
    return closing ??= (async () => {
      try { await deadline(() => runtime.dispose(), 3000, 'Trace runtime cleanup'); }
      finally { for (const res of held) res.destroy(); try { await closeServer(server, 'Trace provider'); }
        finally { store.close(); await rm(directory, { recursive: true, force: true }); } }
    })();
  }
  return { run, segment, get job() { return job; }, filename, calls, notifications, runtime, get store() { return store; },
    setReply(fn) { reply = fn; }, start, capture, query, async dispatch(options) { return deadline(() => start(options).promise, 5000, 'Trace workflow dispatch'); },
    parseRelation(input, relations = []) { const request = buildRelationRequest(input), wire = JSON.parse(request.body.messages[1].content);
      return request.parse(JSON.stringify({ contract_version: wire.contract_version, evidence_version: wire.evidence_version, relations })); },
    nextRelationGeneration() { store.enableRelations(run.listeningId, { retry: true, now: clock });
      job = store.nextRelationJob(run.listeningId, { quietMs: 0, now: clock }); assert.ok(job); return job; },
    reopen() { store.close(); store = new ListeningStore(filename); }, close };
}
