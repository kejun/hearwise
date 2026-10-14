import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { assessQuality, compareQualityMetrics, readQualityCollection } from '../scripts/lib/quality-assessment.mjs';
import { contractDigest, estimateQualityBudget, hashBytes, seriousErrorTypes } from '../scripts/lib/quality-contract.mjs';
import { scoreAsr } from '../scripts/lib/quality-metrics.mjs';
import { collectQualityRun, qualitySources } from '../scripts/lib/quality-collector.mjs';
import { qualityOfflineProvider } from '../test-support/quality-offline.mjs';
import { comparisonThresholds, contractFixtureLabel, mutateFixtureJson, mutateFixtureLog, mutateFixtureTrial,
  readFixtureJson, writeSyntheticAssessmentFixture } from '../test-support/quality-assessment-fixture.mjs';

// All positive evidence shapes below are synthetic contract tests, never real
// measurements. Tests keep assessment objects in memory and remove raw fixtures.
const clone = value => structuredClone(value);
const noSeriousErrors = () => seriousErrorTypes.map(() => false);
const asrRow = (role, { reference = 'a b c d e f g h', hypothesis = reference, language = 'en', metric = 'wer', id = 'speech', serious = [] } = {}) => ({
  trialId: `${role}:${id}:asr:0`, kind: 'asr', language, serious: seriousErrorTypes.map(type => serious.includes(type)),
  metric: scoreAsr([reference], hypothesis, metric)
});
const mtRows = (role, scores) => scores.map((meaningScore, index) => ({ trialId: `${role}:meaning:mt:${index}`, kind: 'mt',
  language: 'en', serious: noSeriousErrors(), meaningScore }));
const compare = (baseline, candidate, thresholds = {}) => compareQualityMetrics(baseline, candidate, { ...comparisonThresholds, ...thresholds });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'quality-assessment-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return writeSyntheticAssessmentFixture(directory);
}
const reportFile = (bundle, role = 'candidate') => path.join(bundle[`${role}Directory`], 'collection.json');
async function assertNotQualityPass(bundle, expectedStatus = 'incomplete') {
  const result = await assessQuality(bundle);
  assert.equal(result.complete, false, JSON.stringify(result));
  assert.equal(result.qualityEvaluated, false);
  assert.equal(result.qualityStatus, expectedStatus);
  assert.notEqual(result.passed, true);
  assert.equal(result.perSample, undefined);
  assert.deepEqual(result.reasons, [expectedStatus === 'not_run' ? 'OFFLINE_RESULTS_ARE_NOT_QUALITY_EVIDENCE' : 'MISSING_CHANGED_OR_INVALID_QUALITY_EVIDENCE']);
  return result;
}

for (const type of ['number', 'negation']) test(`${type} error independently vetoes otherwise passing aggregate ASR and MT`, () => {
  const reference = ['Do', 'not', 'pay', '15.', ...Array(96).fill('context')].join(' ');
  const hypothesis = type === 'number' ? reference.replace('15.', '50.') : reference.replace('not', 'now');
  const baseline = [asrRow('baseline', { reference }), ...mtRows('baseline', [4])];
  const candidate = [asrRow('candidate', { reference, hypothesis }), ...mtRows('candidate', [4])];
  const aggregateOnly = compare(baseline, candidate);
  assert.equal(aggregateOnly.passed, true);
  assert.equal(aggregateOnly.summary['asr:en:wer'].candidate.errorRate, 0.01);
  candidate[0].serious[seriousErrorTypes.indexOf(type)] = true;
  const asrVeto = compare(baseline, candidate);
  assert.equal(asrVeto.passed, false);
  assert.deepEqual(asrVeto.failures, [{ trialId: candidate[0].trialId, reason: 'serious_error', types: [type] }]);
  candidate[0].serious = noSeriousErrors();
  candidate[1].serious[seriousErrorTypes.indexOf(type)] = true;
  const mtVeto = compare(baseline, candidate);
  assert.equal(mtVeto.passed, false);
  assert.deepEqual(mtVeto.failures, [{ trialId: candidate[1].trialId, reason: 'serious_error', types: [type] }]);
});

