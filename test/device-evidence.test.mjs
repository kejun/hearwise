import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm, chmod, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ListeningStore } from '../storage.mjs';
import { deviceProfile, deviceChecks, deviceTexts } from '../verification/device/profile.mjs';
import { devicePlanTemplate, validateDevicePlan, deviceObservationTemplate, evaluateDeviceObservations,
  prepareDeviceEvidence, readDeviceEvidence } from '../scripts/lib/device-evidence.mjs';

const plan = () => ({ ...devicePlanTemplate(), operator: 'synthetic test operator', client: {
  model: 'synthetic client', chip: 'synthetic Intel', osVersion: 'test OS', browserVersion: 'test browser',
  inputDevice: 'synthetic microphone', outputDevice: 'synthetic speaker'
}, services: { asrModel: 'test-asr', translationModel: 'test-mt', ttsProvider: 'test-provider', ttsModel: 'test-tts', voice: 'test-voice', settings: 'test only; no live calls' } });

function syntheticEvidence() {
  const now = Date.now(), sha = 'a'.repeat(40);
  const source = { source: { sha, dirty: false }, digests: { 'test-only-source': 'b'.repeat(64) },
    runtimeBuild: { git_sha: sha, build_dirty: false, instrumentation_version: 3 }, lockDigest: 'c'.repeat(64) };
  const context = { schemaVersion: 1, kind: 'device-check-context', preparedAt: new Date(now - 20000).toISOString(),
    profile: deviceProfile, checklist: deviceChecks, texts: deviceTexts, plan: plan(), source,
    automaticProviderCalls: false, identityAuthenticated: false };
  const observations = deviceObservationTemplate(context);
  observations.startedAt = new Date(now - 10000).toISOString(); observations.finishedAt = new Date(now - 1000).toISOString();
  observations.operatorAttested = true; observations.applicationVersionConfirmed = true;
  for (const row of observations.checks) {
    row.observedAt = new Date(now - 5000).toISOString(); row.notes = 'Synthetic reader regression; no physical action performed.';
    for (const name of Object.keys(row.criteria)) row.criteria[name] = true;
  }
  return { context, observations, source };
}

test('manual reports distinguish audible output, failures and missing checks without certifying devices', () => {
  const { context, observations, source } = syntheticEvidence();
  const checked = evaluateDeviceObservations(context, observations, source);
  assert.equal(checked.reportedPassed, true); assert.equal(checked.complete, true);
  assert.equal(checked.manualStatus, 'reported_passed');
  for (const field of ['identityAuthenticated', 'automaticProviderCalls', 'qualityEvaluated', 'fullProjectAcceptance', 'releaseEligible']) assert.equal(checked[field], false);
  observations.checks.find(row => row.id === 'tts-quality').criteria.heardAudio = false;
  const silent = evaluateDeviceObservations(context, observations, source);
  assert.equal(silent.reportedPassed, false); assert.equal(silent.manualStatus, 'failed'); assert.equal(silent.complete, true);
  observations.checks.find(row => row.id === 'lockscreen').criteria.lockedAudioHeard = null;
  const partial = evaluateDeviceObservations(context, observations, source);
  assert.equal(partial.manualStatus, 'failed'); assert.equal(partial.complete, false, 'A known failure does not hide untested scenarios');
  const blank = evaluateDeviceObservations(context, deviceObservationTemplate(context), source);
  assert.equal(blank.manualStatus, 'not_run'); assert.equal(blank.reportedPassed, false);
});

test('missing observations, source/config changes and over-budget sessions cannot become a reported pass', () => {
  const changes = [
    x => { x.observations.checks.pop(); },
    x => { x.observations.checks.push(x.observations.checks[0]); },
    x => { x.observations.checks[0].criteria.refusalVisible = 'true'; },
    x => { delete x.observations.checks[0].criteria.refusalVisible; },
    x => { x.observations.checks[0].criteria.fake = true; },
    x => { x.observations.checks[0].notes = ''; },
    x => { x.observations.checks[0].observedAt = null; },
    x => { x.observations.checks[0].observedAt = x.context.preparedAt; },
    x => { x.observations.operatorAttested = false; },
    x => { x.observations.applicationVersionConfirmed = false; },
    x => { x.observations.finishedAt = x.observations.startedAt; },
    x => { x.observations.finishedAt = new Date(Date.parse(x.observations.startedAt) + 600001).toISOString(); },
    x => { x.observations.finishedAt = new Date(Date.now() + 2000).toISOString(); },
    x => { x.context.plan.client.chip = 'different chip'; },
    x => { x.context.plan.services.voice = 'different voice'; },
    x => { x.source.digests['test-only-source'] = 'd'.repeat(64); },
    x => { x.source.source.dirty = true; },
    x => { x.observations.releaseEligible = true; }
  ];
  for (const change of changes) {
    const value = structuredClone(syntheticEvidence());
    // The submitted context and independently observed current source are separate objects.
    value.source = structuredClone(value.source); change(value);
    assert.equal(evaluateDeviceObservations(value.context, value.observations, value.source).reportedPassed, false, change.toString());
  }
});

