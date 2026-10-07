import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

// One process group per check: grandchildren cannot keep a timed-out run alive.
export function runProcess(command, args, { cwd, env = process.env, timeoutMs = 90000, graceMs = 1500, logFile, onOutput = () => {} } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let tail = '', timedOut = false, interrupted = false, done = false, killTimer;
    if (logFile) writeFileSync(logFile, '');
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = signal => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
    };
    const record = chunk => {
      const text = String(chunk); tail = (tail + text).slice(-12000);
      if (logFile) appendFileSync(logFile, text);
      onOutput(text);
    };
    const finish = (code, signal, error) => {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(killTimer);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      // Even a successful parent may have leaked a detached server in its group.
      kill('SIGKILL');
      resolve({ code, signal, error: error?.message, timedOut, interrupted, durationMs: Date.now() - started, tail,
        ok: code === 0 && !error && !timedOut && !interrupted });
    };
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), graceMs); };
    const interrupt = () => { interrupted = true; stop(); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    const timer = setTimeout(() => { timedOut = true; record(`\nCHECK TIMEOUT after ${timeoutMs}ms\n`); stop(); }, timeoutMs);
    child.stdout.on('data', record); child.stderr.on('data', record);
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  });
}