test('candidate serious errors are not excused by an equally bad baseline or a permissive aggregate threshold', () => {
  const baseline = [asrRow('baseline', { serious: ['number', 'negation'] })];
  const candidate = [asrRow('candidate', { serious: ['number', 'negation'] })];
  const result = compare(baseline, candidate, { asrErrorRateMax: 1, asrRegressionMax: 1, seriousErrorMax: 99 });
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures[0].types, ['number', 'negation']);
  candidate[0].serious = noSeriousErrors();
  assert.equal(compare(baseline, candidate).passed, true);
});

test('ASR thresholds use upper bounds, inclusive equality and candidate-minus-baseline regression', async t => {
  const rows = [
    { name: 'error equality passes', b: 'a b c d e f g h', c: 'x y c d e f g h', thresholds: { asrRegressionMax: 0.25 }, pass: true },
    { name: 'error increase above maximum fails', b: 'a b c d e f g h', c: 'x y z d e f g h', thresholds: { asrRegressionMax: 0.5 }, pass: false },
    { name: 'omission equality passes', b: 'a b c d e f g h', c: 'a b c d e f g', pass: true },
    { name: 'omission above maximum fails', b: 'a b c d e f g h', c: 'a b c d e f', thresholds: { asrRegressionMax: 0.25 }, pass: false },
    { name: 'regression equality passes', b: 'x b c d e f g h', c: 'x y c d e f g h', pass: true },
    { name: 'regression above maximum fails', b: 'a b c d e f g h', c: 'x y c d e f g h', pass: false },
    { name: 'improvement is not a regression', b: 'x y z d e f g h', c: 'x b c d e f g h', pass: true }
  ];
  for (const row of rows) await t.test(row.name, () => {
    const result = compare([asrRow('baseline', { hypothesis: row.b })], [asrRow('candidate', { hypothesis: row.c })], row.thresholds);
    assert.equal(result.passed, row.pass);
    assert.deepEqual(result.failures.map(failure => failure.reason), row.pass ? [] : ['asr_threshold']);
    const summary = result.summary['asr:en:wer'];
    assert.equal(summary.delta, summary.candidate.errorRate - summary.baseline.errorRate);
  });
});

test('MT thresholds use lower retention bounds and baseline-minus-candidate regression', async t => {
  const rows = [
    { name: 'retention equality passes', b: [3, 3], c: [3, 3], pass: true },
    { name: 'retention below minimum fails', b: [2, 2], c: [2, 2], pass: false },
    { name: 'regression equality passes', b: [4, 3], c: [3, 3], pass: true },
    { name: 'regression above maximum fails', b: [4, 4], c: [3, 3], pass: false },
    { name: 'improvement is not a regression', b: [2, 2], c: [4, 4], pass: true }
  ];
  for (const row of rows) await t.test(row.name, () => {
    const result = compare(mtRows('baseline', row.b), mtRows('candidate', row.c));
    assert.equal(result.passed, row.pass);
    assert.deepEqual(result.failures.map(failure => failure.reason), row.pass ? [] : ['mt_threshold']);
    const summary = result.summary['mt:en:human-meaning'];
    assert.equal(summary.delta, summary.candidate.mean - summary.baseline.mean);
  });
});

test('silence has no WER denominator and its hallucination veto cannot disappear in a voiced aggregate', () => {
  const baseline = [asrRow('baseline'), asrRow('baseline', { reference: '', hypothesis: '', id: 'silence' })];
  const candidate = [asrRow('candidate'), asrRow('candidate', { reference: '', hypothesis: ' \t ', id: 'silence' })];
  assert.equal(candidate[1].metric.referenceUnits, 0);
  assert.equal(candidate[1].metric.errorRate, null);
  assert.equal(candidate[1].metric.omissionRate, null);
  const quiet = compare(baseline, candidate);
  assert.equal(quiet.passed, true);
  assert.deepEqual(quiet.summary['asr:en:empty-reference-hallucination'], { baseline: 0, candidate: 0 });
  assert.equal(quiet.summary['asr:en:wer'].candidate.referenceUnits, 8);
  assert.equal(quiet.summary['asr:en:wer'].candidate.sampleCount, 1);
  candidate[1] = asrRow('candidate', { reference: '', hypothesis: 'invented speech', id: 'silence' });
  const hallucinated = compare(baseline, candidate);
  assert.equal(hallucinated.passed, false);
  assert.deepEqual(hallucinated.failures, [{ group: 'asr:en:empty-reference-hallucination', reason: 'silence_hallucination' }]);
  assert.equal(hallucinated.summary['asr:en:wer'].candidate.errorRate, 0);
  const silenceOnly = compare([baseline[1]], [asrRow('candidate', { reference: '', hypothesis: '', id: 'silence' })]);
  assert.equal(silenceOnly.passed, true);
  assert.deepEqual(silenceOnly.summary, { 'asr:en:empty-reference-hallucination': { baseline: 0, candidate: 0 } });
});

