import { CONTRACT_REVISION, extractKnowledge, repairKnowledge, buildRepairTargets, splitFocusSegments } from './knowledge.mjs';
import { knowledgeRetryDelay } from './knowledge-queue.mjs';

const REQUEST_INTERVAL_MS = 2000;
const MAX_EXTRA_REQUESTS = 2;
const safeFailure = error => error?.code === 'KNOWLEDGE_INVALID_RESPONSE'
  ? 'KNOWLEDGE_INVALID_RESPONSE'
  : error?.status ? `HTTP_${error.status}`
    : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED';
const rateLimit = error => error?.status === 429 ? Math.max(2000, Number(error.retryAfterMs) || 0) : 0;

// References, rather than copies of the transcript, make the split immutable across retries.
function partsFor(input) {
  const offsets = new Map();
  return splitFocusSegments(input).map((part, part_no) => ({
    part_no,
    focus_refs: part.focus_segments.map(segment => {
      const start = offsets.get(segment.id) || 0;
      const end = start + segment.text.length;
      offsets.set(segment.id, end);
      return { segment_id: segment.id, start, end };
    }),
    phase: 'extract_pending', ready_at: 0, initial_requests: 0, repair_reserved: 0,
    unresolved: [], results: [], stats: { initial_complete: false }
  }));
}

function focusFor(part, input) {
  const byId = new Map(input.focus_segments.map(segment => [segment.id, segment.text]));
  return part.focus_refs.map(ref => {
    const text = byId.get(ref.segment_id);
    if (typeof text !== 'string' || ref.start < 0 || ref.end > text.length || ref.end <= ref.start) {
      throw Object.assign(new Error('知识任务的原文范围不再有效'), { code: 'KNOWLEDGE_FOCUS_CHANGED' });
    }
    return { id: ref.segment_id, text: text.slice(ref.start, ref.end) };
  });
}

function repairInput(fresh, snapshot, targets, liveIds) {
  const pin = (field, old, current, limit) => {
    const ids = new Set(targets.map(target => target.rawItem?.[field]).filter(Boolean));
    const currentById = new Map(current.map(candidate => [candidate.id, candidate]));
    const pinned = old.filter(candidate => ids.has(candidate.id)).map(candidate => currentById.get(candidate.id) || candidate);
    return [...new Map([...pinned, ...current].map(candidate => [candidate.id, candidate])).values()].slice(0, limit);
  };
  const result = {
    ...fresh,
    context_segments: snapshot.context_segments || fresh.context_segments,
    existing_candidates: pin('existing_item_id', (snapshot.existing_candidates || []).filter(candidate => liveIds.existing.has(candidate.id)), fresh.existing_candidates, 12),
    observed_candidates: pin('observed_candidate_id', (snapshot.observed_candidates || []).filter(candidate => liveIds.observed.has(candidate.id)), fresh.observed_candidates || [], 8)
  };
  // Pinning an older target must not expand the model's candidate-text budget.
  let budget = 3600;
  result.existing_candidates = result.existing_candidates.map(candidate => {
    const bounded = { ...candidate };
    let remaining = Math.min(600, budget);
    for (const field of ['short_description', 'dialogue_summary']) {
      if (typeof bounded[field] !== 'string') continue;
      bounded[field] = bounded[field].length <= remaining ? bounded[field] : '';
      remaining -= bounded[field].length;
    }
    bounded.recent_facts = [];
    for (const fact of (candidate.recent_facts || []).slice(-2).reverse()) {
      if (typeof fact !== 'string' || fact.length > remaining) continue;
      bounded.recent_facts.unshift(fact); remaining -= fact.length;
    }
    budget -= Math.min(600, budget) - remaining;
    return bounded;
  });
  return result;
}

