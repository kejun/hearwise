import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ListeningStore } from '../storage.mjs';
import { speechFixture } from './speech-fixture.mjs';
import { seedNameTransaction, nameTables } from './name-transaction-fixture.mjs';
import { nameMutation } from './name-protocol-mutations.mjs';

export async function createNameProtocolFixture({ mutation = 'none' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-name-protocol-'));
  let fixture, store;
  try {
    let mutationEvidence, extraEnv;
    if (mutation !== 'none') {
      const variant = await nameMutation(directory, mutation); mutationEvidence = variant.evidence;
      extraEnv = { NAME_PROTOCOL_MUTATION_MODULE: pathToFileURL(path.join(directory, `${mutation}.mjs`)).href,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${new URL('./name-protocol-preload.mjs', import.meta.url).pathname}`.trim() };
    }
    fixture = await speechFixture({ extraEnv, seed: database => ({ ...seedNameTransaction(database),
      filename: database.db.prepare('PRAGMA database_list').get().file }),
    modelResponse: () => { throw new Error('Name protocol verification must not call a provider'); } });
    store = new ListeningStore(fixture.seeded.filename);
    const { listeningId, item } = fixture.seeded;
    const url = `${fixture.base}/api/listenings/${listeningId}/knowledge/${item.id}`;
    return { ...fixture, directory, store, listeningId, itemId: item.id, url, mutationEvidence,
      snapshot: () => store.knowledgeEditSnapshot(listeningId, item.id), tables: () => nameTables(store),
      async close() { try { store.close(); } finally { try { await fixture.close(); } finally { await rm(directory, { recursive: true, force: true }); } } }
    };
  } catch (error) { store?.close(); try { await fixture?.close(); } finally { await rm(directory, { recursive: true, force: true }); } throw error; }
}
