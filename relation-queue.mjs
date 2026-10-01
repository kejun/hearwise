import { relationRetryDelay } from './relation-workflow.mjs';
import { raceRelationAbort } from './relations.mjs';

export const RELATION_QUEUE_DEFAULTS = Object.freeze({ quietMs: 6000, minStartIntervalMs: 2000, busyPollMs: 1000, maxConcurrent: 2 });

// Independent, bounded-concurrency, round-robin low-priority admission.
// SQLite owns durable per-window attempts, coalescing and restart recovery.
// Foreground work retains priority without expiring the remaining history.
export function createRelationScheduler({ store, listeningIds = () => store.relationListeningIds(), keyFor,
  foregroundBusy = () => false, execute, provider, onChange = () => {}, onIdle = () => {}, onError = () => {},
  now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = timer => clearTimeout(timer), ...options }) {
  const config = { ...RELATION_QUEUE_DEFAULTS, ...options };
  config.maxConcurrent = Number.isInteger(config.maxConcurrent) ? Math.max(1, Math.min(2, config.maxConcurrent)) : RELATION_QUEUE_DEFAULTS.maxConcurrent;
  const forced = new Set(), waitingKeys = new Map(), waitingReasons = new Map(), blockedKeys = new Set(), cooldowns = new Map();
  const running = new Map(), failedUpdates = new Map();
  let closed = false, pumping = false, wakeTimer = null, lastServed = null, lastStarted = -Infinity;
  const notify = (callback, ...args) => { try { callback(...args); } catch (error) { try { onError(error); } catch {} } };
  const activeFor = id => [...running.values()].filter(entry => entry.job.listening_id === id && !entry.controller.signal.aborted);
  function abortListening(id, reason) {
    for (const entry of running.values()) if (entry.job.listening_id === id) entry.controller.abort(reason);
  }
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
  function waitReason(id, reason, readyAt = null) {
    const value = JSON.stringify([reason, readyAt]);
    if (waitingReasons.get(id) === value) return;
    waitingReasons.set(id, value);
    store.setRelationWaitReason?.(id, reason, readyAt);
    notify(onChange, id);
  }
  function abortStopped(ids) {
    for (const id of ids) {
      const status = store.relationProcessing?.(id);
      if (['paused', 'cancelled'].includes(status?.state) || (status?.round?.state && status.round.state !== 'active')) {
        abortListening(id, new DOMException('Relation work stopped', 'AbortError'));
      }
    }
  }
  async function perform(job, key, controller) {
    try {
      // Free the scheduler slot even if an injected execute/transport never
      // observes abort. Workflow/storage independently fence late graph writes.
      const result = await raceRelationAbort(execute(job, key, controller.signal), controller.signal);
      if (controller.signal.aborted) return;
      if (result?.stopKey) blockedKeys.add(key);
      if (result?.rateLimitMs) {
        cooldowns.set(key, Math.max(cooldowns.get(key) || 0, now() + result.rateLimitMs));
        provider?.coolDown?.(key, result.rateLimitMs);
      }
      if (result?.kind === 'continue' && result.readyAt) wakeAt(result.readyAt);
    } catch (error) {
      if (!controller.signal.aborted) {
        // A storage failure must not escape this detached task or cause a paid
        // request to be replayed. Retain the finalization until SQLite unlocks.
        let patch = { code: 'RELATION_STORAGE_FAILED', terminal: true };
        try {
          if (store.hasListening(job.listening_id)) {
            const fresh = store.getRelationJob?.(job.id);
            const delay = relationRetryDelay(error, fresh?.window_request_count || fresh?.request_count || job.window_request_count || job.request_count || 1);
            patch = { code: 'RELATION_EXECUTION_FAILED', retryAt: delay == null ? null : now() + delay, terminal: delay == null };
            store.failRelationJob(job.id, patch);
          }
        } catch (storageError) {
          failedUpdates.set(job.id, { listeningId: job.listening_id, patch });
          notify(onError, storageError);
        }
        notify(onError, error);
      }
    } finally {
      if (running.get(job.id)?.controller === controller) running.delete(job.id);
      if (!closed) {
        try {
          if (store.hasListening(job.listening_id)) notify(onChange, job.listening_id, { refreshDetail: true });
        } catch (error) { notify(onError, error); }
        pump(); notify(onIdle, job.listening_id);
      }
    }
  }

  function pump() {
    if (closed || pumping) return;
    pumping = true;
    try {
      for (const [jobId, entry] of failedUpdates) {
        if (store.hasListening(entry.listeningId)) store.failRelationJob(jobId, entry.patch);
        failedUpdates.delete(jobId);
        notify(onChange, entry.listeningId, { refreshDetail: true });
      }
      const ids = [...new Set([...listeningIds(), ...(store.relationListeningIds?.() || [])])].filter(id => store.hasListening(id));
      abortStopped(ids);
      if (running.size >= config.maxConcurrent) return;
      clearTimer(wakeTimer); wakeTimer = null;
      const liveKeys = new Set(ids.map(keyFor).filter(Boolean));
      for (const key of blockedKeys) if (!liveKeys.has(key)) blockedKeys.delete(key);
      for (const [key, until] of cooldowns) if (!liveKeys.has(key) || until <= now()) cooldowns.delete(key);
      for (const id of waitingKeys.keys()) if (!ids.includes(id)) waitingKeys.delete(id);
      for (const id of waitingReasons.keys()) if (!ids.includes(id)) waitingReasons.delete(id);
      let nextWake = Infinity;
      let admitted;
      do {
        admitted = false;
        const cursor = ids.indexOf(lastServed), ordered = [...ids.slice(cursor + 1), ...ids.slice(0, cursor + 1)];
        for (const id of ordered) {
          if (!store.relationHasWork(id)) continue;
          const key = keyFor(id);
          waitingKey(id, !key || blockedKeys.has(key));
          if (!key || blockedKeys.has(key)) { waitReason(id, 'waiting_key'); continue; }
          if (foregroundBusy() || provider?.canStartBackground?.() === false) {
            waitReason(id, 'foreground');
            nextWake = Math.min(nextWake, now() + config.busyPollMs); continue;
          }
          const cooldownAt = Math.max(cooldowns.get(key) || 0, provider?.readyAt?.(key, now()) || 0);
          const admissionAt = Math.max(lastStarted + config.minStartIntervalMs, cooldownAt);
          if (admissionAt > now()) {
            waitReason(id, cooldownAt > now() ? 'provider_cooldown' : 'admission_interval', admissionAt);
            nextWake = Math.min(nextWake, admissionAt); continue;
          }
          // Admission/cooldown has elapsed. Do not let its old timestamp mask a
          // later quiet/retry timestamp when another slot is still in flight.
          waitReason(id, null);
          const job = store.nextRelationJob(id, { now: now(), quietMs: forced.has(id) ? 0 : config.quietMs,
            maxConcurrent: config.maxConcurrent });
          if (!job) {
            if (!store.relationHasWork(id)) { waitReason(id, null); notify(onChange, id); notify(onIdle, id); continue; }
            const status = store.relationProcessing?.(id);
            // An in-flight window may fence a dependent window or the remaining
            // round budget. Its completion will pump again; do not busy-poll it.
            if (activeFor(id).length && !status?.waitingTranslations && !(status?.nextReadyAt > now())) continue;
            waitReason(id, status?.waitingTranslations ? 'translations' : status?.waitReason === 'network_retry' ? 'network_retry' : 'quiet_period', status?.nextReadyAt ?? null);
            if (Number.isFinite(status?.nextReadyAt) && status.nextReadyAt > now()) nextWake = Math.min(nextWake, status.nextReadyAt);
            else if (status?.waitingTranslations || status?.pendingJobs || status?.queued) nextWake = Math.min(nextWake, now() + config.busyPollMs);
            continue;
          }
          // Storage normally marks the job running synchronously in execute.
          // Also fence injected/deferred executors that still return it pending.
          if (running.has(job.id)) continue;
          const readyAt = Number(job.ready_at) || 0;
          if (readyAt > now()) { waitReason(id, 'network_retry', readyAt); nextWake = Math.min(nextWake, readyAt); continue; }
          forced.delete(id);
          waitReason(id, null);
          const controller = new AbortController();
          running.set(job.id, { job, key, controller }); lastServed = id; lastStarted = now();
          notify(onChange, id);
          void perform(job, key, controller).catch(error => {
            // Last-resort containment for the detached task. Preserve a terminal
            // write for retry instead of leaving a persisted running job orphaned.
            if (running.get(job.id)?.controller === controller) running.delete(job.id);
            if (!closed) {
              failedUpdates.set(job.id, { listeningId: job.listening_id, patch: { code: 'RELATION_STORAGE_FAILED', terminal: true } });
              notify(onError, error); wakeAt(now() + config.busyPollMs);
            }
          }); admitted = true; break;
        }
      } while (!closed && admitted && running.size < config.maxConcurrent);
      if (running.size < config.maxConcurrent && Number.isFinite(nextWake)) wakeAt(nextWake);
    } catch (error) {
      // A transient SQLite lock must not escape timer/microtask callbacks and
      // take down the server. Retry admission; durable attempts are never reset.
      notify(onError, error);
      wakeAt(now() + config.busyPollMs);
    } finally { pumping = false; }
  }
  function cancel(id) {
    forced.delete(id); waitingKeys.delete(id); waitingReasons.delete(id);
    abortListening(id, new DOMException('Relation work cancelled', 'AbortError'));
    pump();
  }
  return {
    schedule(id, force = false) {
      if (closed || !store.hasListening(id)) return;
      if (force) { forced.add(id); blockedKeys.delete(keyFor(id)); waitingReasons.delete(id); }
      pump();
    },
    pump,
    hasWork: id => Boolean(activeFor(id).length || store.relationHasWork(id)),
    cancel,
    remove: cancel,
    close() { closed = true; clearTimer(wakeTimer);
      for (const entry of running.values()) entry.controller.abort();
      forced.clear(); waitingKeys.clear(); waitingReasons.clear(); blockedKeys.clear(); cooldowns.clear(); failedUpdates.clear(); }
  };
}
