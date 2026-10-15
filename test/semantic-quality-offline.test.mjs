import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSemanticOffline, inspectSemanticOffline } from '../scripts/lib/semantic-quality-offline.mjs';
import { qualitySources } from '../scripts/lib/quality-collector.mjs';
import { captureSemanticOffline } from '../scripts/lib/semantic-quality-capture.mjs';
import { createSemanticFailureCases } from '../scripts/lib/semantic-quality-failures.mjs';
import { createSemanticReviewTemplate } from '../scripts/lib/semantic-quality-review.mjs';
import { semanticFixtureSample, semanticFixtureResponse, semanticFixtureReviewers, semanticMutations } from '../test-support/semantic-quality-fixture.mjs';
let root, directory, source;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'semantic-offline-test-')); directory = path.join(root, 'run');
  const run = await runSemanticOffline(directory); assert.equal(run.complete, true, run.errorCode); source = await qualitySources();
}, { timeout: 40000 });
after(() => rm(root, { recursive: true, force: true }));
test('all actual workflow outputs and deliberate semantic negatives are revalidated', async () => {
  const r = await inspectSemanticOffline(directory, source); assert.equal(r.infrastructurePassed, true, JSON.stringify(r));
  assert.deepEqual(r.scope, { cases: 11, positive: 3, semanticMutantsDetected: 8, artifacts: 56 });
  assert.equal(r.qualityStatus, 'not_run'); assert.equal(r.qualityEvaluated, false); assert.equal(r.fullQualityAcceptance, false);
  assert.equal(r.releaseEligible, false); assert.equal(r.liveCalls, 0); assert.equal(r.properties[0].status, 'not_run');
});
const changes = [
  ['run.json', 'quality label', r => { r.qualityStatus = 'passed'; }],
  ['run.json', 'live promotion', r => { r.mode = 'live'; }],
  ['run.json', 'missing case', r => { r.cases.pop(); }],
  ['run.json', 'self asserted detection', r => { r.cases[0].detected = true; }],
  ['run.json', 'missing source', r => { delete r.sourceEnd; }],
  ['qualified/review-template.json', 'prefilled template', r => { r.reviewer = 'invented'; }],
  ['qualified/synthetic-review.json', 'edited display output', r => { r.rows[0].output.value.canonical_name = 'changed'; }],
  ['qualified/synthetic-review.json', 'omitted output', r => { r.rows.pop(); }],
  ['qualified/synthetic-review.json', 'invented reviewer', r => { r.reviewer = 'real human'; }],
  ['qualified/synthetic-review.json', 'invented gold', r => { r.sample.gold.approved = true; }],
  ['mutant-number/synthetic-review.json', 'removed severe error', r => { r.rows.forEach(row => { row.severe.number = false; }); }],
  ['mutant-upstream-omission/synthetic-review.json', 'omitted missing gold', r => { r.missingGoldIds = []; }],
  ['mutant-number/assessment.json', 'self asserted normal score', r => { r.offlineReviewPassed = true; }],
  ['qualified/capture.json', 'changed provider output', r => { r.calls[0].response = { items: [] }; }],
  ['qualified/capture.json', 'changed raw request', r => { r.calls[0].requestWire += ' '; }],
  ['qualified/capture.json', 'missing raw calls', r => { r.calls = []; }],
  ['qualified/capture.json', 'missing reopen state', r => { delete r.before; }],
];
for (const [filename, name, mutate] of changes) test(`offline gate rejects ${name}`, async () => {
  const full = path.join(directory, filename), original = await readFile(full), report = JSON.parse(original); mutate(report);
  await writeFile(full, JSON.stringify(report));
  try { const r = await inspectSemanticOffline(directory, source); assert.equal(r.infrastructurePassed, false); assert.equal(r.complete, false); assert.equal(r.qualityStatus, 'not_run'); }
  finally { await writeFile(full, original); }
});
test('missing database or different source cannot pass the profile', async () => {
  const full = path.join(directory, 'qualified/store.sqlite'), original = await readFile(full); await rm(full);
  try { assert.equal((await inspectSemanticOffline(directory, source)).infrastructurePassed, false); }
  finally { await writeFile(full, original); }
  assert.equal((await inspectSemanticOffline(directory, { ...source, sha: '0'.repeat(40) })).infrastructurePassed, false);
});
test('cancellation preserves an incomplete capture and no quality claim', async () => {
  const r = await captureSemanticOffline({ directory: path.join(root, 'cancelled'), sample: semanticFixtureSample(), response: semanticFixtureResponse(), signal: AbortSignal.abort() });
  assert.equal(r.complete, false); assert.equal(r.cleanup, true); assert.equal(r.errorCode, 'TIMEOUT_OR_CANCELLED');
  assert.equal(r.qualityStatus, 'not_run'); assert.equal(r.calls.length, 0);
});
for (const args of [['collect'], ['collect','--live'], ['offline','--live'], ['plan','--live']]) test(`CLI rejects paid adapter path ${args.join(' ')}`, () => {
  const result = spawnSync(process.execPath, ['scripts/evaluate-semantic-quality.mjs', ...args], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /LIVE_SEMANTIC_ADAPTER_NOT_IMPLEMENTED_OR_AUTHORIZED/);
  assert.match(result.stderr, /"qualityStatus":"not_run"/);
});

