// Test-only: drive the collector's existing watchdog at an actual child boundary.
// No deadline, report field, subprocess result or collected observation is replaced.
import { performanceTimeouts } from '../verification/performance/profile.mjs';
if (process.argv[1]?.endsWith('/scripts/collect-performance.mjs') || process.argv[1] === 'scripts/collect-performance.mjs') {
  const timeout = globalThis.setTimeout, write = process.stdout.write.bind(process.stdout);
  let watchdog, fired = false;
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds === performanceTimeouts.runMs) watchdog = callback;
    return timeout(callback, milliseconds, ...args);
  };
  process.stdout.write = (chunk, ...args) => {
    const result = write(chunk, ...args);
    if (!fired && String(chunk).includes('START small-backend')) {
      fired = true;
      timeout(() => {
        if (process.env.PERFORMANCE_TEST_STOP === 'watchdog') {
          if (!watchdog) throw new Error('Actual collection watchdog was not registered');
          watchdog();
        } else process.kill(process.pid, 'SIGINT');
      }, 0);
    }
    return result;
  };
}
