import { extractRelations, buildRelationInput, RELATION_CONTRACT_VERSION, RELATION_MODEL } from './relations.mjs';

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
  error?.code === 'RELATION_INVALID_RESPONSE' ? 'RELATION_INVALID_RESPONSE' :
    ['TimeoutError', 'AbortError'].includes(error?.name) ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED';

// One dispatch is at most one request. Request budgets are durable before the
// HTTP call and must not reset when the scheduler/process restarts.
export function createRelationWorkflow({ store, endpoint, extract = extractRelations, provider,
  now = () => Date.now(), onChange = () => {}, onError = () => {} }) {
  const notify = (fn, ...args) => { try { fn(...args); } catch { /* Committed state is authoritative. */ } };
  async function execute(job, key, signal) {
    if (!store.hasListening(job.listening_id) || signal?.aborted) return { kind: 'discarded' };
    const readyAt = provider?.readyAt?.(key, now()) || 0;
    if (readyAt > now() || provider?.canStartBackground?.() === false) {
      return { kind: 'continue', readyAt: Math.max(readyAt, now() + 1000), reason: 'foreground' };
    }
    // Pure deterministic validation happens before a billable-attempt journal
    // entry. A too-large snapshot cannot consume/retry a network budget.
    try {
      if ((job.prompt_version && job.prompt_version !== RELATION_CONTRACT_VERSION) ||
        (job.model_version && job.model_version !== RELATION_MODEL)) throw Object.assign(new Error('RELATION_CONTRACT_CHANGED'), { reason: 'RELATION_CONTRACT_CHANGED' });
      buildRelationInput(job.input);
    } catch (error) {
      const code = error?.reason || 'RELATION_INPUT_INVALID';
      store.failRelationJob(job.id, { code, terminal: true });
      notify(onError, Object.assign(new Error(code), { code }));
      notify(onChange, job.listening_id);
      return { kind: 'terminal', outcome: 'failed' };
    }
    const reserved = store.beginRelationRequest(job.id, { now: now(), maxRequests: RELATION_MAX_REQUESTS });
    if (!reserved) return { kind: 'discarded' };
    const input = reserved.input || job.input;
    const requestCount = reserved.request_count ?? (job.request_count || 0) + 1;
    let requestFinished = false;
    try {
      const request = () => extract(key, input, endpoint, { signal, now });
      const parsed = provider?.run ? await provider.run({ key, priority: 'relations', signal }, request) : await request();
      requestFinished = true;
      if (!store.hasListening(job.listening_id) || signal?.aborted) return { kind: 'discarded' };
      const result = store.commitRelationJob(job.id, { relations: parsed.relations,
        rejected: parsed.rejected || [], usage: parsed.usage || null });
      if (result?.stale) return { kind: 'discarded', reason: 'stale' };
      notify(onChange, job.listening_id, result);
      return { kind: 'terminal', outcome: parsed.rejected?.length || input.coverage_limited ? 'partial' :
        parsed.relations.length ? 'ok' : 'empty', ...result };
    } catch (error) {
      if (!store.hasListening(job.listening_id)) return { kind: 'discarded' };
      // Storage failures must not replay a completed paid request automatically.
      const delay = requestFinished ? null : relationRetryDelay(error, requestCount);
      const code = safeCode(error), retryAt = delay == null ? null : now() + delay;
      const cooldown = error?.status === 429 ? Math.max(3000, Number(error.retryAfterMs) || 0) : 0;
      if (cooldown) provider?.coolDown?.(key, cooldown);
      store.failRelationJob(job.id, { code, retryAt, terminal: delay == null });
      notify(onError, Object.assign(new Error(code), { code, status: error?.status }));
      notify(onChange, job.listening_id);
      return { kind: delay == null ? 'terminal' : 'continue', outcome: delay == null ? 'failed' : undefined,
        readyAt: retryAt, reason: 'network_retry', rateLimitMs: cooldown, stopKey: [401, 403].includes(error?.status) };
    }
  }
  return { execute };
}
