import { closeServer, stopChild, deadline } from './lifecycle.mjs';
// Local deterministic ASR/MT/TTS fixture. No external services or real credentials.
import http from 'node:http';
import { ListeningStore } from '../storage.mjs';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

export async function speechFixture({ autoSentences = false, audioSamples = 2400, fishStatus = 200, translationText, legacyIncrementalEnv = false, translationDelay = 0, seed, modelResponse, extraEnv = {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-speech-'));
  const filename = path.join(directory, 'test.sqlite');
  let seeded;
  if (seed) { const store = new ListeningStore(filename); try { seeded = await seed(store); } finally { store.close(); } }
  const stats = { providerRequests: [], connections: 0, commits: [], sessions: [], asrClients: new Set(), responses: 0, authorizations: [], models: [],
    mtRequests: [], mtAborted: 0, fishRequests: [], fishAborted: 0, holdFish: false };
  const mt = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); return res.end(); }
    stats.providerRequests.push({ model: body.model, at: Date.now() });
    if (body.model === 'qwen-mt-flash') {
      stats.mtRequests.push(body.messages[0].content);
      res.on('close', () => { if (!res.writableEnded) stats.mtAborted++; });
      if (translationDelay) await new Promise(resolve => setTimeout(resolve, translationDelay));
    }
    const chosenTranslation = typeof translationText === 'function' ? translationText(body.messages?.[0]?.content) : translationText;
    const override = modelResponse ? await modelResponse(body, stats, seeded) : undefined;
    const text = override === undefined ? (body.model === 'qwen-mt-flash' ? chosenTranslation ?? `这是第 ${body.messages[0].content.match(/\d+/)?.[0] || 1} 句中文译文。` : '{"items":[]}') : typeof override === 'string' ? override : JSON.stringify(override);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
  mt.listen(0, '127.0.0.1'); await once(mt, 'listening');
  const fish = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    stats.fishRequests.push({ authorization: req.headers.authorization, model: req.headers.model, body });
    if (fishStatus !== 200) {
      res.writeHead(fishStatus, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: `Upstream echoed ${req.headers.authorization} and ${body.text}` }));
    }
    res.on('close', () => { if (!res.writableFinished) stats.fishAborted++; });
    res.writeHead(200, { 'Content-Type': 'audio/pcm' });
    const pcm = Buffer.alloc(audioSamples * 2);
    for (let i = 0; i < audioSamples; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 24000 * 440 * Math.PI * 2) * 2000), i * 2);
    res.write(pcm.subarray(0, 1001));
    if (stats.holdFish) return; // Used to verify immediate cancellation in the browser.
    for (let offset = 1001; offset < pcm.length && !res.destroyed; offset += 1001) {
      await new Promise(resolve => setTimeout(resolve, 1));
      res.write(pcm.subarray(offset, offset + 1001));
    }
    res.end();
  });
  fish.listen(0, '127.0.0.1'); await once(fish, 'listening');
  const asr = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(asr, 'listening');
  const tts = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(tts, 'listening');
  let sentence = 0;
  function final(text = `Sentence ${++sentence}.`, end = true, id = String(++sentence)) {
    for (const ws of stats.asrClients) if (ws.readyState === 1) ws.send(JSON.stringify({ header: { event: 'result-generated' },
      payload: { output: { sentence: { sentence_id: id, text, sentence_end: end, begin_time: 0, end_time: 1500 } } } }));
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
    stats.models.push(new URL(req.url, 'http://localhost').searchParams.get('model'));
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
    env: { ...process.env, HEARWISE_INCREMENTAL_SPEECH: legacyIncrementalEnv ? '1' : '0', PORT: '0', LISTENING_DB: filename,
      ASR_ENDPOINT: `ws://127.0.0.1:${asr.address().port}`, MT_ENDPOINT: `http://127.0.0.1:${mt.address().port}`,
      TTS_ENDPOINT: `ws://127.0.0.1:${tts.address().port}`, FISH_TTS_ENDPOINT: `http://127.0.0.1:${fish.address().port}/v1/tts`, EXTRACTION_WAIT_MS: '15000', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', closing;
  const record = data => { logs = (logs + data).slice(-1000000); };
  child.stderr.on('data', record); child.stdout.on('data', record);
  function close() {
    return closing ??= (async () => {
      const results = await Promise.allSettled([stopChild(child), closeServer(asr, 'ASR'), closeServer(tts, 'TTS'),
        closeServer(mt, 'model HTTP'), closeServer(fish, 'Fish HTTP')]);
      await rm(directory, { recursive: true, force: true });
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed: ' + logs.slice(-2000));
    })();
  }
  let onData, onError, onExit, base;
  try {
    base = await deadline(() => new Promise((resolve, reject) => {
      onData = data => { const url = String(data).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) resolve(url); };
      onError = reject;
      onExit = (code, signal) => reject(new Error(`Fixture exited before startup: code=${code} signal=${signal}`));
      child.stdout.on('data', onData); child.once('error', onError); child.once('exit', onExit);
    }), 10000, 'Fixture startup');
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fixture startup/cleanup failed'); }
    throw new Error(error.message + ': ' + logs.slice(-4000), { cause: error });
  } finally {
    child.stdout.removeListener('data', onData); child.removeListener('error', onError); child.removeListener('exit', onExit);
  }
  return { base, stats, final, seeded, logs: () => logs, close };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = await speechFixture({ autoSentences: true, audioSamples: 24000 });
  console.log(f.base);
  process.on('SIGTERM', async () => { await f.close(); process.exit(0); });
  process.on('SIGINT', async () => { await f.close(); process.exit(0); });
}