test('ASR languages and metrics stay separate and unequal group counts are rejected', () => {
  const baseline = [asrRow('baseline'), asrRow('baseline', { language: 'zh', metric: 'cer', reference: '甲乙丙丁', id: 'chinese' })];
  const candidate = [asrRow('candidate'), asrRow('candidate', { language: 'zh', metric: 'cer', reference: '甲乙丙丁', hypothesis: '甲乙戊己', id: 'chinese' })];
  const result = compare(baseline, candidate);
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [{ group: 'asr:zh:cer', reason: 'asr_threshold' }]);
  assert.equal(result.summary['asr:en:wer'].candidate.errorRate, 0);
  assert.throws(() => compare(baseline, [candidate[0]]));
  assert.throws(() => compare([baseline[0]], candidate));
});

test('synthetic contract fixture reaches scoring without creating a real measurement or assessment file', async t => {
  const bundle = await fixture(t);
  for (const role of ['baseline', 'candidate']) {
    const read = await readQualityCollection(bundle[`${role}Directory`], bundle.frozen, role);
    assert.equal(read.report.fixtureLabel, contractFixtureLabel);
    assert.equal(read.trials.length, 6);
    assert.ok(read.trials.every(trial => trial.fixtureLabel === contractFixtureLabel));
    assert.ok(read.trials.every(trial => trial.sample.split === 'acceptance'));
  }
  const result = await assessQuality(bundle);
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.qualityEvaluated, true);
  assert.equal(result.passed, true);
  assert.equal(result.qualityStatus, 'passed');
  assert.equal(result.perSample.baseline.length, 6);
  assert.equal(result.perSample.candidate.length, 6);
  assert.equal(result.reviewArtifactSha256, hashBytes(await readFile(bundle.reviewFile)));
  for (const variation of Object.values(result.repeatVariation)) assert.deepEqual(variation, { distinctOutputs: 1, repetitions: 2 });
});

