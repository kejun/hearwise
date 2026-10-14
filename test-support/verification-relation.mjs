// Only synthetic data and an injected provider. No HTTP server or production hook.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { createRelationWorkflow } from '../relation-workflow.mjs';
import { buildRelationRequest } from '../relations.mjs';
import { writeJson } from '../scripts/lib/verification-evidence.mjs';

const [scenario, directory] = process.argv.slice(2);
const context = JSON.parse(readFileSync(path.join(directory, 'context.json'), 'utf8'));
const databaseDirectory = path.join(directory, 'temporary-database');
mkdirSync(databaseDirectory);
const store = new ListeningStore(path.join(databaseDirectory, 'store.sqlite'));
const observations = { scenario, providerCalls: 0, checkpoints: [] };
const saveObservations = () => writeFileSync(path.join(directory, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
const result = { ...context, property: { id: 'HW-04-01', version: 1 },
  scope: { description: 'One listening/window, two synthetic nodes, one provider response; no retry, concurrency or crash proof.',
    scenario, samples: 1, seed: null, steps: null, states: null },
  startedAt: new Date().toISOString(), complete: false, status: 'incomplete' };
try {
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'Verification synthetic fixture');
  const segment = store.addSegment(run.listeningId, run.runId, { id: 'fixture-asr', text: 'Atlas launched Nova.' }).segment;
  store.setTranslation(segment.id, 'Atlas 推出了 Nova。');
  for (const [id, name] of [['atlas', 'Atlas'], ['nova', 'Nova']]) {
    store.db.prepare(`INSERT INTO knowledge_items(id,listening_id,type,canonical_name,normalized_name,dialogue_summary,certainty,created_at,updated_at)
      VALUES(?,?,'other',?,?,?,'clear',?,?)`).run(id, run.listeningId, name, name.toLowerCase(), name, new Date().toISOString(), new Date().toISOString());
    store.db.prepare('INSERT INTO knowledge_mentions(item_id,segment_id,surface_text) VALUES(?,?,?)').run(id, segment.id, name);
  }
  store.enableRelations(run.listeningId);
  const job = store.nextRelationJob(run.listeningId, { quietMs: 0 });
  assert.ok(job, 'A valid relation job must be admitted');
  observations.identity = { listeningId: run.listeningId, jobId: job.id };
  const projection = () => ({
    job: { ...store.db.prepare('SELECT state,request_count,last_error FROM relation_jobs WHERE id=?').get(job.id) },
    journal: store.db.prepare('SELECT attempt,outcome FROM relation_requests WHERE job_id=? ORDER BY attempt').all(job.id),
    relations: store.graph(run.listeningId).relations.map(row => ({ id: row.id, predicate: row.predicate,
      subject: row.subject_item_id, object: row.object_item_id })),
    processingState: store.relationProcessing(run.listeningId).state, hasWork: store.relationHasWork(run.listeningId)
  });
  observations.checkpoints.push({ action: 'admitted', ...projection() });
  const workflow = createRelationWorkflow({ store, endpoint: 'mock://verification-no-network', extract: async (_key, input) => {
    observations.providerCalls++;
    observations.checkpoints.push({ action: 'before-provider-response', ...projection() });
    saveObservations();
    assert.equal(observations.checkpoints.at(-1).job.request_count, 1, 'Budget must be persisted before provider invocation');
    assert.equal(observations.checkpoints.at(-1).journal.length, 1, 'Durable reservation must exist before invocation');
    if (scenario === 'business-failure') throw Object.assign(new Error('Synthetic unauthorized response'), { status: 401 });
    if (['timeout', 'interrupt'].includes(scenario)) {
      console.log('PROVIDER_PENDING');
      return new Promise(() => {});
    }
    const request = buildRelationRequest(input), wire = JSON.parse(request.body.messages[1].content);
    return request.parse(JSON.stringify({ contract_version: wire.contract_version, evidence_version: wire.evidence_version,
      relations: [{ subject_item_id: wire.candidates.find(node => node.canonical_name === 'Atlas').id,
        object_item_id: wire.candidates.find(node => node.canonical_name === 'Nova').id, predicate: 'released',
        polarity: 'positive', modality: 'asserted', status: 'active', evidence_ids: [wire.evidence[0].id] }] }));
  } });
  observations.businessResult = await workflow.execute(job, 'synthetic-not-a-key');
  observations.checkpoints.push({ action: 'workflow-returned', ...projection() });
  saveObservations();
  assert.equal(observations.providerCalls, 1);
  assert.equal(observations.businessResult.kind, 'terminal');
  assert.equal(observations.businessResult.outcome, 'ok', 'This property requires a successful business outcome');
  assert.equal(observations.checkpoints.at(-1).job.request_count, 1);
  assert.equal(observations.checkpoints.at(-1).relations.length, 1);
  assert.equal(observations.checkpoints.at(-1).relations[0].predicate, 'released');
  assert.equal(observations.checkpoints.at(-1).hasWork, false);
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.failure = { name: error.name, message: error.message };
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  store.close();
  saveObservations();
  result.complete = true;
  result.finishedAt = new Date().toISOString();
  await writeJson(path.join(directory, 'result.json'), result);
}
