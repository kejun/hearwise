import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, lstat, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../../storage.mjs';
import { sourceSnapshot, sameSourceSnapshot, validBuildSource } from './runner-evidence-contract.mjs';
import { digest, writeJson } from './verification-evidence.mjs';
import { contractDigest } from './quality-contract.mjs';
import { deviceProfile, deviceTexts, deviceChecks } from '../../verification/device/profile.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
export const devicePlanTemplate = () => ({ schemaVersion: 1, operator: '', applicationOrigin: 'http://localhost:3000',
  client: { model: '', chip: '', osVersion: '', browserVersion: '', inputDevice: '', outputDevice: '' },
  services: { asrModel: '', translationModel: '', ttsProvider: '', ttsModel: '', voice: '', settings: '' } });

export function validateDevicePlan(plan) {
  keys(plan, ['schemaVersion', 'operator', 'applicationOrigin', 'client', 'services']);
  assert.equal(plan.schemaVersion, 1); assert.ok(text(plan.operator), 'Record the actual operator');
  const url = new URL(plan.applicationOrigin);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Use an application origin without credentials or query strings');
  for (const [group, names] of Object.entries({ client: ['model', 'chip', 'osVersion', 'browserVersion', 'inputDevice', 'outputDevice'],
    services: ['asrModel', 'translationModel', 'ttsProvider', 'ttsModel', 'voice', 'settings'] })) {
    keys(plan[group], names);
    for (const name of names) assert.ok(text(plan[group][name]), `Record actual ${group}.${name}`);
  }
  return true;
}

// Keep records outside tracked source so they cannot invalidate their own hash.
export function requireEvidenceLocation(location) {
  const relative = path.relative(process.cwd(), path.resolve(location));
  if (relative === '' || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    try { execFileSync('git', ['check-ignore', '-q', '--', relative], { stdio: 'ignore', timeout: 5000 }); }
    catch { throw new Error('Use verification-evidence/ or a directory outside the checkout'); }
  }
}

export function deviceObservationTemplate(context) {
  return { schemaVersion: 1, contextDigest: contractDigest(context), startedAt: null, finishedAt: null,
    operatorAttested: false, applicationVersionConfirmed: false,
    checks: deviceChecks.map(row => ({ id: row.id, observedAt: null, notes: '',
      criteria: Object.fromEntries(Object.keys(row.criteria).map(key => [key, null])) })) };
}

function checklist(context) {
  return `# Hearwise 真机检查（每台设备一次，最多 10 分钟）\n\n` +
    `源码：${context.source.source.sha}。应用版本：${context.applicationVersion}。\n\n` +
    '先完成服务和浏览器设置，再开始计时。记录实际测试设备与服务配置，不填密钥。Intel、Apple Silicon、手机分别建立记录。自动记录的 host 仅指运行 Node 的机器，不代替浏览器客户端。\n\n' +
    '在 observations.json 填开始/结束 ISO 时间和实际观察：true=亲自确认，false=发现失败，null=未测。每项写具体操作、听到的内容或失败现象和 observedAt。确认页面来自该版本后填 applicationVersionConfirmed；实际操作者填 operatorAttested。报告工具不会代操作、代听或认证身份。超过 10 分钟就停止，未完成项留 null；不要连续重试到成功。\n\n' +
    deviceChecks.map(row => `## ${row.title}（约 ${row.seconds} 秒）\n\n${row.steps}\n\n` + Object.values(row.criteria).map(label => `- [ ] ${label}`).join('\n')).join('\n\n') +
    '\n\n## 固定听测文本\n\n' + deviceTexts.map(row => `### ${row.title}\n\n${row.segments.join('\n\n')}`).join('\n\n') +
    '\n\n所有 true 只代表该操作者报告这台设备/这套配置的短测通过，不代表长期稳定性、其他平台、所有音色或正式发布验收通过。未执行的锁屏等项目不会自动排除。\n';
}