export function knowledgeResultSummary(checkpoint) {
  const summary = { contract_revision: checkpoint.progress?.contract_revision,
    cycle: checkpoint.progress?.cycle || 1,
    first_content_at: checkpoint.progress?.first_content_at || null,
    returned_count: 0, accepted_initial_count: 0, resolved_count: 0,
    normalized_count: 0, rejected_initial_count: 0, repaired_count: 0, repair_excluded_count: 0,
    unresolved_count: 0, failed_part_count: 0, created_count: 0, updated_count: 0,
    observed_count: 0, excluded_count: 0, repeated_count: 0, deferred_identity_count: 0,
    request_count: 0, repair_ms: 0, visible_change_count: 0, evidence_warning_count: 0, protocol_issue_count: 0 };
  const visible = new Set();
  for (const part of checkpoint.parts) {
    const stats = part.stats || {};
    for (const field of ['returned_count', 'accepted_initial_count', 'normalized_count', 'rejected_initial_count',
      'repaired_count', 'repair_excluded_count', 'request_count', 'repair_ms', 'evidence_warning_count', 'protocol_issue_count']) summary[field] += stats[field] || 0;
    summary.unresolved_count += part.unresolved.length;
    if (!stats.initial_complete && stats.failure_code) summary.failed_part_count++;
    for (const result of part.results) {
      summary.resolved_count++;
      const field = `${result.status === 'created' ? 'created' : result.status === 'updated' ? 'updated' :
        result.status === 'observed' ? 'observed' : result.status === 'excluded' ? 'excluded' :
          result.status === 'deferred_identity' ? 'deferred_identity' : 'repeated'}_count`;
      summary[field]++;
      if (result.visibleChange && result.itemId && (result.cycle || 1) === summary.cycle) visible.add(result.itemId);
    }
  }
  summary.visible_change_count = visible.size;
  return summary;
}

