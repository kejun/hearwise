// 知识抽取的合批、会话串行、公平调度与重试。SQLite 是任务的持久化来源。
export const KNOWLEDGE_DEFAULTS = Object.freeze({
  batchQuietMs: 1500, batchMaxWaitMs: 4000, batchChars: 1200,
  minStartIntervalMs: 2000, translationGraceMs: 1500, concurrency: 2
});

export function knowledgeRetryDelay(error, attempt) {
  const invalidResponse = error?.code === 'KNOWLEDGE_INVALID_RESPONSE';
  const transient = [408, 429].includes(error?.status) || error?.status >= 500 ||
    ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name) ||
    ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.cause?.code || error?.code);
  if ((!invalidResponse && !transient) || attempt >= (invalidResponse ? 2 : 3)) return null;
  const delay = Math.max(attempt === 1 ? 2000 : 8000, error.retryAfterMs || 0);
  return delay <= 300000 ? delay : null;
}

export function createKnowledgeScheduler({
  store, listeningIds, keyFor, translationBusy, execute,
  onChange = () => {}, onError = () => {}, onIdle = () => {}, onLog = () => {},
  now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = timer => clearTimeout(timer),
  ...options
}) {
  const config = { ...KNOWLEDGE_DEFAULTS, ...options };
  const buffers = new Map(), running = new Map(), lastStarted = new Map(), keyCooldowns = new Map();
  let wakeTimer, lastServed, closed = false;

  function cancelBuffer(id) {
    if (buffers.has(id)) clearTimer(buffers.get(id).timer);
    buffers.delete(id);
  }
  function flush(id) {
    cancelBuffer(id);
    if (!store.hasListening(id)) return;
    // 字符上限可能令一批不足 3 句；强制提交仍必须排空尾部。
    for (let rows = store.extractionRange(id); rows.length; rows = store.extractionRange(id)) {
      store.createExtractionJob(id, rows);
    }
    onChange(id);
    pump();
  }
  function schedule(id, force = false) {
    if (closed || !store.hasListening(id)) return;
    const rows = store.extractionRange(id);
    if (!rows.length) { cancelBuffer(id); pump(); return; }
    const time = now();
    const previous = buffers.get(id);
    const firstAt = previous?.firstAt ?? Math.min(time, Date.parse(rows[0].created_at) || time);
    const due = Math.min(firstAt + config.batchMaxWaitMs, time + config.batchQuietMs);
    if (force || rows.length >= 3 || rows.reduce((n, row) => n + row.original_text.length, 0) >= config.batchChars || due <= time) {
      flush(id); return;
    }
    cancelBuffer(id);
    buffers.set(id, { firstAt, timer: setTimer(() => flush(id), due - time) });
    onChange(id);
  }
  function log(job, state, startedAt, extra = {}) {
    const metrics = store.jobMetrics(job);
    const time = now();
    onLog({ job_id: job.id, listening_id: job.listening_id, state, attempt: job.attempts,
      segment_count: metrics.segment_count, queue_ms: startedAt - Date.parse(job.queued_at),
      job_age_ms: time - Date.parse(job.created_at),
      execution_ms: time - startedAt,
      first_final_age_ms: metrics.first_final_at ? time - Date.parse(metrics.first_final_at) : null,
      last_final_age_ms: metrics.last_final_at ? time - Date.parse(metrics.last_final_at) : null, ...extra });
  }
  async function perform(job, key, startedAt) {
    try {
      await execute(job, key);
      if (store.hasListening(job.listening_id)) {
        store.markJob(job.id, 'complete');
        log(job, 'complete', startedAt);
      }
    } catch (error) {
      const delay = knowledgeRetryDelay(error, job.attempts);
      if (error.status === 429) {
        // 同一 Key 的其他知识任务也让路；不输出或持久化 Key。
        keyCooldowns.set(key, Math.max(keyCooldowns.get(key) || 0, now() + Math.max(delay || 2000, error.retryAfterMs || 0)));
      }
      if (store.hasListening(job.listening_id)) {
        store.markJob(job.id, delay == null ? 'failed' : 'pending', String(error.message || error).slice(0, 300),
          delay == null ? null : new Date(now() + delay).toISOString());
        log(job, delay == null ? 'failed' : 'retrying', startedAt, { retry_in_ms: delay });
      }
      onError(error);
    } finally {
      running.delete(job.listening_id);
      if (!closed) {
        if (store.hasListening(job.listening_id)) onChange(job.listening_id, { refreshDetail: true });
        pump();
        onIdle(job.listening_id);
      }
    }
  }
  function pump() {
    if (closed) return;
    clearTimer(wakeTimer); wakeTimer = null;
    const time = now(), busy = translationBusy();
    const limit = busy ? 1 : config.concurrency;
    const ids = [...listeningIds()];
    const activeKeys = new Set(ids.map(keyFor));
    for (const [key, until] of keyCooldowns) if (until <= time || !activeKeys.has(key)) keyCooldowns.delete(key);
    for (const [id, startedAt] of lastStarted) if (time - startedAt >= config.minStartIntervalMs) lastStarted.delete(id);
    if (running.size >= limit) return;
    const cursor = ids.indexOf(lastServed);
    const ordered = [...ids.slice(cursor + 1), ...ids.slice(0, cursor + 1)];
    let nextWake = Infinity;
    for (const id of ordered) {
      if (running.size >= limit) break;
      const key = keyFor(id);
      if (!key || running.has(id)) continue;
      const job = store.nextJob(id);
      if (!job) continue;
      const readyAt = Math.max(
        job.retry_at ? Date.parse(job.retry_at) : 0,
        lastStarted.has(id) ? lastStarted.get(id) + config.minStartIntervalMs : 0,
        busy ? Date.parse(job.created_at) + config.translationGraceMs : 0,
        keyCooldowns.get(key) || 0
      );
      if (readyAt > time) { nextWake = Math.min(nextWake, readyAt); continue; }
      store.markJob(job.id, 'running');
      const started = { ...job, state: 'running', attempts: job.attempts + 1, retry_at: null,
        queued_at: job.attempts || job.retry_at ? job.updated_at : job.created_at };
      running.set(id, started);
      lastStarted.set(id, time); lastServed = id;
      onChange(id);
      log(started, 'running', time);
      void perform(started, key, time).catch(onError);
    }
    if (running.size < limit && Number.isFinite(nextWake)) {
      wakeTimer = setTimer(pump, Math.min(60000, Math.max(1, nextWake - now())));
    }
  }
  return {
    schedule, pump,
    hasWork: id => buffers.has(id) || running.has(id) || Boolean(store.nextJob(id)),
    remove(id) { cancelBuffer(id); lastStarted.delete(id); pump(); },
    close() { closed = true; clearTimer(wakeTimer); for (const id of buffers.keys()) cancelBuffer(id); }
  };
}
