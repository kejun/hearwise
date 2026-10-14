// Synthetic contract-test bundles only: no provider calls, paid requests, real
// measurements, human reviews, approvals, or publishable quality-pass evidence.
// These shapes exercise the evidence reader; all generated files are test-owned
// temporary files and the assessment itself is never written to disk.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { contractDigest, estimateQualityBudget, hashBytes, hashJson, qualityBudgetConfig, seriousErrorTypes } from '../scripts/lib/quality-contract.mjs';
import { asrParameters } from '../scripts/lib/quality-collector.mjs';


// Authentic Git identity and blob hashes bind the synthetic shape to real source
// snapshots. This does not make any provider observation or review a real one.
let cachedSourceFixtures;
function sourceFixtures() {
  cachedSourceFixtures ||= Promise.all(['HEAD~1', 'HEAD'].map(async ref => {
    const git = (...args) => execFileSync('git', args, { maxBuffer: 16 * 1024 * 1024 });
    const sha = git('rev-parse', ref).toString().trim();
    const tree = git('rev-parse', `${sha}^{tree}`).toString().trim();
    const entries = git('ls-tree', '-rz', sha).toString().split('\0').filter(Boolean).map(row => {
      const [metadata, name] = row.split('\t'), [, kind, oid] = metadata.split(' ');
      if (kind !== 'blob') throw new Error('Synthetic source fixture needs a blob-only tracked tree');
      return { name, oid };
    });
    const batch = execFileSync('git', ['cat-file', '--batch'], { input: entries.map(row => row.oid).join('\n') + '\n', maxBuffer: 16 * 1024 * 1024 });
    const files = {}; let offset = 0;
    for (const { name } of entries) {
      const newline = batch.indexOf(10, offset), length = Number(batch.subarray(offset, newline).toString().split(' ')[2]);
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('Malformed Git blob fixture');
      files[name] = hashBytes(batch.subarray(newline + 1, newline + 1 + length));
      offset = newline + length + 2;
    }
    files['dist/server/index.js'] = hashBytes(await readFile(new URL('../dist/server/index.js', import.meta.url)));
    return { sha, tree, dirty: false, files, node: process.version, sqlite: process.versions.sqlite,
      platform: process.platform, arch: process.arch, os: os.release() };
  }));
  return cachedSourceFixtures;
}

export const contractFixtureLabel = 'SYNTHETIC CONTRACT TEST ONLY; NOT A REAL QUALITY MEASUREMENT';
export const comparisonThresholds = Object.freeze({ asrErrorRateMax: 0.25, asrOmissionRateMax: 0.125, asrRegressionMax: 0.125,
  asrSilenceHallucinationsMax: 0, mtMeaningRetentionMin: 0.75, mtRegressionMax: 0.125, seriousErrorMax: 0 });
export const readFixtureJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
export async function writeFixtureJson(filename, value) {
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n');
}
export async function mutateFixtureJson(filename, mutate) {
  const value = await readFixtureJson(filename);
  await mutate(value);
  await writeFixtureJson(filename, value);
  return value;
}
export async function mutateFixtureTrial(bundle, role, index, mutate) {
  const directory = bundle[`${role}Directory`];
  const filename = path.join(directory, `trial-${index}`, 'trial.json');
  const trial = await mutateFixtureJson(filename, mutate);
  await mutateFixtureJson(path.join(directory, 'collection.json'), report => {
    report.trials[index].sha256 = hashBytes(JSON.stringify(trial, null, 2) + '\n');
  });
  return trial;
}
export async function mutateFixtureLog(bundle, role, index, content) {
  const filename = path.join(bundle[`${role}Directory`], `trial-${index}`, 'application.log');
  await writeFile(filename, content);
  await mutateFixtureTrial(bundle, role, index, trial => { trial.artifacts[0].sha256 = hashBytes(content); });
}

