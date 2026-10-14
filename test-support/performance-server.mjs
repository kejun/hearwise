import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { deadline, stopChild, closeServer } from './lifecycle.mjs';
import { fileSha256 } from '../scripts/lib/performance-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function listen(server) {
  await deadline(() => new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  }), 3000, 'performance HTTP listener');
  return `http://127.0.0.1:${server.address().port}`;
}

export async function startPerformanceServer({ file, sha256, startupMs = 10000, serverFile = 'server.mjs', temporaryRoot = os.tmpdir() }) {
  assert.equal(await fileSha256(file), sha256, 'Frozen input database hash differs');
  const directory = await mkdtemp(path.join(temporaryRoot, 'hearwise-performance-server-'));
  const database = path.join(directory, 'listenings.sqlite'), providerRequests = [];
  let child, logs = '', closing;
  const provider = http.createServer((req, res) => {
    providerRequests.push({ method: req.method, url: req.url, at: Date.now() });
    req.resume(); res.writeHead(503); res.end('No paid provider is permitted in the performance fixture');
  });
  provider.on('upgrade', (req, socket) => { providerRequests.push({ method: req.method, url: req.url, kind: 'websocket-upgrade', at: Date.now() }); socket.destroy(); });
  const close = () => closing ||= (async () => {
    const results = await Promise.allSettled([child ? stopChild(child) : Promise.resolve(), closeServer(provider, 'performance provider')]);
    await rm(directory, { recursive: true, force: true });
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Performance fixture cleanup failed');
  })();
  try {
    await copyFile(file, database);
    assert.equal(await fileSha256(database), sha256);
    const endpoint = await listen(provider);
    const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { TZ: 'UTC', HOST: '127.0.0.1', PORT: '0', LISTENING_DB: database,
      MT_ENDPOINT: endpoint, ASR_ENDPOINT: endpoint.replace('http:', 'ws:') });
    child = spawn(process.execPath, ['--import', path.join(root, 'test-support/performance-server-metrics.mjs'), path.resolve(root, serverFile)],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '';
    const record = chunk => { logs = (logs + chunk).slice(-200000); };
    child.stdout.on('data', record); child.stderr.on('data', record);
    let onData, onExit, onError;
    const base = await deadline(() => new Promise((resolve, reject) => {
      onData = chunk => { stdout = (stdout + chunk).slice(-200000); const url = stdout.match(/(http:\/\/127\.0\.0\.1:\d+)\r?\n/)?.[1]; if (url) resolve(url); };
      onExit = (code, signal) => reject(new Error(`Performance server exited before ready (${code}/${signal}): ${logs}`));
      onError = reject;
      child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', onError);
    }), startupMs, 'performance server startup').finally(() => {
      child.stdout.removeListener('data', onData); child.removeListener('exit', onExit); child.removeListener('error', onError);
    });
    const observe = async () => {
      const id = randomUUID(); let handler, exited;
      return deadline(() => new Promise((resolve, reject) => {
        handler = message => { if (message?.type === 'performance-observed' && message.id === id) resolve(message); };
        exited = () => reject(new Error('Performance server exited during observation'));
        child.on('message', handler); child.once('exit', exited);
        child.send({ type: 'performance-observe', id }, error => { if (error) reject(error); });
      }), 5000, 'server resource observation').finally(() => { child.removeListener('message', handler); child.removeListener('exit', exited); });
    };
    return { base, pid: child.pid, directory, database, providerRequests, observe, close, logs: () => logs,
      input: { file, sha256 }, instrumentation: { kind: 'read-only-process-IPC-preload', source: 'test-support/performance-server-metrics.mjs' } };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message); }
    throw error;
  }
}

export async function measureBackendRequest(server, route, { controlledDelayMs = 0, timeoutMs = 15000 } = {}) {
  assert.ok(route.startsWith('/api/listenings') && !route.includes('://'), 'Only actual history/graph read routes are measured');
  assert.ok(Number.isInteger(controlledDelayMs) && controlledDelayMs >= 0 && controlledDelayMs <= 1000);
  let proxy, target = server.base, observedMs = 0, forwardedRequests = 0;
  try {
    if (controlledDelayMs) {
      proxy = http.createServer(async (req, res) => {
        try {
          assert.equal(req.url, route); assert.equal(req.method, 'GET'); forwardedRequests++;
          const response = await fetch(`${server.base}${route}`, { signal: AbortSignal.timeout(timeoutMs) });
          const body = Buffer.from(await response.arrayBuffer()), started = performance.now();
          // Node timers can wake slightly early. Observe the fixed monotonic
          // deadline rather than calling a 119.8ms wait a 120ms injected cost.
          while (performance.now() < started + controlledDelayMs) await delay(Math.max(1, started + controlledDelayMs - performance.now()));
          observedMs = performance.now() - started;
          res.writeHead(response.status, { 'Content-Type': 'application/json', 'Content-Length': body.length }); res.end(body);
        } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
      });
      target = await listen(proxy);
    }
    const before = await server.observe(), startedAt = new Date().toISOString(), started = performance.now();
    const response = await fetch(`${target}${route}`, { signal: AbortSignal.timeout(timeoutMs) });
    const bytes = Buffer.from(await response.arrayBuffer()), finished = performance.now(), body = JSON.parse(bytes.toString('utf8'));
    const after = await server.observe();
    assert.equal(before.pid, after.pid); assert.ok(after.monotonicMs >= before.monotonicMs);
    return { route, startedAt, finishedAt: new Date().toISOString(), before, after,
      timing: { startedMonotonicMs: started, bodyReceivedMonotonicMs: finished, timeOrigin: performance.timeOrigin },
      response: { status: response.status, bytes: bytes.length, sha256: hash(bytes), body },
      metrics: { wallMs: finished - started, serverCpuMs: (after.cpuUsage.user - before.cpuUsage.user + after.cpuUsage.system - before.cpuUsage.system) / 1000,
        serverRssAfterBytes: after.memoryUsage.rss, serverHeapUsedAfterBytes: after.memoryUsage.heapUsed,
        serverLifetimeMaxRssAfterKiB: after.resourceUsage.maxRSS },
      controlledCost: controlledDelayMs ? { kind: 'loopback-forwarding-response-delay', requestedMs: controlledDelayMs, observedMs, forwardedRequests } : null };
  } finally { if (proxy) await closeServer(proxy, 'controlled transport delay'); }
}
