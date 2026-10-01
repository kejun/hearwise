import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { readRelationDiagnostics, relationReasonSummary } from '../relation-diagnostics.mjs';

test('reason summaries accept only fixed public codes, never raw errors or model text', () => {
  const summary = relationReasonSummary([{ code: 'FIELD_INVALID' }, { code: 'Bearer SECRET' }, { code: 'Arbitrary transcript text' }, { code: '__proto__' }]);
  assert.equal(summary.find(r => r.code === 'UNKNOWN_REASON').count, 3);
  assert.doesNotMatch(JSON.stringify(summary), /SECRET|Arbitrary|__proto__/);
});

test('read-only CLI diagnoses v8 unknowns and rejects without mutating the DB or exposing content', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relation-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data.sqlite'), store = new ListeningStore(file);
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'PRIVATE TITLE');
  const seg = store.addSegment(run.listeningId, run.runId, { id: 'source', text: 'SECRET Atlas launched Nova.' }).segment;
  for (const name of ['Atlas', 'Nova']) store.applyKnowledge(run.listeningId, [{ type: 'other', canonical_name: name, aliases: [], dialogue_summary: 'PRIVATE DESCRIPTION', background_note: null, certainty: 'clear', decision: 'create', existing_item_id: null, correction_reason: null, evidence: [{ segment_id: seg.id, quote: name }] }]);
  store.enableRelations(run.listeningId);
  const job = store.nextRelationJob(run.listeningId, { quietMs: 0 }); store.beginRelationRequest(job.id);
  store.commitRelationJob(job.id, { relations: [], rejected: [{ code: 'SEMANTIC_NEGATION_DROPPED' }] });
  store.db.prepare('UPDATE relation_jobs SET rejected_json=? WHERE id=?').run(JSON.stringify([{ code: 'SEMANTIC_NEGATION_DROPPED' }, { code: 'SECRET RAW LEGACY ERROR' }]), job.id);
  for (const column of ['returned_count', 'validator_accepted_count', 'accepted_count', 'inserted_relation_count', 'deduplicated_count']) store.db.exec(`ALTER TABLE relation_jobs DROP COLUMN ${column}`);
  store.db.exec('PRAGMA user_version=8'); store.close();
  const before = readFileSync(file);
  const result = spawnSync(process.execPath, ['scripts/diagnose-relations.mjs', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /SECRET|PRIVATE|Atlas|Nova/);
  assert.ok(!result.stdout.includes(run.listeningId));
  const data = JSON.parse(result.stdout);
  assert.equal(data.schemaVersion, 8); assert.equal(data.diagnostics.returnedCount, null);
  assert.equal(data.diagnostics.unknownJobs, 1); assert.equal(data.diagnostics.rejectedCount, 2);
  assert.equal(data.diagnostics.rejectionReasons.find(r => r.code === 'SEMANTIC_NEGATION_DROPPED').count, 1);
  assert.deepEqual(readFileSync(file), before, 'read-only diagnostic must not migrate or write');
});

test('failed or pending jobs do not falsely report that the model returned zero relations', () => {
  const store = new ListeningStore(':memory:');
  try {
    const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Test');
    const seg = store.addSegment(run.listeningId, run.runId, { id: 's', text: 'Atlas launched Nova.' }).segment;
    for (const name of ['Atlas', 'Nova']) store.applyKnowledge(run.listeningId, [{ type: 'other', canonical_name: name, aliases: [], dialogue_summary: name, background_note: null, certainty: 'clear', decision: 'create', existing_item_id: null, correction_reason: null, evidence: [{ segment_id: seg.id, quote: name }] }]);
    store.enableRelations(run.listeningId); const job = store.nextRelationJob(run.listeningId, { quietMs: 0 });
    assert.equal(readRelationDiagnostics(store.db, run.listeningId).returnedCount, null);
    store.beginRelationRequest(job.id); store.failRelationJob(job.id, { code: 'RELATION_INVALID_RESPONSE', terminal: true });
    const diagnostics = readRelationDiagnostics(store.db, run.listeningId);
    assert.equal(diagnostics.returnedCount, null); assert.equal(diagnostics.acceptedCount, null);
    assert.equal(diagnostics.failureReasons[0].code, 'RELATION_INVALID_RESPONSE');
  } finally { store.close(); }
});
