// This reader validates offline capture artifacts. It cannot grant quality acceptance.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hashBytes, contractDigest } from './quality-contract.mjs';
import { semanticDatabase, semanticUnits } from './semantic-quality-capture.mjs';
import { KNOWLEDGE_MODEL, CONTRACT_REVISION } from '../../knowledge.mjs';
import { RELATION_MODEL, RELATION_CONTRACT_VERSION } from '../../relations.mjs';
const same = (a, b) => assert.equal(contractDigest(a), contractDigest(b));
export async function readSemanticCapture(directory, targetSource, { release = false } = {}) {
  const bytes = await readFile(path.join(directory, 'capture.json'));
  const report = JSON.parse(bytes);
  assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'offline-semantic-capture');
  assert.equal(report.mode, 'offline'); assert.equal(report.evidenceKind, 'synthetic-provider-output');
  assert.equal(report.pipeline, 'knowledge-then-relation-cascade');
  assert.equal(report.sample.kind, 'synthetic-contract-fixture'); assert.equal(report.sample.gold.approved, false);
  assert.equal(report.sampleDigest, contractDigest(report.sample));
  assert.equal(report.complete, true); assert.equal(report.cleanup, true); assert.equal(report.errorCode, undefined);
  assert.equal(report.qualityEvaluated, false); assert.equal(report.fullQualityAcceptance, false);
  assert.equal(report.qualityStatus, 'not_run'); assert.equal(report.liveCalls, 0); same(report.errors, []);
  same(report.models, { knowledge: KNOWLEDGE_MODEL, relation: RELATION_MODEL, knowledgeContract: CONTRACT_REVISION, relationContract: RELATION_CONTRACT_VERSION });
  same(report.sourceStart, report.sourceEnd); same(report.sourceStart, targetSource);
  if (release) assert.equal(targetSource.dirty, false);
  assert.ok(Number.isFinite(Date.parse(report.startedAt)) && Date.parse(report.finishedAt) >= Date.parse(report.startedAt));
  assert.ok(Date.parse(report.finishedAt) <= Date.now());
  same(report.artifacts.map(row => row.path), ['store.sqlite']);
  const database = path.join(directory, 'store.sqlite');
  assert.equal(hashBytes(await readFile(database)), report.artifacts[0].sha256);
  const persisted = semanticDatabase(database); same(persisted, report.after);
  same(persisted.integrity, ['ok']); same(persisted.foreignKeys, []);
  const expectedAfter = structuredClone(report.before);
  for (const row of expectedAfter.tables.listenings) row.relation_waiting_key = row.relation_enabled;
  same(persisted, expectedAfter); same(report.units, semanticUnits(persisted));
  const segments = persisted.tables.segments;
  same(segments.map(row => [row.sequence_no, row.original_text]).sort((a,b) => a[0]-b[0]).map(row => row[1]), report.sample.segments);
  assert.ok(segments.every(row => row.listening_id === report.run.listeningId && row.run_id === report.run.runId));
  assert.ok(report.calls.length >= 1 && report.calls.length <= 24);
  const counts = new Map();
  for (const row of report.calls) {
    assert.equal(row.mode, 'offline'); const endpoint = new URL(row.endpoint);
    assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1');
    assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
    assert.ok(['knowledge', 'repair', 'relation'].includes(row.kind));
    assert.equal(Buffer.byteLength(row.requestWire), row.requestBytes); assert.ok(row.requestBytes <= 128000);
    assert.equal(hashBytes(row.requestWire), row.requestSha256); same(JSON.parse(row.requestWire), row.request);
    assert.ok(Date.parse(row.at) >= Date.parse(report.startedAt) && Date.parse(row.at) <= Date.parse(report.finishedAt));
    counts.set(row.jobId, (counts.get(row.jobId) || 0) + 1);
    if (row.kind === 'relation') {
      assert.equal(row.request.model, report.models.relation);
      assert.equal(row.reservation.id, row.jobId); assert.equal(row.reservation.state, 'running');
      assert.equal(row.reservation.request_count, counts.get(row.jobId)); assert.ok(row.reservation.window_request_count <= 3);
      const job = persisted.tables.relation_jobs.find(job => job.id === row.jobId); assert.ok(job);
      assert.equal(job.listening_id, report.run.listeningId);
    } else {
      assert.equal(row.request.model, report.models.knowledge);
      assert.equal(row.reservation.job.id, row.jobId); assert.equal(row.reservation.job.state, 'running');
      assert.equal(row.reservation.job.listening_id, report.run.listeningId);
      assert.ok(Number.isInteger(row.reservation.progress.extra_requests) && row.reservation.progress.extra_requests >= 0 && row.reservation.progress.extra_requests <= 2);
      assert.ok(Number.isInteger(row.reservation.progress.protocol_retries) && row.reservation.progress.protocol_retries >= 0 && row.reservation.progress.protocol_retries <= 1);
      assert.ok(row.reservation.parts.every(part => part.repair_reserved <= 1));
      assert.ok(row.reservation.parts.some(part => part.phase === (row.kind === 'repair' ? 'repair_inflight' : 'extract_inflight')));
      assert.equal(row.reservation.parts.reduce((sum, part) => sum + (part.stats.request_count || 0), 0), counts.get(row.jobId));
    }
  }
  for (const job of persisted.tables.extraction_jobs) {
    const final = report.results.filter(row => row.domain === 'knowledge' && row.jobId === job.id && row.result.kind === 'terminal');
    assert.equal(final.length, 1); assert.ok(['ok', 'empty'].includes(final[0].result.outcome));
    assert.equal(final[0].result.summary.request_count, counts.get(job.id));
  }
  for (const job of persisted.tables.relation_jobs) {
    assert.equal(job.request_count, counts.get(job.id) || 0);
    assert.equal(persisted.tables.relation_requests.filter(row => row.job_id === job.id).length, job.request_count);
  }
  return { report, captureSha256: hashBytes(bytes), artifacts: [{ path: 'capture.json', sha256: hashBytes(bytes) }, ...report.artifacts] };
}
