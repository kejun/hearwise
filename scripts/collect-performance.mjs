import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { performanceRecipes, performanceProfiles, performanceNetworks, performanceBrowser, performanceTimeouts } from '../verification/performance/profile.mjs';
import { performanceProperties } from '../verification/performance/properties.mjs';
import { performanceRoot, performanceSourceSnapshot, performanceEnvironment, performanceConditions, fileSha256 } from './lib/performance-files.mjs';
import { validateBackendEvidence } from './lib/performance-backend-evidence.mjs';
import { validateBrowserEvidence } from '../test-support/performance-browser.mjs';
import { startPerformanceServer } from '../test-support/performance-server.mjs';
import { policyDigest } from './lib/performance-policy.mjs';
import { performanceEnvironmentIdentity, performanceCaseProjection, performanceMeasurementDigest } from './lib/performance-evidence.mjs';
import { runProcess } from './lib/process.mjs';
import { writeJson } from './lib/verification-evidence.mjs';

const args = process.argv.slice(2), fixtures = args[0], profileName = args[1] || 'baseline';
const skipBrowser = args.includes('--skip-browser'), policyIndex = args.indexOf('--policy');
if (!fixtures || !performanceProfiles[profileName] || args.slice(2).some((arg, index, all) => !['--skip-browser', '--policy'].includes(arg) && all[index - 1] !== '--policy'))
  throw new Error('Usage: node scripts/collect-performance.mjs PREPARED.json [baseline|smoke] [--skip-browser] [--policy FILE]');
const profile = performanceProfiles[profileName], fixtureRoot = path.dirname(path.resolve(fixtures));
const prepared = JSON.parse(await readFile(fixtures, 'utf8')); assert.equal(prepared.complete, true, 'Fixture preparation is incomplete');
const outputRoot = path.resolve(process.env.PERFORMANCE_EVIDENCE_DIR || 'verification-evidence/performance');
await mkdir(outputRoot, { recursive: true }); const directory = await mkdtemp(path.join(outputRoot, 'run-'));
await mkdir(path.join(directory, 'inputs'));
const policy = policyIndex >= 0 ? JSON.parse(await readFile(args[policyIndex + 1], 'utf8')) : null;
const policyAtStart = policy ? { digest: policyDigest(policy), capturedAt: new Date().toISOString() } : null;
const initial = await performanceSourceSnapshot(), environment = await performanceEnvironment();
const configuration = { profile: profileName, ...profile, recipes: performanceRecipes.filter(recipe => profile.tiers.includes(recipe.tier)),
  networks: performanceNetworks.filter(network => profile.networks.includes(network.id)), browser: performanceBrowser, timeouts: performanceTimeouts,
  quantile: 'nearest-rank', schemaVersion: 1 };
const report = { schemaVersion: 1, kind: 'history-graph-performance', mode: policy ? 'candidate-collection' : 'baseline-collection',
  ...initial, startedAt: new Date().toISOString(), finishedAt: null, profile: profileName, configuration,
  configurationDigest: policyDigest(configuration), measurementDigest: performanceMeasurementDigest(initial.sourceDigests), sampling: profile.sampling, environment: { runner: environment, browsers: {} }, environmentDigest: null,
  conditions: { before: performanceConditions(), after: null }, policyAtStart, datasets: [], inputDatabaseDigests: {},
  propertyCoverage: performanceProperties, results: [], cases: [], artifacts: [], collectionComplete: false, performanceEvaluated: false,
  performancePassed: false, decision: 'thresholds_not_frozen', execution: { repositoryRoot: performanceRoot, evidenceDirectory: directory, complete: false, timedOut: false, interrupted: false, code: null, signal: null } };
