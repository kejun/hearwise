import { createHash } from 'node:crypto';

// Shared text-provider admission. Foreground requests never wait behind graph work.
// Cooldowns are scoped to the knowledge/relation model, not ASR, MT or TTS.
export function createProviderAdmission({ now = () => Date.now(), onMetric = () => {} } = {}) {
  // Expiry metadata survives ordinary key release without retaining credentials.
  const cooldowns = new Map();
  const fingerprint = key => createHash('sha256').update(String(key)).digest('hex');
  const active = new Map();
  function readyAt(key) {
    for (const [id, until] of cooldowns) if (until <= now()) cooldowns.delete(id);
    const until = cooldowns.get(fingerprint(key)) || 0;
    if (until <= now()) return 0;
    return until;
  }
  function coolDown(key, delayMs) {
    if (Number.isFinite(delayMs) && delayMs > 0) {
      cooldowns.set(fingerprint(key), Math.max(readyAt(key), now() + delayMs));
    }
  }
  return {
    readyAt, coolDown,
    canStartBackground: () => ![...active].some(([priority, count]) => priority !== 'relations' && count > 0),
    release(key) { readyAt(key); },
    async run({ key, priority, signal }, request) {
      if (signal?.aborted) throw signal.reason;
      const started = now();
      active.set(priority, (active.get(priority) || 0) + 1);
      let status = 'complete';
      try { return await request(); }
      catch (error) {
        status = error?.status ? `HTTP_${error.status}` : 'failed';
        if (priority !== 'translation' && error?.status === 429) coolDown(key, Math.max(2000, Number(error.retryAfterMs) || 0));
        throw error;
      } finally {
        const count = (active.get(priority) || 1) - 1;
        if (count) active.set(priority, count); else active.delete(priority);
        // Never include keys, transcript text or upstream error bodies in metrics.
        try { onMetric({ priority, status, elapsedMs: Math.max(0, now() - started) }); } catch { /* Diagnostics are isolated. */ }
      }
    }
  };
}
