import { parseArgs } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { qualitySources } from './lib/quality-collector.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
import { readSemanticCapture } from './lib/semantic-quality-evidence.mjs';
import { runSemanticOffline, inspectSemanticOffline } from './lib/semantic-quality-offline.mjs';
import { runSemanticPairedOffline, inspectSemanticPairedOffline } from './lib/semantic-quality-paired.mjs';
import { runSemanticDistinctOffline, inspectSemanticDistinctOffline } from './lib/semantic-quality-distinct.mjs';
import { collectSemanticCorpusOffline, inspectSemanticCorpusOffline } from './lib/semantic-quality-corpus.mjs';
import { createSemanticReviewTemplate, assessSemanticReview } from './lib/semantic-quality-review.mjs';
import { createSemanticFailureCases } from './lib/semantic-quality-failures.mjs';
const help = `Knowledge / relation semantic evaluation preparation, OFFLINE ONLY.
Commands: corpus-offline | check-corpus-offline | assess-corpus-offline | plan | offline | check-offline | paired-offline | check-paired-offline | distinct-offline | check-distinct-offline | assess-distinct-offline | prepare-review | assess | failure-cases
--plan FILE      exact caller-supplied offline corpus/budget/reviewer plan
--provider URL   loopback-only HTTP fixture provider, no credential arguments
--out PATH       output root for offline; existing run for check-offline; fresh JSON for review/assessment
--baseline DIR / --candidate DIR  explicit trusted independent clean checkouts (distinct commands)
--capture DIR    exact-source offline capture with store.sqlite and capture.json
--reviewers FILE JSON array of declared reviewer labels; no identity authentication is claimed
--review FILE    completed offline review (assess / failure-cases)
--release        require the exact clean current source
collect / --live always rejects: paid-domain adapter and actual quality acceptance are not implemented.
A successful offline exit verifies plumbing only; HW-05-04 and all real quality remain not_run.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' }, out: { type: 'string' },
    capture: { type: 'string' }, reviewers: { type: 'string' }, review: { type: 'string' }, release: { type: 'boolean' }, baseline: { type: 'string' }, candidate: { type: 'string' }, live: { type: 'boolean' }, plan: { type: 'string' }, provider: { type: 'string' } } });
  if (values.help) { console.log(help); return; }
  if (values.live || positionals[0] === 'collect') throw new Error('LIVE_SEMANTIC_ADAPTER_NOT_IMPLEMENTED_OR_AUTHORIZED');
  if (positionals.length > 1) throw new Error('ONE_COMMAND_REQUIRED');
  const command = positionals[0] || 'plan';
  if (['corpus-offline','check-corpus-offline','assess-corpus-offline'].includes(command)) {
    if (!values.plan || !values.out || command === 'corpus-offline' && !values.provider) throw new Error('CORPUS_PLAN_OUTPUT_PROVIDER_REQUIRED');
    const plan = JSON.parse(await readFile(values.plan, 'utf8'));
    const abort = new AbortController(), stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      if (command === 'corpus-offline') await collectSemanticCorpusOffline(values.out, { plan, providerEndpoint: values.provider, signal: abort.signal });
      const result = await inspectSemanticCorpusOffline(values.out, { plan, release: values.release, signal: abort.signal });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.infrastructurePassed && (command !== 'assess-corpus-offline' || result.review?.offlineReviewPassed) ? 0 : 1;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  if (command === 'plan') {
    const plan = JSON.parse(await readFile('verification/semantic-quality/plan.template.json', 'utf8'));
    console.log(JSON.stringify({ complete: true, mode: 'offline-preparation', qualityStatus: 'not_run', qualityEvaluated: false,
      fullQualityAcceptance: false, liveImplemented: false, liveCalls: 0, plan }, null, 2)); return;
  }
  if (['distinct-offline','check-distinct-offline','assess-distinct-offline'].includes(command)) {
    if (!values.baseline || !values.candidate || !values.reviewers || !values.out) throw new Error('CHECKOUTS_REVIEWERS_OUTPUT_REQUIRED');
    const options = { checkouts: { baseline: values.baseline, candidate: values.candidate },
      reviewers: JSON.parse(await readFile(values.reviewers, 'utf8')), release: values.release };
    const abort = new AbortController(), stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    options.signal = abort.signal;
    try {
      if (command === 'distinct-offline') await runSemanticDistinctOffline(values.out, options);
      const summary = await inspectSemanticDistinctOffline(values.out, options);
      console.log(JSON.stringify(summary, null, 2)); process.exitCode = summary.infrastructurePassed && (command !== 'assess-distinct-offline' || summary.reviewComplete && summary.offlineReviewPassed) ? 0 : 1;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  if (['offline','paired-offline'].includes(command)) {
    const paired = command === 'paired-offline', run = paired ? runSemanticPairedOffline : runSemanticOffline, inspect = paired ? inspectSemanticPairedOffline : inspectSemanticOffline;
    const root = values.out || 'verification-evidence/semantic-quality'; await mkdir(root, { recursive: true });
    const outer = await mkdtemp(path.join(root, 'offline-')), directory = path.join(outer, 'run');
    const abort = new AbortController(), stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      await run(directory, { signal: abort.signal });
      const summary = await inspect(directory, await qualitySources(), { release: values.release });
      await writeJson(path.join(outer, 'summary.json'), summary);
      console.log(JSON.stringify({ directory, complete: summary.complete, infrastructurePassed: summary.infrastructurePassed,
        qualityStatus: summary.qualityStatus, qualityEvaluated: false, fullQualityAcceptance: false, liveCalls: 0, scope: summary.scope }, null, 2));
      process.exitCode = summary.infrastructurePassed ? 0 : 1;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  if (['check-offline','check-paired-offline'].includes(command)) {
    const inspect = command === 'check-paired-offline' ? inspectSemanticPairedOffline : inspectSemanticOffline;
    if (!values.out) throw new Error('EXISTING_RUN_REQUIRED');
    const summary = await inspect(values.out, await qualitySources(), { release: values.release });
    console.log(JSON.stringify(summary, null, 2)); process.exitCode = summary.infrastructurePassed ? 0 : 1; return;
  }
  if (!['prepare-review','assess','failure-cases'].includes(command)) throw new Error('UNKNOWN_COMMAND');
  if (!values.capture || !values.reviewers || !values.out) throw new Error('CAPTURE_REVIEWERS_FRESH_OUTPUT_REQUIRED');
  if (command !== 'prepare-review' && !values.review) throw new Error('COMPLETED_REVIEW_REQUIRED');
  const { report: capture } = await readSemanticCapture(values.capture, await qualitySources(), { release: values.release });
  const reviewers = JSON.parse(await readFile(values.reviewers, 'utf8'));
  const report = command === 'prepare-review' ? createSemanticReviewTemplate(capture, { reviewers })
    : (command === 'failure-cases' ? createSemanticFailureCases : assessSemanticReview)(capture, JSON.parse(await readFile(values.review, 'utf8')), { reviewers });
  await writeFile(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: values.out, qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false,
    ...(command === 'assess' ? { complete: report.complete, contractValid: report.contractValid, offlineReviewPassed: report.offlineReviewPassed }
      : command === 'failure-cases' ? { complete: report.complete, failureCases: report.cases.length, offlineReviewStatus: report.offlineReviewStatus } : { reviewRequired: true }) }));
  if (command === 'assess') process.exitCode = report.offlineReviewPassed ? 0 : 1;
}
main().catch(error => {
  console.error(JSON.stringify({ complete: false, qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false,
    code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SEMANTIC_COMMAND_REJECTED' })); process.exitCode = 1;
});