test('an explicit failed criterion remains failed when that observation has incomplete metadata', () => {
  for (const change of [row => { row.notes = ''; }, row => { row.observedAt = null; }, row => { row.observedAt = 'invalid'; }]) {
    const { context, observations, source } = syntheticEvidence();
    const row = observations.checks.find(row => row.id === 'tts-quality'); row.criteria.heardAudio = false; change(row);
    const report = evaluateDeviceObservations(context, observations, source);
    assert.equal(report.manualStatus, 'failed'); assert.equal(report.complete, false); assert.equal(report.reportedPassed, false);
    assert.equal(report.rows.find(row => row.id === 'tts-quality').status, 'failed'); assert.ok(report.issues.length > 0);
  }
});

test('a plan needs actual client and service facts; credentials and extra fields are not plan fields', () => {
  assert.throws(() => validateDevicePlan(devicePlanTemplate()));
  assert.equal(validateDevicePlan(plan()), true);
  for (const origin of ['http://user:secret@localhost:3000', 'https://host/?key=secret', 'file:///tmp/app', 'http://host/path']) {
    assert.throws(() => validateDevicePlan({ ...plan(), applicationOrigin: origin }));
  }
  assert.throws(() => validateDevicePlan({ ...plan(), apiKey: 'synthetic-never-used-key' }));
  assert.throws(() => validateDevicePlan({ ...plan(), client: { ...plan().client, chip: '' } }));
});

test('prepare creates isolated real SQLite and blank reports; CLI never overwrites a plan or approves untested hardware', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearwise-device-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await prepareDeviceEvidence(plan(), root);
  assert.equal(run.automaticProviderCalls, false);
  const seed = await readFile(path.join(run.directory, 'seed.sqlite'));
  assert.deepEqual(await readFile(run.database), seed);
  const db = new DatabaseSync(run.database, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM listenings').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM segments').get().n, 4);
    assert.deepEqual(db.prepare('SELECT original_text FROM segments ORDER BY rowid').all().map(row => row.original_text), deviceTexts.flatMap(row => row.segments));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  const blank = await readDeviceEvidence(run.directory);
  assert.deepEqual(blank.issues, []); assert.equal(blank.manualStatus, 'not_run'); assert.equal(blank.releaseEligible, false);
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const cli = args => spawnSync(process.execPath, ['scripts/verify-device.mjs', ...args], { env, encoding: 'utf8', timeout: 15000 });
  const file = path.join(root, 'plan.json');
  assert.equal(cli(['plan', '--out', file]).status, 0);
  const original = await readFile(file);
  assert.equal(cli(['plan', '--out', file]).status, 3);
  assert.deepEqual(await readFile(file), original);
  assert.equal(cli(['prepare', '--plan', file, '--out', root]).status, 3);
  const incomplete = cli(['report', '--run', run.directory]);
  assert.equal(incomplete.status, 3, incomplete.stderr); assert.equal(JSON.parse(incomplete.stdout).reportedPassed, false);
  await writeFile(path.join(run.directory, 'seed.sqlite'), 'corrupted');
  const corrupted = await readDeviceEvidence(run.directory);
  assert.equal(corrupted.reportedPassed, false); assert.ok(corrupted.issues.some(value => value.startsWith('fixture:')));
});

