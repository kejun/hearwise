// Explicitly synthetic loopback provider: verifies plumbing, never model quality.
import http from 'node:http'; import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'; import path from 'node:path';
import { WebSocketServer } from 'ws';
import { closeServer } from './lifecycle.mjs';
import { collectQualityRun } from '../scripts/lib/quality-collector.mjs';
import { hashBytes, contractDigest, estimateQualityBudget } from '../scripts/lib/quality-contract.mjs';
import { sourceVersion } from '../scripts/lib/verification-evidence.mjs';
export async function qualityOfflineProvider({ output = 'Do not pay 15.', translation = '不要支付15。', revision, failFirstAsr = false } = {}) {
  const requests = [], sockets = new Set();
  const httpServer = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ kind: 'mt', body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: translation } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  });
  const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(ws, 'listening');
  ws.on('connection', client => { sockets.add(client); let taskId;
    client.on('error', () => {}); client.on('close', () => sockets.delete(client));
    client.on('message', (bytes, binary) => {
      if (binary) { requests.push({ kind: 'audio', bytes: bytes.length }); return; }
      const event = JSON.parse(bytes); const action = event.header.action;
      if (action === 'run-task') {
        taskId = event.header.task_id; requests.push({ kind: 'asr', body: event });
        if (failFirstAsr && requests.filter(row => row.kind === 'asr').length === 1) client.send(JSON.stringify({ header: { event: 'task-failed', task_id: taskId }, payload: { message: 'synthetic startup rejection' } }));
        else client.send(JSON.stringify({ header: { event: 'task-started', task_id: taskId } }));
      }
      if (action === 'finish-task') {
        if (output) client.send(JSON.stringify({ header: { event: 'result-generated', task_id: taskId }, payload: { output: { sentence: { sentence_id: 'synthetic-1', text: output, sentence_end: true, begin_time: 0, end_time: 20 } } } }));
        if (revision) client.send(JSON.stringify({ header: { event: 'result-generated', task_id: taskId }, payload: { output: { sentence: { sentence_id: 'synthetic-1', text: revision, sentence_end: true, begin_time: 0, end_time: 20 } } } }));
        client.send(JSON.stringify({ header: { event: 'task-finished', task_id: taskId } }));
      }
    });
  });
  httpServer.listen(0, '127.0.0.1'); await once(httpServer, 'listening');
  return { requests, upstream: { asr: `ws://127.0.0.1:${ws.address().port}`, mt: `http://127.0.0.1:${httpServer.address().port}`, key: 'offline-upstream-sentinel' },
    close: async () => { for (const socket of sockets) socket.terminate(); await Promise.all([closeServer(ws, 'quality offline WS'), closeServer(httpServer, 'quality offline HTTP')]); } };
}
export async function runOfflineQuality(directory, { signal, providerOptions } = {}) {
  const audio = Buffer.alloc(640), source = sourceVersion();
  const config = JSON.parse(await readFile(new URL('../verification/asr-translation-quality/plan.template.json', import.meta.url)));
  config.repetitions = 2; config.roles.candidate.sourceSha = source.sha; config.roles.candidate.maxConnectionMs = 5000; config.roles.candidate.maxRunMs = 20000;
  config.budget = { id: 'offline-only-not-a-live-approval', currency: 'CNY', ceilingMicros: 1000, expiresAt: new Date(Date.now() + 3600000).toISOString(), bounds: Object.fromEntries(['asr','mt'].map(kind => [kind, { inputUnitsUpper: 1, outputUnitsUpper: 1, inputUnitMicros: 1, outputUnitMicros: 1, fixedMicros: 1, validUntil: new Date(Date.now() + 3600000).toISOString() }])) };
  const sample = { id: 'synthetic-plumbing', split: 'acceptance', kind: 'offline-only-synthetic', language: 'en', target: 'Chinese', tasks: ['asr','mt'], text: 'Do not pay 15.',
    audio: { path: 'offline.pcm', format: 'pcm-s16le-mono-16000', bytes: audio.length, durationMs: 20, sha256: hashBytes(audio), transform: 'synthetic zero PCM' } };
  const corpus = { id: 'offline-plumbing-only', version: 1, samples: [sample] }, frozenAt = new Date().toISOString();
  const inputDirectory = await mkdtemp(path.join(path.dirname(path.resolve(directory)), 'offline-input-'));
  const freeze = { kind: 'offline-contract-fixture', frozenAt, config, corpus, digest: contractDigest({ config, corpus }), freezeFileSha256: hashBytes('offline-only'),
    configPath: path.join(inputDirectory, 'not-a-live-plan.json'), corpusPath: path.join(inputDirectory, 'offline-corpus.json'), estimate: estimateQualityBudget(config, corpus.samples) };
  let provider;
  try {
    await writeFile(path.join(inputDirectory, 'offline.pcm'), audio);
    provider = await qualityOfflineProvider(providerOptions);
    const report = await collectQualityRun({ frozen: freeze, role: 'candidate', directory, mode: 'offline', upstream: provider.upstream, signal });
    return { ...report, actualStubRequests: provider.requests, qualityStatus: 'not_run', qualityEvaluated: false };
  } finally { try { await provider?.close(); } finally { await rm(inputDirectory, { recursive: true, force: true }); } }
}
