import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { openNameTransaction, nameTables, nameWriteFaults, installNameWriteFault, removeNameWriteFault } from '../test-support/name-transaction-fixture.mjs';
import { referenceMatches, referenceText } from '../verification/name-interval/corpus.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, suffix = '') {
  const directory = mkdtempSync(path.join(tmpdir(), 'name-transaction-'));
  const h = openNameTransaction(path.join(directory, `${suffix || 'case'}.sqlite`));
  t.after(() => { h.close(); rmSync(directory, { recursive: true, force: true }); });
  return h;
}
function current(h, name) { return { name, revision: h.snapshot().revision }; }

test('an exact old operation replays its fixed receipt after a newer correction; raw name and revision changes are distinct fingerprints', t => {
  const h = fixture(t), id = randomUUID(), input = current(h, 'Tibo'), first = h.rename(id, input);
  h.rename(randomUUID(), current(h, 'Mira'));
  const before = nameTables(h.store), latest = h.snapshot();
  const replay = h.rename(id, input);
  assert.deepEqual(replay.job, first.job); assert.equal(replay.changed, false); assert.deepEqual(nameTables(h.store), before);
  for (const different of [{ ...input, name: ' Tibo ' }, { ...input, revision: latest.revision }]) {
    assert.throws(() => h.rename(id, different), error => error.status === 409 && /同一保存任务/.test(error.message));
    assert.deepEqual(nameTables(h.store), before);
  }
  assert.equal(h.snapshot().item.canonical_name, 'Mira');
  assert.throws(() => h.store.replaceKnowledgeName(h.unrelated.listeningId, h.unrelated.item.id, id, input), { status: 409 });
  assert.deepEqual(nameTables(h.store), before);
});

test('all associated write, receipt and real COMMIT failure boundaries roll back every table and permit the same ID retry', async t => {
  for (const [fault] of nameWriteFaults) await t.test(fault, t => {
    const h = fixture(t), id = randomUUID(), input = current(h, '😀 Longer');
    installNameWriteFault(h.store, fault);
    const before = nameTables(h.store);
    assert.throws(() => h.rename(id, input), error => fault === 'commit-deferred'
      ? /FOREIGN KEY constraint failed/.test(error.message) : error.message === `synthetic name transaction ${fault}`);
    assert.deepEqual(nameTables(h.store), before);
    assert.equal(h.store.knowledgeEditJob(h.listeningId, h.item.id, id), undefined);
    const reopened = new ListeningStore(h.filename);
    try { assert.deepEqual(nameTables(reopened), before); } finally { reopened.close(); }
    removeNameWriteFault(h.store, fault);
    const saved = h.rename(id, input); assert.equal(saved.job.saved, true); assert.equal(saved.item.canonical_name, input.name);
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM knowledge_edit_jobs WHERE id=?').get(id).n, 1);
  });
});

test('a changed active anchor is rejected inside the transaction even when the knowledge revision remains equal', t => {
  const h = fixture(t), input = current(h, 'Tibo'), id = randomUUID();
  h.store.db.prepare("UPDATE relation_supports SET source_revision=? WHERE segment_id=? AND state='active'").run('f'.repeat(64), h.segment.id);
  assert.equal(h.snapshot().revision, input.revision, 'Anchor guard is independently necessary');
  const before = nameTables(h.store);
  assert.throws(() => h.rename(id, input), error => error.status === 409 && /引用已改变/.test(error.message));
  assert.deepEqual(nameTables(h.store), before); assert.equal(h.store.knowledgeEditJob(h.listeningId, h.item.id, id), undefined);
});

