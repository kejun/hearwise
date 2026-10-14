import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureSemanticOffline } from '../scripts/lib/semantic-quality-capture.mjs';
import { readSemanticCapture } from '../scripts/lib/semantic-quality-evidence.mjs';
import { hashBytes } from '../scripts/lib/quality-contract.mjs';
import { qualitySources } from '../scripts/lib/quality-collector.mjs';
import { semanticFixtureSample, semanticFixtureResponse } from '../test-support/semantic-quality-fixture.mjs';
let root, directory, source, original, database;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'semantic-evidence-')); directory = path.join(root, 'capture');
  const report = await captureSemanticOffline({ directory, sample: semanticFixtureSample(), response: semanticFixtureResponse() });
  assert.equal(report.complete, true, report.errorCode); source = await qualitySources();
  original = await readFile(path.join(directory, 'capture.json')); database = await readFile(path.join(directory, 'store.sqlite'));
}, { timeout: 20000 });
after(() => rm(root, { recursive: true, force: true }));
test('raw reader binds actual database, source, wire requests and reservations', async () => {
  const result = await readSemanticCapture(directory, source);
  assert.equal(result.report.qualityStatus, 'not_run'); assert.equal(result.artifacts.length, 2);
});
const corruptions = {
  'lost initial reservation': r => { r.calls[0].reservation.parts[0].initial_requests = 0; },
  'unrelated request source with matching hash': r => {
    const row = r.calls[0], input = JSON.parse(row.request.messages.at(-1).content);
    input.focus_segments[0].text = 'Atlas Nova Orion invented another story';
    row.request.messages.at(-1).content = JSON.stringify(input); row.requestWire = JSON.stringify(row.request);
    row.requestBytes = Buffer.byteLength(row.requestWire); row.requestSha256 = hashBytes(row.requestWire);
  },
  'false empty terminal': r => { r.results.find(row => row.domain === 'knowledge').result.outcome = 'empty'; },
  'false terminal count': r => { r.results.find(row => row.domain === 'knowledge').result.summary.created_count = 0; },
  'false relation input snapshot': r => { r.calls.find(row => row.kind === 'relation').reservation.input.focus_segments[0].text = 'unrelated'; },
  'promoted mode': r => { r.mode = 'live'; },
  'promoted quality': r => { r.qualityEvaluated = true; },
  'promoted acceptance': r => { r.fullQualityAcceptance = true; },
  'incomplete cleanup': r => { r.cleanup = false; },
  'changed source end': r => { r.sourceEnd.sha = '0'.repeat(40); },
  'missing source': r => { delete r.sourceStart; },
  'missing artifact': r => { r.artifacts = []; },
  'altered unit': r => { r.units[0].value.canonical_name = 'Altered'; },
  'changed database snapshot': r => { r.after.tables.knowledge_items = []; },
  'omitted call': r => { r.calls.pop(); },
  'unreserved call': r => { r.calls.push(structuredClone(r.calls[0])); },
  'false request bytes': r => { r.calls[0].requestBytes++; },
  'changed request wire': r => { r.calls[0].requestWire += ' '; },
  'live endpoint': r => { r.calls[0].endpoint = 'https://example.com'; },
  'missing reservation': r => { delete r.calls[0].reservation; },
  'unreserved phase': r => { r.calls[0].reservation.parts.forEach(p => { p.phase = 'complete'; }); },
  'missing terminal': r => { r.results = []; },
  'future capture': r => { r.finishedAt = '2099-01-01T00:00:00.000Z'; },
};
for (const [name, mutate] of Object.entries(corruptions)) test(`reader rejects ${name}`, async () => {
  const report = JSON.parse(original); mutate(report); await writeFile(path.join(directory, 'capture.json'), JSON.stringify(report));
  try { await assert.rejects(readSemanticCapture(directory, source)); }
  finally { await writeFile(path.join(directory, 'capture.json'), original); }
});
test('reader rejects a different target source', async () => {
  await assert.rejects(readSemanticCapture(directory, { ...source, sha: '0'.repeat(40) }));
});
test('reader rejects changed or missing SQLite bytes', async () => {
  await writeFile(path.join(directory, 'store.sqlite'), 'not sqlite');
  try { await assert.rejects(readSemanticCapture(directory, source)); }
  finally { await writeFile(path.join(directory, 'store.sqlite'), database); }
  await rm(path.join(directory, 'store.sqlite'));
  try { await assert.rejects(readSemanticCapture(directory, source)); }
  finally { await writeFile(path.join(directory, 'store.sqlite'), database); }
});
