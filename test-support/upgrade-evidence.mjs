import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { fixtures, hash, assertUpgradeProjection, semanticSchema } from './upgrade-fixture.mjs';
import { faultCases, faultId } from './upgrade-scenarios.mjs';
export { hash };
const provenance = JSON.parse(readFileSync(new URL('../test/fixtures/upgrade/target-provenance.json', import.meta.url)));
export const upgradeVersion = '1.0';
export const restoreVersions = [1, 6, 10, 11, 12];
export const expectedCases = [...fixtures.map(row => `upgrade/v${row.version}`), ...faultCases.map(faultId), ...restoreVersions.map(version => `restore/v${version}`)];
export const installCommands = [
  ['missing-build', ['server.mjs'], 10000, 1], ['ci', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 90000, 0],
  ['version', ['run', 'check:version'], 10000, 0], ['build', ['run', 'build'], 30000, 0],
  ['reinstall', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 90000, 0]
];
export const passedExecution = value => value && value.code === 0 && value.signal === null && value.timedOut === false && value.interrupted === false && value.ok === true;
const expectedRows = fixture => Object.fromEntries(Object.entries(fixture.rows).map(([table, rows]) => [table,
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
function historicalBefore(fixture, value) {
  assert.equal(value.version, fixture.version); assert.equal(value.integrity, 'ok'); assert.deepEqual(value.foreignKeyErrors, []);
  assert.deepEqual(semanticSchema(value.schema), semanticSchema(fixture.schema)); assert.deepEqual(value.rows, expectedRows(fixture));
}
export function validateUpgradeCase(row) {
  assert.equal(row.complete, true); assert.equal(row.ok, true); assert.equal(row.cleanupOk, true);
  assert.ok(Number.isInteger(row.scenarioStartedAt) && row.scenarioFinishedAt >= row.scenarioStartedAt);
  assert.ok(row.startedAt >= row.scenarioStartedAt && row.finishedAt >= row.startedAt && row.finishedAt <= row.scenarioFinishedAt);
  const fixture = fixtures[(row.version || row.config.version) - 1];
  if (row.id.startsWith('upgrade/')) {
    historicalBefore(fixture, row.before); assertUpgradeProjection(fixture, row.upgraded, row);
    assert.deepEqual(row.editRequest, { id: fixture.identities.complete.listening, title: 'Upgrade remains editable', notes: 'Synthetic post-upgrade note' });
    const expected = structuredClone(row.upgraded), listening = expected.rows.listenings.find(value => value.id === row.editRequest.id);
    Object.assign(listening, { title: row.editRequest.title, notes: row.editRequest.notes });
    assert.deepEqual(row.editResult, listening); assert.deepEqual(row.edited, expected); assert.deepEqual(row.reopened, expected);
    assert.deepEqual(row.queries.map(query => query.listening.id).sort(), fixture.rows.listenings.map(value => value.id).sort());
    for (const query of row.queries) {
      assert.deepEqual(query.segments, row.upgraded.rows.segments.filter(segment => segment.listening_id === query.listening.id).sort((a, b) => a.sequence_no - b.sequence_no));
      assert.deepEqual(query.listening, row.upgraded.rows.listenings.find(value => value.id === query.listening.id));
    }
  } else if (row.id.startsWith('restore/')) {
    historicalBefore(fixture, row.before); assert.deepEqual(row.backupAfter, row.before);
    assert.match(row.backupSha256, /^[a-f0-9]{64}$/); assert.equal(row.backupAfterSha256, row.backupSha256);
    assertUpgradeProjection(fixture, row.prepared, { ...row, imported: true }); assert.deepEqual(row.restored, row.prepared);
    assert.equal(row.review.mode, 'replace'); assert.ok(row.review.token && row.review.previewToken); assert.equal(row.commit.status, 200);
    assert.equal(row.detail.status, 200); assert.ok(row.detail.body.segments.some(segment => segment.id === fixture.identities.complete.segment));
    assert.equal(row.usable.get.status, 200); assert.equal(row.usable.patch.status, 200);
    const { version: ignored, ...restored } = row.restored; assert.deepEqual(row.usable.before, restored);
    const expected = structuredClone(restored), listening = expected.rows.listenings.find(value => value.id === row.usable.request.id); assert.ok(listening);
    assert.equal(row.usable.request.title, 'Recovered editable history'); assert.equal(row.usable.request.notes, 'Synthetic restore verified.');
    Object.assign(listening, { title: row.usable.request.title, notes: row.usable.request.notes });
    assert.deepEqual(row.usable.after, expected); assert.deepEqual(row.usable.patch.body, { listening });
    assert.deepEqual(row.providerCalls, []); assert.deepEqual(row.usable.providerCalls, []);
  } else {
    const config = faultCases.find(config => faultId(config) === row.id); assert.deepEqual(row.config, config);
    historicalBefore(fixture, row.backup); assert.ok(row.exit.pid > 0); assertUpgradeProjection(fixture, row.recovered, row);
    assert.ok(row.childStartedAt >= row.scenarioStartedAt && row.exitedAt >= row.childStartedAt && row.startedAt >= row.exitedAt && row.finishedAt >= row.startedAt && row.scenarioFinishedAt >= row.finishedAt);
    assert.deepEqual(row.recoveryWindow, { startedAt: row.startedAt, finishedAt: row.finishedAt });
    let previousAt = row.childStartedAt;
    for (const event of row.events) { assert.equal(event.pid, row.exit.pid); assert.ok(event.at >= previousAt && event.at <= row.exitedAt); previousAt = event.at; }
    if (config.boundary) {
      assert.ok(row.observedMarkerAt >= row.marker.at && row.killRequestedAt >= row.observedMarkerAt && row.exitedAt >= row.killRequestedAt);
      assert.equal(row.exit.code, null); assert.equal(row.exit.signal, 'SIGKILL');
      assert.equal(row.marker.pid, row.exit.pid); assert.equal(row.marker.name, config.boundary); assert.equal(row.marker.transaction, 1);
      const writes = config.boundary === 'after-write' ? provenance.firstStageWrites[config.version].slice(0, 1) : provenance.firstStageWrites[config.version];
      assert.equal(row.marker.writes, writes.length);
      const observedWrites = row.events.filter(event => event.name === 'after-write');
      assert.deepEqual(observedWrites.map(event => hash(event.sql)), writes);
      observedWrites.forEach((event, index) => { assert.equal(event.writes, index + 1); assert.equal(event.pid, row.exit.pid); assert.equal(event.transaction, 1); });
      assert.equal(row.marker.sql.trim(), config.boundary.includes('commit') ? 'COMMIT' : row.events.find(event => event.name === 'after-write').sql.trim());
      const matching = row.events.filter(event => event.event === 'boundary' && event.name === config.boundary);
      assert.equal(matching.length, 1); assert.deepEqual(matching[0], { ...row.marker, event: 'boundary' });
      assert.deepEqual(row.events.filter(event => event.event === 'boundary').map(event => event.name),
        [...writes.map(() => 'after-write'), ...(config.boundary === 'after-write' ? [] : config.boundary === 'before-commit' ? ['before-commit'] : ['before-commit', 'after-commit'])]);
    } else {
      assert.equal(row.exit.code, 1); assert.equal(row.exit.signal, null);
      assert.ok(row.events.some(event => event.event === 'sqlite-error' && (event.errcode & 255) === (config.fault === 'readonly' ? 8 : 19)));
      assert.ok(row.events.some(event => event.event === 'rollback'));
    }
    if (config.fault === 'early-commit') { assert.ok(!isDeepStrictEqual(row.afterFailure, row.before)); assert.equal(row.negativeDetected, true); assert.ok(row.events.some(event => event.event === 'mutant-early-commit')); }
    else if (config.boundary === 'after-commit') {
      const targetVersion = config.version < 5 ? config.version + 1 : config.version < 9 ? 9 : config.version + 1;
      assertUpgradeProjection(fixture, row.afterFailure, { stageOnly: true, targetVersion });
    } else assert.deepEqual(row.afterFailure, row.before);
    if (config.fault === 'constraint') {
      validateUpgradeCase(row.httpRecovery); assert.deepEqual(row.httpRecovery.before, row.backup); assert.equal(row.httpRecovery.backupSha256, row.backupSha256);
    } else historicalBefore(fixture, row.before);
  }
}
export function validateUpgradeObservations(raw, window = null) {
  assert.deepEqual(raw.cases.map(row => row.id), expectedCases); assert.equal(raw.complete, true); assert.equal(raw.ok, true);
  for (const row of raw.cases) {
    validateUpgradeCase(row);
    if (window) assertUpgradeWindow(row, window);
    if (row.httpRecovery) { assert.ok(row.httpRecovery.scenarioStartedAt >= row.scenarioStartedAt && row.httpRecovery.scenarioFinishedAt <= row.scenarioFinishedAt); }
  }
}
export function validateInstall(raw, source, environment = { platform: process.platform, arch: process.arch, node: process.version, sqlite: process.versions.sqlite }, window = null) {
  assert.deepEqual(raw.source, { sha: source.sha, dirty: source.dirty });
  assert.equal(raw.complete, true); assert.equal(raw.ok, true); assert.equal(raw.cleanupOk, true); assert.deepEqual(raw.cleanup, ['server', 'provider', 'cwd', 'directory'].map(name => ({ name, ok: true }))); assert.equal(raw.error, undefined);
  assert.match(raw.environment.npm, /^\d+\.\d+\.\d+/);
  for (const key of ['platform', 'arch', 'node', 'sqlite']) assert.equal(raw.environment[key], environment[key]);
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  const footer = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1];
  assert.equal(lock.version, packageJson.version); assert.equal(lock.packages[''].version, packageJson.version); assert.deepEqual([...footer.matchAll(/HearWise v([^<\s]+)/g)].map(match => match[1]), [packageJson.version]);
  assert.ok(raw.environment.platform && raw.environment.arch && raw.environment.sqlite); assert.match(raw.environment.node, /^v(?:2[4-9]|[3-9]\d)\./);
  assert.equal(raw.isolation.initialNodeModulesAbsent, true); assert.equal(raw.isolation.initialBuildAbsent, true);
  assert.ok(!raw.isolation.externalDatabase.startsWith(`${raw.isolation.checkout}/`));
  assert.deepEqual(raw.commands.map(row => row.name), installCommands.map(row => row[0]));
  for (let i = 0; i < installCommands.length; i++) {
    const row = raw.commands[i], [name, args, timeout, code] = installCommands[i];
    assert.ok(Number.isInteger(row.startedAt) && row.finishedAt >= row.startedAt);
    if (window) assert.ok(row.startedAt >= window.startedAt && row.finishedAt <= window.finishedAt);
    assert.equal(row.executable, name === 'missing-build' ? process.execPath : 'npm');
    assert.deepEqual(row.args, args); assert.equal(row.timeoutMs, timeout); assert.equal(row.log, `install-${name}.log`);
    assert.equal(row.execution.code, code); assert.equal(row.execution.signal, null); assert.equal(row.execution.timedOut, false); assert.equal(row.execution.interrupted, false);
    if (name !== 'missing-build') assert.equal(row.execution.ok, true);
  }
  assert.match(raw.commands[0].execution.tail, /ERR_MODULE_NOT_FOUND/); assert.match(raw.commands[0].execution.tail, /dist\/server\/index.js/);
  validateInstallSchedule(raw, window);
  assert.deepEqual(raw.starts.map(row => row.label), ['clean', 'upgrade', 'reinstall']);
  for (const row of raw.starts) {
    if (window) assert.ok(row.startedAt >= window.startedAt && row.shutdown.finishedAt <= window.finishedAt);
    assert.equal(row.diagnostics.build.git_sha, source.sha); assert.equal(row.diagnostics.build.build_dirty, source.dirty);
    assert.ok(Number.isInteger(row.pid) && row.pid > 0); assert.equal(row.shutdown.pid, row.pid); assert.equal(row.shutdown.requestedSignal, 'SIGTERM');
    assert.equal(row.shutdown.signal, 'SIGTERM'); assert.equal(row.shutdown.code, null); assert.ok(row.shutdown.requestedAt >= row.finishedAt && row.shutdown.finishedAt >= row.shutdown.requestedAt); assert.ok(row.logs.includes('prestart') && row.logs.includes('scripts/build.mjs'));
    assert.deepEqual(row.missingKey, { status: 400, body: { error: '请先填写 API Key' } }); assert.equal(row.version, packageJson.version); assert.deepEqual([...row.servedFooter.matchAll(/HearWise v([^<\s]+)/g)].map(match => match[1]), [packageJson.version]);
  }
  assert.equal(new Set(raw.starts.map(row => row.pid)).size, 3); assert.equal(new Set(raw.starts.map(row => row.version)).size, 1);
  assert.equal(raw.starts[0].history.total, 0); assert.equal(raw.starts[2].history.total, fixtures[10].rows.listenings.length);
  historicalBefore(fixtures[10], raw.before); assertUpgradeProjection(fixtures[10], raw.afterUpgrade, { ...raw.starts[1], server: true });
  assert.deepEqual(raw.afterReinstall, raw.afterUpgrade); assert.deepEqual(raw.providerCalls, []);
}
export function upgradeControls(raw) {
  const changes = {
    missing_case: value => value.cases.pop(),
    missing_schema: value => { value.cases[0].upgraded.schema = []; },
    lost_source: value => { value.cases[0].upgraded.rows.segments[0].original_text = 'lost'; },
    lost_paid_attempt: value => { value.cases[3].upgraded.rows.extraction_parts[0].initial_requests = 0; },
    lost_boundary: value => { value.cases.find(row => row.config?.boundary === 'after-commit').events = []; },
    false_version: value => { value.cases.find(row => row.id.startsWith('restore/')).restored.version = 11; },
    failed_backup_changed: value => { value.cases.find(row => row.config?.fault === 'constraint').httpRecovery.backupSha256 = '0'.repeat(64); }
  };
  return Object.entries(changes).map(([name, change]) => { const copy = structuredClone(raw); change(copy); let rejected = false;
    try { validateUpgradeObservations(copy); } catch { rejected = true; } return { name, rejected }; });
}

export function assertUpgradeWindow(row, window) {
  assert.ok(row.scenarioStartedAt >= window.startedAt && row.scenarioFinishedAt <= window.finishedAt, 'scenario is inside its actual data command');
}

export function validateInstallSchedule(raw, window) {
  for (const row of raw.commands) {
    assert.ok(Number.isInteger(row.execution.durationMs) && row.execution.durationMs >= 0 && row.execution.durationMs <= row.timeoutMs);
    assert.ok(row.finishedAt - row.startedAt >= row.execution.durationMs && row.finishedAt - row.startedAt <= row.timeoutMs);
  }
  for (const row of raw.starts) {
    assert.deepEqual(row.command, ['npm', 'start']); assert.equal(row.cwd, raw.isolation.checkout);
    assert.ok(row.readyAt >= row.startedAt && row.readyAt - row.startedAt <= 15000 && row.finishedAt >= row.readyAt);
    assert.ok(row.shutdown.finishedAt - row.shutdown.requestedAt <= 3000);
  }
  const stages = [...raw.commands.slice(0, 4), ...raw.starts.slice(0, 2).map(row => ({ startedAt: row.startedAt, finishedAt: row.shutdown.finishedAt })),
    raw.commands[4], { startedAt: raw.starts[2].startedAt, finishedAt: raw.starts[2].shutdown.finishedAt }];
  let previous = window?.startedAt ?? -Infinity;
  for (const row of stages) { assert.ok(row.startedAt >= previous && row.finishedAt >= row.startedAt); previous = row.finishedAt; }
  if (window) assert.ok(previous <= window.finishedAt);
}
