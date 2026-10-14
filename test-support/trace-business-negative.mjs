import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { runWorkflowScenario, checkWorkflowCapture } from './trace-business-scenarios.mjs';

export const traceMutations = [
  { id: 'continuation-as-success', file: 'src/server/diagnostics/report.ts',
    anchor: 'if (end?.attributes.outcome === "continue" && span.ownState === "succeeded") span.ownState = "waiting";',
    replacement: '/* Test-only mutant removes the continuing-business-state mapping. */' },
  { id: 'dispatch-as-business-object', file: 'src/server/diagnostics/business.ts',
    anchor: "span.job === 'unknown' ? span.id : span.job", replacement: 'span.id' }
];
export function mutateTraceSource(source, mutation) {
  assert.equal(source.split(mutation.anchor).length - 1, 1, `Mutation ${mutation.id} must match exactly one production anchor`);
  return source.replace(mutation.anchor, mutation.replacement);
}
export async function expectedTraceMutations() {
  return Promise.all(traceMutations.map(async mutation => {
    const source = await readFile(mutation.file, 'utf8');
    return { ...mutation, replacements: 1, normalSha256: digest(source), mutantSha256: digest(mutateTraceSource(source, mutation)) };
  }));
}
export async function runTraceNegativeControls() {
  const normal = await runWorkflowScenario('knowledge-retry');
  const expected = await expectedTraceMutations(), results = [];
  for (const mutation of expected) {
    const directory = await mkdtemp(path.join(tmpdir(), 'trace-real-source-mutant-'));
    try {
      await cp('src', path.join(directory, 'src'), { recursive: true });
      await symlink(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'dir');
      await writeFile(path.join(directory, mutation.file), mutateTraceSource(await readFile(mutation.file, 'utf8'), mutation));
      await mkdir(path.join(directory, 'dist'), { recursive: true });
      const output = path.join(directory, 'dist', 'mutant.mjs');
      await build({ absWorkingDir: directory, entryPoints: ['src/server/index.ts'], outfile: output,
        bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24',
        define: { __BUILD_META__: JSON.stringify(normal.captures[0].snapshot.build) } });
      const implementation = await import(pathToFileURL(output).href);
      const capture = structuredClone(normal.captures[mutation.id === 'continuation-as-success' ? 0 : 1]);
      capture.report = implementation.buildTraceReport(implementation.parseTraceInput(JSON.stringify(capture.snapshot)));
      capture.business = implementation.buildBusinessOverview(capture.report, capture.query.listeningId);
      const comparison = { domain: 'knowledge', state: mutation.id === 'continuation-as-success' ? 'waiting' : 'recovered',
        calls: mutation.id === 'continuation-as-success' ? 1 : 2, items: 0, queryState: mutation.id === 'continuation-as-success' ? 'pending' : 'complete',
        outcome: mutation.id === 'continuation-as-success' ? null : 'empty', next: mutation.id === 'continuation-as-success' };
      let detected = false, mismatch;
      try { checkWorkflowCapture(capture, comparison); }
      catch (error) { if (error.code !== 'ERR_ASSERTION') throw error; detected = true;
        mismatch = { actual: error.actual, expected: error.expected, operator: error.operator }; }
      assert.equal(detected, true, `Real production mutation ${mutation.id} escaped its unchanged business-query oracle`);
      results.push({ ...mutation, detected, complete: true, capture, comparison, mismatch, normalState: normal.captures[mutation.id === 'continuation-as-success' ? 0 : 1].business.tasks[0].state,
        observedStates: capture.business.tasks.map(task => task.state), businessObjects: capture.business.tasks.length,
        persistedState: capture.query.checkpoint.job.state, providerRequests: capture.calls.length });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return { complete: true, ok: true, cleanup: true, normal, results };
}