export async function prepareDeviceEvidence(plan, root) {
  validateDevicePlan(plan); requireEvidenceLocation(root);
  const source = await sourceSnapshot();
  assert.ok(validBuildSource(source) && !source.source.dirty, 'Use a clean committed checkout and run npm run build');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(path.resolve(root), 'run-'));
  const fixture = path.join(directory, 'seed.sqlite');
  const store = new ListeningStore(fixture), recordings = [];
  try {
    for (const row of deviceTexts) {
      const run = store.createRun(null, { source: 'zh', targetLang: 'Chinese', audioSource: 'microphone' }, row.title);
      for (const [index, original] of row.segments.entries()) {
        const { segment } = store.addSegment(run.listeningId, run.runId, { id: `device-${index}`, text: original });
        store.setTranslation(segment.id, original);
      }
      store.finishRun(run.runId); recordings.push({ title: row.title, listeningId: run.listeningId, runId: run.runId });
    }
  } finally { store.close(); }
  await copyFile(fixture, path.join(directory, 'device.sqlite'));
  const context = { schemaVersion: 1, kind: 'device-check-context', preparedAt: new Date().toISOString(),
    profile: deviceProfile, checklist: deviceChecks, texts: deviceTexts, plan, source, applicationVersion: pkg.version,
    host: { platform: process.platform, processArch: process.arch, osRelease: os.release(), node: process.version,
      sqlite: process.versions.sqlite, cpuModels: [...new Set(os.cpus().map(cpu => cpu.model))] },
    fixture: { file: 'seed.sqlite', sha256: digest(await readFile(fixture)), recordings },
    automaticProviderCalls: false, identityAuthenticated: false };
  assert.ok(sameSourceSnapshot(source, await sourceSnapshot()), 'Source changed during preparation');
  await writeJson(path.join(directory, 'context.json'), context);
  await writeJson(path.join(directory, 'observations.json'), deviceObservationTemplate(context));
  await writeFile(path.join(directory, 'checklist.md'), checklist(context), { flag: 'wx', mode: 0o600 });
  return { directory, database: path.join(directory, 'device.sqlite'), contextDigest: contractDigest(context),
    manualStatus: 'not_run', automaticProviderCalls: false, releaseEligible: false };
}

export function evaluateDeviceObservations(context, observations, currentSource) {
  const issues = [], rows = [];
  const check = (label, work) => { try { work(); } catch (error) { issues.push(`${label}: ${error.message}`); } };
  check('context', () => {
    assert.equal(context.schemaVersion, 1); assert.equal(context.kind, 'device-check-context');
    assert.ok(time(context.preparedAt)); validateDevicePlan(context.plan);
    assert.deepEqual(context.profile, deviceProfile); assert.deepEqual(context.checklist, deviceChecks); assert.deepEqual(context.texts, deviceTexts);
    assert.equal(context.automaticProviderCalls, false); assert.equal(context.identityAuthenticated, false);
    assert.ok(validBuildSource(context.source) && !context.source.source.dirty);
    assert.ok(sameSourceSnapshot(context.source, currentSource), 'Source or build changed; create a fresh run');
  });
  check('observations', () => {
    keys(observations, ['schemaVersion', 'contextDigest', 'startedAt', 'finishedAt', 'operatorAttested', 'applicationVersionConfirmed', 'checks']);
    assert.equal(observations.schemaVersion, 1); assert.equal(observations.contextDigest, contractDigest(context));
    assert.equal(typeof observations.operatorAttested, 'boolean'); assert.equal(typeof observations.applicationVersionConfirmed, 'boolean');
    assert.deepEqual(observations.checks.map(row => row.id), deviceChecks.map(row => row.id));
  });
  const attempted = observations?.checks?.some(row => Object.values(row.criteria || {}).some(value => value !== null));
  let durationMs = null;
  if (attempted || observations?.startedAt !== null || observations?.finishedAt !== null) check('session', () => {
    assert.ok(time(observations.startedAt) && time(observations.finishedAt), 'Record both session times');
    durationMs = Date.parse(observations.finishedAt) - Date.parse(observations.startedAt);
    assert.ok(durationMs > 0 && durationMs <= deviceProfile.maxSessionMs, 'Manual session exceeds 10 minutes or has invalid times');
    assert.ok(Date.parse(observations.startedAt) >= Date.parse(context.preparedAt));
    assert.ok(Date.parse(observations.finishedAt) <= Date.now(), 'Future observations are not evidence');
  });
  for (const definition of deviceChecks) {
    const row = observations?.checks?.find(item => item.id === definition.id);
    const before = issues.length;
    check(definition.id, () => {
      keys(row, ['id', 'observedAt', 'notes', 'criteria']); keys(row.criteria, Object.keys(definition.criteria));
      assert.ok(Object.values(row.criteria).every(value => value === null || typeof value === 'boolean'));
      if (Object.values(row.criteria).some(value => value !== null)) {
        assert.ok(text(row.notes), 'Record concrete observations, not just checkmarks');
        assert.ok(time(row.observedAt) && time(observations.startedAt) && time(observations.finishedAt));
        assert.ok(Date.parse(row.observedAt) >= Date.parse(observations.startedAt) && Date.parse(row.observedAt) <= Date.parse(observations.finishedAt));
      }
    });
    const values = Object.values(row?.criteria || {});
    const observedFailure = Object.keys(definition.criteria).some(key => row?.criteria?.[key] === false);
    rows.push({ id: definition.id, complete: issues.length === before && values.every(value => typeof value === 'boolean'),
      status: observedFailure ? 'failed' : issues.length > before ? 'incomplete' : values.every(value => value === true) ? 'reported_passed' : 'not_run' });
  }
  const complete = issues.length === 0 && rows.every(row => row.complete) &&
    observations.operatorAttested === true && observations.applicationVersionConfirmed === true;
  const reportedPassed = complete && rows.every(row => row.status === 'reported_passed');
  return { schemaVersion: 1, kind: 'device-check-summary', evidenceKind: deviceProfile.evidenceKind,
    contextDigest: contractDigest(context), observationsDigest: contractDigest(observations), source: context.source?.source,
    manualStatus: reportedPassed ? 'reported_passed' : rows.some(row => row.status === 'failed') ? 'failed' : attempted ? 'incomplete' : 'not_run',
    complete, reportedPassed, durationMs, issues, rows, identityAuthenticated: false, automaticProviderCalls: false,
    qualityEvaluated: false, fullProjectAcceptance: false, releaseEligible: false,
    claim: 'Operator-reported short checks for the declared device and settings only; no authenticated physical observation, full support matrix or release acceptance.' };
}

