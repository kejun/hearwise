import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalUpgrade, migrationFault, historicalRestore } from '../test-support/upgrade-scenarios.mjs';
import { semanticSchema } from '../test-support/upgrade-fixture.mjs';
import { validateUpgradeCase, assertUpgradeWindow, passedExecution, expectedCases } from '../test-support/upgrade-evidence.mjs';

test('upgrade schema tokenizer preserves word boundaries and quoted identifiers', () => {
  const schema = sql => semanticSchema([{ name: 'example', type: 'table', tbl_name: 'example', sql }]);
  assert.deepEqual(schema('CREATE TABLE t (id INTEGER PRIMARY KEY)'), schema('create  table t(id integer primary key)'));
  assert.notDeepEqual(schema('CREATE TABLE t (id INTEGER PRIMARY KEY)'), schema('CREATE TABLE t (id INTEGERPRIMARYKEY)'));
  assert.notDeepEqual(schema('CREATE TABLE "a b"(id TEXT)'), schema('CREATE TABLE "ab"(id TEXT)'));
  assert.notDeepEqual(schema("CREATE TABLE t(v TEXT DEFAULT 'a b')"), schema("CREATE TABLE t(v TEXT DEFAULT 'ab')"));
});
test('upgrade case evidence rejects schema loss and jointly corrupted post-edit projections', { timeout: 10000 }, async () => {
  const actual = await historicalUpgrade(11); validateUpgradeCase(actual);
  const window = { startedAt: actual.scenarioStartedAt, finishedAt: actual.scenarioFinishedAt }; assertUpgradeWindow(actual, window);
  assert.throws(() => assertUpgradeWindow({ ...actual, scenarioStartedAt: actual.scenarioStartedAt + 365 * 86400000, scenarioFinishedAt: actual.scenarioFinishedAt + 365 * 86400000 }, window));
  for (const mutate of [row => { row.upgraded.schema = []; }, row => { row.editResult.title = 'wrong'; },
    row => { row.reopened.rows.extraction_parts[0].initial_requests = 0; }, row => { row.upgraded.rows.segments.pop(); }, row => { row.queries[0].knowledge = []; }, row => { row.queries[0].graph = {}; }, row => { row.graphs[0].nodes = []; },
    row => { row.edited.rows.segments[0].original_text = row.reopened.rows.segments[0].original_text = 'corrupt'; },
    row => { row.edited.rows.knowledge_revisions = []; row.reopened.rows.knowledge_revisions = []; }]) {
    const copy = structuredClone(actual); mutate(copy); assert.throws(() => validateUpgradeCase(copy));
  }
});
test('upgrade crash evidence binds real SIGKILL and the complete SQLite boundary sequence', { timeout: 10000 }, async () => {
  const actual = await migrationFault({ version: 1, boundary: 'after-commit', fault: null }); validateUpgradeCase(actual);
  for (const mutate of [row => { row.exit.signal = 'SIGTERM'; }, row => { row.marker.writes = 0; }, row => { row.events = []; },
    row => { row.afterFailure.version = 1; }, row => { row.afterFailure.schema = []; }]) { const copy = structuredClone(actual); mutate(copy); assert.throws(() => validateUpgradeCase(copy)); }
});
test('upgrade result rejects interrupted, missing, timed out and nonzero exits', () => {
  const pass = { code: 0, signal: null, timedOut: false, interrupted: false, ok: true }; assert.equal(passedExecution(pass), true);
  for (const change of [{ interrupted: true }, { timedOut: true }, { signal: 'SIGTERM' }, { code: 1 }, { ok: false }]) assert.equal(Boolean(passedExecution({ ...pass, ...change })), false);
  assert.equal(Boolean(passedExecution(null)), false); assert.equal(new Set(expectedCases).size, 45);
});

