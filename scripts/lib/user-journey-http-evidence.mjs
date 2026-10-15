import assert from 'node:assert/strict';

const time = value => { assert.equal(typeof value, 'string', 'journey_time'); const n = Date.parse(value); assert.ok(Number.isFinite(n), 'journey_time'); return n; };
const byId = (rows, id) => { const found = rows.filter(row => row.id === id); assert.equal(found.length, 1, `journey_unique_id:${id}`); return found[0]; };

export function assertJourneyGraphResponse(wire, { listeningId, before, database: snapshot }) {
  // server.mjs admits graph work with 202; cancellation is synchronous 200.
  // Admission metadata precedes the later running/complete checkpoint, so bind
  // durable identity/epoch rather than equating both entire status objects.
  assert.ok(['POST', 'DELETE'].includes(wire.method), 'journey_graph_http_method');
  assert.equal(wire.path, `/api/listenings/${listeningId}/graph`, 'journey_graph_http_path');
  assert.equal(wire.status, wire.method === 'POST' ? 202 : 200, 'journey_graph_http_status');
  const response = wire.response, previous = byId(before.rows.listenings, listeningId), current = byId(snapshot.rows.listenings, listeningId);
  assert.deepEqual(Object.keys(response).sort(), ['ok', 'listeningId', 'graphRevision', 'graph_revision', 'enabled', 'status', 'processingAvailable'].sort(), 'journey_graph_response_fields');
  assert.equal(response.ok, true); assert.equal(response.listeningId, listeningId, 'journey_graph_response_identity');
  assert.equal(response.graphRevision, previous.graph_revision, 'journey_graph_response_revision');
  assert.equal(response.graph_revision, response.graphRevision); assert.ok(response.graphRevision <= current.graph_revision);
  assert.equal(response.enabled, true); assert.equal(response.status.enabled, true); assert.equal(current.relation_enabled, 1);
  assert.equal(typeof response.processingAvailable, 'boolean');
  const round = response.status.round, saved = byId(snapshot.rows.relation_rounds, round.id);
  assert.equal(saved.listening_id, listeningId, 'journey_graph_round_identity');
  assert.equal(round.epoch, saved.epoch, 'journey_graph_round_epoch'); assert.equal(round.epoch, current.relation_epoch);
  assert.equal(round.epoch, previous.relation_epoch + Number(wire.method === 'POST'));
  assert.equal(round.startedAt, saved.started_at, 'journey_graph_round_started');
  if (wire.method === 'POST') {
    assert.equal(response.processingAvailable, true); assert.equal(round.state, 'active'); assert.equal(round.finishedAt, null); assert.equal(round.stopReason, null);
    assert.ok(['queued', 'running'].includes(response.status.state), 'journey_graph_admitted_state');
    assert.ok(response.status.pendingJobs + response.status.runningJobs > 0, 'journey_graph_admitted_work');
  } else {
    assert.equal(response.status.state, 'cancelled', 'journey_graph_cancel_state'); assert.equal(round.state, 'cancelled'); assert.equal(saved.state, 'cancelled');
    assert.equal(round.finishedAt, saved.finished_at); assert.equal(round.stopReason, 'USER_CANCELLED'); assert.equal(saved.stop_reason, 'USER_CANCELLED');
    assert.equal(response.status.pendingJobs, 0); assert.equal(response.status.runningJobs, 0);
  }
}
export function bindGraphRead(request, row) {
  const read = request.graphRead;
  assert.ok(read, 'journey_graph_signal_observation'); assert.equal(read.index, request.graphReadIndex, 'journey_graph_read_index');
  const prior = row.http.filter(value => value.index < request.index && value.contextId === request.contextId && value.documentIndex === request.documentIndex &&
    value.method === 'GET' && /^\/api\/listenings\/[0-9a-f-]{36}\/graph$/.test(value.path));
  assert.equal(request.graphReadIndex, prior.length, 'journey_graph_read_ordinal');
  assert.equal(read.url, row.base + request.path + request.query, 'journey_graph_read_url'); assert.equal(read.method, 'GET');
  assert.equal(read.hasSignal, true, 'journey_graph_actual_signal'); assert.equal(read.initiallyAborted, false); assert.equal(read.done, true);
  const start = time(read.startedAt), end = time(read.finishedAt);
  assert.ok(start >= time(row.startedAt) && end >= start && end <= time(row.finishedAt), 'journey_graph_read_time');
  // request.at is Node's CDP-event receipt time, not the browser's network start;
  // synchronous SQLite/JSON work can delay it beyond the clone's completion.
  assert.ok(time(request.at) >= start && time(request.at) <= time(row.finishedAt), 'journey_graph_request_time');
  return read;
}
export function assertCompleteGraphRead(request, row) {
  const read = bindGraphRead(request, row);
  assert.equal(read.status, request.status); assert.ok(!read.fetchError, 'journey_graph_read_complete');
  if (read.body !== undefined) assert.deepEqual(read.body, request.response, 'journey_graph_read_body');
  else {
    // A completed original HTTP body is authoritative even when loader.stop()
    // aborts the independent clone afterwards. This is not a failed-HTTP waiver.
    assert.ok(!request.failure && !request.bodyError && request.response, 'journey_graph_complete_http_body');
    assert.equal(read.bodyError?.name, 'AbortError', 'journey_graph_clone_abort');
    assert.ok(time(read.abortedAt) >= time(read.startedAt) && time(read.abortedAt) <= time(row.finishedAt), 'journey_graph_clone_abort_time');
  }
  return read;
}
