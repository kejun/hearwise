import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { replaceKnowledgeTerm } from '../knowledge-edit.mjs';
import { graphFixture } from '../test-support/graph-fixture.mjs';
import { randomUUID } from 'node:crypto';

const settings = { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' };
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'knowledge-edit-'));
  const file = path.join(directory, 'store.sqlite');
  const h = { store: new ListeningStore(file) };
  h.reopen = () => { h.store.close(); h.store = new ListeningStore(file); };
  t.after(() => { h.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const run = h.store.createRun(null, settings, 'Manual correction');
  const first = h.store.addSegment(run.listeningId, run.runId, { id: '1', text: 'Open Eye builds tools. OPEN EYE helps.' }).segment;
  const other = h.store.addSegment(run.listeningId, run.runId, { id: '2', text: 'Open Eye is a different object here.' }).segment;
  for (const segment of [first, other]) h.store.setTranslation(segment.id, '已有译文', false);
  h.store.finishRun(run.runId);
  const raw = { type: 'other', canonical_name: 'Open Eye', aliases: [], dialogue_summary: '旧内容', background_note: null,
    certainty: 'clear', decision: 'create', existing_item_id: null, correction_reason: null,
    evidence: [{ segment_id: first.id, quote: 'Open Eye' }] };
  const [item] = h.store.applyKnowledge(run.listeningId, [raw]);
  return Object.assign(h, run, { first, other, item, raw });
}
function prepare(h, name = 'OpenAI', source = h.item.canonical_name) {
  const snapshot = h.store.knowledgeEditSnapshot(h.listeningId, h.item.id);
  return h.store.prepareKnowledgeEdit(h.listeningId, h.item.id, { name, source, revision: snapshot.revision });
}
function card(prepared) {
  const segment = prepared.correctedSegments[0];
  return { short_description: '工具开发者', dialogue_summary: `${prepared.name} 开发工具。`,
    facts: [{ content: `${prepared.name} 开发工具。`, segment_id: segment.id, quote: segment.original_text }],
    evidence: [{ segment_id: segment.id, quote: segment.original_text }] };
}

test('literal replacement respects Latin boundaries, CJK, case, regex characters and replacement dollars', () => {
  assert.equal(replaceKnowledgeTerm('AI RAIL ai', 'AI', '$&'), '$& RAIL $&');
  assert.equal(replaceKnowledgeTerm('介绍千文模型', '千文', '千问'), '介绍千问模型');
  assert.equal(replaceKnowledgeTerm('C++ differs from C+ and AC++', 'C++', 'C#'), 'C# differs from C+ and AC++');
});
test('atomic correction only changes linked source, persists across reopen and resume, fences V1/V2 extraction', t => {
  const h = fixture(t), prepared = prepare(h);
  const updated = h.store.saveKnowledgeEdit(h.listeningId, h.item.id, prepared, card(prepared));
  assert.equal(updated.canonical_name, 'OpenAI');
  assert.equal(updated.id, h.item.id);
  assert.equal(updated.content_version, 2);
  assert.equal(updated.facts.length, 1);
  assert.match(updated.revisions[0].reason, /人工/);
  const detail = h.store.detail(h.listeningId);
  assert.equal(detail.segments[0].original_text, 'OpenAI builds tools. OpenAI helps.');
  assert.equal(detail.segments[1].original_text, h.other.original_text);
  assert.equal(detail.segments[0].translation_text, '已有译文');
  assert.match(h.store.exportText(h.listeningId, 'original').text, /OpenAI builds tools/);
  assert.deepEqual(h.store.applyKnowledge(h.listeningId, [h.raw]), []);
  assert.deepEqual(h.store.applyKnowledgeV2(h.listeningId, [{ ...h.raw, action: 'create', display_label: 'organization' }]), []);
  h.reopen();
  const run = h.store.createRun(h.listeningId, settings);
  const segment = h.store.addSegment(h.listeningId, run.runId, { id: '3', text: 'OPEN EYE returns.' }).segment;
  assert.equal(segment.original_text, 'OpenAI returns.');
  const another = h.store.createRun(null, settings, 'Other listening');
  assert.equal(h.store.addSegment(another.listeningId, another.runId, { id: '1', text: 'Open Eye' }).segment.original_text, 'Open Eye');
});
test('stale drafts, missing anchors, active runs and pending extraction cannot write', t => {
  const h = fixture(t), prepared = prepare(h);
  assert.throws(() => h.store.prepareKnowledgeEdit(h.listeningId, h.item.id, { name: 'OpenAI', source: 'Missing', revision: prepared.revision }), { status: 400 });
  h.store.saveKnowledgeEdit(h.listeningId, h.item.id, prepared, card(prepared));
  assert.throws(() => h.store.saveKnowledgeEdit(h.listeningId, h.item.id, prepared, card(prepared)), { status: 409 });
  assert.throws(() => h.store.deleteKnowledgeItem(h.listeningId, h.item.id, prepared.revision), { status: 409 });
  const run = h.store.createRun(h.listeningId, settings);
  assert.throws(() => h.store.knowledgeEditSnapshot(h.listeningId, h.item.id), { status: 409 });
  h.store.finishRun(run.runId);
  h.store.createExtractionJob(h.listeningId, [h.first]);
  assert.throws(() => h.store.knowledgeEditSnapshot(h.listeningId, h.item.id), { status: 409 });
});
test('transaction rollback preserves card, transcript and rules on invalid generated evidence', t => {
  const h = fixture(t), prepared = prepare(h), before = h.store.detail(h.listeningId);
  assert.throws(() => h.store.saveKnowledgeEdit(h.listeningId, h.item.id, prepared,
    { ...card(prepared), facts: [{ content: 'x', segment_id: 'missing', quote: 'x' }] }));
  assert.deepEqual(h.store.detail(h.listeningId), before);
  assert.equal(h.store.correctKnowledgeText(h.listeningId, 'Open Eye'), 'Open Eye');
});
test('deletion persists a tombstone, preserves source and correction rules and prevents resurrection', t => {
  const h = fixture(t), prepared = prepare(h);
  h.store.saveKnowledgeEdit(h.listeningId, h.item.id, prepared, card(prepared));
  const snapshot = h.store.knowledgeEditSnapshot(h.listeningId, h.item.id);
  h.store.deleteKnowledgeItem(h.listeningId, h.item.id, snapshot.revision);
  h.reopen();
  assert.deepEqual(h.store.applyKnowledge(h.listeningId, [h.raw, { ...h.raw, canonical_name: 'OpenAI' }]), []);
  assert.deepEqual(h.store.applyKnowledgeV2(h.listeningId, [{ ...h.raw, action: 'create', canonical_name: 'OpenAI' }]), []);
  assert.equal(h.store.knowledge(h.listeningId).length, 0);
  assert.match(h.store.exportText(h.listeningId, 'original').text, /OpenAI/);
  assert.equal(h.store.correctKnowledgeText(h.listeningId, 'Open Eye'), 'OpenAI');
  assert.deepEqual(h.store.graph(h.listeningId).deletedItemIds, [h.item.id]);
});
test('a second correction updates earlier mappings without cascading other rules', t => {
  const h = fixture(t), first = prepare(h);
  h.store.saveKnowledgeEdit(h.listeningId, h.item.id, first, card(first));
  const second = prepare(h, 'Open AI', 'OpenAI');
  h.store.saveKnowledgeEdit(h.listeningId, h.item.id, second, card(second));
  assert.equal(h.store.correctKnowledgeText(h.listeningId, 'Open Eye and OpenAI'), 'Open AI and Open AI');
});

test('durable edit receipts commit atomically, reject changed retries and recover only unfinished work', t => {
  const h = fixture(t), prepared = prepare(h), id = randomUUID();
  const input = { name: prepared.name, source: prepared.source, revision: prepared.revision, key: 'must-not-be-stored' };
  h.store.createKnowledgeEditJob(h.listeningId, h.item.id, id, input);
  assert.throws(() => h.store.knowledgeEditJob(h.listeningId, h.item.id, id, { ...input, name: 'Other' }), { status: 409 });
  assert.doesNotMatch(JSON.stringify(h.store.db.prepare('SELECT * FROM knowledge_edit_jobs').all()), /must-not-be-stored/);
  assert.throws(() => h.store.saveKnowledgeEdit(h.listeningId, h.item.id, prepared,
    { ...card(prepared), facts: [{ content: 'bad', segment_id: 'missing', quote: 'bad' }] }, id));
  assert.equal(h.store.knowledgeEditJob(h.listeningId, h.item.id, id).state, 'running');
  h.store.saveKnowledgeEdit(h.listeningId, h.item.id, prepared, card(prepared), id);
  const second = randomUUID();
  const savedRevision = h.store.knowledgeEditSnapshot(h.listeningId, h.item.id).revision;
  h.store.createKnowledgeEditJob(h.listeningId, h.item.id, second, { ...input, name: 'Open AI', revision: savedRevision });
  h.reopen(); h.store.recoverKnowledgeEditJobs();
  assert.equal(h.store.knowledgeEditJob(h.listeningId, h.item.id, id, input).saved, true);
  assert.equal(h.store.knowledgeEditJob(h.listeningId, h.item.id, second).saved, false);
  assert.match(h.store.knowledgeEditJob(h.listeningId, h.item.id, second).error, /重启/);
  assert.equal(h.store.knowledgeEditForSnapshot(h.listeningId, h.item.id, savedRevision).id, second);
  assert.equal(h.store.knowledgeEditForSnapshot(h.listeningId, h.item.id, 'different-revision'), undefined);
  assert.equal(h.store.knowledge(h.listeningId)[0].canonical_name, 'OpenAI');
});

test('v10 migration adds edit jobs while preserving existing cards and transcript', t => {
  const h = fixture(t), before = h.store.detail(h.listeningId);
  h.store.db.exec('DROP TABLE knowledge_edit_jobs; PRAGMA user_version=10');
  h.reopen();
  assert.equal(h.store.db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.deepEqual(h.store.detail(h.listeningId), before);
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM knowledge_edit_jobs').get().n, 0);
});

test('async saves acknowledge before model completion, deduplicate retries and expose durable outcomes', async t => {
  let release, invalid = false, generations = 0;
  let barrier = new Promise(resolve => { release = resolve; });
  const f = await graphFixture({ modelResponse: async body => {
    const input = JSON.parse(body.messages.at(-1).content);
    if (!input.name) return { items: [] };
    generations++;
    await barrier;
    return { short_description: '相机公司', dialogue_summary: '推出相机。', facts: [
      { content: '推出相机。', segment_id: input.segments[0].id, quote: invalid ? 'fabricated' : input.segments[0].text }] };
  } });
  t.after(() => { release(); return f.close(); });
  const first = f.seeded.first, item = first.nodes[0], id = randomUUID();
  const url = `${f.base}/api/listenings/${first.listeningId}/knowledge/${item.id}`;
  const snapshot = await (await fetch(url)).json();
  const input = { name: 'Kodak', source: 'Eastman Kodak', revision: snapshot.revision, key: 'fixture-key' };
  const submit = (jobId = id, body = input) => fetch(url, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'respond-async', 'Idempotency-Key': jobId },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  const responses = await Promise.all([submit(), submit()]);
  assert.deepEqual(responses.map(r => r.status), [202, 202]);
  const running = (await responses[0].json()).job;
  assert.equal(running.state, 'running'); assert.equal(running.saved, null);
  assert.equal((await (await fetch(url)).json()).editJob.id, id);
  assert.equal((await submit(randomUUID())).status, 409);
  assert.equal((await submit(id, { ...input, name: 'Other' })).status, 409);
  const statusUrl = `${url}/edits/${id}`;
  assert.equal((await (await fetch(statusUrl)).json()).job.state, 'running');
  release();
  async function terminal(jobId) {
    for (let i = 0; i < 100; i++) {
      const job = (await (await fetch(`${url}/edits/${jobId}`)).json()).job;
      if (job.state !== 'running') return job;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('job did not complete');
  }
  assert.equal((await terminal(id)).saved, true);
  assert.equal((await (await submit()).json()).job.saved, true);
  assert.equal(generations, 1);
  assert.equal((await (await fetch(url)).json()).item.canonical_name, 'Kodak');
  const next = await (await fetch(url)).json(), failedId = randomUUID();
  invalid = true;
  assert.equal((await submit(failedId, { ...input, source: 'Kodak', name: 'Bad', revision: next.revision })).status, 202);
  const failed = await terminal(failedId);
  assert.equal(failed.saved, false); assert.match(failed.error, /原内容未更改/);
  assert.equal((await (await fetch(url)).json()).revision, next.revision);
  assert.equal((await fetch(statusUrl.replace(item.id, f.seeded.second.nodes[0].id))).status, 404);
});

test('HTTP regeneration, schema/origin/key errors, model failure, deletion and export use real server', async t => {
  let invalid = true;
  const f = await graphFixture({ modelResponse: async body => {
    const input = JSON.parse(body.messages.at(-1).content);
    if (!input.name) return { items: [] };
    await new Promise(resolve => setTimeout(resolve, 60));
    return { short_description: '柯达公司', dialogue_summary: `${input.name} 推出了相机。`,
      facts: [{ content: `${input.name} 推出了相机。`, segment_id: input.segments[0].id,
        quote: invalid ? 'fabricated quote' : input.segments[0].text }] };
  } });
  t.after(() => f.close());
  const { first } = f.seeded, item = first.nodes[0];
  const url = `${f.base}/api/listenings/${first.listeningId}/knowledge/${item.id}`;
  const snapshot = await (await fetch(url)).json();
  const payload = { name: 'Kodak', source: 'Eastman Kodak', revision: snapshot.revision, key: 'test-only' };
  const request = (body, method = 'PATCH', origin = f.base) => fetch(url, { method,
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request(payload, 'PATCH', 'https://unrelated.example')).status, 403);
  assert.equal((await request({ ...payload, key: '' })).status, 400);
  assert.equal((await request({ ...payload, extra: true })).status, 400);
  assert.equal((await request(payload)).status, 502);
  assert.deepEqual(await (await fetch(url)).json(), snapshot);
  invalid = false;
  const callsBefore = f.stats.providerRequests.length;
  const concurrent = await Promise.all([request(payload), request(payload)]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  assert.equal(f.stats.providerRequests.length - callsBefore, 1, 'concurrent writes must not issue duplicate paid requests');
  const saved = concurrent.find(response => response.status === 200);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await saved.json()).item.canonical_name, 'Kodak');
  const original = await (await fetch(`${f.base}/api/listenings/${first.listeningId}/export?kind=original`)).text();
  assert.match(original, /Kodak released/);
  assert.doesNotMatch(original, /Eastman Kodak/);
  assert.equal((await request(payload)).status, 409);
  const fresh = await (await fetch(url)).json();
  assert.equal((await request({ revision: fresh.revision }, 'DELETE')).status, 200);
  assert.equal((await fetch(url)).status, 404);
  const graph = await (await fetch(`${f.base}/api/listenings/${first.listeningId}/graph`)).json();
  assert.ok(!graph.nodes.some(node => node.id === item.id));
  assert.ok(graph.deletedItemIds.includes(item.id));
});
