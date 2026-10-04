import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildServer } from './build.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
let child, pending = false, rebuilding = false, stopping = false, debounce;
async function stopChild() {
  const previous = child; child = undefined;
  if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => previous.kill('SIGKILL'), 2000);
    previous.once('exit', () => { clearTimeout(timer); resolve(); });
    previous.kill('SIGTERM');
  });
}
async function rebuild() {
  pending = true;
  if (rebuilding || stopping) return;
  rebuilding = true;
  try {
    while (pending && !stopping) {
      pending = false;
      await stopChild();
      try {
        await buildServer();
        if (!stopping) child = spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: process.env });
      } catch (error) { console.error('Build failed; server stopped.', error.message); }
    }
  } finally { rebuilding = false; }
}
await rebuild();
const watcher = watch('.', { recursive: true }, (_event, filename) => {
  if (!filename || /^(?:node_modules|dist|data|\.git)\//.test(filename)) return;
  if (!/\.(?:mjs|js|ts|json|md)$/.test(filename)) return;
  clearTimeout(debounce); debounce = setTimeout(rebuild, 100);
});
async function close() {
  if (stopping) return;
  stopping = true; watcher.close(); clearTimeout(debounce); await stopChild();
}
process.once('SIGINT', close); process.once('SIGTERM', close);
