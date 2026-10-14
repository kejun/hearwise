import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createKnowledgeScheduler } from '../knowledge-queue.mjs';
import { createTaskRuntime } from '../dist/server/index.js';
import { createProviderAdmission } from '../provider-admission.mjs';
import { createTranslationServiceAdapter } from './scheduler-service-adapter.mjs';
import { deadline } from './lifecycle.mjs';

// Actual scheduler, runtime and SQLite. The injected executor represents legal
// v2 terminal/continuation outputs; paid HTTP semantics belong to KEJ-64/65.
export async function createKnowledgeSchedulerAdapter(config = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hearwise-scheduler-knowledge-'));
  let store, translation, runtime, scheduler;
  config.resourceAudit?.push({ type: 'directory', path: directory });
  try {
    store = new ListeningStore(path.join(directory, 'fixture.sqlite'));
    if (config.initializationFailure === 'store') throw new Error('Controlled initialization failure after store');
    translation = await createTranslationServiceAdapter({ background: [] });
    config.resourceAudit?.push({ type: 'child', pid: translation.processId });
    if (config.initializationFailure === 'translation') throw new Error('Controlled initialization failure after translation');
    let translationState = await translation.observe();
    let clock = Date.now(), lastServed = -1, closed = false, disposed = false, sequence = 0, recentStarts = [];
    const tokens = config.jobs || [0, 1, 2], runs = [], jobs = new Map(), keys = new Map(), timers = new Map();
    const calls = [], logs = [], admissions = [], errors = [], cancelled = new Set(), lastStarted = new Map();
    const session = actor => actor === 2 ? 1 : 0;
    const keyIndex = id => config.separateKeys ? id : 0;
    const key = id => `synthetic-knowledge-key-${keyIndex(id)}`;
    const provider = createProviderAdmission({ now: () => clock });
    for (let id = 0; id < 2; id++) {
      const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, `Scheduler ${id}`);
      runs.push(run); keys.set(run.listeningId, key(id));
    }
    for (const actor of tokens) {
      const run = runs[session(actor)];
      const segment = store.addSegment(run.listeningId, run.runId, { id: `scheduler-${actor}`, text: `Synthetic scheduler item ${actor}.` }).segment;
      const job = store.createExtractionJob(run.listeningId, [segment]); jobs.set(actor, job);
      store.initializeKnowledgeParts(job.id, [{ part_no: 0, focus_refs: [{ segment_id: segment.id, start: 0, end: segment.original_text.length }] }]);
      store.db.prepare('UPDATE extraction_jobs SET created_at=? WHERE id=?').run(new Date(clock).toISOString(), job.id);
    }
    for (const run of runs) store.finishRun(run.runId);
    // Observe the real storage admission boundary without changing its arguments,
    // transaction, return value or scheduler ordering. The saved pre-write row
    // is independently bound to the preceding raw SQLite observation by the gate.
    const admissionInputs = new Map(), originalMarkJob = store.markJob.bind(store);
    store.markJob = (id, state, ...args) => {
      if (state === 'running') admissionInputs.set(id, store.knowledgeCheckpoint(id));
      return originalMarkJob(id, state, ...args);
    };
    const actorForJob = id => [...jobs].find(([, job]) => job.id === id)?.[0];
    const sessionForListening = id => runs.findIndex(run => run.listeningId === id);
    const busy = () => Boolean(translationState.service.queueLength || translationState.service.final || translationState.service.interim);
    runtime = createTaskRuntime();
    const faultRuntime = config.startErrorActor == null ? runtime : { start(name, attributes, operation) {
      if (attributes.job_id === jobs.get(config.startErrorActor).id) throw new Error('Controlled runtime.start failure');
      return runtime.start(name, attributes, operation);
    } };
    scheduler = createKnowledgeScheduler({ store, provider, taskRuntime: faultRuntime, now: () => clock,
      listeningIds: () => runs.filter(run => store.hasListening(run.listeningId)).map(run => run.listeningId),
      keyFor: id => keys.get(id), translationBusy: busy,
      setTimer: (callback, ms) => { const id = ++sequence; timers.set(id, { callback, at: clock + ms }); return id; },
      clearTimer: id => timers.delete(id),
      onChange: () => { if (config.observerFault) throw new Error('Controlled observer failure'); },
      onError: error => errors.push({ name: error.name, message: error.message }),
      onLog: entry => {
        logs.push(entry);
        if (entry.state === 'running') {
          const actor = actorForJob(entry.job_id), job = jobs.get(actor);
          const current = admissionInputs.get(job.id); assert.ok(current);
          admissions.push({ actor, at: clock, checkpointBefore: structuredClone(current), runningBefore: calls.filter(call => !call.ended).map(call => call.actor),
            translation: structuredClone(translationState.service), previousStart: lastStarted.get(session(actor)) ?? null,
            createdAt: Date.parse(current.job.created_at), retryAt: current.job.retry_at ? Date.parse(current.job.retry_at) : 0,
            readyAt: current.parts[0].ready_at, providerReadyAt: provider.readyAt(key(session(actor))) });
          recentStarts.push(actor); lastServed = session(actor); lastStarted.set(session(actor), clock);
        }
      },
      execute: (job, _key, context) => {
        const actor = actorForJob(job.id);
        const call = { actor, session: session(actor), attempt: job.attempts, startedAt: clock, ended: false, cancelled: false, signal: context.signal };
        calls.push(call);
        return new Promise((resolve, reject) => {
          call.resolve = resolve; call.reject = reject;
          call.abort = () => { call.cancelled = true; reject(context.signal.reason); };
          context.signal.addEventListener('abort', call.abort, { once: true });
        }).finally(() => { call.ended = true; context.signal.removeEventListener('abort', call.abort); });
      }
    });
    async function drain() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); }
    function observe() {
      return { clock, closed, identity: { jobs: Object.fromEntries([...jobs].map(([actor, job]) => [actor, job.id])), sessions: runs.map(run => run.listeningId) },
        listenings: runs.flatMap((run, id) => store.hasListening(run.listeningId) ? [id] : []),
        keyAvailable: Object.fromEntries(runs.map((run, id) => [id, keys.has(run.listeningId)])), jobs: structuredClone(Object.fromEntries(tokens.map(actor => [actor, store.knowledgeCheckpoint(jobs.get(actor).id)]))),
        translation: translationState, calls: calls.map(({ resolve, reject, signal, abort, ...call }) => ({ ...call, signalAborted: signal.aborted })),
        admissions: structuredClone(admissions), logs: structuredClone(logs), errors: structuredClone(errors),
        deadlines: { lastStarted: Object.fromEntries(lastStarted), provider: [0, 1].map(id => provider.readyAt(key(id))), timers: [...timers.values()].map(timer => timer.at) } };
    }
    function project() {
      const phase = {}, durable = {};
      for (const actor of tokens) {
        const checkpoint = store.knowledgeCheckpoint(jobs.get(actor).id);
        durable[actor] = checkpoint?.job.state || 'deleted';
        phase[actor] = cancelled.has(actor) || !checkpoint ? 'cancelled' : checkpoint.job.state;
      }
      return { phase, durable, running: calls.filter(call => !call.ended).map(call => call.actor).sort((a, b) => a - b),
        lastServed, recentStarts: [...recentStarts], translationWaiting: translationState.service.queueLength,
        translationRunning: translationState.service.final, interim: translationState.service.interim, closed,
        listenings: runs.flatMap((run, id) => store.hasListening(run.listeningId) ? [id] : []),
        keyAvailable: Object.fromEntries(runs.map((run, id) => [id, keys.has(run.listeningId)])) };
    }
    async function setTranslation(waiting, finals, optional) {
      for (const actor of [...translationState.queue]) translationState = await translation.act({ action: 'cancel_queued', actor });
      for (const actor of [...translationState.running]) translationState = await translation.act({ action: 'settle_final', actor, argument: 'success' });
      if (translationState.service.interim) translationState = await translation.act({ action: 'settle_interim', argument: 'success' });
      if (optional) translationState = await translation.act({ action: 'admit_interim' });
      for (let actor = 0; actor < finals; actor++) translationState = await translation.act({ action: 'enqueue', actor });
      if (finals) translationState = await translation.act({ action: 'pump' });
      if (waiting) translationState = await translation.act({ action: 'enqueue', actor: 2 });
      assert.deepEqual([translationState.service.queueLength, translationState.service.final, translationState.service.interim], [waiting, finals, optional]);
    }
    async function act({ action, actor = -1, argument = '' }) {
      recentStarts = [];
      if (action === 'pump') scheduler.pump();
      else if (action === 'set_translation') { const [finals, optional] = argument.split(',').map(Number); await setTranslation(actor, finals, optional); }
      else if (action === 'advance_time') {
        const deadlines = [...timers.values()].map(timer => timer.at);
        for (const time of lastStarted.values()) deadlines.push(time + 2000);
        for (const run of runs) {
          deadlines.push(provider.readyAt(key(sessionForListening(run.listeningId))));
          for (const job of store.detail(run.listeningId)?.jobs || []) {
            deadlines.push(Date.parse(job.created_at) + 1500, job.retry_at ? Date.parse(job.retry_at) : 0);
            const checkpoint = store.knowledgeCheckpoint(job.id);
            deadlines.push(...checkpoint.parts.map(part => part.ready_at));
          }
        }
        clock = Math.max(clock + 1, ...deadlines);
      } else if (action === 'block_provider') provider.coolDown(`synthetic-knowledge-key-${actor}`, 7000);
      else if (action === 'set_key') { if (argument === 'present') keys.set(runs[actor].listeningId, key(actor)); else keys.delete(runs[actor].listeningId); }
      else if (action === 'settle') {
        const call = calls.findLast(call => call.actor === actor && !call.ended); assert.ok(call);
        const job = jobs.get(actor), checkpoint = store.knowledgeCheckpoint(job.id);
        call.response = argument;
        if (argument === 'error' || argument === 'timeout') call.reject(Object.assign(new Error(`Controlled ${argument}`), { name: argument === 'timeout' ? 'TimeoutError' : 'Error' }));
        else if (argument === 'rate_limit') call.reject(Object.assign(new Error('Controlled rate limit'), { status: 429, retryAfterMs: 2000 }));
        else if (argument === 'continue' || argument === 'retry') {
          const readyAt = clock + 2000;
          store.saveKnowledgeCheckpoint(job.id, { state: 'pending', part: { ...checkpoint.parts[0], phase: 'extract_pending', ready_at: readyAt } });
          call.resolve({ kind: 'continue', reason: argument === 'retry' ? 'network_retry' : 'next_part', readyAt, summary: {} });
        } else {
          assert.equal(argument, 'success');
          store.saveKnowledgeCheckpoint(job.id, { state: 'complete', outcome: 'empty', part: { ...checkpoint.parts[0], phase: 'done', ready_at: 0 } });
          call.resolve({ kind: 'terminal', outcome: 'empty' });
        }
      } else if (action === 'remove') {
        const id = runs[actor].listeningId;
        for (const token of tokens) if (session(token) === actor) cancelled.add(token);
        assert.equal(store.removeListening(id), 'deleted'); keys.delete(id); scheduler.remove(id); lastStarted.delete(actor);
      } else if (action === 'close') {
        closed = true; for (const call of calls) if (!call.ended) cancelled.add(call.actor);
        await deadline(() => scheduler.close(), 3000, 'Knowledge cancellation');
      } else if (action === 'recycle') {
        throw new Error('Unreplayable abstract knowledge backlog recycle: actual new jobs require new source order and creation deadlines');
      } else if (action !== 'stutter') throw new Error(`Unknown knowledge scheduler action ${action}`);
      await drain(); return project();
    }
    async function close() {
      if (disposed) return; disposed = true;
      const failures = [];
      try { await deadline(() => scheduler.close(), 3000, 'Knowledge fixture shutdown'); } catch (error) { failures.push(error); }
      const cleanup = await Promise.allSettled([
        deadline(async () => { await runtime.dispose(); if (config.cleanupFailure) throw new Error('Controlled runtime disposal failure'); }, 3000, 'Knowledge runtime shutdown'),
        translation.close()
      ]);
      failures.push(...cleanup.filter(result => result.status === 'rejected').map(result => result.reason));
      try { store.close(); } catch (error) { failures.push(error); }
      finally { rmSync(directory, { recursive: true, force: true }); }
      if (failures.length) throw new AggregateError(failures, 'Knowledge fixture cleanup failed');
    }
    function check() {
      const violations = [];
      for (const admission of admissions) {
        const busy = Boolean(admission.translation.queueLength || admission.translation.final || admission.translation.interim);
        if (admission.runningBefore.length >= (busy ? 1 : 2)) violations.push('knowledge_new_admission_budget');
        if (admission.runningBefore.some(actor => session(actor) === session(admission.actor))) violations.push('knowledge_session_overlap');
        const due = Math.max(admission.readyAt, admission.retryAt, admission.providerReadyAt, admission.previousStart == null ? 0 : admission.previousStart + 2000, busy ? admission.createdAt + 1500 : 0);
        if (admission.at < due) violations.push('knowledge_early_admission');
      }
      return violations;
    }
    if (config.fairCycle) await setTranslation(1, 0, 0);
    return { act, observe, project, check, close };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      deadline(() => scheduler?.close(), 3000, 'Failed scheduler initialization cleanup'),
      deadline(() => runtime?.dispose(), 3000, 'Failed runtime initialization cleanup'),
      translation?.close()
    ]);
    const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    try { store?.close(); } catch (failure) { failures.push(failure); }
    finally { rmSync(directory, { recursive: true, force: true }); }
    if (failures.length) throw new AggregateError([error, ...failures], 'Knowledge initialization and cleanup failed');
    throw error;
  }
}
