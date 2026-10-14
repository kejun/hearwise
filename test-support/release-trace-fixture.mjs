import { traceRegressionNames } from '../scripts/lib/trace-release-evidence.mjs';
// Actual workflow observations with synthetic browser/TAP envelopes for reader
// regression only. This is never a browser acceptance artifact.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectTraceBusinessEvidence } from './trace-business-worker.mjs';
import { expectedTraceMutations } from './trace-business-negative.mjs';
import { traceSourceSnapshot, traceBrowserChecks, traceStateLabels, traceBrowserArtifacts, traceBrowserDocuments, validateTraceBusinessObservations,
  traceRegressionFiles, traceRegressionCount, traceEvidenceScope } from './trace-business-evidence.mjs';
import { traceBusinessProperties, traceBusinessProfile } from '../verification/trace-business-properties.mjs';
import { metadata, digest, summarize } from '../scripts/lib/verification-evidence.mjs';
import { hashEvidenceFiles } from '../scripts/lib/runner-evidence-contract.mjs';
import { tapSummary } from '../scripts/lib/tap-summary.mjs';
const json = (file, value) => writeFile(file, JSON.stringify(value));
let businessPromise;
export async function traceReleaseFixture(directory) {
  await mkdir(directory, { recursive: true });
  businessPromise ||= collectTraceBusinessEvidence(); const business = await businessPromise;
  if (!business.ok) throw new Error(JSON.stringify(business.failure));
  const context = await metadata(), source = await traceSourceSnapshot(), mutations = await expectedTraceMutations(), time = new Date().toISOString();
  const full = business.boundaries.find(row => row.name === 'full-public-boundary');
  const browser = { source: context.source, complete: true, ok: true, cleanup: true, chromium: 'synthetic-reader-only', errors: [], networkRequests: [],
    checks: traceBrowserChecks.map(id => ({ id, complete: true, ok: true, counts: { domains: 5, unownedPreviews: 1, cases: 6, tasks: 4, eventIdentities: 4, missingBoundary: 1, jsonlUnknown: 1, safeExports: 1, mobileWidth: 390 } })),
    terminalObservations: Object.entries(traceStateLabels).map(([state, text]) => ({ state, text, badges: 1 })),
    identityObservations: ['translation', 'knowledge', 'relation', 'speech'].map(domain => {
      const task = full.business.tasks.find(row => row.domain === domain), event = full.report.spans.find(row => row.id === task.focus).events[0];
      return { domain, taskId: task.id, jobId: task.job, eventId: event.event_id, listeningId: full.actual.listeningId };
    }), captureObservations: { jsonl: '完整性未知', missing: '采集不完整', exportedEvents: full.report.eventCount, mobileOverflow: false } };
  const documents = traceBrowserDocuments(business);
  for (const document of documents) await writeFile(path.join(directory, document.name), document.html);
  browser.reports = await hashEvidenceFiles(directory, documents.map(row => row.name));
  const embedded = documents.find(row => row.name === 'trace-full.html').html.match(/<script type="application\/json" id="trace-data">([\s\S]*?)<\/script>/)[1];
  await json(path.join(directory, 'trace-safe-export.json'), JSON.parse(embedded));
  for (const file of traceBrowserArtifacts) await writeFile(path.join(directory, file), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  browser.artifacts = await hashEvidenceFiles(directory, [...traceBrowserArtifacts, 'trace-safe-export.json']);
  const names = await traceRegressionNames();
  if (names.length !== traceRegressionCount) throw new Error('Trace regression roster changed');
  const tap = 'TAP version 13\n' + names.map((name, index) => `ok ${index + 1} - ${name}\n`).join('') + `1..${names.length}\n# tests ${names.length}\n# suites 0\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
  const checks = [], logs = [];
  for (const [index, name] of ['workflows', 'regressions', 'browser'].entries()) {
    const log = name === 'regressions' ? tap : 'Synthetic reader envelope only\n'; logs.push(`CHECK ${name}\n${log}`); await writeFile(path.join(directory, `${name}.log`), log);
    const command = name === 'regressions' ? ['--test', '--test-reporter=tap', '--test-timeout=25000', ...traceRegressionFiles] : [`test-support/trace-business-${name === 'workflows' ? 'worker' : 'browser'}.mjs`, directory];
    checks.push({ name, command: [process.execPath, ...command], configuredTimeoutMs: [40000, 45000, 60000][index], ...(name === 'regressions' ? { files: traceRegressionFiles } : {}),
      execution: { code: 0, signal: null, timedOut: false, interrupted: false, ok: true, durationMs: 1, tail: log.slice(-12000), ...(name === 'regressions' ? tapSummary(log) : {}) } });
  }
  await json(path.join(directory, 'business-observations.json'), business); await json(path.join(directory, 'trace-browser.json'), browser);
  const observations = { sourceStart: source, sourceEnd: source, sourceStable: true, checks, cleanupOk: true, budgetExpired: false,
    validation: validateTraceBusinessObservations(business, { source: context.source, mutations }),
    businessArtifact: { path: 'business-observations.json', sha256: digest(await readFile(path.join(directory, 'business-observations.json'))) }, browser, browserValid: true, mutations };
  await json(path.join(directory, 'observations.json'), observations); await writeFile(path.join(directory, 'worker.log'), logs.join('\n'));
  const artifacts = await hashEvidenceFiles(directory, ['observations.json', 'worker.log']);
  const results = traceBusinessProperties.map(property => ({ ...context, property: { id: property.id, version: property.version }, startedAt: time, finishedAt: time,
    complete: true, status: 'passed', scope: traceEvidenceScope(property), artifacts }));
  const summary = summarize({ results, target: context.source, required: traceBusinessProfile, release: false,
    execution: { code: 0, signal: null, timedOut: false, interrupted: false, complete: true }, artifactsValid: results.map(() => true) });
  const report = { ...context, profile: 'trace-business', profileVersion: 1, nodeOnly: false, sourceStart: source, sourceEnd: source, startedAt: time, finishedAt: time,
    complete: true, ok: true, results, summary: { required: traceBusinessProfile, rows: summary.rows, nodeOnly: false, fullTraceBusinessProfile: true, fullProjectAcceptance: false } };
  await json(path.join(directory, 'report.json'), report); return { report, observations, business, browser };
}
