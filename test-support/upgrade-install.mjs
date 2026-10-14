// Dedicated installer profile. Ordinary npm test never performs nested installs.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, cp, realpath, readFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../scripts/lib/process.mjs';
import { deadline, closeServer } from './lifecycle.mjs';
import { writeJson, sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { fixtures, materializeHistorical, upgradeSnapshot, assertUpgradeProjection } from './upgrade-fixture.mjs';
const output = path.resolve(process.argv[2]), source = process.cwd(), context = sourceVersion();
const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-clean-install-')), checkout = path.join(directory, 'checkout');
const report = { source: context, commands: [], starts: [], providerCalls: [], complete: false, ok: false, cleanupOk: false,
  environment: { platform: process.platform, arch: process.arch, node: process.version, sqlite: process.versions.sqlite, release: os.release() } };
// Explicit environment allowlist: no API key/token or personal config inherited.
const env = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'npm_config_cache', 'npm_config_registry', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_http_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
env.HOME = path.join(directory, 'home'); env.npm_config_userconfig = path.join(directory, 'empty.npmrc');
env.LISTENING_DB = path.join(directory, 'external-data', 'listenings.sqlite');
env.ASR_ENDPOINT = 'ws://127.0.0.1:1'; env.MT_ENDPOINT = 'http://127.0.0.1:1'; env.TTS_ENDPOINT = 'ws://127.0.0.1:1'; env.FISH_TTS_ENDPOINT = 'http://127.0.0.1:1';
let server, provider, interrupted = false;
const interrupt = () => {
  interrupted = true;
  // npm start has its own process group. An outer watchdog must not strand it.
  if (server) { try { process.kill(-server.child.pid, 'SIGKILL'); } catch {} }
};
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const requireActive = () => { if (interrupted) throw new Error('Install verification interrupted'); };
const inheritedCache = process.env.UPGRADE_NPM_CACHE || process.env.npm_config_cache;
env.npm_config_cache = inheritedCache ? path.resolve(inheritedCache) : path.join(directory, 'npm-cache');
report.installCache = { reused: Boolean(inheritedCache), path: inheritedCache ? env.npm_config_cache : null };
async function stop() {
  if (!server) return;
  const current = server; server = null;
  const exited = current.exit;
  try { process.kill(-current.child.pid, 'SIGTERM'); } catch {}
  const requestedAt = Date.now();
  try { current.result = await deadline(() => exited, 3000, 'npm start group shutdown'); }
  finally { try { process.kill(-current.child.pid, 'SIGKILL'); } catch {} }
  return { pid: current.child.pid, requestedAt, finishedAt: Date.now(), requestedSignal: 'SIGTERM', ...current.result, logs: current.logs() };
}
async function launch() {
  requireActive();
  const child = spawn('npm', ['start'], { cwd: checkout, env: { ...env, HOST: '127.0.0.1', PORT: '0' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', stdout = '';
  const exit = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  server = { child, exit, logs: () => logs };
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', value => { logs += value; stdout += value; const url = stdout.match(/(http:\/\/127\.0\.0\.1:\d+)\r?\n/)?.[1]; if (url) resolve(url); });
    child.stderr.on('data', value => { logs += value; });
    child.once('error', reject); child.once('exit', (code, signal) => reject(new Error(`npm start exited ${code}/${signal}: ${logs}`)));
  });
  server.base = await deadline(() => ready, 15000, 'npm start/prestart');
}
async function command(name, executable, args, timeoutMs, expectedCode = 0) {
  requireActive();
  const log = path.join(path.dirname(output), `install-${name}.log`);
  const startedAt = Date.now();
  const execution = await runProcess(executable, args, { cwd: checkout, env, timeoutMs, graceMs: 500, logFile: log });
  report.commands.push({ name, startedAt, finishedAt: Date.now(), executable, args, timeoutMs, execution, log: path.basename(log) }); await writeJson(output, report);
  assert.equal(execution.code, expectedCode, execution.tail); assert.equal(execution.signal, null); assert.equal(execution.timedOut, false); assert.equal(execution.interrupted, false);
  return execution;
}
async function start(label) {
  const startedAt = Date.now(); await launch(); const readyAt = Date.now();
  const html = await (await fetch(server.base, { signal: AbortSignal.timeout(5000) })).text();
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.deepEqual([...html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)[1].matchAll(/HearWise v([^<\s]+)/g)].map(match => match[1]), [packageJson.version]);
  const response = await fetch(`${server.base}/api/test-connection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
  const missingKey = { status: response.status, body: await response.json() }; assert.deepEqual(missingKey, { status: 400, body: { error: '请先填写 API Key' } });
  const history = await (await fetch(`${server.base}/api/listenings`, { signal: AbortSignal.timeout(5000) })).json();
  const runtimeModule = await import(`${pathToFileURL(path.join(checkout, 'dist/server/index.js'))}?${label}`);
  const runtime = runtimeModule.createTaskRuntime(); const diagnostics = runtime.diagnostics(); await runtime.dispose();
  assert.equal(diagnostics.build.git_sha, context.sha); assert.equal(diagnostics.build.build_dirty, context.dirty);
  report.starts.push({ label, startedAt, readyAt, command: ['npm', 'start'], cwd: checkout, finishedAt: Date.now(), pid: server.child.pid, version: packageJson.version, servedFooter: html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1], missingKey, history, diagnostics, logs: server.logs() });
  report.starts.at(-1).shutdown = await stop();
}
try {
  await mkdir(env.HOME, { recursive: true });
  // Clone source only: no dist, user DB, node_modules or local environment copied.
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', source, checkout], { timeout: 15000 });
  execFileSync('git', ['checkout', '--quiet', '--detach', context.sha], { cwd: checkout, timeout: 15000 });
  if (context.dirty) {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: source, encoding: 'utf8' }).trim().split('\n');
    for (const file of files) { const target = path.join(checkout, file); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(source, file), target); }
  }
  report.isolation = { checkout, externalDatabase: env.LISTENING_DB, initialNodeModulesAbsent: false, initialBuildAbsent: false };
  await assert.rejects(access(path.join(checkout, 'node_modules'))); report.isolation.initialNodeModulesAbsent = true;
  await assert.rejects(access(path.join(checkout, 'dist'))); report.isolation.initialBuildAbsent = true;
  process.chdir(checkout);
  report.environment.npm = execFileSync('npm', ['--version'], { cwd: checkout, env, encoding: 'utf8', timeout: 10000 }).trim();
  provider = http.createServer((request, response) => { report.providerCalls.push({ path: request.url, transport: 'http' }); response.writeHead(503); response.end(); });
  provider.on('upgrade', (request, socket) => { report.providerCalls.push({ path: request.url, transport: 'websocket' }); socket.destroy(); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const endpoint = `127.0.0.1:${provider.address().port}`;
  Object.assign(env, { ASR_ENDPOINT: `ws://${endpoint}`, MT_ENDPOINT: `http://${endpoint}`, TTS_ENDPOINT: `ws://${endpoint}`, FISH_TTS_ENDPOINT: `http://${endpoint}` });
  const missingBuild = await command('missing-build', process.execPath, ['server.mjs'], 10000, 1);
  assert.match(missingBuild.tail, /ERR_MODULE_NOT_FOUND/); assert.match(missingBuild.tail, /dist\/server\/index.js/);
  await command('ci', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 90000);
  assert.equal(await realpath(path.join(checkout, 'node_modules')), path.join(checkout, 'node_modules'));
  await command('version', 'npm', ['run', 'check:version'], 10000);
  await command('build', 'npm', ['run', 'build'], 30000);
  await start('clean'); assert.equal(report.starts[0].history.total, 0);
  await rm(env.LISTENING_DB, { force: true }); await rm(`${env.LISTENING_DB}-wal`, { force: true }); await rm(`${env.LISTENING_DB}-shm`, { force: true });
  report.before = materializeHistorical(fixtures[10], env.LISTENING_DB);
  await start('upgrade'); report.afterUpgrade = upgradeSnapshot(env.LISTENING_DB);
  assertUpgradeProjection(fixtures[10], report.afterUpgrade, { ...report.starts.at(-1), server: true });
  await rm(path.join(checkout, 'node_modules'), { recursive: true, force: true }); await rm(path.join(checkout, 'dist'), { recursive: true, force: true });
  await command('reinstall', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 90000);
  // npm start must rebuild the removed dist itself through prestart.
  await start('reinstall'); report.afterReinstall = upgradeSnapshot(env.LISTENING_DB);
  assert.deepEqual(report.afterReinstall, report.afterUpgrade); assert.equal(report.starts.at(-1).history.total, fixtures[10].rows.listenings.length);
  requireActive(); assert.deepEqual(report.providerCalls, []); report.complete = report.ok = true;
} catch (error) { report.complete = !interrupted && error.code === 'ERR_ASSERTION'; report.interrupted = interrupted; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  const cleanup = [];
  for (const [name, action] of [['server', () => stop()], ['provider', () => provider && closeServer(provider, 'install provider')],
    ['cwd', () => process.chdir(source)], ['directory', () => rm(directory, { recursive: true, force: true })]]) {
    try { await action(); cleanup.push({ name, ok: true }); }
    catch (error) { cleanup.push({ name, ok: false, error: error.message }); }
  }
  report.cleanup = cleanup; report.cleanupOk = cleanup.every(row => row.ok);
  if (!report.cleanupOk) { report.ok = false; process.exitCode = 1; }
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  await writeJson(output, report);
}
console.log(JSON.stringify({ complete: report.complete, ok: report.ok, error: report.error, cleanupOk: report.cleanupOk }));
