import { parseArgs } from 'node:util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectQualityPlan, freezeQualityPlan, readFrozenQualityPlan, seriousErrorTypes } from './lib/quality-contract.mjs';
import { collectQualityRun, qualitySources } from './lib/quality-collector.mjs';
import { inspectOfflineQualityEvidence } from './lib/quality-offline-evidence.mjs';
import { assessQuality, readQualityCollection } from './lib/quality-assessment.mjs';
import { writeJson } from './lib/verification-evidence.mjs';

const help = `ASR / MT quality preparation and explicit evaluation.
Commands: plan | freeze | offline | check-offline | collect | prepare-review | assess
--config FILE  defaults to verification/asr-translation-quality/plan.template.json
--freeze FILE  immutable plan produced before candidate collection
--out PATH     fresh directory for collection; fresh file for freeze/review/assessment
--role baseline|candidate   collect one role at its exact clean source
--baseline DIR --candidate DIR --reviews FILE  paired assessment inputs
collect additionally requires --live --approve-budget ID and HEARWISE_QUALITY_API_KEY.
No ordinary CI command makes live calls. Missing rights/audio/review/thresholds or
verified worst-case billing bounds blocks live collection before reading a key.
Offline stubs only verify this tool; their quality status is always not_run.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' }, config: { type: 'string' },
    freeze: { type: 'string' }, out: { type: 'string' }, role: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' },
    release: { type: 'boolean' }, reviews: { type: 'string' }, live: { type: 'boolean' }, 'approve-budget': { type: 'string' } } });
  if (values.help) { console.log(help); return; }
  if (positionals.length > 1) throw new Error('ONE_COMMAND_REQUIRED');
  const command = positionals[0] || 'plan', config = values.config || 'verification/asr-translation-quality/plan.template.json';
  if (command === 'plan') {
    const plan = await inspectQualityPlan(config);
    console.log(JSON.stringify({ complete: true, qualityStatus: 'not_run', qualityEvaluated: false, eligibleForFreeze: plan.eligibleForFreeze,
      planDigest: plan.digest, estimate: plan.estimate, missing: plan.issues }, null, 2)); return;
  }
  if (command === 'freeze') {
    if (!values.out) throw new Error('OUTPUT_REQUIRED');
    const frozen = await freezeQualityPlan(config, values.out);
    console.log(JSON.stringify({ frozen: true, digest: frozen.digest, qualityStatus: 'not_run', liveCalls: 0 })); return;
  }
  if (command === 'offline') {
    if (values.live || values['approve-budget']) throw new Error('OFFLINE_CANNOT_AUTHORIZE_LIVE');
    const root = values.out || 'verification-evidence/asr-translation-quality'; await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'offline-'));
    const { runOfflineQuality } = await import('../test-support/quality-offline.mjs');
    const report = await runOfflineQuality(path.join(directory, 'collection'));
    await writeJson(path.join(directory, 'provider-ledger.json'), report.actualStubRequests);
    const summary = await inspectOfflineQualityEvidence(directory, await qualitySources(), { release: values.release });
    await writeJson(path.join(directory, 'offline-summary.json'), summary); console.log(JSON.stringify({ directory, ...summary }, null, 2));
    process.exitCode = summary.infrastructurePassed ? 0 : 1; return;
  }
  if (command === 'check-offline') {
    if (!values.out || values.live || values['approve-budget']) throw new Error('OFFLINE_DIRECTORY_REQUIRED');
    const summary = await inspectOfflineQualityEvidence(values.out, await qualitySources(), { release: values.release });
    console.log(JSON.stringify(summary, null, 2)); process.exitCode = summary.infrastructurePassed ? 0 : 1; return;
  }
  if (!['collect','prepare-review','assess'].includes(command)) throw new Error('UNKNOWN_COMMAND');
  if (!values.freeze) throw new Error('FREEZE_REQUIRED');
  const frozen = await readFrozenQualityPlan(values.freeze, { forCollection: command === 'collect' });
  if (command === 'collect') {
    if (!values.live || values['approve-budget'] !== frozen.config.budget.id || process.env.CI) throw new Error('EXPLICIT_LIVE_BUDGET_APPROVAL_REQUIRED');
    if (!['baseline','candidate'].includes(values.role) || !values.out) throw new Error('ROLE_AND_FRESH_OUTPUT_REQUIRED');
    if (values.role === 'candidate' && !values.baseline) throw new Error('COMPLETE_BASELINE_REQUIRED');
    // This is deliberately after the full frozen plan, source, rights and budget
    // preflight. Never print or copy this value to the application child.
    const key = process.env.HEARWISE_QUALITY_API_KEY;
    if (!key || !key.trim()) throw new Error('DEDICATED_OPERATOR_KEY_REQUIRED');
    const controller = new AbortController(), cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const role = frozen.config.roles[values.role];
      const report = await collectQualityRun({ frozen, role: values.role, directory: values.out, mode: 'live', liveAuthorized: true,
        upstream: { asr: role.asrEndpoint, mt: role.mtEndpoint, key: key.trim() }, signal: controller.signal, baselineDirectory: values.baseline });
      console.log(JSON.stringify({ collectionComplete: report.complete, qualityStatus: 'not_run', qualityEvaluated: false, reviewRequired: true, directory: values.out }));
      process.exitCode = report.complete ? 0 : 1;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    return;
  }
  if (!values.baseline || !values.candidate || !values.out) throw new Error('PAIRED_COLLECTIONS_AND_OUTPUT_REQUIRED');
  if (command === 'prepare-review') {
    const baseline = await readQualityCollection(values.baseline, frozen, 'baseline'), candidate = await readQualityCollection(values.candidate, frozen, 'candidate');
    const rows = [...baseline.trials, ...candidate.trials].map(trial => ({ trialId: trial.trialId, outputSha256: trial.outputSha256,
      source: trial.sample.text, acceptedReferences: trial.kind === 'asr' ? trial.sample.gold.transcripts : trial.sample.gold.translations,
      output: trial.result.output, criticalFacts: trial.sample.gold.criticalFacts, reviewer: null, reviewedAt: null,
      ...(trial.kind === 'mt' ? { meaningScore: null } : {}), serious: Object.fromEntries(seriousErrorTypes.map(type => [type, null])), notes: '' }));
    await writeFile(values.out, JSON.stringify({ schemaVersion: 1, method: 'human-review', frozenDigest: frozen.digest, rows }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ reviewTemplate: values.out, qualityStatus: 'not_run', qualityEvaluated: false })); return;
  }
  if (!values.reviews) throw new Error('HUMAN_REVIEWS_REQUIRED');
  const report = await assessQuality({ frozen, baselineDirectory: values.baseline, candidateDirectory: values.candidate, reviewFile: values.reviews });
  await writeFile(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.qualityStatus === 'passed' ? 0 : 1;
}
main().catch(error => {
  const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'QUALITY_COMMAND_REJECTED';
  console.error(JSON.stringify({ complete: false, qualityStatus: 'not_run', qualityEvaluated: false, code, ...(Array.isArray(error.issues) ? { missing: error.issues } : {}) }));
  process.exitCode = 1;
});