import { upgradeCheckStatus, assertSerialUpgradeChecks } from '../scripts/lib/upgrade-report.mjs';
test('upgrade gate distinguishes complete failed evidence from missing and interrupted evidence', () => {
  const complete = { execution: { code: 0, signal: null, timedOut: false, interrupted: false, ok: true }, raw: { complete: true } };
  assert.equal(upgradeCheckStatus(complete), 'passed');
  assert.equal(upgradeCheckStatus({ ...complete, execution: { ...complete.execution, code: 1, ok: false } }), 'failed');
  assert.equal(upgradeCheckStatus({ ...complete, reasons: ['business projection mismatch'] }), 'failed');
  assert.equal(upgradeCheckStatus({ ...complete, artifactReasons: ['missing observations'] }), 'incomplete');
  assert.equal(upgradeCheckStatus({ ...complete, raw: { complete: false } }), 'incomplete');
  assert.equal(upgradeCheckStatus({ ...complete, execution: { ...complete.execution, interrupted: true } }), 'incomplete');
  assert.equal(upgradeCheckStatus(complete, ['source changed']), 'incomplete');
});

import { validateInstallSchedule } from '../test-support/upgrade-evidence.mjs';
test('installer schedule rejects reordered stages, shifted clocks and false duration budgets', () => {
  const command = (startedAt, finishedAt) => ({ startedAt, finishedAt, timeoutMs: 100, execution: { durationMs: finishedAt - startedAt } });
  const start = (startedAt, finishedAt) => ({ startedAt, readyAt: startedAt, finishedAt: finishedAt - 1,
    command: ['npm', 'start'], cwd: '/isolated', shutdown: { requestedAt: finishedAt - 1, finishedAt } });
  const raw = { isolation: { checkout: '/isolated' }, commands: [command(10, 11), command(12, 13), command(14, 15), command(16, 17), command(22, 23)],
    starts: [start(18, 19), start(20, 21), start(24, 25)] };
  const window = { startedAt: 0, finishedAt: 30 }; validateInstallSchedule(raw, window);
  for (const mutate of [value => { value.commands[4].startedAt = 16; }, value => { value.commands[0].execution.durationMs = 999; },
    value => { value.starts[1].command = ['echo', 'passed']; }, value => { value.starts[2].shutdown.finishedAt = 9999; },
    value => { value.commands[0].startedAt += 365 * 86400000; value.commands[0].finishedAt += 365 * 86400000; }]) {
    const copy = structuredClone(raw); mutate(copy); assert.throws(() => validateInstallSchedule(copy, window));
  }
});


test('upgrade early-commit and HTTP readback controls reject arbitrary unequal or forged snapshots', { timeout: 15000 }, async () => {
  const broken = await migrationFault({ version: 1, boundary: 'after-write', fault: 'early-commit' }); validateUpgradeCase(broken);
  const invalid = structuredClone(broken); invalid.afterFailure = {}; assert.throws(() => validateUpgradeCase(invalid));
  const restored = await historicalRestore(12); validateUpgradeCase(restored);
  const forged = structuredClone(restored); forged.detail.body.segments[0].original_text = 'FORGED'; assert.throws(() => validateUpgradeCase(forged));
  const dropped = structuredClone(restored); dropped.graph.body.supports = []; assert.throws(() => validateUpgradeCase(dropped));
});

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectAtomicityControls } from '../scripts/lib/import-atomicity-controls.mjs';
test('upgrade control generation failure stays data-local and saves its diagnostic', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-upgrade-controls-failure-')), report = {};
  try {
    await writeFile(path.join(directory, 'observations.json'), '{}');
    await collectAtomicityControls(directory, report, () => { throw new Error('synthetic control generation failure'); });
    assert.equal(report.error, undefined); assert.equal(report.controlsError.message, 'synthetic control generation failure');
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'controls.json'))), { error: report.controlsError });
    const completed = { execution: { code: 0, signal: null, timedOut: false, interrupted: false, ok: true }, raw: { complete: true } };
    assert.equal(upgradeCheckStatus({ ...completed, reasons: [report.controlsError.message] }), 'failed');
    assert.equal(upgradeCheckStatus(completed), 'passed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('upgrade report rejects overlapping data and installer execution windows', () => {
  const checks = [{ name: 'data', startedAt: 10, finishedAt: 20 }, { name: 'install', startedAt: 20, finishedAt: 30 }];
  assertSerialUpgradeChecks(checks);
  assert.throws(() => assertSerialUpgradeChecks([{ ...checks[0] }, { ...checks[1], startedAt: 19 }]));
  assert.throws(() => assertSerialUpgradeChecks(checks.toReversed()));
});
