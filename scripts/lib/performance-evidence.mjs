import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performanceRecipes, performanceProfiles, performanceNetworks, performanceBrowser, performanceTimeouts } from '../../verification/performance/profile.mjs';
import { performanceProperties } from '../../verification/performance/properties.mjs';
import { inspectPerformanceDataset, graphTopology, performanceRecipeDigest } from '../../test-support/performance-dataset.mjs';
import { validateBrowserEvidence } from '../../test-support/performance-browser.mjs';
import { validateBackendEvidence } from './performance-backend-evidence.mjs';
import { fileSha256, performanceSourceSnapshot } from './performance-files.mjs';
import { policyDigest, sampleStatistics } from './performance-policy.mjs';

const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (a, b) => policyDigest(a) === policyDigest(b);
const exited = execution => execution && execution.code === 0 && execution.signal === null && execution.timedOut === false && execution.interrupted === false && execution.ok === true;
const safePath = file => typeof file === 'string' && file && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..') && !file.includes('\\');
// Bind generic execution, atomic reporting and cleanup too. Product code stays
// in sourceDigests, but can legitimately change between baseline and candidate.
const measurementHelpers = ['scripts/lib/process.mjs', 'scripts/lib/verification-evidence.mjs', 'test-support/lifecycle.mjs'];
export function performanceMeasurementDigest(sources) {
  for (const file of measurementHelpers) assert.ok(hash(sources[file]), `Missing measurement dependency: ${file}`);
  return policyDigest(Object.fromEntries(Object.entries(sources).filter(([file]) => measurementHelpers.includes(file) ||
    /^(?:scripts\/(?:lib\/)?[^/]*performance[^/]*\.mjs|test-support\/performance[^/]*\.mjs|verification\/performance\/)/.test(file)).sort(([a], [b]) => a.localeCompare(b))));
}

// The random temporary browser user-data directory has no persistent content.
// All other actual flags, device/browser/font/cache/network choices stay bound.
export function performanceEnvironmentIdentity(environment) {
  return { runner: environment.runner, browsers: Object.fromEntries(Object.entries(environment.browsers).map(([id, value]) => [id, {
    ...value, actualCommandLine: value.actualCommandLine?.map(argument => argument.startsWith('--user-data-dir=') ? '--user-data-dir=<fresh-empty-context>' : argument)
  }])) };
}

export async function verifyPerformanceDataset(file, manifest, recipe) {
  assert.deepEqual(manifest.recipe, recipe); assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.recipeDigest, performanceRecipeDigest(recipe));
  assert.equal(await fileSha256(file), manifest.databaseSha256);
  const inspected = await inspectPerformanceDataset(file);
  assert.deepEqual(inspected.counts, manifest.counts); assert.equal(inspected.semanticDigest, manifest.semanticDigest); assert.equal(inspected.databaseVersion, manifest.databaseVersion);
  const graphSegments = recipe.nodesPerGraph + 2 * (recipe.nodesPerGraph - recipe.isolatedPerGraph);
  const expectedCounts = { listenings: recipe.listenings, runs: recipe.listenings,
    nodes: recipe.graphRecords * recipe.nodesPerGraph, relations: recipe.graphRecords * 2 * (recipe.nodesPerGraph - recipe.isolatedPerGraph),
    segments: recipe.graphRecords * graphSegments + (recipe.listenings - recipe.graphRecords) * recipe.segmentsPerBackground };
  for (const [key, value] of Object.entries(expectedCounts)) assert.equal(manifest.counts[key], value, `Recipe ${key} scale differs`);
  assert.equal(manifest.counts.facts, expectedCounts.nodes); assert.equal(manifest.counts.assertions, expectedCounts.relations); assert.equal(manifest.counts.supports, expectedCounts.relations);
  assert.equal(manifest.counts.originalTextCodePoints, expectedCounts.segments * recipe.textCharacters);
  assert.equal(manifest.counts.translationTextCodePoints, expectedCounts.segments * (recipe.textCharacters + 5));
  assert.equal(manifest.records.length, recipe.listenings); assert.equal(new Set(manifest.records.map(record => record.id)).size, recipe.listenings);
  assert.deepEqual(manifest.primary, manifest.records[0]); assert.deepEqual(manifest.secondary, manifest.records[1] || null);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM listening_runs WHERE state!='complete'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM segments WHERE translation_state!='complete'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM extraction_jobs WHERE state!='complete'").get().n, 0);
    for (const [ordinal, record] of manifest.records.entries()) {
      assert.equal(record.nodeCount, ordinal < recipe.graphRecords ? recipe.nodesPerGraph : 0);
      assert.equal(record.edgeCount, ordinal < recipe.graphRecords ? 2 * (recipe.nodesPerGraph - recipe.isolatedPerGraph) : 0);
      assert.equal(record.segmentCount, ordinal < recipe.graphRecords ? graphSegments : recipe.segmentsPerBackground);
      assert.equal(db.prepare('SELECT title FROM listenings WHERE id=?').get(record.id)?.title, record.title);
      const nodes = db.prepare('SELECT id,type FROM knowledge_items WHERE listening_id=? ORDER BY created_at,rowid').all(record.id);
      const relations = db.prepare('SELECT id,subject_item_id,object_item_id FROM relations WHERE listening_id=? ORDER BY id').all(record.id);
      const segments = db.prepare('SELECT id FROM segments WHERE listening_id=? ORDER BY sequence_no').all(record.id);
      assert.deepEqual(nodes.map(node => node.id).sort(), [...record.nodeIds].sort()); assert.equal(nodes.length, record.nodeCount);
      assert.deepEqual(relations.map(edge => edge.id).sort(), [...record.edgeIds].sort()); assert.equal(relations.length, record.edgeCount);
      assert.deepEqual(segments.map(segment => segment.id), record.segmentIds); assert.equal(segments.length, record.segmentCount);
      assert.deepEqual(graphTopology(nodes, relations), record.topology);
      const types = {}; for (const node of nodes) types[node.type] = (types[node.type] || 0) + 1; assert.deepEqual(types, record.typeCounts);
    }
  } finally { db.close(); }
  return true;
}

