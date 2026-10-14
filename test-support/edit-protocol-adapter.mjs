import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createEditFixture, editNames, editTables } from './edit-protocol-fixture.mjs';
import { preFixRevision } from './knowledge-revision-fixture.mjs';
import { readKnowledgeEditorResponse } from '../public/knowledge-editor.js';
import { closeServer, deadline } from './lifecycle.mjs';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const wait = (gate, label) => deadline(() => gate.promise, 5000, label);
const hasOverride = snapshot => snapshot.item.name_override != null || snapshot.item.name_override_identity != null;
const nameId = value => { const id = editNames.indexOf(value); assert.ok(id >= 0, `Unknown fixture name ${value}`); return id; };
const fields = ['phase', 'loadedRevision', 'loadedName', 'draft', 'submittedRevision', 'submittedName', 'userSaves', 'requests',
  'txResult', 'receipt', 'reply', 'commitBaseRevision', 'commitBaseOverride', 'notification'];

// A real HTTP holding proxy is the modeled network. A synchronous test preload
// observes the actual post-COMMIT/pre-notify stack. It is never a debug endpoint.
// Client state here is a protocol driver using the public response parser; the
// separately linked browser profile checks the actual editor implementation.
export async function createEditProtocolAdapter({ clients = 2, codecs = { 0: 'v1', 1: 'v1' }, initialOverride = false, background = true, mutation = 'none' } = {}) {
  assert.ok([1, 2].includes(clients)); assert.ok(['none', 'bypass_revision', 'auto_revision_resend'].includes(mutation));
  assert.ok(Array.from({ length: clients }, (_, id) => ['v1', 'v11', 'v12'].includes(codecs[id])).every(Boolean));
  const fixture = await createEditFixture({ initialOverride, mutation: mutation === 'bypass_revision' ? mutation : 'none' });
  const versions = [fixture.snapshot().revision], rows = [], tasks = new Map(), violations = [], events = [];
  let serverOwner = -1, backgroundDone = false, closed = false, proxy;
  const version = snapshot => { let id = versions.indexOf(snapshot.revision); if (id < 0) { id = versions.length; versions.push(snapshot.revision); } return id; };
  const token = (snapshot, actor) => codecs[actor] === 'v1' ? snapshot.revision : preFixRevision(snapshot, Number(codecs[actor].slice(1)));
  for (let actor = 0; actor < clients; actor++) rows.push({ actor, phase: 'closed', loadedRevision: -1, loadedName: -1, draft: -1,
    submittedRevision: -1, submittedName: -1, userSaves: 0, requests: 0, txResult: 'none', receipt: 'none', reply: 'none',
    commitBaseRevision: -1, commitBaseOverride: false, notification: 'none', jobs: [], lookups: 0 });
  try {
    proxy = http.createServer(async (request, response) => {
      if (request.url === '/unavailable') { response.writeHead(502, { 'Content-Type': 'text/html' }); response.end('Synthetic unavailable receipt'); return; }
      const id = request.url.slice(1), task = tasks.get(id);
      if (!task || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        task.body = JSON.parse(Buffer.concat(chunks).toString());
        task.row.requests++; task.queued.resolve();
        await task.forward.promise;
        if (closed) { response.destroy(); return; }
        const upstream = await fetch(fixture.url + '/name-replacements', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id },
          body: JSON.stringify(task.body), signal: task.controller.signal });
        task.upstream = { status: upstream.status, text: await upstream.text() }; task.prepared.resolve();
        const mode = await task.delivery.promise;
        if (closed || mode === 'lost') { response.destroy(); return; }
        response.writeHead(mode === 'proxy502' ? 502 : task.upstream.status, { 'Content-Type': mode === 'proxy502' ? 'text/html' : 'application/json' });
        response.end(mode === 'proxy502' ? 'Synthetic gateway response after commit' : task.upstream.text);
      } catch (error) { task.transportError = error.message; task.prepared.resolve(); response.destroy(); }
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  } catch (error) { await fixture.close(); throw error; }
  const proxyBase = `http://127.0.0.1:${proxy.address().port}`;
  const read = async (row, resetDraft = false) => {
    assert.equal(serverOwner, -1, 'Real synchronous handler still owns the transaction/notification stack');
    const snapshot = await readKnowledgeEditorResponse(await fetch(fixture.url, { signal: AbortSignal.timeout(5000) }));
    row.loadedRevision = version(snapshot); row.loadedName = nameId(snapshot.item.canonical_name); row.loadedToken = token(snapshot, row.actor);
    if (resetDraft) row.draft = row.loadedName;
    return snapshot;
  };
  const send = async (row, explicit) => {
    const id = randomUUID(), task = { id, row, queued: deferred(), forward: deferred(), prepared: deferred(), delivery: deferred(), controller: new AbortController() };
    tasks.set(id, task); row.task = task; row.jobs.push(id);
    if (explicit) row.userSaves++;
    row.submittedRevision = row.loadedRevision; row.submittedName = row.draft; row.submittedToken = row.loadedToken;
    row.phase = 'pending'; row.txResult = 'none'; row.reply = 'none'; row.notification = 'none';
    task.client = fetch(`${proxyBase}/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editNames[row.submittedName], revision: row.submittedToken }), signal: task.controller.signal })
      .then(response => readKnowledgeEditorResponse(response, 'REPLACE')).then(result => ({ result }), error => ({ error }));
    await wait(task.queued, 'Actual edit POST queued at transport');
  };
  const classify = (row, received) => {
    if (received.result?.job?.state === 'succeeded' && received.result.job.saved === true) { row.phase = 'saved'; row.reply = 'ok'; }
    else if (received.error?.code === 'KNOWLEDGE_EDIT_STALE') { row.phase = 'conflict'; row.reply = 'conflict'; }
    else if (received.error?.outcomeUnknown === false) { row.phase = 'failed'; row.reply = 'failed'; }
    else { row.phase = 'recovering'; row.reply = 'unknown'; }
  };
  const observe = () => {
    const snapshot = fixture.snapshot();
    return { snapshot, versions: [...versions], graph: fixture.store.graph(fixture.listeningId),
      jobs: fixture.store.db.prepare('SELECT id,revision,name,source,state FROM knowledge_edit_jobs ORDER BY id').all(),
      clients: rows.map(row => ({ actor: row.actor, codec: codecs[row.actor], phase: row.phase, jobs: [...row.jobs],
        requests: row.requests, userSaves: row.userSaves, lookups: row.lookups, loadedToken: row.loadedToken || null,
        submittedToken: row.submittedToken || null, actualRequest: row.task?.body || null, actualResponse: row.task?.upstream || null })),
      events: [...events], providerCalls: fixture.stats.providerRequests.length };
  };
  const project = () => {
    const snapshot = fixture.snapshot();
    for (const row of rows) row.receipt = row.task && fixture.store.knowledgeEditJob(fixture.listeningId, fixture.itemId, row.task.id)?.saved === true ? 'succeeded' : 'none';
    return { revision: version(snapshot), name: nameId(snapshot.item.canonical_name), override: hasOverride(snapshot), serverOwner, backgroundDone,
      ...Object.fromEntries(fields.map(field => [field, Object.fromEntries(rows.map(row => [row.actor, row[field]]))])) };
  };
  const check = () => {
    const result = [...violations];
    if (fixture.stats.providerRequests.length) result.push('Unexpected provider request');
    for (const row of rows) {
      if (row.requests > row.userSaves) result.push(`Client ${row.actor}: automatic POST without an explicit save`);
      if (row.txResult === 'committed' && (row.submittedRevision !== row.commitBaseRevision || codecs[row.actor] === 'v11' && row.commitBaseOverride))
        result.push(`Client ${row.actor}: stale/incompatible revision committed`);
      if ((row.receipt === 'succeeded') !== (row.txResult === 'committed')) result.push(`Client ${row.actor}: receipt is not atomic with transaction outcome`);
      if (row.reply === 'failed' && row.receipt === 'succeeded') result.push(`Client ${row.actor}: committed result presented as unsaved`);
    }
    return result;
  };
  return { project, observe, check,
    async act({ action, actor, argument = '' }) {
      const row = rows[actor];
      if (!['background_change', 'stutter'].includes(action)) assert.ok(row, 'Unknown client');
      if (action === 'read' || action === 'reopen') { await read(row, true); row.phase = 'loaded'; }
      else if (action === 'edit') { assert.ok(['new', 'same'].includes(argument)); row.draft = argument === 'same' ? row.loadedName : actor + 1; row.phase = 'draft'; }
      else if (action === 'send') await send(row, true);
      else if (action === 'transaction') {
        assert.equal(serverOwner, -1); assert.ok(['ok', 'rollback'].includes(argument));
        const before = fixture.snapshot(), tables = editTables(fixture.store);
        row.commitBaseRevision = version(before); row.commitBaseOverride = hasOverride(before);
        await fixture.control(row.task.id, 'request', { pause: true, rollback: argument === 'rollback' });
        row.task.forward.resolve();
        const checkpoint = await fixture.checkpoint(row.task.id, 'transaction'); events.push({ actor, action, checkpoint });
        assert.equal(checkpoint.before.revision, before.revision, 'Transaction must re-read the actual durable version');
        if (checkpoint.error) {
          row.txResult = checkpoint.error.code === 'KNOWLEDGE_EDIT_STALE' ? 'conflict' : 'rolled_back'; row.notification = 'skipped';
          if (!isDeepStrictEqual(editTables(fixture.store), tables)) violations.push(`Client ${actor}: rejected/rolled-back transaction changed a persisted table`);
          await wait(row.task.prepared, 'Rejected transaction HTTP response');
        } else {
          row.txResult = 'committed';
          if (checkpoint.held) serverOwner = actor;
          else { row.notification = 'skipped'; await wait(row.task.prepared, 'No-op committed HTTP response'); }
        }
      } else if (action === 'notify') {
        assert.equal(serverOwner, actor); assert.ok(['ok', 'fail'].includes(argument));
        await fixture.control(row.task.id, 'notify', { failure: argument === 'fail' });
        const checkpoint = await fixture.checkpoint(row.task.id, 'notification'); events.push({ actor, action, checkpoint });
        row.notification = checkpoint.outcome;
        await wait(row.task.prepared, 'Actual post-notification HTTP response'); serverOwner = -1;
      } else if (action === 'deliver' || action === 'lose_response') {
        assert.notEqual(serverOwner, actor); await wait(row.task.prepared, 'Response ready before delivery');
        assert.ok(row.task.upstream, row.task.transportError || 'Missing real upstream response');
        row.task.delivery.resolve(action === 'deliver' ? 'deliver' : argument);
        const received = await deadline(() => row.task.client, 5000, 'Client response delivery'); classify(row, received);
        events.push({ actor, action, transport: argument, outcome: row.reply });
      } else if (action === 'lookup') {
        assert.equal(serverOwner, -1); row.lookups++;
        try {
          const url = argument === 'unavailable' ? proxyBase + '/unavailable' : fixture.url + '/edits/' + row.task.id;
          const result = await readKnowledgeEditorResponse(await fetch(url, { signal: AbortSignal.timeout(5000) }), 'JOB');
          if (result.job?.state === 'succeeded' && result.job.saved === true) { row.phase = 'saved'; row.reply = 'ok'; }
          else { row.phase = 'unknown'; row.reply = 'unknown'; }
        } catch { row.phase = 'unknown'; row.reply = 'unknown'; }
      } else if (action === 'refresh_stale') {
        await read(row);
        if (mutation === 'auto_revision_resend') await send(row, false);
      } else if (action === 'refresh_saved') { await read(row); row.phase = 'done'; }
      else if (action === 'close') {
        assert.ok(['loaded', 'draft', 'conflict', 'failed', 'unknown', 'done'].includes(row.phase), 'Busy manual save cannot close'); row.phase = 'closed';
      } else if (action === 'background_change') {
        assert.ok(background && !backgroundDone); assert.equal(serverOwner, -1);
        const source = fixture.snapshot().segments.find(segment => segment.id === fixture.segmentId).original_text;
        fixture.store.setTranslation(fixture.segmentId, 'Background translation completed.', false, source); backgroundDone = true;
      } else if (action === 'automatic_resend') await send(row, false);
      else assert.equal(action, 'stutter', `Unsupported edit action ${action}`);
    },
    async close() {
      if (closed) return; closed = true;
      for (const task of tasks.values()) { task.forward.resolve(); task.delivery.resolve('lost'); task.controller.abort(); }
      try { await fixture.close(); }
      finally { await closeServer(proxy, 'Edit transport proxy'); }
    }
  };
}
