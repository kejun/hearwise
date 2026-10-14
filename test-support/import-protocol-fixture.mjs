import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { ListeningStore } from '../storage.mjs';
import { exportDatabase } from '../data-transfer.mjs';
import { seedNameReplacement } from './name-replacement-fixture.mjs';
import { startServer } from './server-fixture.mjs';
import { closeServer, stopChild, deadline } from './lifecycle.mjs';

export function databaseSnapshot(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return { rows: Object.fromEntries(tables.map(({ name }) => [name,
      db.prepare(`SELECT * FROM "${name}"`).all().map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])),
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row })),
    foreignKeyErrors: db.prepare('PRAGMA foreign_key_check').all().map(row => ({ ...row })),
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check };
  } finally { db.close(); }
}

export async function importProtocolFixture({ tokens = 1, serverFile = 'server.mjs', unfinished = false, mutation = 'none', preloads = [], rich = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-import-protocol-'));
  let provider, ws, server, closed = false;
  async function close() {
    if (closed) return; closed = true;
    const results = await Promise.allSettled([server && stopChild(server.child),
      ws && closeServer(ws, 'import provider websocket'), provider && closeServer(provider, 'import provider HTTP')]);
    await rm(directory, { recursive: true, force: true });
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Import fixture cleanup failed');
  }
  try {
    const filename = path.join(directory, 'current.sqlite'), controlDirectory = path.join(directory, 'control');
    await mkdir(controlDirectory);
    assert.ok(['none', 'skip_http_revision'].includes(mutation));
    let mutationEvidence = null;
    if (mutation === 'skip_http_revision') {
      const source = await readFile('server.mjs', 'utf8');
      const from = 'const options = { prepared: true, revision: pending.info.revision };', to = 'const options = { prepared: true };';
      assert.equal(source.split(from).length - 1, 1, 'unique HTTP-to-storage revision guard anchor');
      const mutated = source.replace(from, to);
      const runnable = mutated.replace(/from '([^']+)'/g, (_, file) =>
        `from '${file.startsWith('./') ? pathToFileURL(path.resolve(file)).href : file.startsWith('node:') ? file : import.meta.resolve(file)}'`);
      serverFile = path.join(directory, 'server-without-revision.mjs');
      await writeFile(serverFile, runnable);
      const hash = text => createHash('sha256').update(text).digest('hex');
      mutationEvidence = { id: mutation, file: 'server.mjs', from, to, sourceSha256: hash(source), mutantSha256: hash(mutated), runnableSha256: hash(runnable) };
    }
    const seeds = [], backups = [], calls = [], lifecycle = [], clockEvents = [];
    const seedStore = new ListeningStore(filename);
    try { seeds[0] = seedNameReplacement(seedStore, { graph: rich });
      if (rich) seedStore.db.prepare('UPDATE listenings SET title=?, notes=?').run('本地历史：保留标题', '本地备注与图谱。');
    } finally { seedStore.close(); }
    for (let token = 0; token < tokens; token++) {
      const source = new ListeningStore(path.join(directory, `source-${token}.sqlite`));
      try {
        seeds[token + 1] = seedNameReplacement(source, { graph: unfinished || rich });
        if (rich) source.db.prepare('UPDATE listenings SET title=?, notes=?').run('导入历史：原译文', '完整备注与任务状态。');
        if (unfinished) {
          const seeded = seeds[token + 1];
          const revision = source.knowledgeEditSnapshot(seeded.listeningId, seeded.item.id).revision;
          const segment = source.addSegment(seeded.listeningId, seeded.runId, { id: 'unfinished', text: 'Unfinished imported work.' }).segment;
          const job = source.createExtractionJob(seeded.listeningId, [segment]);
          source.db.prepare("UPDATE extraction_jobs SET state='running' WHERE id=?").run(job.id);
          const relation = source.nextRelationJob(seeded.listeningId, { quietMs: 0 });
          if (relation) source.beginRelationRequest(relation.id);
          source.db.prepare(`INSERT INTO knowledge_edit_jobs
            (id,listening_id,item_id,fingerprint,revision,name,source,state,created_at,updated_at,result_json)
            VALUES (?,?,?,?,?,?,?,'running',?,?,?)`).run(randomUUID(), seeded.listeningId, seeded.item.id, 'synthetic-import',
            revision, 'Tibo', 'Deebo', new Date().toISOString(), new Date().toISOString(), '{}');
        }
        const backup = path.join(directory, `backup-${token}.sqlite`);
        exportDatabase(source, backup); backups.push(backup);
      } finally { source.close(); }
    }
    provider = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }
      calls.push({ transport: 'http', path: req.url, model: body.model ?? null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"items":[],"relations":[]}' } }] }));
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    ws = new WebSocketServer({ server: provider });
    ws.on('connection', socket => { calls.push({ transport: 'websocket' }); socket.close(1000, 'synthetic provider'); });
    const endpoint = `127.0.0.1:${provider.address().port}`;
    let sequence = 0, mutationCount = 0;
    async function start() {
      await rm(path.join(controlDirectory, 'command.json'), { force: true });
      await rm(path.join(controlDirectory, 'ack.json'), { force: true });
      server = await startServer({ args: ['--import', path.resolve('test-support/import-protocol-control.mjs'), ...preloads.flatMap(file => ['--import', path.resolve(file)]), serverFile],
        env: { LISTENING_DB: filename, HEARWISE_IMPORT_TEST_CONTROL: controlDirectory,
          ASR_ENDPOINT: `ws://${endpoint}`, MT_ENDPOINT: `http://${endpoint}`, TTS_ENDPOINT: `ws://${endpoint}`,
          FISH_TTS_ENDPOINT: `http://${endpoint}/tts`, EXTRACTION_WAIT_MS: '0' } });
      lifecycle.push({ action: 'start', pid: server.child.pid });
    }
    async function control(command, extra = {}) {
      const current = ++sequence;
      await writeFile(path.join(controlDirectory, 'command.next'), JSON.stringify({ sequence: current, command, ...extra }));
      await rename(path.join(controlDirectory, 'command.next'), path.join(controlDirectory, 'command.json'));
      let stopped = false;
      const result = await deadline(async () => {
        while (!stopped) {
          try { const ack = JSON.parse(await readFile(path.join(controlDirectory, 'ack.json'), 'utf8')); if (ack.sequence === current) return ack; }
          catch { /* Writer may not have completed its atomic logical acknowledgement yet. */ }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Import clock command stopped');
      }, 3000, `import clock ${command}`).finally(() => { stopped = true; });
      assert.equal(result.error, null); clockEvents.push({ command, ...result }); return result;
    }
    async function request(url, { method = 'POST', body, headers = {} } = {}) {
      const response = await fetch(`${server.base}${url}`, { method, signal: AbortSignal.timeout(5000),
        headers: { ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }
    function businessIds() {
      const ids = databaseSnapshot(filename).rows.listenings.map(row => row.id);
      assert.ok(ids.every(id => seeds.some(seed => seed.listeningId === id)), 'only known synthetic listening IDs exist');
      return seeds.flatMap((seed, id) => ids.includes(seed.listeningId) ? [id] : []);
    }
    async function write(origin) {
      const existing = businessIds()[0], seed = seeds[existing];
      mutationCount++;
      if (origin === 'same') {
        const url = `/api/listenings/${seed.listeningId}/knowledge/${seed.item.id}`;
        const current = await request(url, { method: 'GET' }); assert.equal(current.status, 200);
        const result = await request(`${url}/name-replacements`, { body: { name: `Edited${mutationCount}`, revision: current.body.revision },
          headers: { 'Idempotency-Key': randomUUID() } });
        assert.equal(result.status, 200, JSON.stringify(result.body));
      } else {
        const db = new DatabaseSync(filename);
        try { assert.equal(db.prepare('UPDATE knowledge_facts SET content=? WHERE id=?').run(`External child edit ${mutationCount}`, seed.factId).changes, 1); }
        finally { db.close(); }
      }
    }
    async function restart({ afterCrash = async () => {} } = {}) {
      const child = server.child, exited = once(child, 'exit');
      child.kill('SIGKILL');
      const [code, signal] = await deadline(() => exited, 3000, 'import server crash');
      assert.equal(signal, 'SIGKILL'); lifecycle.push({ action: 'crash', pid: child.pid, code, signal });
      await afterCrash();
      await start();
    }
    await start();
    return { directory, filename, backups, seeds, calls, lifecycle, clockEvents, mutationEvidence, control, request, businessIds, write, restart, close,
      snapshot: () => databaseSnapshot(filename), base: () => server.base, logs: () => server.logs(),
      upload: async (token, mode) => request(`/api/data/import/validate?mode=${mode}`, { body: await readFile(backups[token]) }) };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Import fixture setup and cleanup failed'); }
    throw error;
  }
}

export function importedWorkObservation(fixture, source = 1) {
  const rows = fixture.snapshot().rows, id = fixture.seeds[source].listeningId;
  const pick = (table, fields) => rows[table].filter(row => row.listening_id === id)
    .map(row => Object.fromEntries(fields.map(field => [field, row[field]])));
  const result = {
    translations: pick('segments', ['id', 'translation_state']),
    extraction: pick('extraction_jobs', ['id', 'state', 'last_error']),
    relations: pick('relation_jobs', ['id', 'state', 'last_error']),
    rounds: pick('relation_rounds', ['id', 'state', 'stop_reason']),
    edits: pick('knowledge_edit_jobs', ['id', 'state']), providerCalls: fixture.calls.length
  };
  assert.ok(result.translations.some(row => row.translation_state === 'failed'));
  assert.ok(result.translations.every(row => row.translation_state !== 'pending'));
  assert.ok(result.extraction.some(row => row.state === 'failed' && row.last_error === 'IMPORT_REQUIRES_RESUME'));
  assert.ok(result.extraction.every(row => !['pending', 'running'].includes(row.state)));
  assert.ok(result.relations.some(row => row.state === 'cancelled' && row.last_error === 'IMPORT_REQUIRES_RESUME'));
  assert.ok(result.relations.every(row => !['pending', 'running'].includes(row.state)));
  assert.ok(result.rounds.some(row => row.state === 'paused' && row.stop_reason === 'IMPORT_REQUIRES_RESUME'));
  assert.ok(result.rounds.every(row => row.state !== 'active'));
  assert.ok(result.edits.length && result.edits.every(row => row.state === 'failed'));
  assert.equal(result.providerCalls, 0);
  return result;
}
