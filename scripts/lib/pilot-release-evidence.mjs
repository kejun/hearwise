import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pilot } from '../../verification/properties.mjs';
import { summarize, checkArtifacts, sourceVersion, metadata } from './verification-evidence.mjs';

export async function validatePilotEvidence(directory, { release = true } = {}) {
  let report;
  try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); }
  catch { return { kind: 'pilot', ok: false, status: 'not_run', reasons: ['missing_report'], fullProjectAcceptance: false }; }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { kind: 'pilot', ok: false, status: 'incomplete', reasons: ['invalid_report'], fullProjectAcceptance: false };
  const reasons = [], target = sourceVersion(); let summary;
  try {
    assert.equal(report.complete, true); assert.equal(report.execution?.complete, true); assert.equal(report.execution?.ok, true);
    assert.equal(report.execution?.code, 0); assert.equal(report.execution?.signal, null); assert.equal(report.execution?.timedOut, false); assert.equal(report.execution?.interrupted, false); assert.ok(!report.execution?.error);
    const context = JSON.parse(await readFile(path.join(directory, 'context.json'), 'utf8')), expected = await metadata();
    for (const key of Object.keys(context)) { assert.deepEqual(report[key], context[key]); assert.deepEqual(report.results?.[0]?.[key], context[key]); }
    assert.deepEqual(context.source, target); assert.deepEqual(context.tools, expected.tools); assert.deepEqual(context.specification, expected.specification);
    assert.ok(['platform', 'arch', 'release'].every(key => typeof context.environment?.[key] === 'string' && context.environment[key]));
    assert.ok(/^v24\./.test(context.tools.node));
    assert.equal(report.profile, 'pilot'); assert.equal(report.scenario, 'success'); assert.equal(report.results.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')), report.results[0]);
    const log = await readFile(path.join(directory, 'worker.log'), 'utf8'); assert.equal(log.slice(-12000), report.execution.tail);
    const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
    assert.equal(observations.scenario, 'success'); assert.equal(observations.providerCalls, 1);
    assert.deepEqual(observations.checkpoints.map(row => row.action), ['admitted', 'before-provider-response', 'workflow-returned']);
    assert.ok(observations.identity.listeningId && observations.identity.jobId);
    const [admitted, reserved, committed] = observations.checkpoints;
    assert.equal(admitted.job.state, 'pending'); assert.equal(admitted.processingState, 'queued'); assert.equal(admitted.hasWork, true);
    assert.equal(admitted.job.request_count, 0); assert.equal(admitted.journal.length, 0); assert.equal(admitted.relations.length, 0);
    assert.equal(reserved.job.state, 'running'); assert.equal(reserved.processingState, 'running'); assert.equal(reserved.hasWork, true);
    assert.deepEqual(reserved.journal, [{ attempt: 1, outcome: null }]);
    assert.equal(reserved.job.request_count, 1); assert.equal(reserved.journal.length, 1); assert.equal(reserved.relations.length, 0);
    assert.equal(committed.job.state, 'complete'); assert.equal(committed.job.request_count, 1); assert.equal(committed.job.last_error, null);
    assert.equal(committed.processingState, 'complete'); assert.equal(committed.journal[0].attempt, 1);
    assert.equal(committed.journal.length, 1); assert.equal(committed.journal[0].outcome, 'complete');
    assert.equal(committed.relations.length, 1); assert.equal(committed.relations[0].predicate, 'released');
    assert.equal(committed.relations[0].subject, 'atlas'); assert.equal(committed.relations[0].object, 'nova'); assert.equal(committed.hasWork, false);
    assert.equal(observations.businessResult.stale, false); assert.equal(observations.businessResult.changed, true); assert.equal(observations.businessResult.accepted, 1);
    assert.deepEqual(observations.businessResult.rejected, []); assert.equal(observations.businessResult.state, 'complete');
    assert.equal(observations.businessResult.kind, 'terminal'); assert.equal(observations.businessResult.outcome, 'ok');
    summary = summarize({ results: report.results, required: pilot, execution: report.execution, target, release,
      artifactsValid: await Promise.all(report.results.map(row => checkArtifacts(directory, row))) });
    if (!summary.ok) reasons.push('pilot_gate_rejected');
  } catch { reasons.push('invalid_raw_pilot_evidence'); }
  const incomplete = report.complete !== true || report.execution?.timedOut || report.execution?.interrupted || report.execution?.signal;
  const stale = report.source?.sha !== target.sha || report.source?.dirty !== target.dirty;
  const status = incomplete ? 'incomplete' : report.execution?.code !== 0 ? 'failed' : reasons.length ? 'incomplete' : 'passed';
  return { kind: 'pilot', ok: status === 'passed' && !stale && !reasons.length, status,
    stale, source: report.source, target, reasons, propertyRows: summary?.rows,
    methods: ['implementation-scenario'], scope: { samples: 1, seed: null, description: 'One real SQLite relation reservation/response/commit with an injected provider; no general concurrency claim.' }, fullProjectAcceptance: false };
}
