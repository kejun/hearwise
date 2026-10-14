import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises'; import path from 'node:path';
import { hashBytes, hashJson, contractDigest, seriousErrorTypes, qualityBudgetConfig, qualityProperties } from './quality-contract.mjs';
import { scoreAsr, aggregateErrors } from './quality-metrics.mjs';
import { sourceVersion } from './verification-evidence.mjs';
import { asrParameters } from './quality-collector.mjs';
import { validateQualityObservations } from './quality-observations.mjs';
const same = (a, b) => assert.equal(contractDigest(a), contractDigest(b));
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
const validSha = value => /^[a-f0-9]{64}$/.test(value || '');
const committedSources = new Map();
function sourceDigests(sha) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  if (!committedSources.has(sha)) {
    const names = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', sha], { encoding: 'utf8', timeout: 5000 }).split('\0').filter(Boolean);
    assert.ok(names.length > 0 && names.every(name => !/[\r\n]/.test(name)));
    const data = execFileSync('git', ['cat-file', '--batch'], { input: names.map(name => `${sha}:${name}`).join('\n') + '\n', maxBuffer: 32 * 1024 * 1024, timeout: 10000 });
    let offset = 0; const result = {};
    for (const name of names) {
      const end = data.indexOf(10, offset), header = data.subarray(offset, end).toString();
      assert.match(header, /^[a-f0-9]{40} blob \d+$/); const size = Number(header.split(' ')[2]);
      offset = end + 1; const bytes = data.subarray(offset, offset + size); assert.equal(bytes.length, size);
      result[name] = hashBytes(bytes); offset += size + 1;
    }
    assert.equal(offset, data.length); committedSources.set(sha, result);
  }
  return committedSources.get(sha);
}