async function validateRetainedDatabase(seedBytes, deviceFile, recordings) {
  // SQLite may need writable WAL/SHM bookkeeping even on a read-only connection.
  // Snapshot the main file and durable journals; SHM is a rebuildable lock/index
  // cache and must not carry another process's locks into validation.
  const readSnapshot = () => Promise.all(['', '-wal', '-journal'].map(async suffix => {
    try {
      assert.ok((await lstat(deviceFile + suffix)).isFile());
      return { suffix, bytes: await readFile(deviceFile + suffix) };
    } catch (error) { if (suffix && error.code === 'ENOENT') return { suffix, bytes: null }; throw error; }
  }));
  const snapshot = await readSnapshot(), confirmed = await readSnapshot();
  assert.deepEqual(snapshot.map(row => row.bytes && digest(row.bytes)), confirmed.map(row => row.bytes && digest(row.bytes)),
    'Database changed during validation snapshot; stop the service before reporting');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-device-validation-'));
  let seed, device;
  try {
    await writeFile(path.join(directory, 'seed.sqlite'), seedBytes, { mode: 0o600 });
    for (const { suffix, bytes } of snapshot) if (bytes !== null)
      await writeFile(path.join(directory, 'device.sqlite' + suffix), bytes, { mode: 0o600 });
    seed = new DatabaseSync(path.join(directory, 'seed.sqlite'), { readOnly: true });
    device = new DatabaseSync(path.join(directory, 'device.sqlite'), { readOnly: true });
    // Never open ListeningStore: reporting must not migrate/recover evidence.
    device.exec('PRAGMA busy_timeout = 3000; BEGIN');
    assert.deepEqual(device.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    assert.deepEqual(device.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(device.prepare('PRAGMA user_version').get(), seed.prepare('PRAGMA user_version').get());
    assert.equal(recordings.length, deviceTexts.length);
    assert.equal(new Set(recordings.map(row => row.listeningId)).size, deviceTexts.length);
    assert.equal(new Set(recordings.map(row => row.runId)).size, deviceTexts.length);
    for (const [index, recording] of recordings.entries()) {
      assert.equal(recording.title, deviceTexts[index].title);
      const identity = db => ({ listening: db.prepare('SELECT id,title FROM listenings WHERE id=?').get(recording.listeningId),
        runs: db.prepare('SELECT id,listening_id,run_no,source_lang,target_lang,state FROM listening_runs WHERE listening_id=? ORDER BY run_no').all(recording.listeningId),
        segments: db.prepare('SELECT id,listening_id,run_id,sequence_no,original_text,translation_text FROM segments WHERE listening_id=? ORDER BY sequence_no').all(recording.listeningId) });
      const expected = identity(seed);
      assert.equal(expected.listening?.title, recording.title); assert.equal(expected.runs.length, 1);
      assert.equal(expected.runs[0].id, recording.runId);
      assert.deepEqual(expected.segments.map(row => row.original_text), deviceTexts[index].segments);
      assert.deepEqual(identity(device), expected, 'Retain seeded recording identities and speech content');
    }
  } finally {
    try { device?.close(); } finally { try { seed?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
  }
}

export async function readDeviceEvidence(directory) {
  const context = JSON.parse(await readFile(path.join(directory, 'context.json'), 'utf8'));
  const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
  const report = evaluateDeviceObservations(context, observations, await sourceSnapshot());
  const invalidate = (label, error) => {
    report.issues.push(`${label}: ${error.message}`); report.complete = false; report.reportedPassed = false;
    if (report.manualStatus !== 'failed') report.manualStatus = 'incomplete';
  };
  const seed = path.join(directory, 'seed.sqlite');
  let seedBytes;
  try {
    assert.equal(context.fixture.file, 'seed.sqlite');
    assert.ok((await lstat(seed)).isFile());
    seedBytes = await readFile(seed);
    assert.equal(digest(seedBytes), context.fixture.sha256, 'Fixed speech fixture changed');
  } catch (error) { seedBytes = null; invalidate('fixture', error); }
  try {
    const device = path.join(directory, 'device.sqlite'); assert.ok((await lstat(device)).isFile());
    if (seedBytes) await validateRetainedDatabase(seedBytes, device, context.fixture.recordings);
  } catch (error) { invalidate('device-database', error); }
  return report;
}
