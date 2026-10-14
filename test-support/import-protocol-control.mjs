// Test-only child preload. Delivers the production import-expiry callback on a
// controlled logical clock and can fail one real SQLite COMMIT. No app endpoints.
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const directory = process.env.HEARWISE_IMPORT_TEST_CONTROL;
if (!directory) throw new Error('Import control preload requires an isolated control directory');
const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
const originalExec = DatabaseSync.prototype.exec;
const timers = new Map();
let nextTimer = 0, failCommit = false, injectedCommits = 0, lastSequence = 0, chain = Promise.resolve();
globalThis.setTimeout = function (callback, milliseconds, ...args) {
  if (milliseconds !== 900000) return originalSetTimeout(callback, milliseconds, ...args);
  const id = nextTimer++;
  const handle = originalSetTimeout(() => {}, 2147483647);
  timers.set(id, { handle, callback, args, active: true, requestedMilliseconds: milliseconds });
  return handle;
};
globalThis.clearTimeout = function (handle) {
  for (const timer of timers.values()) if (timer.handle === handle) timer.active = false;
  return originalClearTimeout(handle);
};
DatabaseSync.prototype.exec = function (sql) {
  if (failCommit && /^\s*COMMIT\s*;?\s*$/i.test(sql)) {
    failCommit = false; injectedCommits++;
    throw Object.assign(new Error('Injected import commit failure after writes'), { code: 'SQLITE_IOERR' });
  }
  return originalExec.call(this, sql);
};
async function command() {
  let input;
  try { input = JSON.parse(await readFile(path.join(directory, 'command.json'), 'utf8')); }
  catch { return; }
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= lastSequence) return;
  lastSequence = input.sequence;
  let error = null;
  if (input.command === 'expire') {
    const timer = timers.get(input.timer);
    if (!timer?.active) error = 'No active import timer';
    else {
      timer.active = false; originalClearTimeout(timer.handle); timer.callback(...timer.args);
    }
  } else if (input.command === 'fail-commit') failCommit = true;
  else if (input.command !== 'state') error = 'Unknown test clock command';
  const state = { sequence: input.sequence, pid: process.pid, error, failCommit, injectedCommits,
    timers: [...timers].map(([id, timer]) => ({ id, active: timer.active, requestedMilliseconds: timer.requestedMilliseconds })) };
  await writeFile(path.join(directory, 'ack.json'), JSON.stringify(state));
}
const watcher = watch(directory, (_, name) => {
  if (name === 'command.json') chain = chain.then(command).catch(error => { console.error('import-test-control', error.message); });
});
watcher.unref();
