// This reader validates offline capture artifacts. It cannot grant quality acceptance.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hashBytes, contractDigest } from './quality-contract.mjs';
import { semanticDatabase, semanticUnits } from './semantic-quality-capture.mjs';
import { KNOWLEDGE_MODEL, CONTRACT_REVISION, SYSTEM_PROMPT_V2 } from '../../knowledge.mjs';
import { RELATION_MODEL, RELATION_CONTRACT_VERSION, buildRelationRequest } from '../../relations.mjs';
import { knowledgeResultSummary } from '../../knowledge-workflow.mjs';
const decodePart = part => ({ ...part, ...Object.fromEntries(['focus_refs','unresolved','results','stats','input_snapshot'].map(key => [key, part[key] ? JSON.parse(part[key]) : null])) });
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
  same(report.models, { knowledge: KNOWLEDGE_MODEL, relation: RELATION_MODEL, knowledgeContract: CONTRACT_REVISION, relationContract: RELATION_CONTRACT_VERSION, buildRelationRequest });
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
  const counts = new Map(), partCounts = new Map();
  const segmentById = new Map(segments.map(row => [row.id, row]));
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
      const input = JSON.parse(job.input_json); same(row.reservation.input, input);
      same(row.request, buildRelationRequest(input).body);
      for (const segment of [...input.focus_segments, ...input.context_segments]) {
        const stored = segmentById.get(segment.id); assert.ok(stored);
        assert.equal(segment.text, stored.original_text); assert.equal(segment.translation, stored.translation_text);
        assert.equal(segment.sequence_no, stored.sequence_no);
      }
      assert.equal(row.reservation.max_requests, 3);
      assert.equal(row.reservation.window_request_count, persisted.tables.relation_requests.filter(request => {
        const owner = persisted.tables.relation_jobs.find(candidate => candidate.id === request.job_id);
        return owner.window_id === job.window_id && owner.epoch === job.epoch &&
          (owner.id !== job.id || request.attempt <= row.reservation.request_count);
      }).length);
    } else {
      assert.equal(row.request.model, report.models.knowledge);
      assert.equal(row.reservation.job.id, row.jobId); assert.equal(row.reservation.job.state, 'running');
      assert.equal(row.reservation.job.listening_id, report.run.listeningId);
      assert.ok(Number.isInteger(row.reservation.progress.extra_requests) && row.reservation.progress.extra_requests >= 0 && row.reservation.progress.extra_requests <= 2);
      assert.ok(Number.isInteger(row.reservation.progress.protocol_retries) && row.reservation.progress.protocol_retries >= 0 && row.reservation.progress.protocol_retries <= 1);
      assert.ok(row.reservation.parts.every(part => part.repair_reserved <= 1));
      assert.ok(row.reservation.parts.some(part => part.phase === (row.kind === 'repair' ? 'repair_inflight' : 'extract_inflight')));
      assert.equal(row.reservation.parts.reduce((sum, part) => sum + (part.stats.request_count || 0), 0), counts.get(row.jobId));
      const job = persisted.tables.extraction_jobs.find(job => job.id === row.jobId); assert.ok(job);
      for (const key of ['id','listening_id','from_sequence','to_sequence','prompt_version']) assert.equal(row.reservation.job[key], job[key]);
      same(JSON.parse(row.reservation.job.progress_json), row.reservation.progress);
      const active = row.reservation.parts.filter(part => part.phase === (row.kind === 'repair' ? 'repair_inflight' : 'extract_inflight'));
      assert.equal(active.length, 1);
      const partKey = `${row.jobId}:${active[0].part_no}`, totals = partCounts.get(partKey) || { initial: 0, repair: 0 };
      totals[row.kind === 'repair' ? 'repair' : 'initial']++; partCounts.set(partKey, totals);
      for (const part of row.reservation.parts) {
        const expected = partCounts.get(`${row.jobId}:${part.part_no}`) || { initial: 0, repair: 0 };
        assert.equal(part.initial_requests, expected.initial); assert.equal(part.repair_reserved, expected.repair);
        assert.equal(part.stats.request_count || 0, expected.initial + expected.repair);
        const stored = persisted.tables.extraction_parts.find(candidate => candidate.job_id === row.jobId && candidate.part_no === part.part_no); assert.ok(stored);
        same(part.focus_refs, JSON.parse(stored.focus_refs));
      }
      assert.equal(row.reservation.progress.extra_requests, row.reservation.parts.reduce((sum, part) => sum + Math.max(0, part.initial_requests - 1), 0));
      const input = JSON.parse(row.request.messages.at(-1).content);
      assert.equal(input.listening_id, job.listening_id); assert.equal(input.policy_version, job.prompt_version);
      same(input.focus_segments, active[0].focus_refs.map(ref => {
        const segment = segmentById.get(ref.segment_id); assert.ok(segment);
        assert.ok(segment.sequence_no >= job.from_sequence && segment.sequence_no <= job.to_sequence);
        assert.ok(Number.isInteger(ref.start) && Number.isInteger(ref.end) && ref.start >= 0 && ref.end > ref.start && ref.end <= segment.original_text.length);
        return { id: ref.segment_id, text: segment.original_text.slice(ref.start, ref.end) };
      }));
      same(input.context_segments, segments.filter(segment => segment.sequence_no < job.from_sequence)
        .sort((a,b) => a.sequence_no-b.sequence_no).slice(-3).map(segment => ({ id: segment.id, text: segment.original_text.slice(0,700) })));
      for (const candidate of input.existing_candidates) {
        const item = persisted.tables.knowledge_items.find(item => item.id === candidate.id); assert.ok(item);
        for (const key of ['canonical_name','type','display_label']) assert.equal(candidate[key], item[key]);
        for (const fact of candidate.recent_facts || []) assert.ok(persisted.tables.knowledge_facts.some(row => row.item_id === item.id && row.content === fact));
      }
      if (row.kind === 'knowledge') same(row.request, { model: KNOWLEDGE_MODEL, enable_thinking: false,
        messages: [{ role: 'system', content: SYSTEM_PROMPT_V2 }, { role: 'user', content: JSON.stringify(input) }] });
    }
  }
  for (const job of persisted.tables.extraction_jobs) {
    const final = report.results.filter(row => row.domain === 'knowledge' && row.jobId === job.id && row.result.kind === 'terminal');
    assert.equal(final.length, 1); assert.ok(['ok', 'empty'].includes(final[0].result.outcome));
    assert.equal(final[0].result.summary.request_count, counts.get(job.id));
    assert.equal(job.state, 'complete'); assert.equal(final[0].result.outcome, job.outcome);
    const parts = persisted.tables.extraction_parts.filter(part => part.job_id === job.id).sort((a,b) => a.part_no-b.part_no).map(decodePart);
    for (const part of parts) {
      const totals = partCounts.get(`${job.id}:${part.part_no}`) || { initial: 0, repair: 0 };
      assert.equal(part.phase, 'done'); assert.equal(part.initial_requests, totals.initial); assert.equal(part.repair_reserved, totals.repair);
      assert.equal(part.stats.request_count, totals.initial + totals.repair);
    }
    const summary = knowledgeResultSummary({ job, progress: JSON.parse(job.progress_json), parts });
    const firstFinal = segments.filter(segment => segment.sequence_no >= job.from_sequence && segment.sequence_no <= job.to_sequence)
      .map(segment => segment.created_at).sort()[0];
    summary.first_content_age_ms = summary.first_content_at && firstFinal ? Math.max(0, summary.first_content_at - Date.parse(firstFinal)) : null;
    same(final[0].result.summary, summary); assert.equal(final[0].result.rateLimitMs, 0);
  }
  for (const job of persisted.tables.relation_jobs) {
    assert.equal(job.request_count, counts.get(job.id) || 0);
    assert.equal(persisted.tables.relation_requests.filter(row => row.job_id === job.id).length, job.request_count);
    if (job.request_count) {
      const terminal = report.results.filter(row => row.domain === 'relation' && row.jobId === job.id && row.result.kind === 'terminal');
      assert.equal(terminal.length, 1); const result = terminal[0].result;
      assert.equal(result.state, job.state); assert.equal(result.accepted, job.accepted_count);
      same(result.rejected, JSON.parse(job.rejected_json)); assert.equal(result.stale, false);
      assert.equal(result.outcome, job.state === 'partial' ? 'partial' : job.accepted_count ? 'ok' : 'empty');
    }
  }
  return { report, captureSha256: hashBytes(bytes), artifacts: [{ path: 'capture.json', sha256: hashBytes(bytes) }, ...report.artifacts] };
}
