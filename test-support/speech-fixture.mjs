// Local deterministic ASR/MT/TTS fixture. No external services or real credentials.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

export async function speechFixture({ autoSentences = false, audioSamples = 2400 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-speech-'));
  const stats = { connections: 0, commits: [], sessions: [], asrClients: new Set(), responses: 0, authorizations: [] };
  const mt = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); return res.end(); }
    const text = body.model === 'qwen-mt-flash' ? `这是第 ${body.messages[0].content.match(/\d+/)?.[0] || 1} 句中文译文。` : '{"items":[]}';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
  mt.listen(0, '127.0.0.1'); await once(mt, 'listening');
  const asr = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(asr, 'listening');
  const tts = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(tts, 'listening');
  let sentence = 0;
  function final(text = `Sentence ${++sentence}.`, end = true) {
    for (const ws of stats.asrClients) if (ws.readyState === 1) ws.send(JSON.stringify({ header: { event: 'result-generated' },
      payload: { output: { sentence: { sentence_id: String(++sentence), text, sentence_end: end, begin_time: 0, end_time: 1500 } } } }));
  }
  asr.on('connection', ws => {
    stats.asrClients.add(ws); let last = Date.now();
    ws.on('close', () => stats.asrClients.delete(ws));
    ws.on('message', (raw, binary) => {
      if (binary) { if (autoSentences && Date.now() - last > 2000) { last = Date.now(); final(); } return; }
      const message = JSON.parse(raw.toString());
      if (message.header?.action === 'run-task') ws.send(JSON.stringify({ header: { event: 'task-started' } }));
      if (message.header?.action === 'finish-task') ws.send(JSON.stringify({ header: { event: 'task-finished' } }));
    });
  });
  tts.on('connection', (ws, req) => {
    stats.authorizations.push(req.headers.authorization);
    stats.connections++; let text = '';
    ws.send(JSON.stringify({ type: 'session.created', session: { id: 'mock' } }));
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'session.update') { stats.sessions.push(event.session); ws.send(JSON.stringify({ type: 'session.updated' })); }
      if (event.type === 'input_text_buffer.append') text += event.text;
      if (event.type === 'input_text_buffer.commit') {
        stats.commits.push(text); text = '';
        const response = { id: `response-${++stats.responses}`, status: 'completed' };
        ws.send(JSON.stringify({ type: 'response.created', response }));
        const pcm = Buffer.alloc(audioSamples * 2);
        for (let i = 0; i < audioSamples; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 24000 * 440 * Math.PI * 2) * 2000), i * 2);
        // Odd byte boundaries deliberately exercise the real transport's carry byte.
        for (let offset = 0; offset < pcm.length; offset += 1001) ws.send(JSON.stringify({ type: 'response.audio.delta', response_id: response.id, delta: pcm.subarray(offset, offset + 1001).toString('base64') }));
        ws.send(JSON.stringify({ type: 'response.audio.done', response_id: response.id }));
        ws.send(JSON.stringify({ type: 'response.done', response }));
      }
    });
  });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    env: { ...process.env, PORT: '0', LISTENING_DB: path.join(directory, 'test.sqlite'),
      ASR_ENDPOINT: `ws://127.0.0.1:${asr.address().port}`, MT_ENDPOINT: `http://127.0.0.1:${mt.address().port}`,
      TTS_ENDPOINT: `ws://127.0.0.1:${tts.address().port}`, EXTRACTION_WAIT_MS: '15000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stderr.on('data', data => { logs += data; });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture startup timeout: ' + logs)), 10000);
    child.stdout.on('data', data => { logs += data; const url = String(data).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) { clearTimeout(timeout); resolve(url); } });
    child.once('error', reject);
  });
  return { base, stats, final, logs: () => logs,
    async close() {
      const exited = once(child, 'exit'); child.kill(); await exited;
      for (const server of [asr, tts]) { for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); }
      mt.closeAllConnections(); await new Promise(resolve => mt.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = await speechFixture({ autoSentences: true, audioSamples: 24000 });
  console.log(f.base);
  process.on('SIGTERM', async () => { await f.close(); process.exit(0); });
  process.on('SIGINT', async () => { await f.close(); process.exit(0); });
}
