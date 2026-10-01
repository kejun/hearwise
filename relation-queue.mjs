import { relationRetryDelay } from './relation-workflow.mjs';

export const RELATION_QUEUE_DEFAULTS = Object.freeze({ quietMs: 6000, minStartIntervalMs: 2000, busyPollMs: 1000 });

// Independent, strictly single-concurrency, round-robin low-priority admission.
// SQLite owns coalescing, waiting-for-nodes and restart recovery. A busy realtime
// queue is never forced to yield merely because relations have waited a while.
export function createRelationScheduler({ store, listeningIds = () => store.relationListeningIds(), keyFor,
  foregroundBusy = () => false, execute, provider, onChange = () => {}, onIdle = () => {}, onError = () => {},
  now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = timer => clearTimeout(timer), ...options }) {
  const config = { ...RELATION_QUEUE_DEFAULTS, ...options };
  const forced = new Set(), waitingKeys = new Map(), blockedKeys = new Set(), cooldowns = new Map();
  let closed = false, running = null, wakeTimer = null, lastServed = null, lastStarted = -Infinity;
  const notify = (callback, ...args) => { try { callback(...args); } catch (error) { try { onError(error); } catch {} } };
  function wakeAt(timestamp) {
    if (closed || !Number.isFinite(timestamp)) return;
    clearTimer(wakeTimer);
    wakeTimer = setTimer(() => { wakeTimer = null; pump(); }, Math.min(60000, Math.max(1, timestamp - now())));
    wakeTimer?.unref?.();
  }
  function waitingKey(id, waiting) {
    if (waitingKeys.get(id) === waiting) return;
    waitingKeys.set(id, waiting);
    if (store.markRelationWaitingKey) store.markRelationWaitingKey(id, waiting);
    notify(onChange, id);
  }
  async function perform(job, key, controller) {
    try {
      const result = await execute(job, key, controller.signal);
      if (result?.stopKey) blockedKeys.add(key);
      if (result?.rateLimitMs) {
        cooldowns.set(key, Math.max(cooldowns.get(key) || 0, now() + result.rateLimitMs));
        provider?.coolDown?.(key, result.rateLimitMs);
      }
      if (result?.kind === 'continue' && result.readyAt) wakeAt(result.readyAt);
    } catch (error) {
      if (store.hasListening(job.listening_id) && !controller.signal.aborted) {
        // Unexpected errors may have followed a durable reservation. Read the
        // latest job rather than resetting the request count in memory.
        const fresh = store.nextRelationJob(job.listening_id, { now: now(), quietMs: 0 });
        const delay = relationRetryDelay(error, fresh?.request_count || job.request_count || 1);
        store.failRelationJob(job.id, { code: 'RELATION_EXECUTION_FAILED',
          retryAt: delay == null ? null : now() + delay, terminal: delay == null });
      }
      notify(onError, error);
    } finally {
      if (running?.controller === controller) running = null;
      if (!closed) {
        if (store.hasListening(job.listening_id)) notify(onChange, job.listening_id, { refreshDetail: true });
        pump(); notify(onIdle, job.listening_id);
      }
    }
  }
  function pump() {
    if (closed || running) return;
    clearTimer(wakeTimer); wakeTimer = null;
    const ids = [...new Set([...listeningIds(), ...(store.relationListeningIds?.() || [])])].filter(id => store.hasListening(id));
    const liveKeys = new Set(ids.map(keyFor).filter(Boolean));
    for (const key of blockedKeys) if (!liveKeys.has(key)) blockedKeys.delete(key);
    for (const [key, until] of cooldowns) if (!liveKeys.has(key) || until <= now()) cooldowns.delete(key);
    for (const id of waitingKeys.keys()) if (!ids.includes(id)) waitingKeys.delete(id);
    const cursor = ids.indexOf(lastServed), ordered = [...ids.slice(cursor + 1), ...ids.slice(0, cursor + 1)];
    let nextWake = Infinity;
    for (const id of ordered) {
      if (!store.relationHasWork(id)) continue;
      const key = keyFor(id);
      waitingKey(id, !key || blockedKeys.has(key));
      if (!key || blockedKeys.has(key)) continue;
      if (foregroundBusy() || provider?.canStartBackground?.() === false) {
        nextWake = Math.min(nextWake, now() + config.busyPollMs); continue;
      }
      const admissionAt = Math.max(lastStarted + config.minStartIntervalMs, cooldowns.get(key) || 0, provider?.readyAt?.(key, now()) || 0);
      if (admissionAt > now()) { nextWake = Math.min(nextWake, admissionAt); continue; }
      const job = store.nextRelationJob(id, { now: now(), quietMs: forced.has(id) ? 0 : config.quietMs });
      if (!job) {
        if (!store.relationHasWork(id)) { notify(onChange, id); notify(onIdle, id); continue; }
        const status = store.relationProcessing?.(id);
        if (Number.isFinite(status?.nextReadyAt) && status.nextReadyAt > now()) nextWake = Math.min(nextWake, status.nextReadyAt);
        else if (status?.waitingTranslations || status?.pendingJobs || status?.queued) nextWake = Math.min(nextWake, now() + config.busyPollMs);
        continue;
      }
      const readyAt = Number(job.ready_at) || 0;
      if (readyAt > now()) { nextWake = Math.min(nextWake, readyAt); continue; }
      forced.delete(id);
      const controller = new AbortController();
      running = { job, key, controller }; lastServed = id; lastStarted = now();
      notify(onChange, id);
      void perform(job, key, controller); return;
    }
    if (Number.isFinite(nextWake)) wakeAt(nextWake);
  }
  return {
    schedule(id, force = false) {
      if (closed || !store.hasListening(id)) return;
      if (force) { forced.add(id); blockedKeys.delete(keyFor(id)); }
      pump();
    },
    pump,
    hasWork: id => running?.job.listening_id === id || Boolean(store.relationHasWork(id)),
    remove(id) {
      forced.delete(id); waitingKeys.delete(id);
      if (running?.job.listening_id === id) running.controller.abort();
      pump();
    },
    close() { closed = true; clearTimer(wakeTimer); running?.controller.abort(); forced.clear(); waitingKeys.clear(); blockedKeys.clear(); cooldowns.clear(); }
  };
}
