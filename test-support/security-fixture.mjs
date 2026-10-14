// Synthetic credentials only. These values are deliberately public test data.
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { ListeningStore } from '../storage.mjs';
import { startServer } from './server-fixture.mjs';
import { closeServer, deadline, stopChild } from './lifecycle.mjs';

export const SECURITY_KEY = 'HW_TEST_ONLY_CREDENTIAL_SENTINEL_82_abc123';
export const SECURITY_FISH_KEY = 'HW_TEST_ONLY_FISH_SENTINEL_82_def456';
export const SECURITY_KEYS = [SECURITY_KEY, SECURITY_FISH_KEY];
export const ATTACK_TEXT = '<img src="/hw-security-probe" onerror="globalThis.__hwSecurityExecuted=(globalThis.__hwSecurityExecuted||0)+1">';
export const SCRIPT_TEXT = '</script><script>globalThis.__hwSecurityExecuted=99</script>';

export function credentialFindings(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return SECURITY_KEYS.flatMap((key, index) => ['utf8', 'utf16le'].filter(encoding => bytes.includes(Buffer.from(key, encoding)))
    .map(encoding => ({ sentinel: index, encoding })));
}

export async function securityFixture({ seed, serverFile = 'server.mjs' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-security-'));
  const filename = path.join(directory, 'business.sqlite');
  let seeded, app, closing;
  const stats = { requests: [], asrConnections: 0, asrClients: new Set() };
  const control = { modelStatus: 200, asrFailure: false, modelOutput: undefined };
  if (seed) { const store = new ListeningStore(filename); try { seeded = await seed(store); } finally { store.close(); } }
  const model = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    stats.requests.push({ kind: 'model', model: body.model, authorization: req.headers.authorization, body });
    res.writeHead(control.modelStatus, { 'Content-Type': 'application/json', 'Retry-After': '0' });
    if (control.modelStatus !== 200) return res.end(JSON.stringify({ error: { message: `Provider echoed ${req.headers.authorization}` } }));
    const output = typeof control.modelOutput === 'function' ? control.modelOutput(body) : control.modelOutput;
    const content = output === undefined ? body.model === 'qwen-mt-flash' ? '固定安全译文。' : '{"items":[]}' : typeof output === 'string' ? output : JSON.stringify(output);
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const asr = new WebSocketServer({ noServer: true });
  const asrHttp = http.createServer();
  asrHttp.on('upgrade', (req, socket, head) => asr.handleUpgrade(req, socket, head, ws => asr.emit('connection', ws, req)));
  asr.on('connection', (ws, req) => {
    stats.asrConnections++; stats.asrClients.add(ws);
    stats.requests.push({ kind: 'asr', authorization: req.headers.authorization });
    ws.on('close', () => stats.asrClients.delete(ws));
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const input = JSON.parse(raw.toString());
      if (input.header?.action === 'run-task') ws.send(JSON.stringify(control.asrFailure
        ? { header: { event: 'task-failed', error_message: `Provider echoed ${req.headers.authorization}` } }
        : { header: { event: 'task-started' } }));
      if (input.header?.action === 'finish-task') ws.send(JSON.stringify({ header: { event: 'task-finished' } }));
    });
  });
  const close = () => closing ??= (async () => {
    const results = await Promise.allSettled([app ? stopChild(app.child) : Promise.resolve(), closeServer(asr, 'security ASR'),
      closeServer(model, 'security model'), closeServer(asrHttp, 'security ASR HTTP')]);
    await rm(directory, { recursive: true, force: true });
    const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
    if (errors.length) throw new AggregateError(errors, 'Security fixture cleanup failed');
  })();
  try {
    for (const server of [model, asrHttp]) { server.listen(0, '127.0.0.1'); await deadline(() => once(server, 'listening'), 5000, 'Security provider startup'); }
    const env = { LISTENING_DB: filename, MT_ENDPOINT: `http://127.0.0.1:${model.address().port}`,
      ASR_ENDPOINT: `ws://127.0.0.1:${asrHttp.address().port}`, EXTRACTION_WAIT_MS: '15000' };
    app = await startServer({ args: [serverFile], env });
    return { directory, filename, seeded, stats, control, base: app.base, logs: app.logs, close,
      async restart() { await stopChild(app.child); app = await startServer({ args: [serverFile], env }); this.base = app.base; this.logs = app.logs; },
      final(text, id = 'security-source') {
        for (const ws of stats.asrClients) if (ws.readyState === 1) ws.send(JSON.stringify({ header: { event: 'result-generated' },
          payload: { output: { sentence: { sentence_id: id, text, sentence_end: true, begin_time: 0, end_time: 1000 } } } }));
      } };
  } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup]); } throw error; }
}
