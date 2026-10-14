import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createKnowledgeWorkflow } from '../knowledge-workflow.mjs';
import { createKnowledgeScheduler } from '../knowledge-queue.mjs';
import { parseKnowledgeV2, parseKnowledgeRepair, splitFocusSegments } from '../knowledge.mjs';
import { deadline } from './lifecycle.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const wait = (gate, label) => deadline(() => gate.promise, 3000, label);
const item = (name, input, patch = {}) => ({ action: 'create', type: 'other', display_label: 'organization', canonical_name: name,
  role: '主体', reason: '本段讨论的公司', existing_item_id: null, observed_candidate_id: null, aliases: [], correction_reason: null,
  short_description: `${name}是本段讨论的公司。`, new_information: `原文正在讨论${name}。`, certainty: 'clear',
  evidence: [{ segment_id: input.focus_segments[0].id, quote: name }], ...patch });
const requestError = response => {
  const error = new Error(`Synthetic ${response}`);
  if (response === 'protocol') error.code = 'KNOWLEDGE_INVALID_RESPONSE';
  else if (response === 'transient') error.status = 500;
  else if (response === 'auth') error.status = 401;
  else if (response === 'rate_limit') Object.assign(error, { status: 429, retryAfterMs: 7000 });
  else if (response === 'rate_limit_long') Object.assign(error, { status: 429, retryAfterMs: 301000 });
  else assert.equal(response, 'unexpected');
  return error;
};

