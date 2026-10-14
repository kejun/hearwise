import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './lib/process.mjs';
import { metadata, writeJson } from './lib/verification-evidence.mjs';
import { sourceSnapshot, sameSourceSnapshot, validBuildSource, evidenceFiles, hashEvidenceFiles } from './lib/runner-evidence-contract.mjs';
import { validateUserJourneyReleaseContract } from './lib/user-journey-release-evidence.mjs';
import { journeyLimits, journeyExternalAcceptance } from '../test-support/user-journey-contract.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--release', '--node-only'].includes(arg))) throw new Error('Usage: verify-user-journey-browser.mjs [--release] [--node-only]');
const nodeOnly = args.includes('--node-only'), root = path.resolve(process.env.USER_JOURNEY_EVIDENCE_DIR || 'browser-evidence');
await mkdir(root, { recursive: true }); const directory = await mkdtemp(path.join(root, 'user-journey-'));
const startedAt = new Date().toISOString(), sourceStart = await sourceSnapshot();
const report = { ...await metadata(), schemaVersion: 1, profile: 'user-journey', startedAt, finishedAt: null,
  sourceStart, sourceEnd: null, complete: false, ok: false, status: 'not_run', checks: [], artifacts: [], browserFile: 'browser.json',
  executionContext: { repositoryRoot: process.cwd(), evidenceDirectory: directory, nodeExecutable: process.execPath, overallTimeoutMs: journeyLimits.overallMs },
  externalAcceptance: journeyExternalAcceptance, fullProjectAcceptance: false };
await writeJson(path.join(directory, 'report.json'), report); console.log(`User journey browser evidence: ${directory}`);
const temporary = await mkdtemp(path.join(directory, 'temporary-runtime-'));
try {
  if (!validBuildSource(sourceStart)) throw new Error('Journey runtime source differs from checkout; run npm run build');
  if (!nodeOnly) {
    const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary }; delete env.NODE_TEST_CONTEXT;
    const command = [process.execPath, 'test-support/user-journey-browser.mjs', directory];
    const execution = await runProcess(command[0], command.slice(1), { env, timeoutMs: journeyLimits.browserMs,
      logFile: path.join(directory, 'browser.log'), onOutput: text => process.stdout.write(text) });
    report.checks.push({ name: 'browser', command, timeoutMs: journeyLimits.browserMs, execution });
  }
} catch (error) { report.error = { name: error.name, message: error.message }; }
finally {
  // Finalization is not a prerequisite for cleanup. Preserve every failure and
  // still attempt the final report when a diagnostic read or temp removal fails.
  report.finalizationErrors = [];
  const finalize = async (phase, operation) => {
    try { return await operation(); } catch (error) { report.finalizationErrors.push({ phase, name: error.name, message: error.message }); return null; }
  };
  await finalize('temporary-cleanup', () => rm(temporary, { recursive: true, force: true }));
  report.sourceEnd = await finalize('source-end', sourceSnapshot); report.finishedAt = new Date().toISOString();
  report.artifacts = await finalize('artifact-hashes', async () => hashEvidenceFiles(directory, (await evidenceFiles(directory)).filter(file => file !== 'report.json'))) || [];
  report.complete = !nodeOnly && !report.error && report.finalizationErrors.length === 0 && sameSourceSnapshot(report.sourceStart, report.sourceEnd) && validBuildSource(report.sourceEnd) &&
    report.checks.length === 1 && report.checks.every(({ execution }) => execution.code !== null && !execution.timedOut && !execution.interrupted && execution.signal === null);
  if (nodeOnly) report.reason = 'Browser was deliberately not launched. Node fixture tests are preparation and cannot establish a user journey.';
  else try {
    const checked = await validateUserJourneyReleaseContract(report, directory, { requirePassed: false, release: args.includes('--release') || process.env.CI === 'true' });
    report.ok = checked.ok; report.status = checked.ok ? 'passed' : 'failed'; report.propertyRows = checked.propertyRows;
  } catch (error) { report.status = report.complete ? 'failed' : 'incomplete'; report.reasons = [error.message]; }
  try { await writeJson(path.join(directory, 'report.json'), report); }
  catch (error) { report.ok = false; report.status = 'incomplete'; console.error('Journey final report write failed:', error.message); }
  console.log(JSON.stringify({ directory, complete: report.complete, ok: report.ok, status: report.status, reasons: report.reasons,
    finalizationErrors: report.finalizationErrors, externalAcceptance: report.externalAcceptance, fullProjectAcceptance: false })); process.exitCode = report.ok ? 0 : 1;
}
