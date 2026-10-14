import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { seedNameReplacement } from '../test-support/name-replacement-fixture.mjs';
import { speechFixture } from '../test-support/speech-fixture.mjs';
import WebSocket from 'ws';

const until = async predicate => {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error('Session consistency observation timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
function storeFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'session-version-'));
  const filename = path.join(directory, 'test.sqlite');
  const h = { store: new ListeningStore(filename) };
  Object.assign(h, seedNameReplacement(h.store));
  // Model a legitimately pending request captured before a local name correction.
  h.store.db.prepare("UPDATE segments SET translation_text=NULL, translation_state='pending' WHERE id=?").run(h.segment.id);
  h.rename = (name = 'Tibo') => h.store.replaceKnowledgeName(h.listeningId, h.item.id, randomUUID(), {
    name, revision: h.store.knowledgeEditSnapshot(h.listeningId, h.item.id).revision
  });
  h.row = () => h.store.detail(h.listeningId).segments.find(s => s.id === h.segment.id);
  h.reopen = () => { h.store.close(); h.store = new ListeningStore(filename); };
  t.after(() => { h.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return h;
}

for (const failed of [false, true]) test(`a ${failed ? 'failed' : 'successful'} old translation cannot commit against a corrected persistent source`, t => {
  const h = storeFixture(t), oldSource = h.row().original_text;
  // A concurrent failed attempt makes editing legal while this older attempt is still in flight.
  h.store.setTranslation(h.segment.id, null, true);
  h.rename(); h.reopen();
  const current = h.row();
  assert.notEqual(current.original_text, oldSource);
  const stale = h.store.setTranslation(current.id, failed ? null : 'OLD SOURCE RESPONSE', failed, oldSource);
  assert.equal(stale, undefined);
  assert.deepEqual(h.row(), current, 'late old result must not alter pending source, translation or state');
  const valid = h.store.setTranslation(current.id, '有效新译文', false, current.original_text);
  assert.equal(valid.translation_text, '有效新译文');
  h.store.setTranslation(current.id, 'ANOTHER OLD RESPONSE', false, oldSource);
  h.reopen();
  assert.equal(h.row().translation_text, '有效新译文');
  assert.equal(h.row().original_text, current.original_text);
});

test('ASR final identity is run plus sentence ID; stop accepts its tail but rejects a final queued after task-finished', { timeout: 15000 }, async t => {
  const fixture = await speechFixture();
  const clients = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); await fixture.close(); });
  const start = async listeningId => {
    const ws = new WebSocket(fixture.base.replace('http:', 'ws:') + '/ws'), events = [];
    clients.push(ws); ws.on('message', raw => events.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'start', key: 'fixture-only', source: 'en', targetLang: 'English', audioSource: 'microphone', listeningId }));
    await until(() => events.some(e => e.type === 'listening-ready'));
    return { ws, events, ...events.find(e => e.type === 'listening-ready') };
  };
  const first = await start();
  fixture.final('First 😀.', true, 'same'); fixture.final('First 😀.', true, 'same');
  fixture.final('Conflicting final.', true, 'same');
  await until(() => first.events.some(e => e.type === 'caption-correction'));
  assert.equal(first.events.filter(e => e.type === 'segment-final').length, 1);
  // One upstream TCP batch deliberately places a final after the terminal frame.
  const upstream = [...fixture.stats.asrClients][0];
  const tail = text => JSON.stringify({ header: { event: 'result-generated' }, payload: { output: {
    sentence: { sentence_id: text, text, sentence_end: true } } } });
  upstream.send(tail('Valid stop tail.'));
  upstream.send(JSON.stringify({ header: { event: 'task-finished' } }));
  upstream.send(tail('INVALID AFTER FINISHED'));
  await new Promise(resolve => first.ws.once('close', resolve));
  const read = async id => (await fetch(`${fixture.base}/api/listenings/${id}`)).json();
  const detail = await read(first.listeningId);
  assert.deepEqual(detail.segments.map(s => s.original_text), ['First 😀.', 'Valid stop tail.']);
  assert.equal(detail.runs[0].state, 'complete');
  const second = await start(first.listeningId);
  fixture.final('New run same identity.', true, 'same');
  await until(() => second.events.some(e => e.type === 'segment-final'));
  second.ws.send(JSON.stringify({ type: 'stop' }));
  await new Promise(resolve => second.ws.once('close', resolve));
  const recovered = await read(first.listeningId);
  assert.equal(recovered.runs.length, 2);
  assert.deepEqual(recovered.segments.map(s => s.sequence_no), [1, 2, 3]);
  assert.notEqual(recovered.segments[0].run_id, recovered.segments[2].run_id);
  assert.equal(recovered.segments[0].asr_sentence_id, recovered.segments[2].asr_sentence_id);
});

