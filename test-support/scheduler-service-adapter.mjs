import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deadline } from './lifecycle.mjs';

export async function createTranslationServiceAdapter(config = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hearwise-scheduler-service-'));
  config.resourceAudit?.push({ type: 'directory', path: directory });
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', LISTENING_DB: path.join(directory, 'fixture.sqlite') };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(fileURLToPath(new URL('./scheduler-service-worker.mjs', import.meta.url)), [], {
    env, execArgv: [], detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  config.resourceAudit?.push({ type: 'child', pid: child.pid });
  let sequence = 0, logs = '', closed = false;
  const pending = new Map();
  child.stdout.on('data', data => { logs = (logs + data).slice(-100000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-100000); });
  child.on('message', message => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${message.error}\n${logs}`)); else entry.resolve(message.state);
  });
  child.on('error', error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); });
  child.once('exit', (code, signal) => {
    for (const entry of pending.values()) entry.reject(new Error(`Scheduler worker exited ${code}/${signal}\n${logs}`));
    pending.clear();
  });
  const kill = () => {
    if (child.pid && child.exitCode == null && child.signalCode == null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  process.on('SIGINT', kill); process.on('SIGTERM', kill); process.on('exit', kill);
  async function command(action) {
    const id = ++sequence;
    try {
      return await deadline(() => new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject }); child.send({ id, ...action });
      }), 6000, `Scheduler ${action.action}`);
    } finally { pending.delete(id); }
  }
  async function close() {
    if (closed) return;
    closed = true;
    const failures = [], exit = new Promise(resolve => child.once('exit', resolve));
    try {
      if (child.pid && child.exitCode == null && child.signalCode == null) {
        try { await command({ action: 'close' }); await deadline(() => exit, 3000, 'Scheduler worker shutdown'); }
        catch (error) { failures.push(error); }
      }
      try { kill(); } catch (error) { failures.push(error); }
      if (child.pid && child.exitCode == null && child.signalCode == null) {
        try { await deadline(() => exit, 1500, 'Scheduler worker kill'); } catch (error) { failures.push(error); }
      }
    } finally {
      process.removeListener('SIGINT', kill); process.removeListener('SIGTERM', kill); process.removeListener('exit', kill);
      rmSync(directory, { recursive: true, force: true });
    }
    if (failures.length) throw new AggregateError(failures, 'Scheduler worker cleanup failed');
  }
  try { await command({ action: 'initialize', config }); }
  catch (error) { await close().catch(() => {}); throw error; }
  return { processId: child.pid, act: command, observe: () => command({ action: 'observe' }), close, logs: () => logs };
}
