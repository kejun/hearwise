// Executes only predetermined synthetic provider/review inputs over real workflows.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { qualitySources } from './quality-collector.mjs';
import { contractDigest, hashBytes } from './quality-contract.mjs';
import { writeJson } from './verification-evidence.mjs';
import { captureSemanticOffline } from './semantic-quality-capture.mjs';
import { readSemanticCapture } from './semantic-quality-evidence.mjs';
import { assessSemanticReview, createSemanticReviewTemplate } from './semantic-quality-review.mjs';
import { semanticFixtureSample, semanticFixtureResponse, semanticFixtureReview, semanticFixtureReviewers, semanticMutations } from '../../test-support/semantic-quality-fixture.mjs';
export const semanticOfflineCases = Object.freeze([
  ...['qualified', 'independent', 'empty'].map(sample => ({ id: sample, sample, mutation: 'none' })),
  ...semanticMutations.map(mutation => ({ id: `mutant-${mutation}`, sample: 'qualified', mutation }))
]);
const same = (a, b) => assert.equal(contractDigest(a), contractDigest(b));
const fileJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
export function semanticCaseSample(spec) {
  const sample = semanticFixtureSample(spec.sample);
  if (spec.mutation === 'duplicate') { sample.segments.push(sample.segments[0]); sample.ingestionBatchSize = 1; }
  return sample;
}
export async function runSemanticOffline(directory, { signal } = {}) {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const sourceStart = await qualitySources(), startedAt = new Date().toISOString();
  const timer = new AbortController(), timeout = setTimeout(() => timer.abort(), 150000);
  const combined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  const rows = []; let errorCode;
  try {
    for (const spec of semanticOfflineCases) {
      combined.throwIfAborted();
      const capture = await captureSemanticOffline({ directory: path.join(directory, spec.id), sample: semanticCaseSample(spec), response: semanticFixtureResponse(spec.mutation), signal: combined });
      assert.equal(capture.complete, true);
      const template = createSemanticReviewTemplate(capture, { reviewers: semanticFixtureReviewers });
      const review = await semanticFixtureReview(capture, spec.mutation);
      await writeJson(path.join(directory, spec.id, 'review-template.json'), template);
      await writeJson(path.join(directory, spec.id, 'synthetic-review.json'), review);
      const assessment = assessSemanticReview(capture, review, { reviewers: semanticFixtureReviewers });
      await writeJson(path.join(directory, spec.id, 'assessment.json'), assessment);
      rows.push({ ...spec, contractValid: assessment.contractValid, detected: spec.mutation !== 'none' && !assessment.offlineReviewPassed });
      assert.equal(assessment.contractValid, true); assert.equal(assessment.offlineReviewPassed, spec.mutation === 'none');
    }
  } catch { errorCode = combined.aborted ? 'SEMANTIC_OFFLINE_CANCELLED' : 'SEMANTIC_OFFLINE_INCOMPLETE'; }
  finally { clearTimeout(timeout); }
  const sourceEnd = await qualitySources();
  if (contractDigest(sourceStart) !== contractDigest(sourceEnd)) errorCode = 'SEMANTIC_SOURCE_CHANGED';
  const report = { schemaVersion: 1, kind: 'semantic-offline-contract', mode: 'offline', pipeline: 'knowledge-then-relation-cascade',
    sourceStart, sourceEnd, startedAt, finishedAt: new Date().toISOString(), complete: !errorCode, errorCode,
    cases: rows, liveCalls: 0, qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false, releaseEligible: false };
  await writeJson(path.join(directory, 'run.json'), report); return report;
}
export async function inspectSemanticOffline(directory, targetSource, { release = false } = {}) {
  const boundary = { qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false, releaseEligible: false, liveCalls: 0,
    properties: [{ id: 'HW-05-04', status: 'not_run', method: 'real-corpus-human-review', reason: 'No approved real corpus or live provider adapter/evaluation.' }] };
  const artifacts = [], rows = [];
  try {
    const run = await fileJson(path.join(directory, 'run.json'));
    same(Object.keys(run).sort(), ['schemaVersion','kind','mode','pipeline','sourceStart','sourceEnd','startedAt','finishedAt','complete','cases','liveCalls','qualityStatus','qualityEvaluated','fullQualityAcceptance','releaseEligible'].sort());
    assert.equal(run.schemaVersion, 1); assert.equal(run.kind, 'semantic-offline-contract'); assert.equal(run.mode, 'offline');
    assert.equal(run.pipeline, 'knowledge-then-relation-cascade'); assert.equal(run.complete, true);
    for (const key of ['qualityStatus','qualityEvaluated','fullQualityAcceptance','releaseEligible','liveCalls']) same(run[key], boundary[key]);
    same(run.sourceStart, targetSource); same(run.sourceEnd, targetSource); if (release) assert.equal(targetSource.dirty, false);
    assert.ok(Date.parse(run.finishedAt) >= Date.parse(run.startedAt) && Date.parse(run.finishedAt) <= Date.now());
    assert.equal(run.cases.length, semanticOfflineCases.length);
    for (const [index, spec] of semanticOfflineCases.entries()) {
      const { report: capture, artifacts: captured } = await readSemanticCapture(path.join(directory, spec.id), targetSource, { release });
      same(capture.sample, semanticCaseSample(spec));
      const response = semanticFixtureResponse(spec.mutation);
      for (const [callIndex, call] of capture.calls.entries()) same(call.response, response({ kind: call.kind, input: JSON.parse(call.request.messages.at(-1).content), sample: capture.sample, calls: capture.calls.slice(0, callIndex) }));
      assert.ok(Date.parse(capture.startedAt) >= Date.parse(run.startedAt) && Date.parse(capture.finishedAt) <= Date.parse(run.finishedAt));
      const template = await fileJson(path.join(directory, spec.id, 'review-template.json'));
      same(template, createSemanticReviewTemplate(capture, { reviewers: semanticFixtureReviewers }));
      const review = await fileJson(path.join(directory, spec.id, 'synthetic-review.json'));
      // Bind the deliberate annotation recipe, retaining its actual capture-time
      // reviewer timestamp. This is a test oracle, never inferred human judgment.
      const expectedReview = await semanticFixtureReview(capture, spec.mutation);
      expectedReview.reviewedAt = review.reviewedAt; expectedReview.rows.forEach(row => { row.reviewedAt = review.reviewedAt; }); same(review, expectedReview);
      const assessment = assessSemanticReview(capture, review, { reviewers: semanticFixtureReviewers });
      same(assessment, await fileJson(path.join(directory, spec.id, 'assessment.json')));
      assert.equal(assessment.contractValid, true); assert.equal(assessment.offlineReviewPassed, spec.mutation === 'none');
      const row = { ...spec, contractValid: true, detected: spec.mutation !== 'none' }; same(run.cases[index], row); rows.push(row);
      for (const entry of captured) artifacts.push({ path: `${spec.id}/${entry.path}`, sha256: entry.sha256 });
      for (const filename of ['review-template.json','synthetic-review.json','assessment.json']) artifacts.push({ path: `${spec.id}/${filename}`, sha256: hashBytes(await readFile(path.join(directory, spec.id, filename))) });
    }
    artifacts.push({ path: 'run.json', sha256: hashBytes(await readFile(path.join(directory, 'run.json'))) });
    return { schemaVersion: 1, kind: 'semantic-offline-summary', ...boundary, complete: true, infrastructurePassed: true,
      source: targetSource, scope: { cases: 11, positive: 3, semanticMutantsDetected: 8, artifacts: artifacts.length }, cases: rows, artifacts };
  } catch { return { schemaVersion: 1, kind: 'semantic-offline-summary', ...boundary, complete: false, infrastructurePassed: false,
    source: targetSource, errorCode: 'SEMANTIC_OFFLINE_EVIDENCE_REJECTED', cases: rows, artifacts }; }
}
