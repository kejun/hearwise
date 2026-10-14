import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalUpgrade, migrationFault } from '../test-support/upgrade-scenarios.mjs';
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
    row => { row.reopened.rows.extraction_parts[0].initial_requests = 0; }, row => { row.upgraded.rows.segments.pop(); },
    row => { row.edited.rows.segments[0].original_text = row.reopened.rows.segments[0].original_text = 'corrupt'; },
    row => { row.edited.rows.knowledge_revisions = []; row.reopened.rows.knowledge_revisions = []; }]) {
    const copy = structuredClone(actual); mutate(copy); assert.throws(() => validateUpgradeCase(copy));
  }
});
test('upgrade crash evidence binds real SIGKILL and the complete SQLite boundary sequence', { timeout: 10000 }, async () => {
  const actual = await migrationFault({ version: 1, boundary: 'after-commit', fault: null }); validateUpgradeCase(actual);
  for (const mutate of [row => { row.exit.signal = 'SIGTERM'; }, row => { row.marker.writes = 0; }, row => { row.events = []; },
    row => { row.afterFailure.version = 1; }]) { const copy = structuredClone(actual); mutate(copy); assert.throws(() => validateUpgradeCase(copy)); }
});
test('upgrade result rejects interrupted, missing, timed out and nonzero exits', () => {
  const pass = { code: 0, signal: null, timedOut: false, interrupted: false, ok: true }; assert.equal(passedExecution(pass), true);
  for (const change of [{ interrupted: true }, { timedOut: true }, { signal: 'SIGTERM' }, { code: 1 }, { ok: false }]) assert.equal(Boolean(passedExecution({ ...pass, ...change })), false);
  assert.equal(Boolean(passedExecution(null)), false); assert.equal(new Set(expectedCases).size, 45);
});

import { upgradeCheckStatus } from '../scripts/lib/upgrade-report.mjs';
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