let stopped = false, timedOut = false; const artifacts = new Set();
const interrupt = () => { stopped = true; };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const overall = setTimeout(() => { timedOut = true; process.kill(process.pid, 'SIGTERM'); }, performanceTimeouts.runMs);
const save = () => writeJson(path.join(directory, 'report.json'), report);
console.log(`Performance evidence: ${directory}`); await save();
const addJson = async (file, value) => { await writeJson(path.join(directory, file), value); artifacts.add(file); };
async function execute(id, script, manifest, timeoutMs) {
  if (stopped) throw new Error('Performance collection interrupted');
  const input = `${id}-input.json`, output = `${id}.json`, log = `${id}.log`;
  await addJson(input, manifest);
  const argv = [script, path.join(directory, input), path.join(directory, output)], env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const startedAt = new Date().toISOString(); console.log(`START ${id}`);
  const { tail: _tail, ...execution } = await runProcess(process.execPath, argv, { cwd: performanceRoot, env, timeoutMs, logFile: path.join(directory, log) });
  artifacts.add(log); let result = null;
  try { result = JSON.parse(await readFile(path.join(directory, output), 'utf8')); artifacts.add(output); } catch { /* Missing output remains incomplete. */ }
  const validation = !result ? { ok: false, issues: ['missing_observations'] } : script.includes('backend') ? validateBackendEvidence(result, manifest) :
    (() => { const value = validateBrowserEvidence(result, manifest); return { ok: value.valid, issues: value.errors }; })();
  const row = { id, kind: script.includes('backend') ? 'backend' : 'browser', input, output: result ? output : null, log,
    argv, cwd: performanceRoot, timeoutMs, startedAt, finishedAt: new Date().toISOString(), execution, validation,
    complete: execution.code === 0 && execution.signal === null && !execution.timedOut && !execution.interrupted && validation.ok };
  report.results.push(row);
  if (result?.cases) report.cases.push(...performanceCaseProjection(result));
  await save(); console.log(`${row.complete ? 'COLLECTED' : 'INCOMPLETE'} ${id}`); return result;
}
try {
  await addJson('preparation.json', prepared); if (policy) await addJson('policy-at-start.json', policy);
  for (const recipe of configuration.recipes) {
    if (stopped) throw new Error('Performance collection interrupted');
    const preparedRow = prepared.datasets.find(row => row.tier === recipe.tier); assert.ok(preparedRow, `Missing fixture tier ${recipe.tier}`);
    const entry = { tier: recipe.tier };
    for (const key of ['database', 'manifest', 'importDatabase', 'importManifest']) {
      const original = preparedRow[key]; assert.ok(typeof original === 'string' && path.basename(original) === original);
      entry[key] = `inputs/${original}`; await copyFile(path.join(fixtureRoot, original), path.join(directory, entry[key])); artifacts.add(entry[key]);
    }
    const dataset = JSON.parse(await readFile(path.join(directory, entry.manifest), 'utf8'));
    const imported = JSON.parse(await readFile(path.join(directory, entry.importManifest), 'utf8'));
    assert.deepEqual(dataset.recipe, recipe);
    assert.deepEqual(imported.recipe, { ...recipe, tier: `${recipe.tier}-import`, listenings: 1, graphRecords: 1, seed: recipe.seed + 1 });
    assert.equal(await fileSha256(path.join(directory, entry.database)), dataset.databaseSha256);
    assert.equal(await fileSha256(path.join(directory, entry.importDatabase)), imported.databaseSha256);
    report.datasets.push(entry); report.inputDatabaseDigests[recipe.tier] = dataset.databaseSha256;
    report.inputDatabaseDigests[`${recipe.tier}-import`] = imported.databaseSha256;
    const common = { schemaVersion: 1, database: { file: path.join(directory, entry.database), sha256: dataset.databaseSha256 },
      workload: { id: recipe.tier, tier: recipe.tier, seed: recipe.seed, recipeDigest: dataset.recipeDigest, counts: dataset.counts, topology: dataset.primary.topology },
      primary: dataset.primary, secondary: dataset.secondary, sampling: profile.sampling,
      import: { file: path.join(directory, entry.importDatabase), sha256: imported.databaseSha256, record: imported.primary, addedCount: 1, expectedTotal: dataset.counts.listenings + 1 } };
    await execute(`${recipe.tier}-backend`, 'scripts/measure-performance-backend.mjs', common, performanceTimeouts.backendMs);
    for (const network of configuration.networks) {
      const id = `${recipe.tier}-${network.id}-browser`;
      if (skipBrowser) { report.results.push({ id, kind: 'browser', complete: false, status: 'not_run', reason: 'explicit_skip_browser' }); await save(); continue; }
      const server = await startPerformanceServer(common.database);
      let browserRow;
      try {
        const manifest = { ...common, baseUrl: server.base, network, browser: performanceBrowser, timeouts: { actionMs: performanceTimeouts.actionMs, overallMs: performanceTimeouts.browserMs - 10000 } };
        const observed = await execute(id, 'scripts/measure-performance-browser.mjs', manifest, performanceTimeouts.browserMs);
        browserRow = report.results.at(-1);
        if (observed?.environment) report.environment.browsers[id] = observed.environment;
        assert.equal(server.providerRequests.length, 0, 'Browser caused an unexpected provider request');
      } finally {
        const observation = { pid: server.pid, input: server.input, providerRequests: [...server.providerRequests], log: server.logs(), cleanupComplete: false };
        try { await server.close(); observation.cleanupComplete = true; }
        finally { const file = `${id}-server.json`; await addJson(file, observation); if (browserRow) browserRow.serverObservation = file; }
      }
    }
  }
} catch (error) { report.error = { name: error.name, message: error.message }; }
finally {
  clearTimeout(overall); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  report.finalSource = await performanceSourceSnapshot(); report.conditions.after = performanceConditions();
  report.environmentDigest = policyDigest(performanceEnvironmentIdentity(report.environment));
  const expected = profile.tiers.length * (1 + profile.networks.length);
  report.collectionComplete = !report.error && !stopped && !timedOut && report.results.length === expected && report.results.every(row => row.complete) &&
    policyDigest(initial) === policyDigest(report.finalSource);
  report.execution = { ...report.execution, complete: !stopped && !timedOut, timedOut, interrupted: stopped && !timedOut, code: report.collectionComplete ? 0 : 3 };
  report.decision = policy ? 'candidate_collected_requires_comparison_gate' : 'thresholds_not_frozen';
  report.finishedAt = new Date().toISOString();
  for (const file of [...artifacts].sort()) report.artifacts.push({ path: file, sha256: await fileSha256(path.join(directory, file)) });
  await save(); console.log(JSON.stringify({ path: path.join(directory, 'report.json'), collectionComplete: report.collectionComplete, performanceEvaluated: false, decision: report.decision }));
  process.exitCode = report.execution.code;
}
