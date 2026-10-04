import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createKnowledgeWorkflow } from '../knowledge-workflow.mjs';
import { extractKnowledge } from '../knowledge.mjs';
import { createTaskRuntime } from '../dist/server/index.js';

// Real Effect runtime, SQLite workflow and HTTP adapter; only the paid provider is replaced.
export async function traceReportFixture({ recovered = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-trace-'));
  const store = new ListeningStore(path.join(directory, 'data.sqlite'));
  const runtime = createTaskRuntime({ enabled: true });
  let mode = 'success', received;
  const server = http.createServer((_req, res) => {
    if (mode === 'hold') { received(); return; }
    res.writeHead(mode === 'fail' ? 429 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(mode === 'fail' ? { error: { message: 'PRIVATE_PROVIDER_ERROR' } } :
      { choices: [{ message: { content: '{"items":[]}' } }] }));
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'trace-fixture');
    store.addSegment(run.listeningId, run.runId, { id: 'one', text: 'PRIVATE_TRANSCRIPT' });
    store.finishRun(run.runId);
    const job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
    const workflow = createKnowledgeWorkflow({ store, endpoint });
    await runtime.start(job.id, { job_id: job.id, listening_id: run.listeningId, attempt: 1 },
      context => workflow.execute(job, 'PRIVATE_KEY', context)).promise;
    if (recovered) {
      await runtime.start('recovery-fixture', { job_id: 'recovery-fixture', listening_id: run.listeningId, attempt: 1 }, async context => {
        mode = 'fail';
        try { await context.step('knowledge.extract', child => extractKnowledge('PRIVATE_KEY', { policy_version: 2 }, endpoint, child)); }
        catch (error) { if (error.status !== 429) throw error; }
        mode = 'success';
        await context.step('knowledge.extract', child => extractKnowledge('PRIVATE_KEY', { policy_version: 2 }, endpoint, child));
      }).promise;
    }
    mode = 'hold';
    const incoming = new Promise(resolve => { received = resolve; });
    const cancelled = runtime.start('cancel-fixture', { job_id: 'cancel-fixture', listening_id: run.listeningId, attempt: 1 },
      context => context.step('knowledge.extract', child => extractKnowledge('PRIVATE_KEY', { policy_version: 2 }, endpoint, child)));
    await incoming;
    cancelled.cancel('listening_deleted');
    await cancelled.promise.catch(error => { if (error.code !== 'TASK_CANCELLED') throw error; });
    await runtime.dispose();
    return runtime.diagnostics();
  } finally {
    await runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); await rm(directory, { recursive: true, force: true });
  }
}
