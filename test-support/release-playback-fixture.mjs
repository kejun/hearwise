// Synthetic report/log/UI envelopes for reader regression only, never browser acceptance.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { syntheticBrowser } from './playback-browser-fixture.mjs';
import { playbackProvenance } from './playback-provenance.mjs';
import { playbackAssets, playbackTap, writePlaybackEvidence, summarizePlaybackResults } from './playback-evidence.mjs';
import { playbackProperties, playbackProfile } from '../verification/playback-properties.mjs';
import { metadata, writeJson } from '../scripts/lib/verification-evidence.mjs';
import { playbackNestedChecks, playbackTestNames } from '../scripts/lib/playback-release-evidence.mjs';
export const exactPlaybackTap = names => 'TAP version 13\n' + names.map((name, i) => `ok ${i + 1} - ${name.replaceAll('\\', '\\\\').replaceAll('#', '\\#')}\n`).join('') +
  `1..${names.length}\n# tests ${names.length}\n# suites 0\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;
export async function releasePlaybackFixture(directory) {
  await mkdir(directory, { recursive: true }); const context = await metadata(), provenance = await playbackProvenance();
  const browser = syntheticBrowser(provenance), time = new Date().toISOString(), checks = [];
  for (const spec of playbackNestedChecks) {
    const log = spec.files ? exactPlaybackTap(await playbackTestNames(spec.files)) : 'Synthetic browser envelope, not execution\n';
    await writeFile(path.join(directory, spec.name + '.log'), log);
    checks.push({ name: spec.name, executionContext: { cwd: process.cwd(), executable: process.execPath }, configuredTimeoutMs: spec.timeoutMs, ...(spec.files ? { files: spec.files } : {}),
      command: [process.execPath, ...(spec.files ? ['--test', '--test-reporter=tap', '--test-timeout=30000', ...spec.files] : ['test-support/playback-browser.mjs', directory])],
      execution: { code: 0, signal: null, interrupted: false, timedOut: false, durationMs: 1, tail: log.slice(-12000), ok: true,
        ...(spec.files ? playbackTap(log, spec.name) : {}), effectiveTimeoutMs: spec.timeoutMs } });
  }
  await writeJson(path.join(directory, 'browser.json'), browser);
  for (const file of playbackAssets.filter(file => file.endsWith('.png'))) await writeFile(path.join(directory, file), Buffer.from([137,80,78,71,13,10,26,10,0]));
  const observations = { executionContext: { repositoryRoot: process.cwd(), evidenceDirectory: path.resolve(directory), outputArgument: directory, executable: process.execPath }, sourceStart: provenance.snapshot, sourceEnd: provenance.snapshot, browser, checks };
  const artifacts = await writePlaybackEvidence(directory, observations);
  const results = playbackProperties.map(property => ({ ...context, tools: { ...context.tools, chromium: browser.chromium }, property: { id: property.id, version: property.version },
    startedAt: time, finishedAt: time, complete: true, status: 'passed', scope: { description: property.domain, scenario: 'playback-generation-text', samples: 1, seed: null }, artifacts }));
  const { execution, summary } = summarizePlaybackResults({ results, target: context.source, checks, nodeOnly: false, budgetExpired: false,
    required: playbackProfile, sourceStable: true, release: false, artifactsValid: results.map(() => true) });
  const report = { ...context, profile: 'playback', startedAt: time, finishedAt: time, complete: true, ok: true, results, execution, summary };
  await writeJson(path.join(directory, 'report.json'), report); return { report, observations, browser };
}