export async function writeSyntheticAssessmentFixture(directory) {
  const sources = await sourceFixtures();
  const now = Date.now(), date = offset => new Date(now + offset).toISOString();
  const config = { repetitions: 2, thresholds: { ...comparisonThresholds }, reviewers: ['synthetic-contract-reviewer'], roles: {},
    budget: { id: 'synthetic-contract-budget', currency: 'CNY', ceilingMicros: 1000, expiresAt: date(3600000),
      bounds: Object.fromEntries(['asr', 'mt'].map(kind => [kind, { inputUnitsUpper: 1, outputUnitsUpper: 1, inputUnitMicros: 1,
        outputUnitMicros: 1, fixedMicros: 1, validUntil: date(3600000) }])) } };
  config.budget.bounds.mt.providerRequestByteLimit = 12000;
  const corpus = { id: 'synthetic-contract-corpus', samples: [
    { id: 'speech', split: 'acceptance', language: 'en', target: 'Chinese', tasks: ['asr', 'mt'], text: 'Do not pay 15.',
      asrMetric: 'wer', audio: { bytes: 640 }, gold: { transcripts: ['Do not pay 15.'] } },
    { id: 'silence', split: 'acceptance', language: 'en', target: 'Chinese', tasks: ['asr'], text: '', silence: true,
      asrMetric: 'wer', audio: { bytes: 640 }, gold: { transcripts: [''] } },
    { id: 'development-only', split: 'development', language: 'en', target: 'Chinese', tasks: ['asr', 'mt'], text: 'Not an acceptance sample.' }
  ] };
  for (const [index, role] of ['baseline', 'candidate'].entries()) config.roles[role] = {
    sourceSha: sources[index].sha, sourceTree: sources[index].tree, requestBuilderSha256: sources[index].files['server.mjs'],
    asrModel: `synthetic-${role}-asr`, mtModel: `synthetic-${role}-mt`,
    asrEndpoint: `wss://${role}.example.invalid/asr`, mtEndpoint: `https://${role}.example.invalid/mt`,
    maxConnectionMs: 5000, maxRunMs: 20000, captionMode: 'classic', sentenceSilenceMs: 2500
  };
  const frozen = { kind: 'synthetic-assessment-contract-fixture', fixtureLabel: contractFixtureLabel,
    frozenAt: date(-60000), config, corpus, digest: contractDigest({ config, corpus }), freezeFileSha256: hashBytes('synthetic freeze file only'),
    estimate: estimateQualityBudget(config, corpus.samples) };
  const budgetConfig = qualityBudgetConfig(frozen), attempts = [], reviewRows = [], runs = [];
  const snapshot = () => ({ id: budgetConfig.id, currency: budgetConfig.currency, ceilingMicros: budgetConfig.ceilingMicros,
    binding: hashJson({ config: budgetConfig, freezeDigest: frozen.digest }), freezeDigest: frozen.digest,
    reservedMicros: attempts.reduce((sum, row) => sum + row.reserved_micros, 0), attempts: structuredClone(attempts), runs: structuredClone(runs) });
  const bundle = { directory, frozen, baselineDirectory: path.join(directory, 'baseline'), candidateDirectory: path.join(directory, 'candidate'),
    reviewFile: path.join(directory, 'synthetic-human-review-contract.json') };
  for (const [roleIndex, role] of ['baseline', 'candidate'].entries()) {
    const roleConfig = config.roles[role], roleDirectory = bundle[`${role}Directory`], roleStart = -50000 + roleIndex * 20000;
    const source = structuredClone(sources[roleIndex]);
    const report = { schemaVersion: 1, kind: 'quality-collection', fixtureLabel: contractFixtureLabel, mode: 'live', evidenceKind: 'live-provider', role,
      complete: true, cleanup: true, interrupted: false, qualityEvaluated: false, qualityStatus: 'not_run',
      outputDirectory: path.resolve(roleDirectory), frozenDigest: frozen.digest, freezeFileSha256: frozen.freezeFileSha256, frozenAt: frozen.frozenAt,
      sourceStart: source, sourceEnd: structuredClone(source), maxRunMs: roleConfig.maxRunMs,
      startedAt: date(roleStart), finishedAt: date(roleStart + 10000), trials: [], budget: { before: snapshot() } };
    for (const sample of corpus.samples.filter(row => row.split === 'acceptance')) for (const kind of sample.tasks) for (let repetition = 0; repetition < config.repetitions; repetition++) {
      const index = report.trials.length, trialId = `${role}:${sample.id}:${kind}:${repetition}`, start = roleStart + index * 100;
      const output = kind === 'asr' ? sample.text : '不要支付15。';
      const build = { git_sha: roleConfig.sourceSha, build_dirty: false, instrumentation_version: 3 };
      const log = `${contractFixtureLabel}\nexecution_trace ${JSON.stringify({ build })}\n`;
      const trial = { schemaVersion: 1, fixtureLabel: contractFixtureLabel, mode: 'live', evidenceKind: 'live-provider',
        trialId, sampleId: sample.id, kind, repetition, role, complete: true, status: 'collected', cleanup: true, logTruncated: false,
        config: roleConfig, outputSha256: hashBytes(output), startedAt: date(start), finishedAt: date(start + 50),
        traceBuilds: [build], artifacts: [{ path: 'application.log', sha256: hashBytes(log) }], result: { output },
        provider: [{ attemptId: String(attempts.length + 1), kind, mode: 'live', evidenceKind: 'live-provider',
          status: 'succeeded', startedAt: date(start + 1), upstreamStartedAt: date(start + 3), completedAt: date(start + 40), endpoint: roleConfig[`${kind}Endpoint`], model: roleConfig[`${kind}Model`] }] };
      const provider = trial.provider[0];
      if (kind === 'mt') {
        Object.assign(trial.result, { input: sample.text, source: sample.language, target: sample.target });
        Object.assign(provider, { input: sample.text, output, config: { translation_options: { source_lang: 'auto', target_lang: sample.target } } });
        provider.requestWire = JSON.stringify({ model: roleConfig.mtModel, messages: [{ role: 'user', content: sample.text }], translation_options: { source_lang: 'auto', target_lang: sample.target } });
        provider.requestBytes = Buffer.byteLength(provider.requestWire); provider.requestSha256 = hashBytes(provider.requestWire);
      } else {
        const segment = { id: `synthetic-segment-${index}`, original_text: output, listening_id: 'synthetic-listening', run_id: 'synthetic-run', asr_sentence_id: 'synthetic-sentence' };
        const segments = sample.silence ? [] : [segment];
        Object.assign(trial.result, { segments, listeningId: 'synthetic-listening', runId: 'synthetic-run', audioBytes: sample.audio.bytes,
          events: [...segments.map(segment => ({ event: { type: 'segment-final', segment } })), { event: { type: 'finished' } }] });
        Object.assign(provider, { config: { parameters: asrParameters(roleConfig, sample.language)[0] }, audioBytes: sample.audio.bytes,
          outputs: segments.map(row => ({ sentence_end: true, sentence_id: row.asr_sentence_id, text: row.original_text })) });
      }
      attempts.push({ id: attempts.length + 1, kind, trial_id: trialId, reserved_micros: budgetConfig.attemptMicros[kind], reserved_at: date(start + 2) });
      const trialDirectory = path.join(roleDirectory, `trial-${index}`);
      await mkdir(trialDirectory, { recursive: true });
      await writeFile(path.join(trialDirectory, 'application.log'), log);
      await writeFixtureJson(path.join(trialDirectory, 'trial.json'), trial);
      report.trials.push({ path: `trial-${index}/trial.json`, sha256: hashBytes(await readFile(path.join(trialDirectory, 'trial.json'))) });
      reviewRows.push({ trialId, outputSha256: trial.outputSha256, reviewer: 'synthetic-contract-reviewer', reviewedAt: date(-1000),
        serious: Object.fromEntries(seriousErrorTypes.map(type => [type, false])), ...(kind === 'mt' ? { meaningScore: 4 } : {}) });
    }
    runs.push({ role, source_sha: roleConfig.sourceSha, directory: path.resolve(roleDirectory), state: 'complete', started_at: report.startedAt, finished_at: report.finishedAt });
    if (role === 'candidate') report.baselineCollectionSha256 = hashBytes(await readFile(path.join(bundle.baselineDirectory, 'collection.json')));
    report.expectedTrials = report.trials.length; report.budget.after = snapshot();
    await writeFixtureJson(path.join(roleDirectory, 'collection.json'), report);
  }
  await writeFixtureJson(bundle.reviewFile, { schemaVersion: 1, fixtureLabel: contractFixtureLabel, frozenDigest: frozen.digest, method: 'human-review', rows: reviewRows });
  return bundle;
}