const invalidCollectionCases = [
  ['missing collection', bundle => rm(reportFile(bundle))],
  ['missing raw trial', bundle => rm(path.join(bundle.candidateDirectory, 'trial-0', 'trial.json'))],
  ['missing application log', bundle => rm(path.join(bundle.candidateDirectory, 'trial-0', 'application.log'))],
  ['raw trial changed without updating its hash', bundle => mutateFixtureJson(path.join(bundle.candidateDirectory, 'trial-0', 'trial.json'), trial => { trial.result.output = 'forged output'; })],
  ['raw log changed without updating its hash', bundle => writeFile(path.join(bundle.candidateDirectory, 'trial-0', 'application.log'), 'forged log')],
  ['forged collection-level pass flag', bundle => mutateFixtureJson(reportFile(bundle), report => { report.qualityEvaluated = true; report.qualityStatus = 'passed'; })],
  ['incomplete collection despite complete trials', bundle => mutateFixtureJson(reportFile(bundle), report => { report.complete = false; })],
  ['interrupted collection', bundle => mutateFixtureJson(reportFile(bundle), report => { report.interrupted = true; })],
  ['incomplete collection cleanup', bundle => mutateFixtureJson(reportFile(bundle), report => { report.cleanup = false; })],
  ['wrong collection role', bundle => mutateFixtureJson(reportFile(bundle), report => { report.role = 'baseline'; })],
  ['wrong freeze digest', bundle => mutateFixtureJson(reportFile(bundle), report => { report.frozenDigest = hashBytes('forged freeze'); })],
  ['wrong freeze file hash', bundle => mutateFixtureJson(reportFile(bundle), report => { report.freezeFileSha256 = hashBytes('forged freeze file'); })],
  ['wrong freeze timestamp', bundle => mutateFixtureJson(reportFile(bundle), report => { report.frozenAt = '2000-01-01T00:00:00.000Z'; })],
  ['missing start source', bundle => mutateFixtureJson(reportFile(bundle), report => { delete report.sourceStart; })],
  ['missing end source', bundle => mutateFixtureJson(reportFile(bundle), report => { delete report.sourceEnd; })],
  ['candidate source replaced with the baseline source', async bundle => {
    const baseline = await readFixtureJson(reportFile(bundle, 'baseline'));
    await mutateFixtureJson(reportFile(bundle), report => { report.sourceStart = baseline.sourceStart; report.sourceEnd = baseline.sourceEnd; });
  }],
  ['dirty source hidden by an otherwise matching source pair', bundle => mutateFixtureJson(reportFile(bundle), report => { report.sourceStart.dirty = true; report.sourceEnd.dirty = true; })],
  ['forged tracked source hash despite matching source pair', bundle => mutateFixtureJson(reportFile(bundle), report => { report.sourceStart.files['package-lock.json'] = hashBytes('forged tracked lock'); report.sourceEnd.files['package-lock.json'] = hashBytes('forged tracked lock'); })],
  ['missing tracked source path', bundle => mutateFixtureJson(reportFile(bundle), report => { delete report.sourceStart.files['README.md']; delete report.sourceEnd.files['README.md']; })],
  ['unexpected extra source path', bundle => mutateFixtureJson(reportFile(bundle), report => { report.sourceStart.files['forged-extra.mjs'] = hashBytes('extra'); report.sourceEnd.files['forged-extra.mjs'] = hashBytes('extra'); })],
  ['source changes during collection', bundle => mutateFixtureJson(reportFile(bundle), report => { report.sourceEnd.files['package-lock.json'] = hashBytes('changed lock'); })],
  ['missing runtime source digest', bundle => mutateFixtureJson(reportFile(bundle), report => { delete report.sourceStart.files['dist/server/index.js']; delete report.sourceEnd.files['dist/server/index.js']; })],
  ['request-builder hash mismatches frozen role', bundle => mutateFixtureJson(reportFile(bundle), report => { report.sourceStart.files['server.mjs'] = hashBytes('other builder'); report.sourceEnd.files['server.mjs'] = hashBytes('other builder'); })],
  ['changed frozen run cap', bundle => mutateFixtureJson(reportFile(bundle), report => { report.maxRunMs++; })],
  ['collection starts before freeze', bundle => mutateFixtureJson(reportFile(bundle), report => { report.startedAt = '2000-01-01T00:00:00.000Z'; })],
  ['declared trial count reduced to hide a missing repetition', bundle => mutateFixtureJson(reportFile(bundle), report => { report.trials.pop(); report.expectedTrials--; })],
  ['extra duplicate trial', bundle => mutateFixtureJson(reportFile(bundle), report => { report.trials.push(clone(report.trials[0])); report.expectedTrials++; })],
  ['reordered trial paths', bundle => mutateFixtureJson(reportFile(bundle), report => { [report.trials[0], report.trials[1]] = [report.trials[1], report.trials[0]]; })],
  ['missing trial schema version', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { delete trial.schemaVersion; })],
  ['unsupported trial schema version', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.schemaVersion = 999; })],
  ['provider upstream starts before the durable reservation', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].upstreamStartedAt = trial.provider[0].startedAt; })],
  ['missing provider upstream-start timestamp', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { delete trial.provider[0].upstreamStartedAt; })],
  ['provider completion predates its own start', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].startedAt = trial.finishedAt; })],
  ['provider start occurs after the containing trial ends', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].startedAt = new Date(Date.parse(trial.finishedAt) + 1).toISOString(); })],
  ['wrong trial role with a recomputed outer hash', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.role = 'baseline'; })],
  ['wrong sample ID with a recomputed outer hash', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.sampleId = 'development-only'; })],
  ['duplicate repetition with a recomputed outer hash', bundle => mutateFixtureTrial(bundle, 'candidate', 1, trial => { trial.repetition = 0; trial.trialId = trial.trialId.replace(/1$/, '0'); })],
  ['trial config mismatches frozen candidate role', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.config.mtModel = 'forged-model'; })],
  ['truncated application log flag even when hashes match', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.logTruncated = true; })],
  ['application log loses its trace even when all hashes are recomputed', bundle => mutateFixtureLog(bundle, 'candidate', 0, `${contractFixtureLabel}\ntruncated\n`)],
  ['malformed raw execution trace even when all hashes are recomputed', bundle => mutateFixtureLog(bundle, 'candidate', 0, 'execution_trace {malformed\n')],
  ['runtime trace uses another source SHA', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.traceBuilds[0].git_sha = bundle.frozen.config.roles.baseline.sourceSha; })],
  ['runtime trace marks the build dirty', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.traceBuilds[0].build_dirty = true; })],
  ['missing runtime trace build', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.traceBuilds = []; })],
  ['output hash mismatches raw output', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.outputSha256 = hashBytes('forged output'); })],
  ['offline trial mode under a live collection header', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.mode = 'offline'; })],
  ['offline trial evidence kind under a live collection header', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.evidenceKind = 'offline-provider-stub'; })],
  ['offline provider mode under live collection and trial headers', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].mode = 'offline'; })],
  ['offline provider evidence kind under live collection and trial headers', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].evidenceKind = 'offline-provider-stub'; })],
  ['wrong provider endpoint', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].endpoint = 'https://forged.example.invalid/'; })],
  ['ASR parameters differ from frozen mode and source', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].config.parameters.language_hints = ['zh']; })],
  ['wrong provider model', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].model = 'forged-model'; })],
  ['no successful provider attempt', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].status = 'failed'; })],
  ['missing reserved provider attempt', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].attemptId = '9999'; })],
  ['missing canonical ASR completion', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.result.events = trial.result.events.filter(row => row.event.type !== 'finished'); })],
  ['ASR audio count differs from frozen sample', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.result.audioBytes++; })],
  ['ASR canonical final differs from raw provider output', bundle => mutateFixtureTrial(bundle, 'candidate', 0, trial => { trial.provider[0].outputs[0].text = 'different raw provider output'; })],
  ['MT request differs from frozen sample', bundle => mutateFixtureTrial(bundle, 'candidate', 2, trial => { trial.result.input = 'changed input'; })],
  ['MT output differs from raw provider output', bundle => mutateFixtureTrial(bundle, 'candidate', 2, trial => { trial.provider[0].output = 'changed output'; })],
  ['budget reservation sum forged', bundle => mutateFixtureJson(reportFile(bundle), report => { report.budget.after.reservedMicros--; })],
  ['budget binding changed', bundle => mutateFixtureJson(reportFile(bundle), report => { report.budget.after.binding = hashBytes('different budget'); })],
  ['budget reservation assigned to another trial', bundle => mutateFixtureJson(reportFile(bundle), report => { report.budget.after.attempts.at(-1).trial_id = 'forged-trial'; })]
];

