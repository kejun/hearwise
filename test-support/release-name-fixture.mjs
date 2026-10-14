// Synthetic packaging contract only: UI/log/PNG envelopes are not Chromium
// evidence. The underlying name fixture performs genuine loopback HTTP/SQLite.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nameBrowserContractFixture } from './name-browser-contract-fixture.mjs';
import { nameBrowserAssets, nameBrowserChecks, nameHttpRoster } from './name-protocol-browser-evidence.mjs';
import { metadata, digest, writeJson } from '../scripts/lib/verification-evidence.mjs';
import { summarizeChecks } from '../scripts/lib/verification-checks.mjs';
import { nameProperties, nameProfile } from '../verification/name-properties.mjs';
export function nameContractTap(roster) {
  const roots = roster.filter(name => !name.includes(' > ')), lines = ['TAP version 13'];
  for (const [index, root] of roots.entries()) {
    lines.push(`# Subtest: ${root}`);
    const children = roster.filter(name => name.startsWith(root + ' > ')).map(name => name.slice(root.length + 3));
    for (const [number, child] of children.entries()) lines.push(`    # Subtest: ${child}`, `    ok ${number + 1} - ${child}`);
    if (children.length) lines.push(`    1..${children.length}`);
    lines.push(`ok ${index + 1} - ${root}`);
  }
  lines.push(`1..${roots.length}`, `# tests ${roster.length}`, '# suites 0', `# pass ${roster.length}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 1');
  return lines.join('\n') + '\n';
}
export async function releaseNameBrowserFixture(directory) {
  await mkdir(directory, { recursive: true });
  const { browser, source, mutation } = await nameBrowserContractFixture(), context = await metadata(), time = new Date().toISOString();
  const origin = { cwd: '/original-ci/checkout', executable: '/original-ci/node/bin/node', evidenceDirectory: '/original-ci/evidence/' + path.basename(directory) };
  origin.outputArgument = origin.evidenceDirectory;
  const checks = [];
  for (const spec of nameBrowserChecks) {
    const log = spec.file ? nameContractTap(await nameHttpRoster()) : 'SYNTHETIC CONTRACT ONLY: Chromium was not launched.\n';
    await writeFile(path.join(directory, spec.name + '.log'), log);
    checks.push({ name: spec.name, execution: { code: 0, ok: true, signal: null, timedOut: false, interrupted: false, durationMs: 1, tail: log.slice(-12000),
      configuredTimeoutMs: spec.timeoutMs, timeoutMs: spec.timeoutMs, cwd: origin.cwd,
      command: [origin.executable, ...(spec.file ? ['--test', '--test-reporter=tap', '--test-timeout=20000', spec.file] : ['test-support/name-protocol-browser.mjs', origin.outputArgument])],
      ...(spec.file ? { testComplete: true, testCount: (await nameHttpRoster()).length } : {}) } });
  }
  for (const file of nameBrowserAssets.filter(name => name.endsWith('.png'))) await writeFile(path.join(directory, file), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const observations = { checks, sourceStart: source, sourceEnd: source, browser, mutation, executionContext: origin };
  const hash = async names => Promise.all(names.map(async file => ({ path: file, sha256: digest(await readFile(path.join(directory, file))) })));
  const report = { ...context, profile: 'name-protocol-browser', startedAt: time, finishedAt: time, complete: true, ok: true };
  const save = async (value = observations) => {
    await writeJson(path.join(directory, 'browser.json'), value.browser); value.attachments = await hash(nameBrowserAssets);
    await writeJson(path.join(directory, 'observations.json'), value);
    await writeFile(path.join(directory, 'worker.log'), (await Promise.all(value.checks.map(async row => `CHECK ${row.name}\n${await readFile(path.join(directory, row.name + '.log'), 'utf8')}`))).join('\n'));
    const artifacts = await hash(['observations.json', 'worker.log']);
    report.results = nameProperties.map(property => ({ ...context, property: { id: property.id, version: property.version }, startedAt: time, finishedAt: time,
      status: 'passed', complete: true, scope: { description: 'Synthetic UI packaging, actual loopback HTTP below', scenario: 'name-http-browser', samples: 1, seed: null }, artifacts }));
    Object.assign(report, summarizeChecks({ results: report.results, checks: value.checks, target: context.source, required: nameProfile, release: false,
      sourceStable: true, expectedChecks: nameBrowserChecks.map(row => row.name), checksForProperty: () => nameBrowserChecks.map(row => row.name), artifactsValid: report.results.map(() => true) }));
    await writeJson(path.join(directory, 'report.json'), report); return report;
  };
  await save(); return { report, observations, save };
}