// One dispatch performs at most one HTTP request. All retries and correction budgets
// live in SQLite; a scheduler continuation never means the job has succeeded.
export function createKnowledgeWorkflow({ store, endpoint, extract = extractKnowledge, repair = repairKnowledge,
  now = () => Date.now(), onItems = () => {}, onProgress = () => {}, onRejected = () => {}, onDiagnostic = () => {}, onError = () => {} }) {
  const reportError = error => { try { onError(error); } catch { /* Diagnostics cannot change committed state. */ } };
  const notify = (callback, ...args) => { try { callback(...args); } catch (error) { reportError(error); } };
  function save(job, progress, part, accepted = [], patch = {}) {
    const result = store.saveKnowledgeCheckpoint(job.id, {
      progress, part, state: 'pending', outcome: null, lastError: null, retryAt: null, ...patch
    }, accepted);
    if (result.changedItems?.length) notify(onItems, job.listening_id, result.changedItems);
    notify(onProgress, job.listening_id);
    return result;
  }

  function settle(job, { rateLimitMs = 0, reason = 'phase' } = {}) {
    const checkpoint = store.knowledgeCheckpoint(job.id);
    if (!checkpoint) return { kind: 'terminal', outcome: 'invalid', rateLimitMs };
    const next = checkpoint.parts.find(part => part.phase !== 'done');
    const summary = knowledgeResultSummary(checkpoint);
    const firstFinal = store.jobMetrics(job).first_final_at;
    summary.first_content_age_ms = summary.first_content_at && firstFinal
      ? Math.max(0, summary.first_content_at - Date.parse(firstFinal)) : null;
    if (next) {
      const readyAt = Math.max(next.ready_at || 0, (checkpoint.progress.last_request_at || 0) + REQUEST_INTERVAL_MS,
        checkpoint.progress.rate_limit_until || 0, now());
      save(job, checkpoint.progress, { part_no: next.part_no, ready_at: readyAt }, [], {
        lastError: checkpoint.job.last_error,
        retryAt: reason === 'network_retry' ? new Date(readyAt).toISOString() : null
      });
      return { kind: 'continue', readyAt, reason, rateLimitMs, summary };
    }
    const unresolved = summary.unresolved_count + summary.failed_part_count;
    const outcome = unresolved ? (summary.resolved_count ? 'partial' : 'invalid')
      : summary.resolved_count ? 'ok' : 'empty';
    store.saveKnowledgeCheckpoint(job.id, {
      progress: checkpoint.progress, state: outcome === 'invalid' ? 'failed' : 'complete', outcome,
      lastError: unresolved ? `KNOWLEDGE_UNRESOLVED: ${summary.unresolved_count} items, ${summary.failed_part_count} parts` : null,
      retryAt: null
    });
    return { kind: 'terminal', outcome, summary, rateLimitMs };
  }

  function stopConfigurationFailure(job, code) {
    const checkpoint = store.knowledgeCheckpoint(job.id);
    for (const part of checkpoint.parts.filter(part => part.phase !== 'done')) {
      save(job, checkpoint.progress, { part_no: part.part_no, phase: 'done', ready_at: 0,
        stats: { failure_code: code, failure_message: '知识服务配置需修正后继续处理' } });
    }
  }

  async function execute(job, key, context = {}) {
    context.signal?.throwIfAborted();
    if (!store.hasListening(job.listening_id)) return { kind: 'terminal', outcome: 'invalid' };
    let checkpoint = store.knowledgeCheckpoint(job.id);
    if (!checkpoint?.parts.length) {
      if (checkpoint?.job.outcome === 'legacy') throw Object.assign(new Error('历史任务需重新核对'), { code: 'LEGACY_RECOVERY_REQUIRED' });
      store.initializeKnowledgeParts(job.id, partsFor(store.jobInput(job)), CONTRACT_REVISION);
      checkpoint = store.knowledgeCheckpoint(job.id);
    }
    if (checkpoint.progress.contract_revision !== CONTRACT_REVISION) {
      throw Object.assign(new Error('知识任务协议版本不兼容，需升级后继续'), { code: 'KNOWLEDGE_CONTRACT_VERSION' });
    }
    const part = checkpoint.parts.find(part => part.phase !== 'done');
    if (!part) return settle(job);
    const due = Math.max(part.ready_at || 0, (checkpoint.progress.last_request_at || 0) + REQUEST_INTERVAL_MS,
      checkpoint.progress.rate_limit_until || 0);
    if (due > now()) {
      save(job, checkpoint.progress, { part_no: part.part_no, ready_at: due }, [], {
        lastError: checkpoint.job.last_error, retryAt: checkpoint.job.retry_at
      });
      return { kind: 'continue', readyAt: due, reason: 'interval' };
    }
    const focus = focusFor(part, store.jobInput(job));
    let input = store.jobInput(job, focus);
    for (const segment of focus) context.event?.('source_linked', { segment_id: segment.id });
    const progress = { ...checkpoint.progress };
    const stats = { ...part.stats };

    if (part.phase === 'extract_pending') {
      if (part.initial_requests && (progress.extra_requests >= MAX_EXTRA_REQUESTS ||
        (stats.retry_kind === 'protocol' && progress.protocol_retries >= 1))) {
        save(job, progress, { part_no: part.part_no, phase: 'done', stats: {
          failure_code: 'REQUEST_BUDGET_EXHAUSTED', initial_complete: false } });
        return settle(job);
      }
      if (part.initial_requests) {
        progress.extra_requests++;
        if (stats.retry_kind === 'protocol') progress.protocol_retries++;
      }
      const startedAt = now();
      progress.last_request_at = startedAt;
      stats.request_count = (stats.request_count || 0) + 1;
      save(job, progress, { part_no: part.part_no, phase: 'extract_inflight',
        initial_requests: part.initial_requests + 1, stats }, [], { state: 'running' });
      let requestFinished = false;
      try {
        context.event?.('checkpoint_reserved', { phase: 'extract', part_no: part.part_no, request_count: stats.request_count });
        context.signal?.throwIfAborted();
        const parsed = await (context.step ? context.step('knowledge.extract', child => extract(key, input, endpoint, child)) : extract(key, input, endpoint, context));
        context.signal?.throwIfAborted();
        requestFinished = true;
        if (!store.hasListening(job.listening_id)) return { kind: 'terminal', outcome: 'invalid' };
        const rejected = buildRepairTargets(input, parsed.rejected, job.id, part.part_no);
        const repairable = rejected.some(target => target.anchor);
        Object.assign(stats, { initial_complete: true, returned_count: parsed.returnedCount,
          accepted_initial_count: parsed.accepted.length, rejected_initial_count: rejected.length,
          normalized_count: parsed.normalized.length, failure_code: null, failure_message: null, retry_kind: null,
          evidence_warning_count: parsed.evidenceWarnings?.length || 0,
          extract_ms: now() - startedAt });
        save(job, progress, { part_no: part.part_no, phase: repairable ? 'repair_pending' : 'done',
          ready_at: Math.max(now(), startedAt + REQUEST_INTERVAL_MS), stats, unresolved: rejected,
          input_snapshot: { context_segments: input.context_segments,
            existing_candidates: input.existing_candidates, observed_candidates: input.observed_candidates || [] }
        }, parsed.accepted);
        context.event?.('checkpoint_committed', { part_no: part.part_no, accepted_count: parsed.accepted.length, rejected_count: rejected.length, returned_count: parsed.returnedCount });
        if (rejected.length) notify(onRejected, job, part.part_no, rejected, 'initial');
        if (parsed.evidenceWarnings?.length) notify(onDiagnostic, job, part.part_no, parsed.evidenceWarnings, 'initial');
        return settle(job);
      } catch (error) {
        context.signal?.throwIfAborted();
        if (!store.hasListening(job.listening_id)) return { kind: 'terminal', outcome: 'invalid' };
        // Storage, diagnostics and event-delivery failures are not model retries.
        if (requestFinished) throw error;
        const code = safeFailure(error);
        const protocol = error?.code === 'KNOWLEDGE_INVALID_RESPONSE';
        const delay = knowledgeRetryDelay(error, 1);
        const canRetry = delay != null && progress.extra_requests < MAX_EXTRA_REQUESTS &&
          (!protocol || progress.protocol_retries < 1);
        const retryMs = Math.max(progress.extra_requests ? 8000 : 2000, delay || 0);
        if (rateLimit(error)) progress.rate_limit_until = Math.max(progress.rate_limit_until || 0, now() + rateLimit(error));
        save(job, progress, { part_no: part.part_no, phase: canRetry ? 'extract_pending' : 'done',
          ready_at: canRetry ? now() + retryMs : 0, stats: { ...stats, initial_complete: false,
            failure_code: code, failure_message: code, retry_kind: protocol ? 'protocol' : 'transient' }
        }, [], { lastError: code, retryAt: canRetry ? new Date(now() + retryMs).toISOString() : null });
        reportError(error);
        if ([400, 401, 403, 404, 422].includes(error.status)) stopConfigurationFailure(job, code);
        return settle(job, { reason: canRetry ? 'network_retry' : 'phase', rateLimitMs: rateLimit(error) });
      }
    }

    if (part.phase === 'repair_pending') {
      if (part.repair_reserved || !part.unresolved.some(target => target.anchor)) {
        save(job, progress, { part_no: part.part_no, phase: 'done' });
        return settle(job);
      }
      input = repairInput(input, part.input_snapshot || {}, part.unresolved, store.knowledgeCandidateIds(job.listening_id));
      const startedAt = now();
      progress.last_request_at = startedAt;
      stats.request_count = (stats.request_count || 0) + 1;
      save(job, progress, { part_no: part.part_no, phase: 'repair_inflight', repair_reserved: 1, stats }, [], { state: 'running' });
      let requestFinished = false;
      try {
        context.event?.('checkpoint_reserved', { phase: 'repair', part_no: part.part_no, request_count: stats.request_count });
        context.signal?.throwIfAborted();
        const parsed = await (context.step ? context.step('knowledge.repair', child => repair(key, input, endpoint, part.unresolved, child)) : repair(key, input, endpoint, part.unresolved, context));
        context.signal?.throwIfAborted();
        requestFinished = true;
        if (!store.hasListening(job.listening_id)) return { kind: 'terminal', outcome: 'invalid' };
        stats.repaired_count = (stats.repaired_count || 0) + parsed.accepted.filter(entry => entry.item.action !== 'exclude').length;
        stats.repair_excluded_count = (stats.repair_excluded_count || 0) + (parsed.repairExcluded || 0);
        stats.normalized_count = (stats.normalized_count || 0) + (parsed.normalized?.length || 0);
        stats.evidence_warning_count = (stats.evidence_warning_count || 0) + (parsed.evidenceWarnings?.length || 0);
        stats.protocol_issue_count = (stats.protocol_issue_count || 0) + (parsed.protocolIssues?.length || 0);
        stats.repair_ms = (stats.repair_ms || 0) + now() - startedAt;
        stats.repair_error = null;
        save(job, progress, { part_no: part.part_no, phase: 'done', stats, unresolved: parsed.rejected }, parsed.accepted);
        context.event?.('checkpoint_committed', { part_no: part.part_no, accepted_count: parsed.accepted.length, rejected_count: parsed.rejected.length });
        if (parsed.rejected.length) notify(onRejected, job, part.part_no, parsed.rejected, 'repair');
        const diagnostics = [...(parsed.evidenceWarnings || []), ...(parsed.protocolIssues || [])];
        if (diagnostics.length) notify(onDiagnostic, job, part.part_no, diagnostics, 'repair');
        return settle(job);
      } catch (error) {
        context.signal?.throwIfAborted();
        if (!store.hasListening(job.listening_id)) return { kind: 'terminal', outcome: 'invalid' };
        if (requestFinished) throw error;
        const code = safeFailure(error);
        if (rateLimit(error)) progress.rate_limit_until = Math.max(progress.rate_limit_until || 0, now() + rateLimit(error));
        const unresolved = part.unresolved.map(target => ({ ...target,
          issues: [...target.issues, { code, path: 'repair' }], reason: code }));
        save(job, progress, { part_no: part.part_no, phase: 'done', unresolved,
          stats: { ...stats, repair_error: code, repair_ms: (stats.repair_ms || 0) + now() - startedAt } });
        reportError(error);
        if ([400, 401, 403, 404, 422].includes(error.status)) stopConfigurationFailure(job, code);
        return settle(job, { rateLimitMs: rateLimit(error) });
      }
    }
    throw Object.assign(new Error('知识任务阶段不可执行'), { code: 'KNOWLEDGE_PHASE_INVALID' });
  }
  return { execute };
}