// Real scheduler + workflow + SQLite. Only provider outputs, time, observers and
// the existing context.step boundary are controlled by this isolated fixture.
export async function createKnowledgeProtocolAdapter({ parts = 1, mutation = 'none' } = {}) {
  assert.ok([1, 2].includes(parts));
  assert.ok(['none', 'skip_reservation', 'corrupt_terminal_state', 'corrupt_accepted_content'].includes(mutation));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-knowledge-protocol-'));
  const filename = path.join(directory, 'store.sqlite');
  let store = new ListeningStore(filename);
  let scheduler, current, closed = false, enabled = false, clock = Date.now(), timerId = 0, stage = 'idle';
  const calls = Array.from({ length: parts }, () => ({ extract: 0, repair: 0 }));
  const replies = Array(parts).fill('none'), initialReplies = Array(parts).fill('none'), acceptedSnapshots = new Map(), errors = [], events = [], notifications = { sent: 0, failed: 0 };
  const timers = new Map();
  let run, job, baseline;
  try {
    run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Synthetic knowledge protocol');
    const first = 'Baseline seed. Atlas 0 and Nova 0 signed a deal. ';
    const text = parts === 1 ? first : first.padEnd(2500, 'x') + 'Atlas 1 and Nova 1 signed a deal.';
    const segment = store.addSegment(run.listeningId, run.runId, { id: 'protocol-original', text }).segment;
    job = store.createExtractionJob(run.listeningId, [segment]);
    const input = store.jobInput(job), offsets = new Map();
    const slices = splitFocusSegments(input).map((group, part_no) => ({ part_no,
      focus_refs: group.focus_segments.map(segment => {
        const start = offsets.get(segment.id) || 0, end = start + segment.text.length;
        offsets.set(segment.id, end); return { segment_id: segment.id, start, end };
      }) }));
    assert.equal(slices.length, parts);
    store.initializeKnowledgeParts(job.id, slices, 'v2.1');
    store.applyKnowledgeV2(run.listeningId, [item('Baseline seed', input)]);
    baseline = structuredClone(store.knowledge(run.listeningId)[0]);
  } catch (error) { store.close(); await rm(directory, { recursive: true, force: true }); throw error; }

  const notify = () => {
    notifications.sent++;
    if (current?.notifyFailure) { notifications.failed++; throw new Error('Synthetic observer failure'); }
  };
  const recordError = error => errors.push({ name: error.name, message: error.message, code: error.code || null });
  const provider = async (kind, input, targets) => {
    assert.equal(current.kind, kind);
    current.input = input; current.targets = targets;
    calls[current.actor][kind]++;
    stage = 'inflight'; current.gates.sent.resolve();
    return current.gates.response.promise;
  };
  function makeScheduler() {
    // Test-only mutations are scoped to this temporary store and never enabled by
    // the application's workflow or settings.
    if (mutation === 'skip_reservation') {
      const save = store.saveKnowledgeCheckpoint.bind(store);
      store.saveKnowledgeCheckpoint = (id, patch, accepted) => {
        if (patch.state === 'running' && patch.part && ['extract_inflight', 'repair_inflight'].includes(patch.part.phase)) {
          const before = store.knowledgeCheckpoint(id), part = before.parts.find(row => row.part_no === patch.part.part_no);
          patch = { ...patch, progress: { ...patch.progress, extra_requests: before.progress.extra_requests, protocol_retries: before.progress.protocol_retries },
            part: { ...patch.part, initial_requests: part.initial_requests, repair_reserved: part.repair_reserved,
              stats: { ...patch.part.stats, request_count: part.stats.request_count || 0 } } };
        }
        return save(id, patch, accepted);
      };
    }
    const workflow = createKnowledgeWorkflow({ store, now: () => clock, endpoint: 'mock://knowledge-protocol-no-network',
      extract: (_key, input) => provider('extract', input), repair: (_key, input, _endpoint, targets) => provider('repair', input, targets),
      onItems: notify, onProgress: notify, onRejected: notify, onDiagnostic: notify,
      onError: error => { recordError(error); if (current?.notifyFailure) throw new Error('Synthetic diagnostic failure'); } });
    return createKnowledgeScheduler({ store, now: () => clock, listeningIds: () => [run.listeningId],
      keyFor: () => enabled ? 'synthetic-not-a-key' : null, translationBusy: () => false,
      setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; },
      clearTimer: id => timers.delete(id), onChange: notify, onLog: notify, onError: recordError,
      onIdle: () => {
        const saved = store.knowledgeCheckpoint(job.id).job;
        stage = ['complete', 'failed'].includes(saved.state) ? 'done' : 'idle';
        current.gates.finished.resolve();
      },
      execute: async (started, key, context) => {
        try {
          const result = await workflow.execute(started, key, { ...context,
            event: (name, attributes) => { events.push({ name, attributes }); context.event(name, attributes); },
            step: (name, operation) => context.step(name, async child => {
              assert.equal(name, `knowledge.${current.kind}`);
              replies[current.actor] = 'none';
              stage = 'reserved'; current.gates.reserved.resolve();
              await current.gates.send.promise; child.signal.throwIfAborted();
              const response = await operation(child);
              stage = 'received'; current.gates.received.resolve();
              await current.gates.commit.promise; child.signal.throwIfAborted();
              return response;
            }) });
          if (mutation === 'corrupt_terminal_state' && result.kind === 'terminal' && result.outcome === 'ok') {
            store.db.prepare("UPDATE extraction_jobs SET state='failed' WHERE id=?").run(job.id);
          }
          if (mutation === 'corrupt_accepted_content' && current.kind === 'repair' && result.kind === 'terminal') {
            const accepted = store.knowledgeCheckpoint(job.id).parts[current.actor].results[0];
            if (accepted) store.db.prepare("UPDATE knowledge_facts SET content='synthetic corrupted accepted content' WHERE item_id=?").run(accepted.itemId);
          }
          current.result = result; return result;
        } catch (error) { current.error = { name: error.name, message: error.message }; throw error; }
      }
    });
  }
  scheduler = makeScheduler();

  function parseResponse(response) {
    const { actor, kind, input, targets } = current;
    if (kind === 'repair') {
      assert.ok(['ok', 'empty'].includes(response));
      return parseKnowledgeRepair(JSON.stringify({ corrections: response === 'empty' ? [] : targets.filter(target => target.anchor)
        .map(target => ({ rejection_id: target.rejection_id, item: { ...target.rawItem, role: '主体' } })) }), input, targets);
    }
    initialReplies[actor] = response;
    const valid = item(`Atlas ${actor}`, input), rejected = item(`Nova ${actor}`, input, { role: null });
    const items = response === 'ok' ? [valid] : response === 'empty' ? [] : response === 'partial' ? [valid, rejected] :
      response === 'rejected' ? [rejected] : response === 'unrepairable' ? [{ ...rejected, canonical_name: null }] : null;
    assert.ok(items, `Unsupported successful extract response ${response}`);
    return parseKnowledgeV2(JSON.stringify({ items }), input);
  }
  const observe = () => ({ clock, stage, checkpoint: store.knowledgeCheckpoint(job.id), knowledge: store.knowledge(run.listeningId),
    calls: structuredClone(calls), replies: [...replies], nextJob: store.nextJob(run.listeningId) || null,
    result: current?.result || null, error: current?.error || null, errors: [...errors], events: [...events], notifications: { ...notifications } });
  const project = () => {
    const actual = observe(), { checkpoint: cp } = actual;
    const map = field => Object.fromEntries(cp.parts.map(part => [part.part_no, field(part)]));
    const readyAt = Math.max(actual.nextJob?.ready_at || 0, actual.nextJob?.retry_at ? Date.parse(actual.nextJob.retry_at) : 0);
    return { stage, outcome: cp.job.outcome || 'none', ready: stage !== 'idle' || readyAt <= clock,
      extra_requests: cp.progress.extra_requests, protocol_retries: cp.progress.protocol_retries, cycle: cp.progress.cycle,
      phase: map(part => part.phase), initial_requests: map(part => part.initial_requests), repair_reserved: map(part => part.repair_reserved),
      extract_calls: map(part => calls[part.part_no].extract), repair_calls: map(part => calls[part.part_no].repair),
      initial_complete: map(part => Boolean(part.stats.initial_complete)), retry_kind: map(part => part.stats.retry_kind || 'none'),
      accepted: map(part => part.results.map(result => result.sourceIndex).sort((a, b) => a - b)),
      unresolved: map(part => part.unresolved.map(target => target.sourceIndex).sort((a, b) => a - b)),
      anchored: map(part => part.unresolved.filter(target => target.anchor).map(target => target.sourceIndex).sort((a, b) => a - b)),
      replies: map(part => replies[part.part_no]) };
  };
  const check = () => {
    const actual = observe(), cp = actual.checkpoint, failures = [];
    const expect = (ok, label) => { if (!ok) failures.push(label); };
    expect(JSON.stringify(actual.knowledge.find(item => item.id === baseline.id)) === JSON.stringify(baseline), 'existing knowledge changed');
    expect(cp.progress.cycle === 1, 'automatic execution changed the processing cycle');
    expect(cp.progress.extra_requests <= 2 && cp.progress.protocol_retries <= 1, 'durable automatic retry budget exceeded');
    expect(cp.progress.extra_requests === cp.parts.reduce((n, part) => n + Math.max(0, part.initial_requests - 1), 0), 'extra budget differs from per-part reservations');
    if (stage === 'idle') expect(cp.job.state === 'pending', 'continuation is not durably pending');
    if (['reserved', 'inflight', 'received'].includes(stage)) expect(cp.job.state === 'running', 'active request is not durably running');
    if (stage === 'done') expect(cp.job.state === (cp.job.outcome === 'invalid' ? 'failed' : 'complete') && ['ok', 'empty', 'partial', 'invalid'].includes(cp.job.outcome), 'terminal state/outcome mismatch');
    for (const part of cp.parts) {
      const id = part.part_no, accepted = new Set(part.results.map(result => result.sourceIndex));
      expect(accepted.size === part.results.length, `part ${id}: repeated accepted sourceIndex`);
      expect(part.unresolved.every(target => !accepted.has(target.sourceIndex)), `part ${id}: resolved target remains eligible`);
      expect(calls[id].extract <= part.initial_requests && calls[id].repair <= part.repair_reserved, `part ${id}: invocation lacks durable reservation`);
      expect((part.stats.request_count || 0) === part.initial_requests + part.repair_reserved, `part ${id}: request accounting differs from reservations`);
      expect(part.repair_reserved <= 1, `part ${id}: repair was reserved more than once`);
      for (const result of part.results) {
        const saved = actual.knowledge.find(item => item.id === result.itemId);
        expect(saved && saved.content_version === 1 && saved.facts.length === 1, `part ${id}: accepted content lost or reapplied`);
        const name = `${initialReplies[id] === 'rejected' || result.sourceIndex === 1 ? 'Nova' : 'Atlas'} ${id}`;
        expect(saved?.canonical_name === name && saved?.dialogue_summary === `原文正在讨论${name}。` &&
          saved?.facts[0]?.content === `原文正在讨论${name}。` && saved?.facts[0]?.surface_text === name &&
          saved?.facts[0]?.segment_id === part.focus_refs[0].segment_id, `part ${id}: accepted content identity/fact/source changed`);
        const snapshot = JSON.stringify(saved);
        if (acceptedSnapshots.has(result.itemId)) expect(acceptedSnapshots.get(result.itemId) === snapshot, `part ${id}: accepted content changed after its first commit`);
        else acceptedSnapshots.set(result.itemId, snapshot);
      }
    }
    return failures;
  };
  async function act({ action, actor, response, milliseconds }) {
    assert.equal(closed, false);
    if (action === 'stutter') { assert.equal(stage, 'done'); return project(); }
    if (action === 'advance_time') {
      const next = store.nextJob(run.listeningId);
      if (milliseconds != null) { assert.ok(Number.isSafeInteger(milliseconds) && milliseconds >= 0); clock += milliseconds; }
      else clock = Math.max(clock, next?.ready_at || 0, next?.retry_at ? Date.parse(next.retry_at) : 0);
      return project();
    }
    if (['admit', 'reserve_fail', 'probe_admit'].includes(action)) {
      assert.equal(stage, 'idle'); if (action !== 'probe_admit') assert.equal(project().ready, true);
      const part = store.knowledgeCheckpoint(job.id).parts.find(part => part.phase !== 'done');
      assert.equal(part?.part_no ?? -1, actor, 'Trace must dispatch the first unfinished part');
      current = { actor, kind: part?.phase === 'repair_pending' ? 'repair' : 'extract', gates: Object.fromEntries(
        ['reserved', 'send', 'sent', 'response', 'received', 'commit', 'finished'].map(name => [name, deferred()])) };
      if (action === 'reserve_fail') store.db.exec("CREATE TEMP TRIGGER protocol_reservation_failure BEFORE UPDATE ON extraction_parts WHEN NEW.phase IN ('extract_inflight','repair_inflight') BEGIN SELECT RAISE(ABORT,'synthetic reservation failure'); END");
      try {
        enabled = true; scheduler.pump(); enabled = false;
        if (action === 'probe_admit') await new Promise(resolve => setImmediate(resolve));
        else await deadline(() => Promise.race([current.gates.reserved.promise, current.gates.finished.promise]), 3000, 'knowledge durable reservation');
      } finally { enabled = false; if (action === 'reserve_fail') store.db.exec('DROP TRIGGER protocol_reservation_failure'); }
    } else if (action === 'send') {
      assert.equal(stage, 'reserved'); assert.equal(current.actor, actor);
      current.gates.send.resolve(); await wait(current.gates.sent, 'knowledge provider invocation');
    } else if (action === 'response') {
      assert.equal(stage, 'inflight'); assert.equal(current.actor, actor); replies[actor] = response;
      if (['ok', 'empty', 'partial', 'rejected', 'unrepairable'].includes(response)) {
        current.gates.response.resolve(parseResponse(response)); await wait(current.gates.received, 'knowledge provider response');
      } else {
        current.gates.response.reject(requestError(response)); await wait(current.gates.finished, 'knowledge failed request settlement');
      }
    } else if (['commit', 'commit_fail', 'commit_notify_failure'].includes(action)) {
      assert.equal(stage, 'received'); assert.equal(current.actor, actor);
      current.notifyFailure = action === 'commit_notify_failure';
      if (action === 'commit_fail') store.db.exec("CREATE TEMP TRIGGER protocol_commit_failure BEFORE UPDATE ON extraction_parts WHEN NEW.phase IN ('done','repair_pending') BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END");
      try { current.gates.commit.resolve(); await wait(current.gates.finished, 'knowledge commit and scheduler settlement'); }
      finally { if (action === 'commit_fail') store.db.exec('DROP TRIGGER protocol_commit_failure'); }
    } else throw new Error(`Unsupported knowledge protocol action: ${action}`);
    return project();
  }
  async function stopScheduler() {
    enabled = false;
    const closing = scheduler.close();
    for (const [name, gate] of Object.entries(current?.gates || {})) gate.resolve(name === 'response' ? { accepted: [], rejected: [] } : undefined);
    await deadline(() => closing, 3000, 'knowledge replay cleanup');
  }
  // Supplementary checkpoint-persistence checks, explicitly outside the finite
  // one-cycle model. Closing/reopening SQLite is not an OS process crash test.
  async function reopen() {
    assert.equal(closed, false);
    await stopScheduler(); store.close(); store = new ListeningStore(filename);
    current = null;
    stage = ['complete', 'failed'].includes(store.knowledgeCheckpoint(job.id).job.state) ? 'done' : 'idle';
    scheduler = makeScheduler();
  }
  function manualRetry() {
    const resumed = store.retry(run.listeningId);
    if (resumed) stage = 'idle';
    return resumed;
  }
  async function close() {
    if (closed) return; closed = true;
    try { await stopScheduler(); }
    finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  }
  return { act, project, observe, check, reopen, manualRetry, close };
}