test('seeded Unicode rename sequences preserve identity, stale history, other listening and exact duplicate idempotency', t => {
  const targets = ['T', 'Tibo Longname', '李四五', '😀X', 'e\u0301', 'New  Name', '$&-$1', '🧑‍🔬'];
  let state = 0x4b454a71; const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (let sample = 0; sample < 32; sample++) {
    const h = fixture(t, String(sample)), initial = nameTables(h.store), original = h.snapshot(), unrelated = h.store.detail(h.unrelated.listeningId);
    const firstName = targets[next() % targets.length], secondName = targets[next() % targets.length];
    const id = randomUUID(), body = current(h, firstName), receipt = h.rename(id, body).job;
    const firstText = referenceText(original.segments[0].original_text, referenceMatches(original.segments[0].original_text, 'Deebo'), firstName);
    assert.equal(h.snapshot().segments[0].original_text, firstText);
    h.rename(randomUUID(), current(h, secondName));
    const after = nameTables(h.store), snapshot = h.snapshot();
    assert.equal(snapshot.segments[0].original_text, referenceText(firstText, referenceMatches(firstText, firstName), secondName));
    assert.deepEqual(h.rename(id, body).job, receipt); assert.deepEqual(nameTables(h.store), after);
    const beforeStale = initial.relation_supports.find(row => row.id === h.staleId);
    assert.deepEqual(after.relation_supports.find(row => row.id === h.staleId), beforeStale);
    assert.deepEqual(after.relations, initial.relations);
    assert.deepEqual(after.relation_jobs, initial.relation_jobs); assert.deepEqual(after.relation_windows, initial.relation_windows);
    assert.deepEqual(after.knowledge_items.map(row => row.id), initial.knowledge_items.map(row => row.id));
    assert.equal(snapshot.item.id, h.item.id);
    assert.equal(h.store.db.prepare('SELECT original_text FROM segments WHERE id=?').get(h.other.id).original_text, h.other.original_text);
    assert.deepEqual(h.store.detail(h.unrelated.listeningId), unrelated);
    for (const table of ['knowledge_items', 'segments', 'relation_jobs', 'relation_windows', 'relations'])
      assert.deepEqual(after[table].filter(row => row.listening_id === h.unrelated.listeningId), initial[table].filter(row => row.listening_id === h.unrelated.listeningId));
    const text = snapshot.segments[0].original_text;
    for (const row of after.relation_supports.filter(row => row.segment_id === h.segment.id && row.state === 'active')) {
      assert.equal(row.source_revision, hash(text)); assert.equal(text.slice(row.start, row.end), row.quote);
    }
  }
});

test('isolated real production-copy mutations expose fingerprint and receipt atomicity violations', async t => {
  const { nameMutation } = await import('../test-support/name-protocol-mutations.mjs');
  const { seedNameTransaction } = await import('../test-support/name-transaction-fixture.mjs');
  const directory = mkdtempSync(path.join(tmpdir(), 'name-negative-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const mutation of ['bypass_fingerprint', 'non_atomic_receipt']) {
    const { Store, evidence } = await nameMutation(directory, mutation);
    assert.notEqual(evidence.sourceDigest, evidence.mutatedDigest);
    const store = new Store(path.join(directory, `${mutation}.sqlite`));
    try {
      const h = seedNameTransaction(store), id = randomUUID();
      const input = { name: 'Tibo', revision: store.knowledgeEditSnapshot(h.listeningId, h.item.id).revision };
      if (mutation === 'bypass_fingerprint') {
        const receipt = store.replaceKnowledgeName(h.listeningId, h.item.id, id, input).job;
        const before = nameTables(store);
        const wrong = store.replaceKnowledgeName(h.listeningId, h.item.id, id, { ...input, name: ' Tibo ' });
        assert.deepEqual(wrong.job, receipt, 'Broken guard incorrectly accepts a different raw fingerprint');
        assert.deepEqual(nameTables(store), before);
      } else {
        installNameWriteFault(store, 'receipt-success'); const before = nameTables(store);
        assert.throws(() => store.replaceKnowledgeName(h.listeningId, h.item.id, id, input), /synthetic name transaction receipt-success/);
        assert.notDeepEqual(nameTables(store), before, 'Broken transaction leaves associated writes behind');
        assert.equal(store.knowledgeEditSnapshot(h.listeningId, h.item.id).item.canonical_name, 'Tibo');
        assert.equal(store.knowledgeEditJob(h.listeningId, h.item.id, id).state, 'running');
      }
    } finally { store.close(); }
  }
});

test('immutable receipt lookup precedes busy admission and newer-revision checks, but rejects altered input first', t => {
  const h = fixture(t), id = randomUUID(), input = current(h, 'Tibo'), first = h.rename(id, input);
  h.rename(randomUUID(), current(h, 'Mira'));
  const before = nameTables(h.store), latest = h.snapshot();
  const replay = h.store.replaceKnowledgeName(h.listeningId, h.item.id, id, input, { busy: true });
  assert.deepEqual(replay.job, first.job); assert.equal(replay.changed, false); assert.deepEqual(nameTables(h.store), before);
  for (const altered of [{ ...input, name: ' Tibo ' }, { ...input, revision: latest.revision }]) {
    assert.throws(() => h.store.replaceKnowledgeName(h.listeningId, h.item.id, id, altered, { busy: true }),
      error => error.status === 409 && /同一保存任务/.test(error.message));
    assert.deepEqual(nameTables(h.store), before);
  }
  assert.throws(() => h.store.replaceKnowledgeName(h.listeningId, h.item.id, randomUUID(), current(h, 'Tibo'), { busy: true }),
    error => error.status === 409 && /正在保存/.test(error.message));
  assert.deepEqual(nameTables(h.store), before);
});