test('strict reader and assessor reject missing, forged, truncated and role-mismatched raw evidence', async t => {
  for (const [name, mutate] of invalidCollectionCases) await t.test(name, async child => {
    const bundle = await fixture(child);
    await mutate(bundle);
    await assert.rejects(() => readQualityCollection(bundle.candidateDirectory, bundle.frozen, 'candidate'));
    await assertNotQualityPass(bundle);
  });
});

test('frozen repetition and acceptance counts cannot silently change at assessment time', async t => {
  for (const [name, mutate] of [
    ['extra frozen repetition', frozen => { frozen.config.repetitions++; }],
    ['acceptance sample dropped', frozen => { frozen.corpus.samples = frozen.corpus.samples.filter(row => row.id !== 'silence'); }],
    ['development sample inserted into acceptance', frozen => { frozen.corpus.samples.at(-1).split = 'acceptance'; }]
  ]) await t.test(name, async child => {
    const bundle = await fixture(child);
    mutate(bundle.frozen);
    await assert.rejects(() => readQualityCollection(bundle.candidateDirectory, bundle.frozen, 'candidate'));
    await assertNotQualityPass(bundle);
  });
});

const invalidReviewCases = [
  ['missing review file', bundle => rm(bundle.reviewFile)],
  ['machine review relabeled as human output', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.method = 'model-judge'; })],
  ['wrong review freeze digest', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.frozenDigest = hashBytes('different freeze'); })],
  ['missing one trial review', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows.pop(); })],
  ['duplicate trial review replacing another', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[1] = clone(review.rows[0]); })],
  ['review refers to another output', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[0].outputSha256 = hashBytes('another output'); })],
  ['unapproved human reviewer', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[0].reviewer = 'unapproved-reviewer'; })],
  ['review before trial completion', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[0].reviewedAt = '2000-01-01T00:00:00.000Z'; })],
  ['review in the future', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[0].reviewedAt = new Date(Date.now() + 3600000).toISOString(); })],
  ['missing serious-error field', bundle => mutateFixtureJson(bundle.reviewFile, review => { delete review.rows[0].serious.negation; })],
  ['extra serious-error field', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[0].serious.unknown = false; })],
  ['nonboolean serious-error field', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[0].serious.number = 0; })],
  ['serious error without explanatory notes', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[0].serious.number = true; review.rows[0].notes = ' '; })],
  ['missing MT meaning score', bundle => mutateFixtureJson(bundle.reviewFile, review => { delete review.rows[2].meaningScore; })],
  ['fractional MT meaning score', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[2].meaningScore = 3.5; })],
  ['out-of-range MT meaning score', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[2].meaningScore = 5; })],
  ['meaning score zero without serious-error classification', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[2].meaningScore = 0; })],
  ['meaning score one without serious-error classification', bundle => mutateFixtureJson(bundle.reviewFile, review => { review.rows[2].meaningScore = 1; })]
];