test('HTTP retry, failed concurrent attempt, source correction and late provider result preserve the persisted source version', { timeout: 15000 }, async t => {
  const pending = [];
  const fixture = await speechFixture({
    seed(store) {
      const h = seedNameReplacement(store);
      store.db.prepare("UPDATE segments SET translation_text=NULL, translation_state='failed' WHERE id=?").run(h.segment.id);
      return h;
    },
    modelResponse(body) {
      if (body.model !== 'qwen-mt-flash') return { items: [] };
      return new Promise(resolve => pending.push({ source: body.messages[0].content, resolve }));
    }
  });
  t.after(async () => { for (const request of pending) request.resolve('cleanup'); await fixture.close(); });
  const h = fixture.seeded, url = `${fixture.base}/api/listenings/${h.listeningId}`;
  const json = async (endpoint, options) => {
    const response = await fetch(endpoint, options);
    const body = await response.json();
    assert.ok(response.ok, JSON.stringify(body));
    return body;
  };
  const post = (endpoint, body, extra = {}) => json(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const row = async () => (await json(url)).segments.find(s => s.id === h.segment.id);
  await post(`${url}/retry`, { key: 'fixture-only' }); await until(() => pending.length === 1);
  await post(`${url}/retry`, { key: 'fixture-only' }); await until(() => pending.length === 2);
  // Retry is a waiting-set dedupe, not in-flight dedupe. The second response fails first.
  pending[1].resolve('');
  await until(async () => (await row()).translation_state === 'failed' && fixture.logs().includes('model_error translation:other'));
  const snapshot = await json(`${url}/knowledge/${h.item.id}`);
  await post(`${url}/knowledge/${h.item.id}/name-replacements`, { name: 'Tibo', revision: snapshot.revision }, { 'Idempotency-Key': randomUUID() });
  const corrected = await row(), revised = await json(`${url}/knowledge/${h.item.id}`);
  assert.notEqual(revised.revision, snapshot.revision);
  assert.notEqual(corrected.original_text, pending[0].source);
  pending[0].resolve('OLD SOURCE RESPONSE');
  await until(() => fixture.logs().includes('"stage":"model","kind":"background"'));
  assert.deepEqual(await row(), corrected, 'the old successful HTTP response must be discarded');
  await post(`${url}/retry`, { key: 'fixture-only' }); await until(() => pending.length === 3);
  assert.equal(pending[2].source, corrected.original_text);
  pending[2].resolve('新版本有效译文 😀');
  await until(async () => (await row()).translation_state === 'complete');
  assert.equal((await row()).translation_text, '新版本有效译文 😀');
  assert.equal((await row()).original_text, corrected.original_text);
});


for (const failed of [false, true]) test(`A→B→A retains the existing content-source version for an old ${failed ? 'failure' : 'success'}, without overwriting a new completion`, t => {
  const h = storeFixture(t), source = h.row().original_text;
  h.store.setTranslation(h.segment.id, null, true);
  const before = h.store.knowledgeEditSnapshot(h.listeningId, h.item.id).revision;
  h.rename('Tibo'); h.rename('Deebo'); h.reopen();
  assert.equal(h.row().original_text, source);
  assert.notEqual(h.store.knowledgeEditSnapshot(h.listeningId, h.item.id).revision, before,
    'editing revision includes knowledge changes; source content version remains equal');
  const accepted = h.store.setTranslation(h.segment.id, failed ? null : '同内容译文', failed, source);
  assert.equal(accepted.translation_state, failed ? 'failed' : 'complete');
  if (failed) h.store.setTranslation(h.segment.id, '有效新译文', false, source);
  const complete = h.row();
  assert.equal(h.store.setTranslation(h.segment.id, failed ? null : '重复旧译文', failed, source), undefined);
  h.reopen(); assert.deepEqual(h.row(), complete);
});
