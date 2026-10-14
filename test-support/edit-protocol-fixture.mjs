import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ListeningStore } from '../storage.mjs';
import { speechFixture } from './speech-fixture.mjs';
import { seedNameReplacement } from './name-replacement-fixture.mjs';

export const editNames = ['Deebo', 'Tibo', 'Mira'];
export function editTables(store) {
  const db = typeof store === 'string' ? new DatabaseSync(store, { readOnly: true }) : store.db;
  try {
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${JSON.stringify(name)}`).all().map(row => JSON.stringify(row)).sort()]));
  } finally { if (typeof store === 'string') db.close(); }
}
export async function createEditFixture({ initialOverride = false, failedTranslation = true, notificationFailure = false, rollback = false, mutation = 'none' } = {}) {
  assert.ok(['none', 'bypass_revision'].includes(mutation));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-edit-protocol-'));
  let fixture, store;
  try {
    let mutationModule;
    if (mutation === 'bypass_revision') {
      let source = await readFile(new URL('../knowledge-name-replacement.mjs', import.meta.url), 'utf8');
      const guard = "assertKnowledgeRevision(snapshot, input.revision, '条目或原文已改变，请核对最新内容后再提交');";
      assert.equal(source.split(guard).length, 2, 'Mutation must remove exactly the real transaction revision guard');
      source = source.replace(guard, 'void snapshot; // Deliberately broken test-only transaction.');
      source = source.replace(/from '(\.\/.+?)'/g, (_all, specifier) => `from '${new URL('../' + specifier.slice(2), import.meta.url).href}'`);
      const file = path.join(directory, 'unguarded-replacement.mjs'); await writeFile(file, source); mutationModule = pathToFileURL(file).href;
    }
    await writeFile(path.join(directory, 'options.json'), JSON.stringify({ notificationFailure, rollback, mutationModule }));
    fixture = await speechFixture({ seed: database => {
      const seeded = seedNameReplacement(database, { graph: true });
      if (failedTranslation) database.db.prepare("UPDATE segments SET translation_text=NULL,translation_state='failed' WHERE id=?").run(seeded.segment.id);
      if (initialOverride) database.db.prepare('UPDATE knowledge_items SET name_override=?,name_override_identity=? WHERE id=?').run('Display Deebo', 'display deebo', seeded.item.id);
      return { ...seeded, filename: database.db.prepare('PRAGMA database_list').get().file };
    }, extraEnv: { EDIT_PROTOCOL_CONTROL_DIR: directory,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${new URL('./edit-protocol-preload.mjs', import.meta.url).pathname}`.trim() },
    modelResponse: () => { throw new Error('Edit verification must not call a paid provider'); } });
    store = new ListeningStore(fixture.seeded.filename);
    const { listeningId, item, segment } = fixture.seeded;
    const url = `${fixture.base}/api/listenings/${listeningId}/knowledge/${item.id}`;
    return { ...fixture, directory, store, url, listeningId, itemId: item.id, segmentId: segment.id,
      snapshot: () => store.knowledgeEditSnapshot(listeningId, item.id),
      control: async (id, stage, value) => {
        const file = path.join(directory, `${id}.${stage}.json`);
        await writeFile(file + '.tmp', JSON.stringify(value)); await rename(file + '.tmp', file);
      },
      checkpoint: async (id, stage) => {
        const until = Date.now() + 5000;
        while (Date.now() < until) {
          try { return JSON.parse(await readFile(path.join(directory, `${id}.${stage}.json`), 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error(`Edit ${stage} checkpoint exceeded 5000ms`);
      },
      async close() {
        try {
          // Release a held synchronous stack before asking the child to stop.
          for (const file of await readdir(directory)) if (file.endsWith('.request.json')) {
            const gate = path.join(directory, file.replace('.request.json', '.notify.json'));
            try { await writeFile(gate, JSON.stringify({ failure: false }), { flag: 'wx' }); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
          }
        } finally {
          try { store.close(); } finally { try { await fixture.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
        }
      }
    };
  } catch (error) { store?.close(); try { await fixture?.close(); } finally { await rm(directory, { recursive: true, force: true }); } throw error; }
}