test('a reported pass requires the retained device database and permits legitimate additional recordings', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearwise-device-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await prepareDeviceEvidence(plan(), root);
  const context = JSON.parse(await readFile(path.join(run.directory, 'context.json'), 'utf8'));
  const store = new ListeningStore(run.database);
  try {
    const recording = store.createRun(null, { source: 'zh', targetLang: 'Chinese', audioSource: 'microphone' }, 'Synthetic additional recording');
    const { segment } = store.addSegment(recording.listeningId, recording.runId, { id: 'additional', text: 'Synthetic microphone test' });
    store.setTranslation(segment.id, 'Synthetic microphone test'); store.finishRun(recording.runId);
  } finally { store.close(); }
  const observations = deviceObservationTemplate(context);
  observations.startedAt = context.preparedAt; observations.finishedAt = new Date().toISOString();
  observations.operatorAttested = true; observations.applicationVersionConfirmed = true;
  for (const row of observations.checks) {
    row.observedAt = observations.finishedAt; row.notes = 'Synthetic regression, no hardware observation.';
    for (const key of Object.keys(row.criteria)) row.criteria[key] = true;
  }
  const file = path.join(run.directory, 'observations.json'); await writeFile(file, JSON.stringify(observations));
  assert.equal((await readDeviceEvidence(run.directory)).reportedPassed, true);
  const retained = await readFile(run.database);
  const mutateSql = sql => async () => { const db = new DatabaseSync(run.database); try { db.exec(sql); } finally { db.close(); } };
  for (const mutate of [
    async () => rm(run.database),
    async () => writeFile(run.database, 'corrupted database'),
    async () => { await rm(run.database); const db = new DatabaseSync(run.database); db.close(); },
    mutateSql("UPDATE segments SET original_text='changed fixed speech' WHERE asr_sentence_id='device-0'"),
    mutateSql("UPDATE segments SET translation_text='changed translation' WHERE asr_sentence_id='device-0'"),
    mutateSql(`UPDATE listenings SET title='replaced seed identity' WHERE id='${context.fixture.recordings[0].listeningId}'`),
    mutateSql(`DELETE FROM segments WHERE run_id='${context.fixture.recordings[0].runId}'`),
    async () => {
      const store = new ListeningStore(run.database);
      try {
        const appended = store.createRun(context.fixture.recordings[0].listeningId,
          { source: 'zh', targetLang: 'Chinese', audioSource: 'microphone' });
        store.addSegment(appended.listeningId, appended.runId, { id: 'append', text: 'Unexpected extra playback content' });
        store.finishRun(appended.runId);
      } finally { store.close(); }
    }
  ]) {
    try {
      await mutate(); const report = await readDeviceEvidence(run.directory);
      assert.equal(report.reportedPassed, false, mutate.toString()); assert.equal(report.complete, false);
      assert.equal(report.manualStatus, 'incomplete'); assert.ok(report.issues.some(value => value.startsWith('device-database:')));
    } finally { await writeFile(run.database, retained); }
  }
  const failed = observations.checks.find(row => row.id === 'tts-quality'); failed.criteria.heardAudio = false; failed.notes = '';
  await writeFile(file, JSON.stringify(observations));
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const cli = spawnSync(process.execPath, ['scripts/verify-device.mjs', 'report', '--run', run.directory], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(cli.status, 1, cli.stderr); assert.equal(JSON.parse(cli.stdout).complete, false);
});

test('device validation includes committed WAL content and leaves submitted files unchanged', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearwise-device-wal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await prepareDeviceEvidence(plan(), root), original = await readFile(run.database);
  const store = new ListeningStore(run.database);
  try {
    store.db.exec("UPDATE segments SET original_text='Changed only in committed WAL' WHERE asr_sentence_id='device-0'");
    assert.deepEqual(await readFile(run.database), original, 'The mutation must reside in WAL, not the main file');
    const paths = [run.database, run.database + '-wal', run.database + '-shm'];
    const before = await Promise.all(paths.map(file => readFile(file))); assert.ok(before[1].length > 0);
    const report = await readDeviceEvidence(run.directory);
    assert.ok(report.issues.some(value => value.startsWith('device-database:')));
    assert.deepEqual(await Promise.all(paths.map(file => readFile(file))), before);
  } finally { store.close(); }
});

test('closed WAL evidence can be revalidated from a read-only directory', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('POSIX non-root permission enforcement required; covered by the Ubuntu CI runner'); return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearwise-device-readonly-'));
  const run = await prepareDeviceEvidence(plan(), root);
  t.after(async () => { await chmod(run.directory, 0o700); await rm(root, { recursive: true, force: true }); });
  const names = await readdir(run.directory);
  for (const name of names) await chmod(path.join(run.directory, name), 0o444);
  await chmod(run.directory, 0o555);
  const report = await readDeviceEvidence(run.directory);
  assert.deepEqual(report.issues, []); assert.equal(report.manualStatus, 'not_run');
  assert.deepEqual(await readdir(run.directory), names, 'Readback must not create WAL sidecars in the submitted evidence');
});
