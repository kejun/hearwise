import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deadline, closeServer } from './lifecycle.mjs';
import { readProcessDurable, providerResponse, providerActor } from './process-crash-fixture.mjs';

const workerFile = fileURLToPath(new URL('./process-crash-worker.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function createProcessProtocolAdapter(config = { protocol: 'knowledge', parts: 1 }) {
  assert.ok(['knowledge', 'relation'].includes(config.protocol));
  assert.ok(['none', 'reset_on_recovery'].includes(config.mutation || 'none'));
  if (config.protocol === 'knowledge') assert.ok([1, 2].includes(config.parts));
  else { assert.ok([1, 3].includes(config.actors)); assert.ok([1, 2].includes(config.capacity));
    assert.ok(['valid', 'reserve_fail', 'no_candidates'].includes(config.mode || 'valid')); }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-process-crash-'));
  const filename = path.join(directory, 'store.sqlite'), manifestFile = path.join(directory, 'manifest.json');
  const acceptedSnapshots = new Map(), baseline = new Map();
  const launches = [];
  const ledger = [], pending = new Map(), messages = [], exits = [], history = [], children = [];
  let child, exitPromise, latest, manifest, generation = 0, crashes = 0, alive = false, closed = false, boundary = null;
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; assert.ok(length <= 200000); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString()), input = JSON.parse(body.messages.at(-1).content);
      const actor = providerActor(input);
      const requestGeneration = Number(request.url.split('/').at(-1));
      assert.ok(Number.isSafeInteger(requestGeneration));
      const row = { id: ledger.length + 1, generation: requestGeneration, actor, kind: config.protocol === 'relation' ? 'relation' : input.rejected ? 'repair' : 'extract',
        receivedAt: new Date().toISOString(), response: null, closed: false };
      ledger.push(row); pending.set(row.id, { response, input, row });
      // This independent provider's ledger survives SIGKILL of the application.
      appendFileSync(path.join(directory, 'provider-ledger.ndjson'), JSON.stringify(row) + '\n');
      response.once('close', () => { row.closed = true; });
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  appendFileSync(path.join(directory, 'provider-ledger.ndjson'), '');
  const endpoint = `http://127.0.0.1:${server.address().port}/synthetic-provider`;
  const waitFor = async (predicate, label, ms = 5000) => {
    const until = Date.now() + ms;
    while (!closed && Date.now() < until) {
      const value = await predicate(); if (value) return value;
      const abnormal = exits.find(exit => exit.generation === generation && exit.reason === 'unexpected');
      if (abnormal) throw new Error(`Worker exited unexpectedly: ${JSON.stringify(abnormal)}`);
      const failure = messages.find(message => message.generation === generation && message.type === 'command-error');
      if (failure) throw new Error(`${label}: ${JSON.stringify(failure.error)}`);
      await pause(10);
    }
    throw new Error(`${label} exceeded ${ms}ms or fixture closed`);
  };
  const stateAfter = (index, labels, ms = 5000) => waitFor(() => messages.slice(index).find(message => message.type === 'state' &&
    message.generation === generation && labels.includes(message.label)), `worker ${generation}: ${labels.join('/')}`, ms);
  const send = command => { assert.ok(alive && child.connected); child.send(command); };
  async function start() {
    const index = messages.length, env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    child = spawn(process.execPath, [workerFile, JSON.stringify({ ...config, directory, endpoint: `${endpoint}/${generation}`, generation, clock: latest?.clock })],
      { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const running = child, currentGeneration = generation;
    children.push(running); launches.push({ generation, pid: running.pid, startedAt: new Date().toISOString() }); alive = true;
    running.stdout.on('data', bytes => appendFileSync(path.join(directory, `worker-${currentGeneration}.log`), bytes));
    running.stderr.on('data', bytes => appendFileSync(path.join(directory, `worker-${currentGeneration}.log`), bytes));
    running.on('message', message => {
      messages.push(message);
      if (message.type === 'state' && message.generation === generation) latest = message;
    });
    exitPromise = new Promise(resolve => running.once('exit', (code, signal) => {
      const exit = { generation: currentGeneration, pid: running.pid, code, signal, reason: running.fixtureExitReason || 'unexpected', at: new Date().toISOString() };
      exits.push(exit); if (running === child) alive = false; resolve(exit);
    }));
    await stateAfter(index, ['ready']); manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    boundary = null;
    if (generation === 0) {
      const initial = durable();
      if (config.protocol === 'knowledge') for (const item of initial.knowledge) baseline.set(item.id, item);
      else for (const row of initial.actors) baseline.set(row.actor, row.knowledge);
    }
  }
  const durable = () => readProcessDurable(filename, manifest);
  const observe = () => ({ ...structuredClone(latest), processState: alive ? 'up' : 'down', generation, crashes,
    pid: child?.pid, evidenceIdentity: { databasePath: filename, ledgerPath: path.join(directory, 'provider-ledger.ndjson'), providerPid: process.pid, providerUrl: endpoint }, launches: structuredClone(launches), boundary: structuredClone(boundary), durable: durable(), ledger: structuredClone(ledger),
    exits: structuredClone(exits), history: structuredClone(history) });
  const project = () => {
    if (config.protocol === 'relation') {
      const rows = durable().actors;
      return { processState: alive ? 'up' : 'down', generation, ...Object.fromEntries(['phase', 'counts', 'calls', 'relations', 'outcome', 'replies', 'ready'].map(field => [field,
        Object.fromEntries(rows.map(row => { const task = latest.tasks[row.actor]; return [row.actor, field === 'counts' ? row.budget :
          field === 'calls' ? ledger.filter(call => call.actor === row.actor).length : field === 'relations' ? row.relations.length :
          field === 'replies' ? task.reply : field === 'ready' ? !(row.jobs.at(-1)?.ready_at > latest.clock) : task[field]]; }))])) };
    }
    const cp = durable().checkpoint, map = select => Object.fromEntries(cp.parts.map(part => [part.part_no, select(part)]));
    const next = cp.parts.find(part => part.phase !== 'done');
    const due = Math.max(latest.schedulerReadyAt || 0, next?.ready_at || 0, (cp.progress.last_request_at || 0) + 2000,
      cp.progress.rate_limit_until || 0, cp.job.retry_at ? Date.parse(cp.job.retry_at) : 0);
    return { processState: alive ? 'up' : 'down', generation, stage: alive ? latest.stage : 'down', outcome: cp.job.outcome || 'none',
      ready: latest.stage !== 'idle' || due <= latest.clock, extra_requests: cp.progress.extra_requests,
      protocol_retries: cp.progress.protocol_retries, cycle: cp.progress.cycle, phase: map(part => part.phase),
      initial_requests: map(part => part.initial_requests), repair_reserved: map(part => part.repair_reserved),
      extract_calls: map(part => ledger.filter(row => row.actor === part.part_no && row.kind === 'extract').length),
      repair_calls: map(part => ledger.filter(row => row.actor === part.part_no && row.kind === 'repair').length),
      initial_complete: map(part => Boolean(part.stats.initial_complete)), retry_kind: map(part => part.stats.retry_kind || 'none'),
      accepted: map(part => part.results.map(result => result.sourceIndex).sort((a, b) => a - b)),
      unresolved: map(part => part.unresolved.map(target => target.sourceIndex).sort((a, b) => a - b)),
      anchored: map(part => part.unresolved.filter(target => target.anchor).map(target => target.sourceIndex).sort((a, b) => a - b)),
      replies: map(part => latest.replies[part.part_no]) };
  };
  const check = () => {
    if (config.protocol === 'relation') return durable().actors.flatMap(row => {
      const failures = [], task = latest.tasks[row.actor], job = row.jobs.at(-1);
      const expect = (condition, message) => { if (!condition) failures.push(`actor ${row.actor}: ${message}`); };
      expect(isDeepStrictEqual(row.knowledge, baseline.get(row.actor)), 'relation workflow changed existing knowledge');
      for (const relation of row.relations) {
        expect(relation.predicate === 'released' && relation.version === 1 && relation.assertions.length === 1 && relation.assertions[0].supports.length > 0, 'committed relation lost or reapplied');
        if (acceptedSnapshots.has(relation.id)) expect(JSON.stringify(relation) === acceptedSnapshots.get(relation.id), 'committed graph changed after first commit');
        else acceptedSnapshots.set(relation.id, JSON.stringify(relation));
      }
      expect(row.budget === row.journal.length && row.budget <= 3, 'durable reservation ledger mismatch or budget exceeded');
      expect(ledger.filter(call => call.actor === row.actor).length <= row.budget, 'external provider call lacks durable reservation');
      if (alive && ['reserved', 'inflight', 'received'].includes(task.phase)) expect(job?.state === 'running' && row.window.state === 'pending', 'active request not durably running');
      if (task.phase === 'committed' || (task.phase === 'done' && ['ok', 'empty'].includes(task.outcome))) {
        expect(job?.state === 'complete' && row.window.state === 'complete', 'committed success not durably complete');
        expect(row.journal.at(-1)?.outcome === 'complete', 'successful request ledger not complete');
      }
      return failures;
    });
    const saved = durable(), cp = saved.checkpoint, failures = [];
    const expect = (condition, label) => { if (!condition) failures.push(label); };
    for (const [id, item] of baseline) expect(isDeepStrictEqual(saved.knowledge.find(row => row.id === id), item), 'baseline knowledge changed');
    expect(cp.progress.extra_requests === cp.parts.reduce((sum, part) => sum + Math.max(0, part.initial_requests - 1), 0), 'shared budget differs from per-part reservations');
    if (alive && latest.stage === 'idle') expect(cp.job.state === 'pending', 'idle continuation not pending');
    if (alive && ['reserved', 'inflight', 'received'].includes(latest.stage)) expect(cp.job.state === 'running', 'active request not running');
    if (latest.stage === 'committed') expect(cp.job.state === 'pending' && cp.job.outcome === null, 'result checkpoint not pending before settlement');
    if (latest.stage === 'done') expect(cp.job.state === (cp.job.outcome === 'invalid' ? 'failed' : 'complete') && ['ok', 'empty', 'partial', 'invalid'].includes(cp.job.outcome), 'terminal job state/outcome mismatch');
    if (cp.progress.cycle !== 1 || cp.progress.extra_requests > 2 || cp.progress.protocol_retries > 1) failures.push('automatic budget/cycle changed');
    for (const part of cp.parts) {
      if (ledger.filter(row => row.actor === part.part_no && row.kind === 'extract').length > part.initial_requests ||
        ledger.filter(row => row.actor === part.part_no && row.kind === 'repair').length > part.repair_reserved) failures.push('provider invocation without durable reservation');
      expect((part.stats.request_count || 0) === part.initial_requests + part.repair_reserved, 'request stats differ from reservations');
      for (const result of part.results) {
        const item = saved.knowledge.find(row => row.id === result.itemId);
        const initialReply = ledger.findLast(row => row.actor === part.part_no && row.kind === 'extract' && ['ok', 'partial', 'rejected', 'unrepairable', 'empty'].includes(row.response))?.response;
        const name = `${initialReply === 'rejected' || result.sourceIndex === 1 ? 'Nova' : 'Atlas'} ${part.part_no}`;
        expect(item?.canonical_name === name && item?.content_version === 1 && item?.facts.length === 1 &&
          item?.facts[0]?.content === `原文正在讨论${name}。` && item?.facts[0]?.surface_text === name &&
          item?.facts[0]?.segment_id === part.focus_refs[0].segment_id, 'accepted content identity/fact/source lost or reapplied');
        if (acceptedSnapshots.has(result.itemId)) expect(JSON.stringify(item) === acceptedSnapshots.get(result.itemId), 'accepted content changed after first commit');
        else if (item) acceptedSnapshots.set(result.itemId, JSON.stringify(item));
      }
      if (part.repair_reserved > 1 || new Set(part.results.map(row => row.sourceIndex)).size !== part.results.length) failures.push('repair/result repeated');
    }
    return failures;
  };
  async function releaseBoundary(action) {
    assert.ok(boundary);
    const release = boundary.release;
    // The worker polls existence synchronously; publish only the complete command.
    await writeFile(`${release}.tmp`, `${action}\n`);
    await rename(`${release}.tmp`, release);
  }
  async function act({ action, actor = -1, response }) {
    assert.equal(closed, false);
    const index = messages.length;
    if (action === 'crash') {
      assert.ok(alive); assert.equal(crashes, 0, 'This finite domain permits one crash');
      assert.ok(config.protocol === 'knowledge' ? ['reserved', 'inflight', 'received', 'committed'].includes(latest.stage) :
        latest.tasks.some(task => ['reserved', 'inflight', 'received', 'committed'].includes(task.phase)), 'Crash requires a handshaken active boundary');
      const before = observe(); delete before.history; const oldPid = child.pid; child.fixtureExitReason = 'crash';
      if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL');
      const exit = await deadline(() => exitPromise, 3000, 'SIGKILL exit acknowledgement');
      assert.equal(exit.signal, 'SIGKILL'); assert.equal(exit.pid, oldPid); crashes++;
      for (const entry of pending.values()) if (entry.row.generation === generation) entry.response.destroy();
      history.push({ action: 'crash', generation, pid: oldPid, before, exit, after: durable() }); boundary = null;
    } else if (action === 'abnormal_exit') {
      send({ command: 'abnormal_exit' }); await deadline(() => exitPromise, 3000, 'abnormal worker exit acknowledgement');
    } else if (action === 'recover') {
      assert.equal(alive, false); assert.equal(exits.at(-1)?.signal, 'SIGKILL');
      assert.equal(exits.at(-1)?.reason, 'crash'); assert.equal(crashes, generation + 1);
      const before = durable(); generation++; await start();
      history.push({ action: 'recover', generation, pid: child.pid, before, after: durable() });
    } else if (['admit', 'settle', 'settle_exhausted', 'reserve_fail'].includes(action)) {
      send({ command: action === 'settle_exhausted' ? 'settle' : action, actor }); await stateAfter(index, ['reserved', 'settled']);
    } else if (action === 'send') {
      const count = ledger.length; send({ command: 'send', actor });
      await waitFor(() => ledger.length > count, 'independent provider request receipt');
      await stateAfter(index, ['inflight']);
    } else if (action === 'response') {
      const request = [...pending.values()].find(row => row.row.generation === generation && row.row.actor === actor && !row.row.response && !row.row.closed);
      assert.ok(request, 'No externally observed request is awaiting a response');
      send({ command: 'response', actor, response }); await stateAfter(index, ['response-selected']);
      request.row.response = response;
      appendFileSync(path.join(directory, 'provider-ledger.ndjson'), JSON.stringify({ event: 'response', id: request.row.id, response, at: new Date().toISOString() }) + '\n');
      const result = providerResponse(request.input, response);
      request.response.writeHead(result.status || 200, { 'content-type': 'application/json', ...(result.retryAfter ? { 'retry-after': result.retryAfter } : {}) });
      request.response.end(JSON.stringify(result.body));
      await stateAfter(index, ['received', 'settled']);
    } else if (action === 'commit_fail' || action === 'commit_locked') {
      send({ command: action === 'commit_locked' ? 'commit' : action, actor });
      await stateAfter(index, ['settled'], action === 'commit_locked' ? 10000 : 5000);
    } else if (action === 'commit') {
      send({ command: 'commit', actor });
      boundary = await waitFor(async () => {
        const files = (await readdir(directory)).filter(file => file.startsWith(`boundary-${generation}-`) && file.endsWith('.json'));
        if (!files.length) return null;
        const values = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(directory, file), 'utf8'))));
        return values.find(value => !history.some(row => row.boundaryId === value.id));
      }, 'committed SQLite before the first result notification');
      latest = { ...boundary, type: 'state', label: 'committed' }; history.push({ action: 'commit', boundaryId: boundary.id });
    } else if (action === 'notify' || action === 'notify_fail') {
      await releaseBoundary(action); await stateAfter(index, ['settled']); boundary = null;
    } else if (action === 'advance_time') {
      send({ command: 'advance_time' }); await stateAfter(index, ['clock']);
    } else if (action === 'pump') { send({ command: 'pump' }); await stateAfter(index, ['pumped']);
    } else if (action !== 'stutter') throw new Error(`Unsupported crash action: ${action}`);
    return project();
  }
  const terminateOwnedWorkers = () => {
    for (const owned of children) if (owned.pid && owned.exitCode == null && owned.signalCode == null) {
      try { if (process.platform === 'win32') owned.kill('SIGKILL'); else process.kill(-owned.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  };
  process.on('SIGINT', terminateOwnedWorkers); process.on('SIGTERM', terminateOwnedWorkers); process.on('exit', terminateOwnedWorkers);
  let writeLock;
  function holdWriteLock() {
    assert.equal(writeLock, undefined); writeLock = new DatabaseSync(filename); writeLock.exec('BEGIN IMMEDIATE');
    return () => { if (writeLock) { writeLock.exec('ROLLBACK'); writeLock.close(); writeLock = undefined; } };
  }
  async function close() {
    if (closed) return; closed = true;
    if (writeLock) { writeLock.exec('ROLLBACK'); writeLock.close(); writeLock = undefined; }
    if (alive) {
      child.fixtureExitReason = 'cleanup';
      if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL');
      await deadline(() => exitPromise, 3000, 'fixture process cleanup');
    }
    for (const entry of pending.values()) entry.response.destroy();
    await closeServer(server, 'independent crash provider'); await rm(directory, { recursive: true, force: true });
    process.removeListener('SIGINT', terminateOwnedWorkers); process.removeListener('SIGTERM', terminateOwnedWorkers); process.removeListener('exit', terminateOwnedWorkers);
  }
  try { await start(); return { act, observe, project, check, close, holdWriteLock }; }
  catch (error) { await close(); throw error; }
}
