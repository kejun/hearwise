import assert from 'node:assert/strict';
const localCodes = new Set(['MT_REQUEST_DENIED','BODY_LIMIT','BUDGET_REJECTED','ASR_REQUEST_DENIED','ASR_AUDIO_DENIED','GATEWAY_TIMEOUT','ASR_CLIENT_ERROR','CLIENT_CANCELLED','GATEWAY_CANCELLED']);
// Examine the complete raw ledger before selecting paid attempts. Local rejected
// work may remain visible, but an unreserved upstream result is never invisible.
export function validateQualityObservations(rows, { mode, kind, startedAt, finishedAt, maxConnectionMs }) {
  assert.ok(Array.isArray(rows) && rows.length > 0);
  const attempts = [];
  for (const row of rows) {
    assert.ok(['asr','mt'].includes(row.kind)); assert.equal(row.mode, mode);
    assert.equal(row.evidenceKind, mode === 'live' ? 'live-provider' : 'offline-provider-stub');
    assert.ok(['succeeded','failed','denied','cancelled'].includes(row.status));
    const start = Date.parse(row.startedAt), end = Date.parse(row.completedAt);
    assert.ok(start >= Date.parse(startedAt) && end >= start && end <= Date.parse(finishedAt));
    if (row.attemptId === undefined) {
      assert.ok(['denied','cancelled'].includes(row.status) && localCodes.has(row.code));
      assert.equal(row.upstreamStartedAt, undefined); assert.equal(row.httpStatus, undefined); assert.equal(row.usage, undefined); assert.equal(row.output, undefined);
      assert.ok(row.outputs === undefined || Array.isArray(row.outputs) && row.outputs.length === 0);
      for (const key of ['returnedModel','responseModel','revision','requestId','responseId']) assert.ok(row[key] == null);
      continue;
    }
    assert.ok(typeof row.attemptId === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(row.attemptId)); assert.equal(row.kind, kind);
    const upstream = Date.parse(row.upstreamStartedAt);
    assert.ok(upstream >= start && upstream <= end && end - upstream <= maxConnectionMs);
    attempts.push(row);
  }
  assert.equal(new Set(attempts.map(row => row.attemptId)).size, attempts.length);
  return attempts;
}

// Public final captions, durable segment text and actual provider output must agree.
// This establishes plumbing consistency; it does not assess recognition quality.
export function validateAsrResult(result, success) {
  assert.ok(result.events.some(row => row.event.type === 'finished'));
  assert.ok(!result.events.some(row => row.event.type === 'error'));
  const finals = result.events.filter(row => row.event.type === 'segment-final').map(row => row.event.segment);
  assert.deepEqual(finals.map(row => [row.id, row.original_text]), result.segments.map(row => [row.id, row.original_text]));
  assert.equal(result.output, result.segments.map(row => row.original_text).join(' '));
  for (const segment of result.segments) {
    assert.equal(segment.listening_id, result.listeningId); assert.equal(segment.run_id, result.runId);
    assert.ok(success.outputs.some(row => row.sentence_end && String(row.sentence_id) === segment.asr_sentence_id && row.text === segment.original_text));
  }
}