const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const reviewOptions = { reviewers: semanticFixtureReviewers };
async function failureInput(id) {
  return { capture: await json(path.join(directory, id, 'capture.json')), review: await json(path.join(directory, id, 'synthetic-review.json')) };
}
test('failure excerpts preserve all eight actual semantic counterexamples and their reference context', async () => {
  for (const mutation of semanticMutations) {
    const { capture, review } = await failureInput(`mutant-${mutation}`);
    const report = createSemanticFailureCases(capture, review, reviewOptions);
    assert.deepEqual(report, createSemanticFailureCases(capture, review, reviewOptions));
    assert.equal(report.qualityStatus, 'not_run'); assert.equal(report.releaseEligible, false); assert.equal(report.liveCalls, 0);
    assert.equal(report.offlineReviewStatus, 'failed'); assert.ok(report.cases.length > 0);
    assert.deepEqual(report.input.segments, capture.sample.segments);
    assert.equal(report.gold.length, capture.sample.gold.variants[0].units.length);
    const outputs = new Map(report.outputs.map(row => [row.id, row])), gold = new Map(report.gold.map(row => [row.id, row]));
    for (const row of report.cases) {
      assert.ok(row.output === null || outputs.has(row.output)); assert.ok(row.gold === null || gold.has(row.gold));
      assert.ok(row.duplicateOf === null || outputs.has(row.duplicateOf));
    }
    for (const output of outputs.values()) {
      for (const key of ['owner', 'subject', 'object', 'correctionOf']) if (output[key]) assert.ok(outputs.has(output[key]));
      assert.ok(output.sources.length > 0 && output.sources.every(source => typeof report.input.segments[source.index] === 'string' && typeof source.quote === 'string'));
      if (output.kind === 'relation') {
        const original = capture.units[Number(output.id.slice('output-'.length)) - 1];
        for (const key of ['statement', 'polarity', 'modality', 'conditions', 'time_scope', 'attribution'])
          assert.equal(output.value[key], original.value[key]);
      }
    }
    if (mutation === 'upstream-omission') {
      assert.equal(report.metrics.relation.goldCount, 2); assert.equal(report.metrics.relation.recall, 0);
      assert.equal(report.cases.filter(row => gold.get(row.gold)?.kind === 'relation').length, 2);
      assert.ok(report.cases.every(row => row.output === null));
    } else assert.ok(report.cases.some(row => row.reasons.some(reason => reason.types?.includes(mutation))));
    if (mutation === 'duplicate') {
      assert.equal(report.input.ingestionBatchSize, 1); assert.equal(report.input.segments.length, 2);
      const duplicate = report.cases.find(row => row.duplicateOf);
      assert.equal(outputs.get(duplicate.output).owner, outputs.get(duplicate.duplicateOf).owner);
      assert.notEqual(outputs.get(duplicate.output).value.content, outputs.get(duplicate.duplicateOf).value.content);
    }
    if (mutation === 'attribution') for (const row of report.cases.filter(row => row.output))
      assert.equal(outputs.get(outputs.get(row.output).subject).value.canonical_name, 'Orion');
    const wire = JSON.stringify(report);
    for (const id of [capture.run.listeningId, capture.run.runId, ...capture.units.map(row => row.value.id)]) assert.equal(wire.includes(id), false);
    assert.equal(wire.includes(capture.calls[0].endpoint), false); assert.equal(wire.includes(review.reviewer), false);
    assert.equal(wire.includes(review.rows[0].notes), false); assert.equal(wire.includes('requestWire'), false);
  }
});

test('valid empty and passing reviews export zero cases; incomplete or edited annotations are rejected', async () => {
  for (const id of ['qualified', 'independent', 'empty']) {
    const { capture, review } = await failureInput(id), report = createSemanticFailureCases(capture, review, reviewOptions);
    assert.deepEqual(report.cases, []); assert.deepEqual(report.outputs, []); assert.equal(report.offlineReviewStatus, 'passed');
    assert.equal(report.qualityEvaluated, false); assert.equal(report.fullQualityAcceptance, false);
    assert.throws(() => createSemanticFailureCases(capture, createSemanticReviewTemplate(capture, reviewOptions), reviewOptions), /VALID_SEMANTIC_REVIEW_REQUIRED/);
    review.sample.segments[0] = 'forged context';
    assert.throws(() => createSemanticFailureCases(capture, review, reviewOptions), /VALID_SEMANTIC_REVIEW_REQUIRED/);
  }
});

test('failure-cases CLI revalidates raw SQLite, writes a fresh private file and never overwrites', async () => {
  const reviewers = path.join(root, 'reviewers.json'), output = path.join(root, 'failures.json');
  await writeFile(reviewers, JSON.stringify(semanticFixtureReviewers));
  const captureDirectory = path.join(directory, 'mutant-number');
  const args = ['scripts/evaluate-semantic-quality.mjs', 'failure-cases', '--capture', captureDirectory,
    '--reviewers', reviewers, '--review', path.join(captureDirectory, 'synthetic-review.json'), '--out', output];
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(first.stdout).failureCases, 1);
  const { capture, review } = await failureInput('mutant-number');
  assert.deepEqual(await json(output), JSON.parse(JSON.stringify(createSemanticFailureCases(capture, review, reviewOptions))));
  const original = await readFile(output); assert.equal(run().status, 1); assert.deepEqual(await readFile(output), original);
  await rm(output);
  const database = path.join(captureDirectory, 'store.sqlite'), bytes = await readFile(database);
  await writeFile(database, Buffer.concat([bytes, Buffer.from('damaged')]));
  try { assert.equal(run().status, 1); await assert.rejects(readFile(output), { code: 'ENOENT' }); }
  finally { await writeFile(database, bytes); }
});
