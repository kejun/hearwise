// Loaded only by isolated test child processes. No production endpoint/env hook.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';

const directory = process.env.EDIT_PROTOCOL_CONTROL_DIR;
if (!directory) throw new Error('Missing test-only edit checkpoint directory');
const options = JSON.parse(readFileSync(path.join(directory, 'options.json'), 'utf8'));
const save = (id, stage, data) => {
  const file = path.join(directory, `${id}.${stage}.json`), temporary = file + '.tmp';
  writeFileSync(temporary, JSON.stringify(data)); renameSync(temporary, file);
};
const load = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
if (options.mutationModule) {
  const mutant = await import(options.mutationModule);
  ListeningStore.prototype.replaceKnowledgeName = mutant.knowledgeNameReplacementMethods.replaceKnowledgeName;
}
const original = ListeningStore.prototype.replaceKnowledgeName;
const graphMetadata = ListeningStore.prototype.graphMetadata;
let notification;
ListeningStore.prototype.replaceKnowledgeName = function (listeningId, itemId, id, input, ...rest) {
  const control = load(path.join(directory, `${id}.request.json`));
  const before = this.knowledgeEditSnapshot(listeningId, itemId);
  const rollback = control.rollback || options.rollback;
  if (rollback) this.db.exec("CREATE TEMP TRIGGER edit_protocol_rollback BEFORE UPDATE OF state ON knowledge_edit_jobs WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic edit transaction rollback'); END");
  let result;
  try { result = original.call(this, listeningId, itemId, id, input, ...rest); }
  catch (error) {
    save(id, 'transaction', { before, after: this.knowledgeEditSnapshot(listeningId, itemId), held: false,
      error: { code: error.code || null, status: error.status || null, message: error.message } });
    throw error;
  } finally { if (rollback) this.db.exec('DROP TRIGGER edit_protocol_rollback'); }
  save(id, 'transaction', { before, after: this.knowledgeEditSnapshot(listeningId, itemId), result, held: Boolean(control.pause && result.changed) });
  if (result.changed) {
    let setting = { failure: Boolean(options.notificationFailure) };
    if (control.pause) {
      const gate = path.join(directory, `${id}.notify.json`), deadline = Date.now() + 10000;
      // Pause the real synchronous stack after COMMIT, before notify. Other HTTP
      // handlers cannot run here; the model must preserve this same ownership.
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(gate)) {
        if (Date.now() >= deadline) throw new Error('Test notification gate timed out after commit');
        Atomics.wait(wait, 0, 0, 10);
      }
      setting = load(gate);
    }
    notification = { id, failure: Boolean(setting.failure) };
  }
  return result;
};
ListeningStore.prototype.graphMetadata = function (...args) {
  const current = notification; notification = null;
  if (current?.failure) {
    save(current.id, 'notification', { outcome: 'fail' });
    throw new Error('Synthetic post-commit notification failure');
  }
  const result = graphMetadata.apply(this, args);
  if (current) save(current.id, 'notification', { outcome: 'ok' });
  return result;
};