// Independent reload of raw files. Collection flags are necessary, not sufficient.
export async function readQualityCollection(directory, frozen, role) {
  const report = await readJson(path.join(directory, 'collection.json'));
  if (report.mode !== 'live' || report.evidenceKind !== 'live-provider') throw new Error('OFFLINE_RESULTS_ARE_NOT_QUALITY_EVIDENCE');
  assert.equal(report.kind, 'quality-collection'); assert.equal(report.schemaVersion, 1); assert.equal(report.role, role);
  assert.equal(report.complete, true); assert.equal(report.cleanup, true); assert.equal(report.interrupted, false);
  assert.equal(report.qualityEvaluated, false); assert.equal(report.qualityStatus, 'not_run');
  assert.equal(report.frozenDigest, frozen.digest); assert.equal(report.freezeFileSha256, frozen.freezeFileSha256); assert.equal(report.frozenAt, frozen.frozenAt);
  const config = frozen.config.roles[role], source = report.sourceStart;
  assert.equal(source.sha, config.sourceSha); assert.equal(source.tree, config.sourceTree); assert.equal(source.dirty, false); same(source, report.sourceEnd);
  assert.equal(source.files['server.mjs'], config.requestBuilderSha256);
  const tracked = sourceDigests(source.sha);
  same(Object.keys(source.files).sort(), [...Object.keys(tracked), 'dist/server/index.js'].sort());
  for (const [name, digest] of Object.entries(tracked)) assert.equal(source.files[name], digest);
  for (const name of ['server.mjs','package-lock.json','dist/server/index.js']) assert.ok(validSha(source.files[name]));
  for (const name of ['node','sqlite','platform','arch','os']) assert.ok(typeof source[name] === 'string' && source[name]);
  assert.equal(report.maxRunMs, config.maxRunMs);
  assert.ok(Date.parse(report.startedAt) >= Date.parse(frozen.frozenAt)); assert.ok(Date.parse(report.finishedAt) >= Date.parse(report.startedAt));
  assert.ok(Date.parse(report.finishedAt) <= Date.now());
  assert.ok(Date.parse(report.finishedAt) - Date.parse(report.startedAt) <= report.maxRunMs + 20000);
  const expected = frozen.corpus.samples.filter(row => row.split === 'acceptance').flatMap(sample => sample.tasks.flatMap(kind =>
    Array.from({ length: frozen.config.repetitions }, (_, repetition) => ({ sample, kind, repetition, trialId: `${role}:${sample.id}:${kind}:${repetition}` }))));
  assert.ok(expected.length > 0);
  assert.equal(report.expectedTrials, expected.length); assert.equal(report.trials.length, expected.length);
  const trials = [];
  for (const [index, entry] of expected.entries()) {
    const artifact = report.trials[index]; assert.equal(artifact.path, `trial-${index}/trial.json`); assert.ok(validSha(artifact.sha256));
    const bytes = await readFile(path.join(directory, artifact.path)); assert.equal(hashBytes(bytes), artifact.sha256);
    const trial = JSON.parse(bytes);
    assert.equal(trial.schemaVersion, 1);
    assert.equal(trial.mode, 'live'); assert.equal(trial.evidenceKind, 'live-provider'); assert.equal(trial.trialId, entry.trialId);
    assert.equal(trial.kind, entry.kind); assert.equal(trial.sampleId, entry.sample.id); assert.equal(trial.repetition, entry.repetition); assert.equal(trial.role, role);
    assert.equal(trial.complete, true); assert.equal(trial.status, 'collected'); assert.equal(trial.cleanup, true); assert.equal(trial.logTruncated, false); assert.ok(!trial.errorCode);
    same(trial.config, config); assert.equal(trial.outputSha256, hashBytes(trial.result.output));
    assert.ok(Date.parse(trial.startedAt) >= Date.parse(report.startedAt)); assert.ok(Date.parse(trial.finishedAt) <= Date.parse(report.finishedAt));
    assert.ok(Date.parse(trial.finishedAt) >= Date.parse(trial.startedAt));
    if (trials.length) assert.ok(Date.parse(trial.startedAt) >= Date.parse(trials.at(-1).finishedAt));
    assert.equal(trial.traceBuilds.length, 1); assert.equal(trial.traceBuilds[0].git_sha, source.sha); assert.equal(trial.traceBuilds[0].build_dirty, false); assert.equal(trial.traceBuilds[0].instrumentation_version, 3);
    assert.equal(trial.artifacts.length, 1); assert.equal(trial.artifacts[0].path, 'application.log');
    const log = await readFile(path.join(directory, `trial-${index}`, 'application.log')); assert.equal(hashBytes(log), trial.artifacts[0].sha256);
    const actualBuilds = [...new Set(log.toString().split('\n').filter(row => row.startsWith('execution_trace ')).map(row => JSON.stringify(JSON.parse(row.slice(16)).build)))].map(value => JSON.parse(value));
    same(actualBuilds, trial.traceBuilds);
    const attempts = validateQualityObservations(trial.provider, { mode: 'live', kind: trial.kind, startedAt: trial.startedAt, finishedAt: trial.finishedAt, maxConnectionMs: config.maxConnectionMs }), success = attempts.filter(row => row.status === 'succeeded');
    assert.ok(attempts.length >= 1 && attempts.length <= (entry.kind === 'asr' ? 2 : 1)); assert.equal(success.length, 1);
    assert.equal(attempts.at(-1).status, 'succeeded');
    for (let attemptIndex = 1; attemptIndex < attempts.length; attemptIndex++) assert.ok(Date.parse(attempts[attemptIndex].startedAt) >= Date.parse(attempts[attemptIndex - 1].completedAt));
    for (const row of attempts) {
      assert.equal(row.kind, entry.kind); assert.equal(row.mode, 'live'); assert.equal(row.evidenceKind, 'live-provider');
      assert.equal(row.endpoint, new URL(config[entry.kind === 'asr' ? 'asrEndpoint' : 'mtEndpoint']).href);
      assert.equal(row.model, config[entry.kind === 'asr' ? 'asrModel' : 'mtModel']);
      assert.ok(['succeeded','failed'].includes(row.status)); assert.ok(Date.parse(row.startedAt) >= Date.parse(trial.startedAt));
      assert.ok(Date.parse(row.startedAt) <= Date.parse(row.completedAt));
      assert.ok(Date.parse(row.upstreamStartedAt) >= Date.parse(row.startedAt));
      assert.ok(Date.parse(row.upstreamStartedAt) <= Date.parse(row.completedAt));
      assert.ok(Date.parse(row.completedAt) <= Date.parse(trial.finishedAt));
    }
    if (entry.kind === 'mt') {
      assert.equal(trial.result.input, entry.sample.text); assert.equal(trial.result.source, entry.sample.language); assert.equal(trial.result.target, entry.sample.target);
      assert.equal(success[0].input, entry.sample.text.trim()); assert.equal(trial.result.output, success[0].output.trim());
      same(success[0].config, { translation_options: { source_lang: 'auto', target_lang: entry.sample.target } });
      assert.equal(success[0].requestBytes, Buffer.byteLength(success[0].requestWire)); assert.equal(success[0].requestSha256, hashBytes(success[0].requestWire));
      assert.ok(success[0].requestBytes <= frozen.config.budget.bounds.mt.providerRequestByteLimit);
      same(JSON.parse(success[0].requestWire), { model: config.mtModel, messages: [{ role: 'user', content: entry.sample.text.trim() }], translation_options: { source_lang: 'auto', target_lang: entry.sample.target } });
    } else {
      const parameters = asrParameters(config, entry.sample.language); assert.ok(attempts.length <= parameters.length);
      for (const [attemptIndex, attempt] of attempts.entries()) same(attempt.config, { parameters: parameters[attemptIndex] });
      if (attempts.length === 2) { assert.equal(attempts[0].status, 'failed'); assert.equal(attempts[0].audioBytes, 0); }
      const billing = frozen.config.budget.bounds.asr;
      if (billing.durationBasis === 'provider-hard-session-duration') for (const attempt of attempts)
        assert.ok(Date.parse(attempt.completedAt) - Date.parse(attempt.upstreamStartedAt) <= billing.providerHardSessionMs + billing.billingTailMs);
      assert.equal(trial.result.audioBytes, entry.sample.audio.bytes); assert.equal(success[0].audioBytes, entry.sample.audio.bytes);
      assert.ok(trial.result.events.some(row => row.event.type === 'finished'));
      assert.ok(!trial.result.events.some(row => row.event.type === 'error'));
      const finals = trial.result.events.filter(row => row.event.type === 'segment-final').map(row => row.event.segment);
      same(finals.map(row => [row.id,row.original_text]), trial.result.segments.map(row => [row.id,row.original_text]));
      assert.equal(trial.result.output, trial.result.segments.map(row => row.original_text).join(' '));
      for (const segment of trial.result.segments) {
        assert.equal(segment.listening_id, trial.result.listeningId); assert.equal(segment.run_id, trial.result.runId);
        assert.ok(success[0].outputs.some(row => row.sentence_end && String(row.sentence_id) === segment.asr_sentence_id && row.text === segment.original_text));
      }
    }
    trials.push({ ...trial, sample: entry.sample });
  }
  const budgetConfig = qualityBudgetConfig(frozen);
  for (const snap of [report.budget.before, report.budget.after]) {
    assert.equal(snap.binding, hashJson({ config: budgetConfig, freezeDigest: frozen.digest })); assert.equal(snap.freezeDigest, frozen.digest);
    assert.equal(snap.id, budgetConfig.id); assert.equal(snap.currency, budgetConfig.currency); assert.equal(snap.ceilingMicros, budgetConfig.ceilingMicros);
    assert.equal(snap.reservedMicros, snap.attempts.reduce((sum, row) => sum + row.reserved_micros, 0)); assert.ok(snap.reservedMicros <= snap.ceilingMicros);
    assert.equal(new Set(snap.attempts.map(row => row.id)).size, snap.attempts.length);
    for (const row of snap.attempts) { assert.equal(row.reserved_micros, budgetConfig.attemptMicros[row.kind]); assert.ok(Date.parse(row.reserved_at) < Date.parse(budgetConfig.expiresAt)); }
    for (const kind of ['asr','mt']) assert.ok(snap.attempts.filter(row => row.kind === kind).length <= budgetConfig.maxAttempts[kind]);
  }
  const beforeRuns = report.budget.before.runs, afterRuns = report.budget.after.runs;
  if (role === 'baseline') { assert.deepEqual(beforeRuns, []); assert.equal(report.budget.before.attempts.length, 0); }
  else { assert.equal(beforeRuns.length, 1); assert.equal(beforeRuns[0].role, 'baseline'); assert.equal(beforeRuns[0].state, 'complete'); assert.ok(validSha(report.baselineCollectionSha256)); }
  assert.equal(afterRuns.length, beforeRuns.length + 1); same(afterRuns.filter(row => row.role !== role), beforeRuns);
  const claimed = afterRuns.filter(row => row.role === role); assert.equal(claimed.length, 1);
  assert.equal(claimed[0].state, 'complete'); assert.equal(claimed[0].source_sha, source.sha); assert.equal(claimed[0].directory, report.outputDirectory);
  assert.ok(Date.parse(claimed[0].started_at) >= Date.parse(report.startedAt) && Date.parse(claimed[0].started_at) <= Date.parse(trials[0].startedAt));
  assert.ok(Date.parse(claimed[0].finished_at) >= Date.parse(trials.at(-1).finishedAt) && Date.parse(claimed[0].finished_at) <= Date.parse(report.finishedAt));
  same(report.budget.after.attempts.slice(0, report.budget.before.attempts.length), report.budget.before.attempts);
  const added = report.budget.after.attempts.slice(report.budget.before.attempts.length), observed = trials.flatMap(trial => trial.provider.filter(row => row.attemptId).map(row => ({ trial, row })));
  assert.equal(added.length, observed.length);
  // Every sequential upstream attempt has its own preceding durable reservation:
  // no duplicate reference, phantom reservation or order substitution.
  same(observed.map(({ row }) => row.attemptId), added.map(row => String(row.id)));
  for (const { trial, row } of observed) {
    const reservation = added.filter(item => String(item.id) === row.attemptId); assert.equal(reservation.length, 1);
    assert.equal(reservation[0].kind, trial.kind); assert.equal(reservation[0].trial_id, trial.trialId);
    assert.ok(Date.parse(reservation[0].reserved_at) >= Date.parse(trial.startedAt)); assert.ok(Date.parse(reservation[0].reserved_at) <= Date.parse(row.completedAt));
    assert.ok(Date.parse(reservation[0].reserved_at) <= Date.parse(row.upstreamStartedAt));
    assert.ok(Date.parse(row.upstreamStartedAt) < Date.parse(budgetConfig.expiresAt));
  }
  return { report, trials };
}
export function compareQualityMetrics(baseline, candidate, thresholds) {
  assert.ok(baseline.length > 0 && candidate.length > 0);
  const failures = [], groups = {};
  for (const [role, rows] of Object.entries({ baseline, candidate })) for (const row of rows) {
    const key = `${row.kind}:${row.language}:${row.metric?.metric || 'human-meaning'}`;
    groups[key] ||= { baseline: [], candidate: [] }; groups[key][role].push(row);
    if (role === 'candidate' && row.serious.some(Boolean)) failures.push({ trialId: row.trialId, reason: 'serious_error', types: seriousErrorTypes.filter((_, i) => row.serious[i]) });
  }
  const summary = {};
  for (const [key, pair] of Object.entries(groups)) {
    assert.ok(pair.baseline.length > 0); assert.equal(pair.baseline.length, pair.candidate.length);
    if (key.includes('empty-reference-hallucination')) {
      const counts = Object.fromEntries(Object.entries(pair).map(([role, rows]) => [role, rows.filter(row => row.metric.hallucination).length]));
      summary[key] = counts; if (counts.candidate > thresholds.asrSilenceHallucinationsMax) failures.push({ group: key, reason: 'silence_hallucination' });
    } else if (key.startsWith('asr:')) {
      const b = aggregateErrors(pair.baseline.map(row => row.metric)), c = aggregateErrors(pair.candidate.map(row => row.metric));
      summary[key] = { baseline: b, candidate: c, delta: c.errorRate - b.errorRate };
      if (c.errorRate > thresholds.asrErrorRateMax || c.omissionRate > thresholds.asrOmissionRateMax || c.errorRate - b.errorRate > thresholds.asrRegressionMax) failures.push({ group: key, reason: 'asr_threshold' });
    } else {
      const value = rows => ({ mean: rows.reduce((sum,row) => sum + row.meaningScore / 4, 0) / rows.length, minimum: Math.min(...rows.map(row => row.meaningScore / 4)), maximum: Math.max(...rows.map(row => row.meaningScore / 4)), samples: rows.length });
      const b = value(pair.baseline), c = value(pair.candidate); summary[key] = { baseline: b, candidate: c, delta: c.mean - b.mean };
      if (c.mean < thresholds.mtMeaningRetentionMin || b.mean - c.mean > thresholds.mtRegressionMax) failures.push({ group: key, reason: 'mt_threshold' });
    }
  }
  return { passed: failures.length === 0, failures, summary };
}
export async function assessQuality({ frozen, baselineDirectory, candidateDirectory, reviewFile }) {
  const startedAt = new Date().toISOString(), source = sourceVersion();
  const metadata = { schemaVersion: 1, kind: 'quality-assessment', method: 'real-corpus-human-review', frozenDigest: frozen.digest,
    startedAt, assessorSource: source, tool: { node: process.version, sqlite: process.versions.sqlite },
    corpus: { id: frozen.corpus?.id, version: frozen.corpus?.version }, parameters: frozen.config,
    randomSeed: null, sampling: 'fixed frozen corpus order; paired repetitions, no random subsampling' };
  try {
    const baseline = await readQualityCollection(baselineDirectory, frozen, 'baseline'), candidate = await readQualityCollection(candidateDirectory, frozen, 'candidate');
    assert.equal(baseline.report.budget.before.attempts.length, 0); same(baseline.report.budget.after, candidate.report.budget.before);
    assert.equal(candidate.report.baselineCollectionSha256, hashBytes(await readFile(path.join(baselineDirectory, 'collection.json'))));
    assert.ok(Date.parse(candidate.report.startedAt) >= Date.parse(baseline.report.finishedAt));
    const review = await readJson(reviewFile); assert.equal(review.schemaVersion, 1); assert.equal(review.frozenDigest, frozen.digest); assert.equal(review.method, 'human-review');
    const all = [...baseline.trials, ...candidate.trials]; assert.equal(review.rows.length, all.length);
    const scored = { baseline: [], candidate: [] };
    for (const trial of all) {
      const matches = review.rows.filter(row => row.trialId === trial.trialId); assert.equal(matches.length, 1); const row = matches[0];
      assert.equal(row.outputSha256, trial.outputSha256); assert.ok(frozen.config.reviewers.includes(row.reviewer));
      // The human scores the displayed context, not merely a copied digest.
      assert.equal(row.output, trial.result.output); assert.equal(row.source, trial.sample.text);
      same(row.acceptedReferences, trial.kind === 'asr' ? trial.sample.gold.transcripts : trial.sample.gold.translations);
      same(row.criticalFacts, trial.sample.gold.criticalFacts);
      assert.ok(Date.parse(row.reviewedAt) >= Date.parse(trial.finishedAt) && Date.parse(row.reviewedAt) <= Date.now());
      same(Object.keys(row.serious).sort(), [...seriousErrorTypes].sort()); assert.ok(Object.values(row.serious).every(value => typeof value === 'boolean'));
      if (Object.values(row.serious).some(Boolean)) assert.ok(typeof row.notes === 'string' && row.notes.trim());
      const score = { trialId: trial.trialId, sampleId: trial.sampleId, kind: trial.kind, language: trial.sample.language, repetition: trial.repetition,
        outputSha256: trial.outputSha256, serious: seriousErrorTypes.map(type => row.serious[type]), reviewer: row.reviewer };
      if (trial.kind === 'asr') score.metric = scoreAsr(trial.sample.gold.transcripts, trial.result.output, trial.sample.asrMetric);
      else { assert.ok(Number.isInteger(row.meaningScore) && row.meaningScore >= 0 && row.meaningScore <= 4); if (row.meaningScore <= 1) assert.ok(Object.values(row.serious).some(Boolean)); score.meaningScore = row.meaningScore; }
      scored[trial.role].push(score);
    }
    const comparison = compareQualityMetrics(scored.baseline, scored.candidate, frozen.config.thresholds);
    const variability = {};
    for (const trial of all) { const key = `${trial.role}:${trial.sampleId}:${trial.kind}`; (variability[key] ||= new Set()).add(trial.outputSha256); }
    const properties = Object.entries(qualityProperties).map(([kind, propertyId]) => {
      const failures = comparison.failures.filter(row => row.group?.startsWith(`${kind}:`) || scored.candidate.some(trial => trial.kind === kind && trial.trialId === row.trialId));
      return { propertyId, status: failures.length ? 'failed' : 'passed', complete: true, samplesPerRole: scored.candidate.filter(row => row.kind === kind).length, failures };
    });
    same(source, sourceVersion());
    return { ...metadata, finishedAt: new Date().toISOString(), complete: true, qualityEvaluated: true, properties,
      qualityStatus: comparison.passed ? 'passed' : 'failed', ...comparison, perSample: scored,
      releaseEligible: comparison.passed && !source.dirty, fullQualityAcceptance: comparison.passed && !source.dirty,
      roleSources: { baseline: baseline.report.sourceStart, candidate: candidate.report.sourceStart },
      collections: { baseline: { path: path.resolve(baselineDirectory), sha256: hashBytes(await readFile(path.join(baselineDirectory, 'collection.json'))) },
        candidate: { path: path.resolve(candidateDirectory), sha256: hashBytes(await readFile(path.join(candidateDirectory, 'collection.json'))) } },
      assessorImplementationSha256: hashBytes(await readFile(new URL('./quality-assessment.mjs', import.meta.url))),
      repeatVariation: Object.fromEntries(Object.entries(variability).map(([key, values]) => [key, { distinctOutputs: values.size, repetitions: frozen.config.repetitions }])),
      reviewArtifactSha256: hashBytes(await readFile(reviewFile)), boundary: 'Finite approved corpus and declared provider aliases; no population guarantee, immutable provider revision or end-to-end browser/device claim.' };
  } catch (error) {
    return { ...metadata, finishedAt: new Date().toISOString(), complete: false, qualityEvaluated: false, fullQualityAcceptance: false,
      properties: Object.values(qualityProperties).map(propertyId => ({ propertyId, complete: false, status: /OFFLINE/.test(error.message) ? 'not_run' : 'incomplete' })),
      qualityStatus: /OFFLINE/.test(error.message) ? 'not_run' : 'incomplete', reasons: [/OFFLINE/.test(error.message) ? error.message : 'MISSING_CHANGED_OR_INVALID_QUALITY_EVIDENCE'] };
  }
}