export function performanceCaseProjection(raw) {
  return raw.cases.map(item => ({ id: item.id, phase: item.phase, status: item.status, ...(item.reason ? { reason: item.reason } : {}),
    samples: item.samples.map(sample => ({ index: sample.index, warmup: sample.warmup, metrics: sample.metrics })),
    statistics: item.status === 'collected' && item.samples.length && item.samples.every(sample => Object.values(sample.metrics).every(value => typeof value === 'number' && Number.isFinite(value))) ?
      Object.fromEntries(Object.keys(item.samples[0].metrics).map(metric => [metric, sampleStatistics(item.samples.filter(sample => !sample.warmup).map(sample => sample.metrics[metric]))])) : null }));
}

export async function validatePerformanceEvidence(directory, { release = false, cleanSource = false, target = null, requireComplete = true } = {}) {
  requireComplete ||= release; // A release request can never be downgraded to partial inspection.
  const issues = [], check = async (label, work) => { try { await work(); } catch (error) { issues.push(`${label}: ${error.message}`); } };
  let report; try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); } catch (error) { return { valid: false, collectionComplete: false, performanceEvaluated: false, issues: [error.message] }; }
  const profile = performanceProfiles[report.profile];
  const stopped = !requireComplete && report.execution?.complete === false &&
    (report.execution?.timedOut === true || report.execution?.interrupted === true);
  await check('header', async () => {
    assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'history-graph-performance'); assert.ok(profile);
    assert.ok(['baseline-collection', 'candidate-collection'].includes(report.mode));
    assert.ok(date(report.startedAt) && date(report.finishedAt) && Date.parse(report.startedAt) <= Date.parse(report.finishedAt));
    assert.deepEqual(report.propertyCoverage, performanceProperties); assert.deepEqual(report.sampling, profile.sampling);
    const expected = { profile: report.profile, ...profile, recipes: performanceRecipes.filter(recipe => profile.tiers.includes(recipe.tier)),
      networks: performanceNetworks.filter(network => profile.networks.includes(network.id)), browser: performanceBrowser, timeouts: performanceTimeouts, quantile: 'nearest-rank', schemaVersion: 1 };
    assert.deepEqual(report.configuration, expected); assert.equal(report.configurationDigest, policyDigest(expected));
    assert.equal(report.environmentDigest, policyDigest(performanceEnvironmentIdentity(report.environment)));
    for (const key of ['platform', 'arch', 'osRelease', 'node', 'sqlite', 'host', 'label']) assert.ok(typeof report.environment.runner[key] === 'string' && report.environment.runner[key]);
    assert.equal(report.environment.runner.userDeviceMeasurement, false);
    assert.ok(Number.isSafeInteger(report.environment.runner.availableParallelism) && report.environment.runner.availableParallelism > 0);
    assert.ok(report.environment.runner.totalMemoryBytes > 0 && Object.keys(report.environment.runner.cpuModels).length > 0);
    for (const key of ['cpuMax', 'memoryMax', 'cpuset']) assert.ok(Object.hasOwn(report.environment.runner.cgroup, key));
    for (const observation of [report.conditions?.before, report.conditions?.after]) {
      assert.ok(date(observation?.recordedAt) && Date.parse(observation.recordedAt) >= Date.parse(report.startedAt) && Date.parse(observation.recordedAt) <= Date.parse(report.finishedAt));
      assert.ok(Array.isArray(observation.loadAverage) && observation.loadAverage.length === 3 && observation.loadAverage.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0));
      assert.ok(typeof observation.freeMemoryBytes === 'number' && Number.isFinite(observation.freeMemoryBytes) && observation.freeMemoryBytes >= 0);
    }
    assert.ok(Date.parse(report.conditions.before.recordedAt) <= Date.parse(report.conditions.after.recordedAt));
    assert.equal(report.measurementDigest, performanceMeasurementDigest(report.sourceDigests));
    assert.equal(report.performanceEvaluated, false); assert.equal(report.performancePassed, false, 'Collection must not claim release performance');
    assert.equal(report.decision, report.mode === 'baseline-collection' ? 'thresholds_not_frozen' : 'candidate_collected_requires_comparison_gate');
    if (report.mode === 'baseline-collection') assert.equal(report.policyAtStart, null);
    else {
      assert.ok(hash(report.policyAtStart.digest) && date(report.policyAtStart.capturedAt) && Date.parse(report.policyAtStart.capturedAt) <= Date.parse(report.startedAt));
      assert.equal(report.policyAtStart.digest, policyDigest(JSON.parse(await readFile(path.join(directory, 'policy-at-start.json'), 'utf8'))));
    }
    assert.ok(path.isAbsolute(report.execution.repositoryRoot)); assert.ok(path.isAbsolute(report.execution.evidenceDirectory));
    const execution = report.execution;
    for (const key of ['complete', 'timedOut', 'interrupted']) assert.equal(typeof execution[key], 'boolean');
    assert.equal(execution.signal, null, 'A retained terminal report has handled its signal');
    assert.equal(execution.timedOut && execution.interrupted, false, 'Watchdog and external interruption are distinct');
    assert.equal(execution.complete, !execution.timedOut && !execution.interrupted);
    assert.ok([0, 3].includes(execution.code));
    if (!execution.complete) { assert.equal(execution.code, 3); assert.equal(report.collectionComplete, false); }
    if (requireComplete) { assert.equal(execution.complete, true); assert.equal(report.collectionComplete, true); assert.equal(execution.code, 0); assert.equal(report.error, undefined); }
    assert.ok(equal(report.source, report.finalSource.source) && equal(report.sourceDigests, report.finalSource.sourceDigests) && equal(report.runtimeBuild, report.finalSource.runtimeBuild), 'Source changed while collecting');
    assert.match(report.runtimeBuild.git_sha, /^[a-f0-9]{40}$/); assert.equal(typeof report.runtimeBuild.build_dirty, 'boolean'); assert.equal(report.runtimeBuild.instrumentation_version, 3);
    const actual = target || await performanceSourceSnapshot();
    assert.deepEqual(report.source, actual.source); assert.deepEqual(report.sourceDigests, actual.sourceDigests); assert.deepEqual(report.runtimeBuild, actual.runtimeBuild);
    for (const file of ['server.mjs', 'storage.mjs', 'dist/server/index.js', 'public/vendor/cytoscape.js', 'test-support/performance-browser.mjs']) assert.ok(hash(report.sourceDigests[file]));
    if (release || cleanSource) { assert.equal(report.source.dirty, false); assert.equal(report.runtimeBuild.git_sha, report.source.sha); assert.equal(report.runtimeBuild.build_dirty, false); }
    if (release) assert.equal(profile.releaseCollection, true);
  });
  const artifactMap = new Map();
  await check('artifacts', async () => {
    assert.ok(Array.isArray(report.artifacts) && report.artifacts.length > 0);
    for (const entry of report.artifacts) {
      assert.ok(safePath(entry.path) && hash(entry.sha256)); assert.equal(artifactMap.has(entry.path), false);
      const file = path.join(directory, entry.path); assert.equal((await lstat(file)).isFile(), true); assert.equal(await fileSha256(file), entry.sha256);
      artifactMap.set(entry.path, entry.sha256);
    }
    assert.ok(artifactMap.has('preparation.json'));
    if (report.mode === 'candidate-collection') assert.ok(artifactMap.has('policy-at-start.json'));
  });
  const manifests = new Map();
  if (profile) await check('frozen databases', async () => {
    assert.deepEqual(report.datasets.map(row => row.tier), stopped ? profile.tiers.slice(0, report.datasets.length) : profile.tiers);
    assert.ok(report.datasets.length <= profile.tiers.length);
    const hashes = {};
    for (const row of report.datasets) {
      const recipe = performanceRecipes.find(recipe => recipe.tier === row.tier);
      for (const key of ['database', 'manifest', 'importDatabase', 'importManifest']) assert.ok(artifactMap.has(row[key]));
      const dataset = JSON.parse(await readFile(path.join(directory, row.manifest), 'utf8')), imported = JSON.parse(await readFile(path.join(directory, row.importManifest), 'utf8'));
      await verifyPerformanceDataset(path.join(directory, row.database), dataset, recipe);
      await verifyPerformanceDataset(path.join(directory, row.importDatabase), imported, { ...recipe, tier: `${recipe.tier}-import`, listenings: 1, graphRecords: 1, seed: recipe.seed + 1 });
      hashes[row.tier] = dataset.databaseSha256; hashes[`${row.tier}-import`] = imported.databaseSha256;
      manifests.set(row.tier, { row, dataset, imported });
    }
    assert.deepEqual(report.inputDatabaseDigests, hashes);
  });
  const projectedCases = [], browserEnvironments = {};
  if (profile) await check('execution roster', async () => {
    const expected = profile.tiers.flatMap(tier => [`${tier}-backend`, ...profile.networks.map(network => `${tier}-${network}-browser`)]);
    assert.deepEqual(report.results.map(row => row.id), stopped ? expected.slice(0, report.results.length) : expected);
    assert.ok(report.results.length <= expected.length);
  });
  for (const row of report.results || []) await check(row.id, async () => {
    if (!requireComplete && row.status === 'not_run' && !row.execution) { assert.equal(row.complete, false); assert.equal(row.reason, 'explicit_skip_browser'); return; }
    for (const key of ['input', 'log']) assert.ok(artifactMap.has(row[key]));
    const manifest = JSON.parse(await readFile(path.join(directory, row.input), 'utf8'));
    const hasOutput = typeof row.output === 'string' && artifactMap.has(row.output);
    const raw = hasOutput ? JSON.parse(await readFile(path.join(directory, row.output), 'utf8')) : null;
    assert.ok(date(row.startedAt) && date(row.finishedAt) && Date.parse(row.startedAt) <= Date.parse(row.finishedAt));
    assert.ok(Date.parse(report.conditions.before.recordedAt) <= Date.parse(row.startedAt) && Date.parse(row.finishedAt) <= Date.parse(report.conditions.after.recordedAt), 'Load observations do not bracket actual collection');
    if (raw) assert.ok(date(raw.startedAt) && date(raw.finishedAt) && Date.parse(row.startedAt) <= Date.parse(raw.startedAt) && Date.parse(raw.finishedAt) <= Date.parse(row.finishedAt));
    const { row: datasetRow, dataset, imported } = manifests.get(manifest.workload.tier) || {};
    assert.ok(dataset);
    assert.deepEqual(manifest.primary, dataset.primary); assert.deepEqual(manifest.secondary, dataset.secondary);
    assert.deepEqual(manifest.workload, { id: dataset.recipe.tier, tier: dataset.recipe.tier, seed: dataset.recipe.seed, recipeDigest: dataset.recipeDigest, counts: dataset.counts, topology: dataset.primary.topology });
    assert.equal(manifest.database.sha256, dataset.databaseSha256); assert.equal(path.basename(manifest.database.file), path.basename(datasetRow.database));
    assert.equal(manifest.database.file, path.join(report.execution.evidenceDirectory, datasetRow.database));
    assert.deepEqual(manifest.import.record, imported.primary); assert.equal(manifest.import.sha256, imported.databaseSha256);
    assert.equal(manifest.import.addedCount, 1); assert.equal(manifest.import.expectedTotal, dataset.counts.listenings + 1);
    assert.equal(manifest.import.file, path.join(report.execution.evidenceDirectory, datasetRow.importDatabase));
    assert.deepEqual(manifest.sampling, profile.sampling);
    const browser = row.kind === 'browser', script = browser ? 'scripts/measure-performance-browser.mjs' : 'scripts/measure-performance-backend.mjs';
    assert.ok(['backend', 'browser'].includes(row.kind));
    assert.equal(row.cwd, report.execution.repositoryRoot);
    assert.deepEqual(row.argv, [script, path.join(report.execution.evidenceDirectory, row.input), path.join(report.execution.evidenceDirectory, `${row.id}.json`)]);
    if (hasOutput) assert.equal(row.output, `${row.id}.json`);
    assert.equal(row.timeoutMs, browser ? performanceTimeouts.browserMs : performanceTimeouts.backendMs);
    const execution = row.execution;
    assert.ok(execution && (execution.code === null || Number.isSafeInteger(execution.code) && execution.code >= 0));
    assert.ok(execution.signal === null || typeof execution.signal === 'string' && /^SIG[A-Z0-9]+$/.test(execution.signal));
    for (const key of ['timedOut', 'interrupted', 'ok']) assert.equal(typeof execution[key], 'boolean');
    assert.ok(typeof execution.durationMs === 'number' && Number.isFinite(execution.durationMs) && execution.durationMs >= 0);
    assert.ok(execution.error === undefined || typeof execution.error === 'string' && execution.error);
    assert.ok(execution.code !== null || execution.signal !== null || execution.error);
    assert.equal(execution.ok, execution.code === 0 && !execution.error && !execution.timedOut && !execution.interrupted);
    if (!hasOutput) {
      assert.equal(stopped, true, 'Missing observations outside an interrupted inspection');
      assert.equal(row.output, null); assert.equal(exited(execution), false); assert.equal(row.complete, false);
      assert.deepEqual(row.validation, { ok: false, issues: ['missing_observations'] });
    }
    if (browser) {
      const network = performanceNetworks.find(value => `${dataset.recipe.tier}-${value.id}-browser` === row.id); assert.ok(network);
      assert.deepEqual(manifest.network, network); assert.deepEqual(manifest.browser, performanceBrowser);
      assert.deepEqual(manifest.timeouts, { actionMs: performanceTimeouts.actionMs, overallMs: performanceTimeouts.browserMs - 10000 });
      if (raw?.environment) browserEnvironments[row.id] = raw.environment;
      assert.ok(artifactMap.has(row.serverObservation));
      const server = JSON.parse(await readFile(path.join(directory, row.serverObservation), 'utf8'));
      assert.ok(Number.isSafeInteger(server.pid) && server.pid > 0); assert.equal(server.input.sha256, dataset.databaseSha256);
      assert.deepEqual(server.providerRequests, []); assert.equal(server.cleanupComplete, true);
    } else {
      assert.equal(row.id, `${dataset.recipe.tier}-backend`);
      if (raw?.cases?.[0]?.samples?.[0]) assert.deepEqual(raw.cases[0].samples[0].before.runtime, Object.fromEntries(['node', 'sqlite', 'platform', 'arch'].map(key => [key, report.environment.runner[key]])));
    }
    if (!raw) return;
    const checked = browser ? validateBrowserEvidence(raw, manifest) : validateBackendEvidence(raw, manifest);
    const valid = browser ? checked.valid : checked.ok;
    if (requireComplete) { assert.equal(exited(row.execution), true); assert.equal(row.complete, true); assert.equal(valid, true, JSON.stringify(checked)); }
    else assert.equal(row.complete, exited(row.execution) && valid);
    projectedCases.push(...performanceCaseProjection(raw));
  });
  await check('derived summaries', () => { assert.deepEqual(report.cases, projectedCases); assert.deepEqual(report.environment.browsers, browserEnvironments); });
  await check('collection conclusion', () => {
    const expected = profile.tiers.length * (1 + profile.networks.length);
    const complete = !report.error && report.results.length === expected && report.results.every(row => row.complete === true) &&
      report.execution.complete === true && report.execution.timedOut === false && report.execution.interrupted === false;
    assert.equal(report.collectionComplete, complete); assert.equal(report.execution.code, complete ? 0 : 3);
  });
  return { valid: issues.length === 0, collectionComplete: issues.length === 0 && report.collectionComplete === true,
    performanceEvaluated: false, performancePassed: false, decision: report.decision, issues, source: report.source };
}
