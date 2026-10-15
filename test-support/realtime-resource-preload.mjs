// Test-only observation. Never imported by the normal application entrypoint.
import { appendFileSync, readdirSync, readlinkSync } from 'node:fs';
import WebSocket from 'ws';
const file = process.env.HEARWISE_BASELINE_RESOURCES;
if (!file) throw new Error('Resource sampler requires an evidence file');
const started = performance.now();
let retainedCloseCalls = 0;
const sample = () => {
  const descriptors = { total: null, socket: null, file: null, pipe: null, other: null };
  if (process.platform === 'linux') {
    const names = readdirSync('/proc/self/fd');
    Object.assign(descriptors, { total: 0, socket: 0, file: 0, pipe: 0, other: 0 });
    for (const name of names) {
      let target; try { target = readlinkSync(`/proc/self/fd/${name}`); } catch { continue; }
      descriptors.total++;
      descriptors[target.startsWith('socket:') ? 'socket' : target.startsWith('pipe:') ? 'pipe' : target.startsWith('/') ? 'file' : 'other']++;
    }
  }
  const activeResources = {};
  for (const name of process.getActiveResourcesInfo()) activeResources[name] = (activeResources[name] || 0) + 1;
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), elapsedMs: performance.now() - started, pid: process.pid,
    memory: process.memoryUsage(), cpuMicroseconds: process.cpuUsage(), activeResources, descriptors, retainedCloseCalls }) + '\n');
};
sample();
setInterval(sample, Number(process.env.HEARWISE_BASELINE_SAMPLE_MS)).unref();
if (process.env.HEARWISE_BASELINE_NEGATIVE === 'retain-asr-socket') {
  const close = WebSocket.prototype.close;
  WebSocket.prototype.close = function (...args) {
    // Real upstream transport remains open after its run has stopped.
    if (this.url && new URL(this.url).href === new URL(process.env.ASR_ENDPOINT).href) { retainedCloseCalls++; return; }
    return close.apply(this, args);
  };
}
