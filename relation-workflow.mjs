import { safeRelationReason } from './relation-diagnostics.mjs';
import { extractRelations, buildRelationRequest, raceRelationAbort, RELATION_CONTRACT_VERSION, RELATION_MODEL, RELATION_REQUEST_TIMEOUT_MS } from './relations.mjs';

export const RELATION_MAX_REQUESTS = 3;
export function relationRetryDelay(error, requestCount) {
  if (requestCount >= RELATION_MAX_REQUESTS || [400, 401, 403, 404, 422].includes(error?.status)) return null;
  const protocol = error?.code === 'RELATION_INVALID_RESPONSE';
  const transient = [408, 429].includes(error?.status) || error?.status >= 500 ||
    ['TimeoutError', 'TypeError', 'AbortError'].includes(error?.name) ||
    ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.cause?.code || error?.code);
  if ((!protocol && !transient) || (protocol && requestCount >= 2)) return null;
  const retryAfter = Number(error?.retryAfterMs) || 0;
  const delay = Math.max(requestCount <= 1 ? 3000 : 12000, retryAfter);
  return delay <= 300000 ? delay : null;
}
const safeCode = error => error?.status ? `HTTP_${error.status}` :
  safeRelationReason(error?.reason) !== 'UNKNOWN_REASON' ? safeRelationReason(error.reason) :
  ['RELATION_INVALID_RESPONSE', 'RELATION_OUTPUT_LIMIT'].includes(error?.code) ? error.code :
    ['TimeoutError', 'AbortError'].includes(error?.name) ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED';
const stopped = status => ['paused', 'cancelled'].includes(status?.state) ||
  (status?.round?.state && status.round.state !== 'active');

// One dispatch is at most one request. Request budgets are durable before the
// HTTP call and must not reset when the scheduler/process restarts.
export function createRelationWorkflow({ store, endpoint, extract = extractRelations, provider,
  now = () => Date.now(), onChange = () => {}, onError = () => {}, requestTimeoutMs = RELATION_REQUEST_TIMEOUT_MS }) {
  const notify = (fn, ...args) => { try { fn(...args); } catch { /* Committed state is authoritative. */ } };
  async function execute(job, key, signal) {
    if (!job || !store.hasListening(job.listening_id) || signal?.aborted) return { kind: 'discarded' };
    const id = job.listening_id;
    const status = store.relationProcessing?.(id);
    if (stopped(status)) return { kind: 'discarded', reason: status?.stopReason || status?.round?.stopReason };
    const readyAt = provider?.readyAt?.(key, now()) || 0;
    if (readyAt > now() || provider?.canStartBackground?.() === false) {
      const reason = readyAt > now() ? 'provider_cooldown' : 'foreground';
      const nextReadyAt = Math.max(readyAt, now() + 1000);
      store.setRelationWaitReason?.(id, reason, nextReadyAt);
      return { kind: 'continue', readyAt: nextReadyAt, reason };
    }
    // Pure deterministic validation happens before a billable-attempt journal
    // entry. A too-large snapshot cannot consume/retry a network budget.
    try {
      if ((job.prompt_version && job.prompt_version !== RELATION_CONTRACT_VERSION) ||
        (job.model_version && job.model_version !== RELATION_MODEL)) throw Object.assign(new Error('RELATION_CONTRACT_CHANGED'), { reason: 'RELATION_CONTRACT_CHANGED' });
      buildRelationRequest(job.input);
    } catch (error) {
      const code = error?.reason || 'RELATION_INPUT_INVALID';
      store.failRelationJob(job.id, { code, terminal: true });
      notify(onError, Object.assign(new Error(code), { code }));
      notify(onChange, id);
      return { kind: 'terminal', outcome: 'failed' };
    }
    const reserved = store.beginRelationRequest(job.id, { now: now(), maxRequests: RELATION_MAX_REQUESTS });
    if (!reserved) return { kind: 'discarded' };
    store.setRelationWaitReason?.(id, null);
    notify(onChange, id);
    const input = reserved.input || job.input;
    const attempt = reserved.request_count ?? (job.request_count || 0) + 1;
    const requestCount = reserved.window_request_count ?? attempt;
    const timeout = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => {
      timeout.abort(new DOMException('Relation request timed out', 'TimeoutError'));
    }, requestTimeoutMs);
    const recordUsage = (usage, outcome) => {
      try {
        if (store.hasListening(id)) store.recordRelationUsage?.(job.id, { usage, outcome, attempt });
      } catch (error) { notify(onError, error); }
    };
    let requestFinished = false;
    try {
      const request = () => {
        // A provider implementation may postpone invoking us. Never start paid
        // work after cancellation or after this request timed out.
        if (requestSignal.aborted) return Promise.reject(requestSignal.reason);
        const operation = Promise.resolve().then(() => {
          if (requestSignal.aborted) throw requestSignal.reason;
          return extract(key, input, endpoint, { signal: requestSignal, now, requestTimeoutMs,
            onUsage: usage => recordUsage(usage, requestSignal.aborted ? 'late_response' : 'response_received') });
        }).then(parsed => {
          recordUsage(parsed?.usage, requestSignal.aborted ? 'late_response' : 'response_received');
          return parsed;
        }, error => {
          recordUsage(error?.usage, requestSignal.aborted ? 'late_response' : safeCode(error));
          throw error;
        });
        return raceRelationAbort(operation, requestSignal);
      };
      const operation = provider?.run ? provider.run({ key, priority: 'relations', signal: requestSignal }, request) : request();
      const parsed = await raceRelationAbort(operation, requestSignal);
      requestFinished = true;
      if (!store.hasListening(id) || requestSignal.aborted) return { kind: 'discarded' };
      if (stopped(store.relationProcessing?.(id))) return { kind: 'discarded' };
      const result = store.commitRelationJob(job.id, { relations: parsed.relations,
        rejected: parsed.rejected || [], returnedCount: parsed.returnedCount, coverageLimited: parsed.coverageLimited === true, usage: parsed.usage || null });
      if (result?.stale) return { kind: 'discarded', reason: 'stale' };
      notify(onChange, id, result);
      return { kind: 'terminal', outcome: result?.state === 'partial' ? 'partial' :
        result?.accepted ? 'ok' : 'empty', ...result };
    } catch (error) {
      if (!store.hasListening(id)) return { kind: 'discarded' };
      if (signal?.aborted || stopped(store.relationProcessing?.(id))) return { kind: 'discarded' };
      // Storage failures must not replay a completed paid request automatically.
      const delay = requestFinished ? null : relationRetryDelay(error, requestCount);
      const code = safeCode(error), retryAt = delay == null ? null : now() + delay;
      const cooldown = error?.status === 429 ? Math.max(3000, Number(error.retryAfterMs) || 0) : 0;
      if (cooldown) provider?.coolDown?.(key, cooldown);
      store.failRelationJob(job.id, { code, retryAt, terminal: delay == null });
      if (retryAt) store.setRelationWaitReason?.(id, 'network_retry', retryAt);
      notify(onError, Object.assign(new Error(code), { code, status: error?.status }));
      notify(onChange, id);
      return { kind: delay == null ? 'terminal' : 'continue', outcome: delay == null ? 'failed' : undefined,
        readyAt: retryAt, reason: 'network_retry', rateLimitMs: cooldown, stopKey: [401, 403].includes(error?.status) };
    } finally { clearTimeout(timer); }
  }
  return { execute };
}
