import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { seedPerformanceDatabase } from '../test-support/performance-dataset.mjs';
import { collectBackendSamples } from '../test-support/performance-backend.mjs';
import { validateBackendEvidence } from '../scripts/lib/performance-backend-evidence.mjs';

test('real backend report is accepted; raw counters, semantic output, missing cases and fake negatives are rejected', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'performance-backend-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recipe = { version: 1, tier: 'unit', listenings: 3, segmentsPerBackground: 2, graphRecords: 2, nodesPerGraph: 6, isolatedPerGraph: 2, textCharacters: 160, seed: 20261014 };
  const file = path.join(directory, 'input.sqlite'), imported = path.join(directory, 'import.sqlite');
  const a = await seedPerformanceDatabase(file, recipe), b = await seedPerformanceDatabase(imported, { ...recipe, listenings: 1, graphRecords: 1, seed: 20261015 });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = { database: { file, sha256: hash(await readFile(file)) }, workload: { tier: 'unit', counts: a.counts },
    primary: a.primary, secondary: a.secondary, sampling: { warmups: 1, repetitions: 2 },
    import: { file: imported, sha256: hash(await readFile(imported)), record: b.primary, addedCount: 1, expectedTotal: 4 } };
  const report = await collectBackendSamples(manifest);
  assert.equal(validateBackendEvidence(report, manifest).ok, true, JSON.stringify(validateBackendEvidence(report, manifest)));
  const changes = [
    r => { r.cases.pop(); }, r => { r.cases[0].samples.pop(); }, r => { r.cases[0].samples[0].warmup = false; },
    r => { r.cases[0].samples[0].metrics.wallMs = 0; }, r => { r.cases[0].samples[0].after.cpuUsage.user += 1000; },
    r => { r.cases[0].samples[0].after.memoryUsage.rss += 1000; }, r => { r.cases[0].samples[0].before.pid += 1; },
    r => { r.responseBodies[r.cases[0].samples[0].response.sha256].total = 0; },
    r => { const response = r.cases[4].samples[0].response, body = structuredClone(r.responseBodies[response.sha256]); body.nodes[0].id = 'wrong'; const bytes = Buffer.from(JSON.stringify(body)); response.bytes = bytes.length; response.sha256 = hash(bytes); r.responseBodies[response.sha256] = body; },
    r => { delete r.responseBodies[r.cases[0].samples[0].response.sha256]; },
    r => { r.import.destinationTotal = 1; }, r => { r.providerRequests = [{ url: 'provider' }]; },
    r => { r.negative.controlledCost.observedMs = 0; }, r => { r.negative.metrics.wallMs = 0; },
    r => { r.cleanup.complete = false; }, r => { r.server.input.sha256 = '0'.repeat(64); },
    r => { r.cases[0].samples[0].route = '/other'; },
    r => { const s = r.cases[0].samples[1]; s.before.timeOrigin += 1; s.after.timeOrigin += 1; },
    r => { const s = r.cases[0].samples[0]; s.after.resourceUsage.maxRSS = 1; s.metrics.serverLifetimeMaxRssAfterKiB = 1; },
    r => { const s = r.cases[0].samples[0]; s.timing.timeOrigin += 100000; }
  ];
  for (const change of changes) {
    const altered = structuredClone(report); change(altered);
    assert.equal(validateBackendEvidence(altered, manifest).ok, false, change.toString());
  }
});
