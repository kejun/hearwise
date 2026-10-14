import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startPerformanceServer, measureBackendRequest } from './performance-server.mjs';
import { backendPhases } from '../verification/performance/profile.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = values => values.map(value => value.id).sort();
export function validateBackendResponse(phase, body, manifest) {
  const expected = phase.startsWith('post-import') ? manifest.import.record : phase === 'record-secondary' ? manifest.secondary : manifest.primary;
  if (phase.includes('history')) {
    const page = phase === 'history-second-page' ? 2 : 1, total = manifest.workload.counts.listenings + (phase.startsWith('post-import') ? manifest.import.addedCount : 0);
    assert.equal(body.total, total); assert.equal(body.page, page); assert.equal(body.pageSize, 20);
    assert.equal(body.items.length, Math.min(20, Math.max(0, total - (page - 1) * 20)));
    assert.equal(new Set(ids(body.items)).size, body.items.length);
    if (page === 1 && !phase.startsWith('post-import')) assert.equal(body.items[0].id, manifest.primary.id);
  } else if (phase.endsWith('graph') || phase === 'graph-primary') {
    assert.deepEqual(ids(body.nodes), [...expected.nodeIds].sort());
    assert.deepEqual(ids(body.relations), [...expected.edgeIds].sort());
  } else {
    assert.equal(body.listening.id, expected.id); assert.equal(body.listening.title, expected.title);
    assert.equal(body.segmentCount, expected.segmentCount); assert.equal(body.segments.length, Math.min(100, expected.segmentCount));
    assert.deepEqual(ids(body.knowledge), [...expected.nodeIds].sort());
    assert.deepEqual(ids(body.segments), [...expected.segmentIds.slice(0, 100)].sort());
  }
  return true;
}

export async function appendPerformanceImport(server, imported) {
  const bytes = await readFile(imported.file); assert.equal(hash(bytes), imported.sha256);
  const uploaded = await fetch(`${server.base}/api/data/import/validate?mode=append`, {
    method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3' }, body: bytes, signal: AbortSignal.timeout(30000) });
  const preview = await uploaded.json(); assert.equal(uploaded.status, 200, JSON.stringify(preview));
  assert.equal(preview.addedCount, imported.addedCount);
  const committed = await fetch(`${server.base}/api/data/import/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: preview.token, mode: 'append', previewToken: preview.previewToken }), signal: AbortSignal.timeout(30000) });
  const result = await committed.json(); assert.equal(committed.status, 200, JSON.stringify(result));
  assert.equal(result.addedCount, imported.addedCount);
  // The API's listeningCount describes the imported backup, not the resulting
  // destination. Read the real history route to check the new destination size.
  const historyResponse = await fetch(`${server.base}/api/listenings?page=1`, { signal: AbortSignal.timeout(15000) });
  const history = await historyResponse.json(); assert.equal(historyResponse.status, 200); assert.equal(history.total, imported.expectedTotal);
  return { preview, result, destinationTotal: history.total, inputSha256: imported.sha256 };
}

export async function collectBackendSamples(manifest) {
  const report = { schemaVersion: 1, component: 'backend', startedAt: new Date().toISOString(), complete: false, cases: [], responseBodies: {}, providerRequests: [] };
  const retainBody = sample => {
    report.responseBodies[sample.response.sha256] ??= sample.response.body;
    delete sample.response.body;
  };
  const server = await startPerformanceServer(manifest.database);
  try {
    report.server = { pid: server.pid, input: server.input, instrumentation: server.instrumentation };
    for (const phase of backendPhases) {
      if (phase === 'post-import-history') report.import = await appendPerformanceImport(server, manifest.import);
      const record = phase.startsWith('post-import') ? manifest.import.record : phase === 'record-secondary' ? manifest.secondary : manifest.primary;
      const route = phase.includes('history') ? `/api/listenings?page=${phase === 'history-second-page' ? 2 : 1}` :
        `/api/listenings/${record.id}${phase.includes('graph') ? '/graph' : '?page=1'}`;
      const row = { id: `${manifest.workload.tier}/backend/${phase}`, phase, status: 'collecting', samples: [] };
      report.cases.push(row);
      for (let index = 0; index < manifest.sampling.warmups + manifest.sampling.repetitions; index++) {
        const sample = await measureBackendRequest(server, route);
        assert.equal(sample.response.status, 200); validateBackendResponse(phase, sample.response.body, manifest);
        retainBody(sample);
        row.samples.push({ index, warmup: index < manifest.sampling.warmups, ...sample });
      }
      row.status = 'collected';
    }
    // A predetermined cost in a real forwarding/read path must be visible. It is
    // diagnostic instrumentation, not a product regression or a release budget.
    report.negative = await measureBackendRequest(server, `/api/listenings/${manifest.primary.id}/graph`, { controlledDelayMs: 200 });
    validateBackendResponse('graph-primary', report.negative.response.body, manifest);
    retainBody(report.negative);
    assert.equal(report.negative.controlledCost.forwardedRequests, 1);
    assert.ok(report.negative.controlledCost.observedMs >= 190 && report.negative.metrics.wallMs >= 190);
    assert.equal(server.providerRequests.length, 0);
    report.complete = true;
  } catch (error) { report.error = { name: error.name, message: error.message }; }
  finally {
    report.providerRequests = [...server.providerRequests]; report.serverLog = server.logs();
    try { await server.close(); report.cleanup = { complete: true }; }
    catch (error) { report.complete = false; report.cleanup = { complete: false, error: error.message }; }
    report.finishedAt = new Date().toISOString();
  }
  return report;
}