test('human review must cover every frozen trial and be approved, timestamped and output-bound', async t => {
  for (const [name, mutate] of invalidReviewCases) await t.test(name, async child => {
    const bundle = await fixture(child);
    await mutate(bundle);
    // Both raw collections remain structurally valid, isolating the review gate.
    for (const role of ['baseline', 'candidate']) await readQualityCollection(bundle[`${role}Directory`], bundle.frozen, role);
    await assertNotQualityPass(bundle);
  });
});

for (const type of ['number', 'negation']) test(`synthetic human ${type} finding yields a completed failed assessment even with perfect metric aggregates`, async t => {
  const bundle = await fixture(t);
  await mutateFixtureJson(bundle.reviewFile, review => {
    const row = review.rows.find(row => row.trialId === 'candidate:speech:mt:0');
    row.serious[type] = true; row.notes = `Synthetic contract-test ${type} classification only.`;
  });
  const result = await assessQuality(bundle);
  assert.equal(result.complete, true);
  assert.equal(result.qualityEvaluated, true);
  assert.equal(result.qualityStatus, 'failed');
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [{ trialId: 'candidate:speech:mt:0', reason: 'serious_error', types: [type] }]);
  assert.equal(result.summary['asr:en:wer'].candidate.errorRate, 0);
  assert.equal(result.summary['mt:en:human-meaning'].candidate.mean, 1);
});

test('individually valid collections still require a continuous shared budget and baseline-first execution', async t => {
  for (const [name, mutate] of [
    ['candidate budget starts with another trial history', bundle => mutateFixtureJson(reportFile(bundle), report => {
      for (const snap of [report.budget.before, report.budget.after]) snap.attempts[0].trial_id = 'different-baseline-history';
    })],
    ['candidate starts before baseline ends', bundle => mutateFixtureJson(reportFile(bundle), report => {
      report.startedAt = new Date(Date.parse(report.startedAt) - 11000).toISOString();
    })]
  ]) await t.test(name, async child => {
    const bundle = await fixture(child);
    await mutate(bundle);
    for (const role of ['baseline', 'candidate']) await readQualityCollection(bundle[`${role}Directory`], bundle.frozen, role);
    await assertNotQualityPass(bundle);
  });
});

