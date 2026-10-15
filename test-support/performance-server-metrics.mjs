// Test-only IPC observation. The original server imports/handlers are unchanged.
// Values describe this server process, including startup and observation overhead.
import { performance } from 'node:perf_hooks';
process.on('message', message => {
  if (message?.type !== 'performance-observe' || typeof message.id !== 'string') return;
  process.send?.({ type: 'performance-observed', id: message.id, pid: process.pid,
    runtime: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch },
    monotonicMs: performance.now(), timeOrigin: performance.timeOrigin,
    cpuUsage: process.cpuUsage(), memoryUsage: process.memoryUsage(), resourceUsage: process.resourceUsage() });
});
