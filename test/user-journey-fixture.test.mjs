import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { userJourneyFixture, journeyText } from '../test-support/user-journey-fixture.mjs';
import { deadline } from '../test-support/lifecycle.mjs';
import { assertJourneyGraphResponse } from '../scripts/lib/user-journey-evidence.mjs';

async function until(read, predicate, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Journey fixture did not reach ${label}`);
}

for (const batches of [[journeyText.original], journeyText.original.map(text => [text])]) test(
  `empty journey fixture persists authored knowledge and relation across ${batches.length} actual run(s)`, { timeout: 30000 }, async () => {
  const f = await userJourneyFixture(); let socket;
  const get = async suffix => {
    const response = await fetch(f.base + suffix, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200); return response.json();
  };
  try {
    assert.equal(f.snapshot().rows.listenings.length, 0);
    let identity, detail, segmentCount = 0;
    const runs = [];
    for (const texts of batches) {
      socket = new WebSocket(f.base.replace('http:', 'ws:') + '/ws');
      const events = []; socket.on('message', data => events.push(JSON.parse(data.toString())));
      await deadline(() => once(socket, 'open'), 3000, 'journey fixture socket startup');
      socket.send(JSON.stringify({ type: 'start', key: 'journey-synthetic-only', source: 'en', targetLang: 'Chinese',
        audioSource: 'microphone', ...(identity ? { listeningId: identity } : {}) }));
      const ready = await until(() => events.find(row => row.type === 'listening-ready'), Boolean, 'listening identity');
      if (identity) assert.equal(ready.listeningId, identity);
      identity = ready.listeningId; runs.push(ready.runId);
      await until(() => f.stats.asrClients.size, count => count === 1, 'upstream ASR connection');
      for (const text of texts) f.final(text, true, `journey-${segmentCount++}`);
      const current = `/api/listenings/${identity}`;
      await until(() => get(current), value => value.segments.length === segmentCount && value.segments.every(row => row.translation_state === 'complete'), 'persisted final translations');
      const closed = once(socket, 'close'); socket.send(JSON.stringify({ type: 'stop' }));
      await deadline(() => closed, 3000, 'journey fixture listening stop');
      detail = await until(() => get(current), value => value.jobs.length === runs.length && value.jobs.every(row => row.state === 'complete'), 'knowledge completion');
      await until(() => f.stats.asrClients.size, count => count === 0, 'old upstream ASR closure');
    }
    const url = `/api/listenings/${identity}`;
    assert.deepEqual(detail.segments.map(row => row.original_text), journeyText.original);
    assert.deepEqual(detail.segments.map(row => row.translation_text), journeyText.translation);
    assert.deepEqual(detail.knowledge.map(row => row.canonical_name).sort(), ['Brownie camera', 'Eastman Kodak']);
    const before = f.snapshot(), started = await fetch(f.base + url + '/graph', { method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'journey-synthetic-only' }) });
    assertJourneyGraphResponse({ method: 'POST', path: url + '/graph', status: started.status, response: await started.json() },
      { listeningId: identity, before, database: f.snapshot() });
    const graph = await until(() => get(url + '/graph'), value => value.relations.length === 1 && value.status.runningJobs === 0 && value.status.pendingJobs === 0, 'committed relation');
    assert.equal(graph.nodes.length, 2);
    const durable = f.snapshot(); assert.equal(durable.integrity, 'ok'); assert.deepEqual(durable.foreignKeyErrors, []);
    assert.equal(durable.rows.knowledge_items.length, 2);
    assert.equal(durable.rows.relation_requests.length, 1);
    assert.equal(durable.rows.relation_requests[0].outcome, 'complete');
    assert.equal(durable.rows.relation_jobs[0].request_count, 1);
    assert.deepEqual(f.providerLedger.map(row => row.kind).sort(), [...batches.map(() => 'knowledge'), 'relation', 'translation', 'translation']);
    for (const row of f.providerLedger.filter(row => row.kind === 'knowledge')) {
      assert.ok(row.output.items.every(item => item.evidence.every(evidence => row.input.focus_segments.some(segment =>
        segment.id === evidence.segment_id && segment.text.includes(evidence.quote)))));
    }
    const knowledgeCalls = f.providerLedger.filter(row => row.kind === 'knowledge');
    assert.deepEqual(knowledgeCalls[0].output.items.map(row => row.canonical_name).sort(), ['Brownie camera', 'Eastman Kodak']);
    if (batches.length === 2) assert.deepEqual(knowledgeCalls[1].output.items.map(row => row.canonical_name), ['Brownie camera']);
    assert.equal(f.stats.audioFrames, 0, 'Node fixture test covers ASR protocol finals, not browser microphone/PCM');
    assert.equal(durable.rows.listenings[0].id, identity);
    assert.deepEqual(durable.rows.listening_runs.map(row => row.id).sort(), [...runs].sort());
    assert.ok(durable.rows.listening_runs.every(row => row.state === 'complete'));
  } finally { socket?.terminate(); await f.close(); }
});

test('journey relation continuation completes before an obsolete HTTP supplier is released', { timeout: 30000 }, async () => {
  const f = await userJourneyFixture(); let socket;
  const request = async (url, method = 'GET', body) => {
    const before = method === 'GET' ? null : f.snapshot();
    const response = await fetch(f.base + url, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000) });
    const value = await response.json();
    if (method === 'GET') assert.equal(response.status, 200);
    else {
      // Feed actual server responses into the same reader used for browser raw
      // evidence; a synthetic 200 default must not conceal POST admission 202.
      const wire = { method, path: url, status: response.status, response: value };
      const options = { listeningId: url.split('/')[3], before, database: f.snapshot() };
      assertJourneyGraphResponse(wire, options);
      assert.throws(() => assertJourneyGraphResponse({ ...wire, status: method === 'POST' ? 200 : 202 }, options), /journey_graph_http_status/);
    }
    return value;
  };
  try {
    socket = new WebSocket(f.base.replace('http:', 'ws:') + '/ws'); const messages = [];
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    await deadline(() => once(socket, 'open'), 3000, 'journey test socket open');
    socket.send(JSON.stringify({ type: 'start', key: 'journey-synthetic-only', source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }));
    const ready = await until(() => messages.find(event => event.type === 'listening-ready'), Boolean, 'listening');
    await until(() => f.stats.asrClients.size, n => n === 1, 'ASR');
    journeyText.original.forEach((text, i) => f.final(text, true, `held-${i}`));
    const url = `/api/listenings/${ready.listeningId}`;
    await until(() => request(url), value => value.segments.length === 2 && value.segments.every(row => row.translation_state === 'complete'), 'translation');
    const closed = once(socket, 'close'); socket.send(JSON.stringify({ type: 'stop' })); await deadline(() => closed, 3000, 'journey stop');
    await until(() => request(url), value => value.knowledge.length === 2 && value.jobs.every(row => row.state === 'complete'), 'knowledge');
    f.holdNextRelation(); await request(url + '/graph', 'POST', { key: 'journey-synthetic-only' });
    await until(() => f.heldRelations.length, n => n === 1, 'held supplier');
    await request(url + '/graph', 'DELETE');
    await until(() => request(url + '/graph'), value => value.status.state === 'cancelled' && value.status.runningJobs === 0, 'cancelled');
    await request(url + '/graph', 'POST', { key: 'journey-synthetic-only' });
    await until(() => request(url + '/graph'), value => value.relations.length === 1 && value.status.runningJobs === 0 && value.status.pendingJobs === 0, 'new current relation');
    assert.equal(f.heldRelations[0].row.completedAt, null);
    const before = f.snapshot(); f.releaseRelations(); await until(() => f.heldRelations[0].row.completedAt, Boolean, 'physical completion');
    await until(() => f.heldRelations[0].row.transport.some(event => event.type === 'close'), Boolean, 'HTTP closure');
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.providerLedger.filter(row => row.kind === 'relation').length, 2);
    assert.equal(f.heldRelations[0].row.transport.some(event => event.type === 'close' && !event.writableEnded), true,
      'cancelled HTTP response was disconnected, not an observed application callback');
  } finally { socket?.terminate(); await f.close(); }
});
