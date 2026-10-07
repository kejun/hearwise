import { spawn } from 'node:child_process';
import { deadline, stopChild } from './lifecycle.mjs';

// Let the OS reserve the port and wait for this child's actual startup message.
export async function startServer({ env = {}, args = ['server.mjs'], timeoutMs = 5000 } = {}) {
  const child = spawn(process.execPath, args, { cwd: process.cwd(),
    env: { ...process.env, ...env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', stdout = '';
  const record = data => { logs = (logs + data).slice(-100000); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  let onData, onError, onExit;
  try {
    const base = await deadline(() => new Promise((resolve, reject) => {
      onData = data => {
        stdout = (stdout + data).slice(-100000);
        const url = stdout.match(/(http:\/\/127\.0\.0\.1:\d+)\r?\n/)?.[1];
        // A partial port at a chunk boundary is not a complete startup line.
        if (url) resolve(url);
      };
      onError = reject;
      onExit = (code, signal) => reject(new Error(`Server exited before startup: code=${code} signal=${signal}`));
      child.stdout.on('data', onData); child.once('error', onError); child.once('exit', onExit);
    }), timeoutMs, 'Server startup');
    return { child, base, logs: () => logs };
  } catch (error) {
    let cleanupError;
    try { await stopChild(child); } catch (failure) { cleanupError = failure; }
    const failure = new Error(`${error.message}\n${logs}`, { cause: error });
    if (cleanupError) throw new AggregateError([failure, cleanupError], failure.message);
    throw failure;
  } finally {
    child.stdout.removeListener('data', onData); child.removeListener('error', onError); child.removeListener('exit', onExit);
  }
}
