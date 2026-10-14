import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createNameProtocolFixture } from './name-protocol-fixture.mjs';
import { installNameWriteFault, removeNameWriteFault } from './name-transaction-fixture.mjs';
import { readKnowledgeEditorResponse } from '../public/knowledge-editor.js';
import { deadline, closeServer } from './lifecycle.mjs';

const names = ['Deebo', 'Tibo', 'Mira'];
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = input => hash(JSON.stringify(['name_replace', input.name, input.revision]));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const wait = (gate, label) => deadline(() => gate.promise, 5000, label);
const attemptFields = ['phase', 'rawName', 'submittedRevision', 'submittedName', 'operationId', 'requests', 'txResult', 'reply',
  'commitBaseRevision', 'commitBaseAnchorValid', 'loadedRevision', 'loadedName'];
const operationFields = ['receipt', 'receiptRawName', 'receiptInputRevision', 'receiptCommitRevision', 'receiptOwner', 'commits'];
const index = name => { const result = names.indexOf(name); assert.ok(result >= 0, `Unexpected fixture name ${name}`); return result; };
const same = isDeepStrictEqual;
function activeValid(tables, segmentId) {
  const text = tables.segments.find(row => row.id === segmentId).original_text;
  return tables.relation_supports.filter(row => row.segment_id === segmentId && row.state === 'active').every(row =>
    Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end) && row.start >= 0 && row.start < row.end && row.end <= text.length &&
    row.source_revision === hash(text) && row.quote === text.slice(row.start, row.end));
}
function isolatedRows(tables, listeningId) {
  const ids = new Set([listeningId]), fields = ['listening_id', 'run_id', 'item_id', 'subject_item_id', 'object_item_id', 'segment_id', 'relation_id', 'assertion_id', 'job_id', 'window_id'];
  let changed;
  do { changed = false; for (const rows of Object.values(tables)) for (const row of rows) if ((ids.has(row.id) || fields.some(key => ids.has(row[key]))) && row.id && !ids.has(row.id)) { ids.add(row.id); changed = true; } } while (changed);
  return Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.filter(row => ids.has(row.id) || fields.some(key => ids.has(row[key])))]));
}
export async function createNameProtocolAdapter({ mode = 'independent', mutation = 'none' } = {}) {
  assert.ok(['independent', 'reuse'].includes(mode)); assert.ok(['none', 'bypass_fingerprint', 'non_atomic_receipt', 'bypass_revision', 'bypass_anchor'].includes(mutation));
  const fixture = await createNameProtocolFixture({ mutation }), baseline = fixture.tables(), baselineSnapshot = fixture.snapshot(), seeded = fixture.seeded;
  const versions = [fixture.snapshot().revision], operationIds = [randomUUID(), randomUUID()], events = [], tasks = new Map();
  const version = snapshot => { let id = versions.indexOf(snapshot.revision); if (id < 0) { id = versions.length; versions.push(snapshot.revision); } return id; };
  const attempts = [0, 1].map(actor => ({ actor, phase: 'unused', rawName: '', submittedRevision: -1, submittedName: -1, operationId: actor,
    requests: 0, txResult: 'none', reply: 'none', commitBaseRevision: -1, commitBaseAnchorValid: true, loadedRevision: -1, loadedName: -1 }));
  const operations = [0, 1].map(() => ({ receipt: 'none', receiptRawName: '', receiptInputRevision: -1, receiptCommitRevision: -1, receiptOwner: -1, commits: 0 }));
  let proxy, closed = false, background = 'none', sourceVersion = 0, evidenceVersion = 0;
  try {
    proxy = http.createServer(async (request, response) => {
      if (request.url === '/unavailable') { response.writeHead(502, { 'Content-Type': 'text/html' }); response.end('Synthetic unavailable receipt'); return; }
      const task = tasks.get(Number(request.url.slice(1)));
      if (!task || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        task.actualRequest = JSON.parse(Buffer.concat(chunks).toString()); task.row.requests++; task.queued.resolve();
        await task.forward.promise; if (closed) { response.destroy(); return; }
        const upstream = await fetch(fixture.url + '/name-replacements', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': task.id },
          body: JSON.stringify(task.actualRequest), signal: task.controller.signal });
        task.actualResponse = { status: upstream.status, text: await upstream.text() }; task.prepared.resolve();
        const transport = await task.delivery.promise;
        if (closed || transport === 'lost') { response.destroy(); return; }
        response.writeHead(transport === 'proxy502' ? 502 : task.actualResponse.status, { 'Content-Type': transport === 'proxy502' ? 'text/html' : 'application/json' });
        response.end(transport === 'proxy502' ? 'Synthetic proxy error after actual upstream result' : task.actualResponse.text);
      } catch (error) { task.transportError = error.message; task.prepared.resolve(); response.destroy(); }
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  } catch (error) { await fixture.close(); throw error; }
  const proxyBase = `http://127.0.0.1:${proxy.address().port}`;
  const linked = tables => tables.segments.find(row => row.id === seeded.segment.id);
  const supportQuote = tables => tables.relation_supports.find(row => row.segment_id === seeded.segment.id && row.state === 'active' && row.role === 'relation').quote;
  const currentName = () => index(fixture.snapshot().item.canonical_name);
  const classify = (row, received) => {
    if (received.result?.job?.saved === true) { row.phase = 'saved'; row.reply = 'ok'; }
    else if (received.error?.outcomeUnknown === false) {
      row.phase = row.txResult === 'rolled_back' ? 'failed' : 'conflict'; row.reply = row.phase;
    } else { row.phase = 'recovering'; row.reply = 'unknown'; }
  };
  const observe = () => ({ snapshot: fixture.snapshot(), tables: fixture.tables(), baseline, baselineSnapshot, identities: { listeningId: fixture.listeningId,
    itemId: fixture.itemId, segmentId: seeded.segment.id, unlinkedId: seeded.other.id, unrelatedId: seeded.unrelated.listeningId, staleId: seeded.staleId,
    cameraId: seeded.camera.id, factId: seeded.factId }, versions: [...versions], operationIds: [...operationIds],
    attempts: attempts.map(({ task, transactionBefore, transactionAfter, ...row }) => ({ ...row, actualRequest: task?.actualRequest || null, actualResponse: task?.actualResponse || null })),
    operations: structuredClone(operations), events: structuredClone(events), providerCalls: fixture.stats.providerRequests.length, mutation: fixture.mutationEvidence || null });
  const project = () => {
    const tables = fixture.tables(), snapshot = fixture.snapshot(), name = currentName(), text = linked(tables).original_text;
    const textName = value => names.findIndex(candidate => value.startsWith(`${candidate} released Camera.`));
    const associated = [snapshot.item.dialogue_summary, tables.knowledge_items.find(row => row.id === seeded.camera.id).dialogue_summary,
      tables.knowledge_facts.find(row => row.id === seeded.factId).content,
      tables.relation_assertions.find(row => row.id === baseline.relation_assertions.find(item => item.statement === 'Deebo released Camera.' && item.relation_id === baseline.relations.find(r => r.listening_id === fixture.listeningId).id).id).statement];
    const associatedName = names.findIndex(candidate => same(associated, [`${candidate} appeared with ${candidate}.`, `Camera appeared with ${candidate}.`, `${candidate} released Camera.`, `${candidate} released Camera.`]));
    const identities = table => tables[table].map(row => row.id).sort();
    const identitiesPreserved = ['knowledge_items', 'knowledge_facts', 'relations', 'relation_assertions', 'relation_supports'].every(table => same(identities(table), baseline[table].map(row => row.id).sort())) && same(tables.relations, baseline.relations);
    const stalePreserved = same(tables.relation_supports.filter(row => row.state === 'stale'), baseline.relation_supports.filter(row => row.state === 'stale'));
    const scopePreserved = same(isolatedRows(tables, seeded.unrelated.listeningId), isolatedRows(baseline, seeded.unrelated.listeningId)) &&
      same(tables.segments.find(row => row.id === seeded.other.id), baseline.segments.find(row => row.id === seeded.other.id));
    return { revision: version(snapshot), name, sourceName: textName(text), associatedName, evidenceName: textName(supportQuote(tables)),
      changes: tables.knowledge_revisions.filter(row => row.item_id === fixture.itemId && row.action === 'name_replace').length,
      sourceVersion, associatedVersion: snapshot.item.content_version - baseline.knowledge_items.find(row => row.id === fixture.itemId).content_version,
      evidenceVersion, anchorValid: activeValid(tables, seeded.segment.id), background, stalePreserved, scopePreserved, identitiesPreserved,
      ...Object.fromEntries(attemptFields.map(field => [field, Object.fromEntries(attempts.map(row => [row.actor, row[field]]))])),
      ...Object.fromEntries(operationFields.map(field => [field, Object.fromEntries(operations.map((row, id) => [id, row[field]]))])) };
  };
  const check = () => {
    const state = project(), errors = [];
    if (fixture.stats.providerRequests.length) errors.push('Unexpected provider request');
    if (![state.stalePreserved, state.scopePreserved, state.identitiesPreserved].every(Boolean)) errors.push('Protected business rows changed');
    if (![state.sourceName, state.associatedName, state.evidenceName].every(value => value === state.name) ||
        ![state.sourceVersion, state.associatedVersion, state.evidenceVersion].every(value => value === state.changes)) errors.push('Associated writes are not atomic');
    for (const row of attempts) {
      const receipt = fixture.store.db.prepare('SELECT * FROM knowledge_edit_jobs WHERE id=?').get(operationIds[row.operationId]);
      if (row.txResult === 'duplicate' && receipt?.fingerprint !== fingerprint(row.input)) errors.push('Different fingerprint accepted as duplicate');
      if (row.txResult === 'rolled_back' && row.transactionBefore && !same(row.transactionBefore, row.transactionAfter)) errors.push('Failed transaction changed durable tables');
    }
    return errors;
  };
  return { project, observe, check,
    async act({ action, actor, argument = '' }) {
      const startedAtMs = Date.now(), beforeTables = fixture.tables(), beforeSnapshot = fixture.snapshot(); let detail = {};
      const row = attempts[actor]; if (!['background_change', 'stutter'].includes(action)) assert.ok(row, 'Unknown attempt');
      if (action === 'prepare') {
        assert.equal(row.phase, 'unused'); const snapshot = await fetch(fixture.url, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
        row.loadedRevision = version(snapshot); row.loadedName = index(snapshot.item.canonical_name);
        const reuse = ['exact', 'raw_mismatch', 'revision_mismatch'].includes(argument), first = attempts[0];
        if (reuse) { assert.equal(mode, 'reuse'); assert.equal(actor, 1); assert.equal(first.requests, 1); row.operationId = 0; }
        else assert.ok(['new', 'same'].includes(argument));
        row.submittedName = reuse ? first.submittedName : argument === 'same' ? row.loadedName : actor + 1;
        row.rawName = reuse ? argument === 'raw_mismatch' ? ` ${names[row.submittedName]} ` : first.rawName : names[row.submittedName];
        row.submittedRevision = reuse && argument !== 'revision_mismatch' ? first.submittedRevision : row.loadedRevision;
        row.input = { name: row.rawName, revision: versions[row.submittedRevision] }; row.phase = 'prepared';
      } else if (action === 'send') {
        assert.equal(row.phase, 'prepared'); const task = { id: operationIds[row.operationId], row, queued: deferred(), forward: deferred(), prepared: deferred(), delivery: deferred(), controller: new AbortController() };
        tasks.set(actor, task); row.task = task; row.phase = 'pending';
        task.client = fetch(`${proxyBase}/${actor}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row.input), signal: task.controller.signal })
          .then(response => readKnowledgeEditorResponse(response, 'REPLACE')).then(result => ({ result }), error => ({ error }));
        await wait(task.queued, 'Name POST queued at real proxy');
      } else if (action === 'transaction') {
        assert.equal(row.phase, 'pending'); assert.equal(row.txResult, 'none');
        const before = fixture.tables(), snapshot = fixture.snapshot(), previous = before.knowledge_edit_jobs.find(item => item.id === row.task.id);
        row.transactionBefore = before; row.commitBaseRevision = version(snapshot); row.commitBaseAnchorValid = activeValid(before, seeded.segment.id) || row.submittedName === index(snapshot.item.canonical_name);
        const fault = argument === 'associated_fail' ? 'support-write' : argument === 'receipt_fail' ? 'receipt-success' : null;
        if (fault) installNameWriteFault(fixture.store, fault);
        try { row.task.forward.resolve(); await wait(row.task.prepared, 'Actual synchronous name handler returned'); }
        finally { if (fault) removeNameWriteFault(fixture.store, fault); }
        assert.ok(row.task.actualResponse, row.task.transportError || 'No upstream response');
        const response = row.task.actualResponse, body = JSON.parse(response.text), after = fixture.tables(); row.transactionAfter = after;
        sourceVersion += Number(linked(before).original_text !== linked(after).original_text); evidenceVersion += Number(supportQuote(before) !== supportQuote(after));
        if (response.status === 200) row.txResult = previous ? 'duplicate' : 'committed';
        else if (response.status === 409) row.txResult = body.code === 'KNOWLEDGE_EDIT_STALE' ? 'revision_conflict' : /同一保存任务/.test(body.error) ? 'fingerprint_conflict' : /引用已改变/.test(body.error) ? 'anchor_conflict' : 'unexpected_conflict';
        else if (response.status === 502 && body.saved === false) row.txResult = 'rolled_back'; else throw new Error(`Unexpected name transaction response ${response.status}`);
        const operation = operations[row.operationId], persisted = after.knowledge_edit_jobs.find(item => item.id === row.task.id);
        if (persisted?.state === 'succeeded' && operation.receipt === 'none') Object.assign(operation, { receipt: 'succeeded', receiptRawName: row.rawName,
          receiptInputRevision: row.submittedRevision, receiptCommitRevision: version(fixture.snapshot()), receiptOwner: actor, commits: operation.commits + 1 });
        detail = { id: row.task.id, response: row.task.actualResponse };
      } else if (action === 'deliver' || action === 'lose_response') {
        assert.notEqual(row.txResult, 'none'); row.task.delivery.resolve(action === 'deliver' ? 'normal' : argument); classify(row, await wait({ promise: row.task.client }, 'Name response delivery'));
      } else if (action === 'lookup') {
        assert.equal(row.phase, 'recovering');
        const response = await fetch(argument === 'ok' ? `${fixture.url}/edits/${operationIds[row.operationId]}` : `${proxyBase}/unavailable`, { signal: AbortSignal.timeout(5000) });
        let receipt; try { receipt = (await readKnowledgeEditorResponse(response, 'JOB')).job; } catch { /* Unknown is not an unsaved claim. */ }
        row.phase = receipt?.saved === true ? 'saved' : 'unknown'; row.reply = receipt?.saved === true ? 'receipt' : 'unknown';
        detail = { id: operationIds[row.operationId], status: response.status, receipt: receipt || null };
      } else if (action === 'refresh') {
        const snapshot = await fetch(fixture.url, { signal: AbortSignal.timeout(5000) }).then(response => response.json()); row.loadedRevision = version(snapshot); row.loadedName = index(snapshot.item.canonical_name); row.phase = 'done';
      } else if (action === 'cancel') { assert.equal(row.phase, 'prepared'); row.phase = 'cancelled'; }
      else if (action === 'background_change') {
        assert.equal(background, 'none'); const before = fixture.snapshot();
        if (argument === 'revision') fixture.store.db.prepare('UPDATE segments SET translation_text=? WHERE id=?').run('Synthetic changed linked translation', seeded.segment.id);
        else if (argument === 'anchor') fixture.store.db.prepare("UPDATE relation_supports SET source_revision=? WHERE segment_id=? AND state='active'").run('f'.repeat(64), seeded.segment.id);
        else throw new Error('Unknown background action');
        background = argument; const after = fixture.snapshot(); if (argument === 'anchor') assert.equal(after.revision, before.revision); else assert.notEqual(after.revision, before.revision);
        version(after);
      } else assert.equal(action, 'stutter');
      events.push({ action, actor, argument, startedAtMs, finishedAtMs: Date.now(), before: beforeTables, after: fixture.tables(), beforeSnapshot, afterSnapshot: fixture.snapshot(), ...detail });
      return project();
    },
    async close() {
      if (closed) return; closed = true;
      for (const task of tasks.values()) { task.forward.resolve(); task.delivery.resolve('lost'); task.controller.abort(); }
      try { await Promise.allSettled([...tasks.values()].map(task => task.client)); await closeServer(proxy, 'Name proxy'); }
      finally { await fixture.close(); }
    }
  };
}
