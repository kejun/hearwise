import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowScenarioNames, runWorkflowScenario } from './trace-business-scenarios.mjs';
import { runFullTraceComparison, runSpeechTraceComparison, runTranslationTraceRecovery } from './trace-business-boundary.mjs';
import { runTraceNegativeControls } from './trace-business-negative.mjs';
import { sourceVersion, writeJson } from '../scripts/lib/verification-evidence.mjs';

export async function collectTraceBusinessEvidence(save = async () => {}) {
  const result = { profileVersion: 1, source: sourceVersion(), startedAt: new Date().toISOString(), finishedAt: null,
    complete: false, ok: false, workflows: [], boundaries: [], negative: null };
  await save(result);
  try {
    for (const name of workflowScenarioNames) {
      result.workflows.push(await runWorkflowScenario(name)); await save(result);
    }
    for (const run of [runFullTraceComparison, () => runSpeechTraceComparison({ failed: false }),
      () => runSpeechTraceComparison({ failed: true }), runTranslationTraceRecovery]) {
      const row = await run(); result.boundaries.push(row); await save(result);
    }
    result.negative = await runTraceNegativeControls(); result.complete = true; result.ok = true;
  } catch (error) {
    result.failure = { name: error.name, code: error.code || null, message: error.message.replaceAll('TRACE_SECRET_KEY', '[redacted]').slice(0, 4000) };
  } finally { result.finishedAt = new Date().toISOString(); await save(result); }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]; if (!directory) throw new Error('Trace business evidence directory is required');
  await mkdir(directory, { recursive: true });
  const result = await collectTraceBusinessEvidence(value => writeJson(path.join(directory, 'business-observations.json'), value));
  console.log(JSON.stringify({ complete: result.complete, ok: result.ok, workflows: result.workflows.length, boundaries: result.boundaries.length,
    mutants: result.negative?.results.length, failure: result.failure || null }));
  process.exitCode = result.ok ? 0 : 1;
}