test('actual offline collector evidence and a collection-header mode flip cannot quality-pass', { timeout: 25000 }, async t => {
  const bundle = await fixture(t), source = await qualitySources(), provider = await qualityOfflineProvider();
  t.after(() => provider.close());
  const frozen = clone(bundle.frozen), sample = clone(frozen.corpus.samples[0]), audio = Buffer.alloc(640);
  sample.audio = { path: 'synthetic-offline.pcm', format: 'pcm-s16le-mono-16000', bytes: audio.length, durationMs: 20,
    sha256: hashBytes(audio), transform: 'synthetic zeros for offline contract test only' };
  sample.kind = 'offline-only-synthetic';
  frozen.corpus.samples = [sample];
  const template = await readFixtureJson(new URL('../verification/asr-translation-quality/plan.template.json', import.meta.url));
  frozen.config.roles.candidate = { ...template.roles.candidate, maxConnectionMs: 5000 };
  frozen.config.roles.candidate.sourceSha = source.sha;
  frozen.config.roles.candidate.sourceTree = source.tree;
  frozen.config.roles.candidate.requestBuilderSha256 = source.files['server.mjs'];
  frozen.config.roles.candidate.maxRunMs = 20000;
  frozen.digest = contractDigest({ config: frozen.config, corpus: frozen.corpus });
  frozen.estimate = estimateQualityBudget(frozen.config, frozen.corpus.samples);
  frozen.corpusPath = path.join(bundle.directory, 'synthetic-offline-corpus.json');
  await writeFile(path.join(bundle.directory, sample.audio.path), audio);
  const directory = path.join(bundle.directory, 'actual-offline-run');
  const result = await collectQualityRun({ frozen, role: 'candidate', directory, mode: 'offline', upstream: provider.upstream });
  const trialOutcomes = await Promise.all(result.trials.map(async artifact => {
    const trial = await readFixtureJson(path.join(directory, artifact.path));
    return { trialId: trial.trialId, status: trial.status, errorCode: trial.errorCode };
  }));
  assert.equal(result.complete, true, JSON.stringify({ complete: result.complete, sourceStable: contractDigest(result.sourceStart) === contractDigest(result.sourceEnd), trialOutcomes }));
  assert.equal(result.cleanup, true);
  assert.equal(result.qualityStatus, 'not_run');
  assert.equal(result.qualityEvaluated, false);
  assert.equal(result.trials.length, 4);
  assert.equal(provider.requests.filter(row => row.kind === 'asr').length, 2);
  assert.equal(provider.requests.filter(row => row.kind === 'mt').length, 2);
  await assert.rejects(() => readQualityCollection(directory, frozen, 'candidate'), /OFFLINE_RESULTS_ARE_NOT_QUALITY_EVIDENCE/);
  // Use the actual offline report as the first collection so the public assessor
  // must classify offline evidence before any unrelated role or review failure.
  await assertNotQualityPass({ ...bundle, frozen, baselineDirectory: directory, candidateDirectory: directory }, 'not_run');
  const filename = path.join(directory, 'collection.json');
  await mutateFixtureJson(filename, report => { report.mode = 'live'; report.evidenceKind = 'live-provider'; });
  await assert.rejects(() => readQualityCollection(directory, frozen, 'candidate'));
  const firstTrial = await readFixtureJson(path.join(directory, result.trials[0].path));
  assert.equal(firstTrial.mode, 'offline');
  assert.equal(firstTrial.evidenceKind, 'offline-provider-stub');
  assert.ok(firstTrial.provider.filter(row => row.attemptId).every(row => row.mode === 'offline' && row.evidenceKind === 'offline-provider-stub'));
  await assertNotQualityPass({ ...bundle, frozen, baselineDirectory: directory, candidateDirectory: directory });
});
test('a completed failed quality assessment is never release eligible, including on clean source', async t => {
  const bundle = await fixture(t);
  await mutateFixtureJson(bundle.reviewFile, review => { const row = review.rows.find(row => row.trialId.startsWith('candidate:')); row.serious.number = true; row.notes = 'Synthetic number counterexample.'; });
  const result = await assessQuality(bundle);
  assert.equal(result.complete, true); assert.equal(result.passed, false); assert.equal(result.qualityStatus, 'failed');
  assert.equal(result.releaseEligible, false); assert.equal(result.fullQualityAcceptance, false);
});
