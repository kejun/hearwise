// One empty real service/store. Only upstream suppliers and the import timer are controlled.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deadline } from './lifecycle.mjs';
import { capturePlaybackWorkletResponses } from './playback-worklet-responses.mjs';
import { speechFixture } from './speech-fixture.mjs';
import { databaseSnapshot } from './import-protocol-fixture.mjs';
import { relationWireEnvelope } from './relation-wire-fixture.mjs';

export const journeyText = Object.freeze({
  original: Object.freeze(['Eastman Kodak released the Brownie camera in 1900.', 'The Brownie camera was made for everyday photography.']),
  translation: Object.freeze(['伊士曼柯达于1900年推出布朗尼相机。', '布朗尼相机面向日常摄影。'])
});

export async function userJourneyFixture() {
  const providerLedger = [], ttsLedger = [], heldRelations = [], heldSpeech = [], clockEvents = [];
  const controlDirectory = await mkdtemp(path.join(tmpdir(), 'hearwise-journey-control-'));
  let workletCapture;
  let holdRelation = false, holdSpeech = false, clockSequence = 0;
  let fixture;
  try { workletCapture = await capturePlaybackWorkletResponses(); fixture = await speechFixture({
    audioSamples: 6000,
    serverImports: [new URL('./import-protocol-control.mjs', import.meta.url).href, ...workletCapture.imports],
    extraEnv: { HEARWISE_IMPORT_TEST_CONTROL: controlDirectory, ...workletCapture.env },
    onTtsCommit(request) {
      const row = { sequence: ttsLedger.length + 1, text: request.text, samples: request.pcm.length / 2, held: holdSpeech, delivered: false };
      ttsLedger.push(row);
      const deliver = () => { row.delivered = request.sendDefault(); row.completedAt = new Date().toISOString(); return row.delivered; };
      if (holdSpeech) heldSpeech.push({ request, row, deliver }); else deliver();
    },
    seed: store => ({ filename: store.db.prepare('PRAGMA database_list').get().file }),
    async modelResponse(body, _stats, _seeded, transport) {
      const input = body.model === 'qwen-mt-flash' ? body.messages[0].content : JSON.parse(body.messages.at(-1).content);
      let output, kind;
      if (body.model === 'qwen-mt-flash') {
        kind = 'translation'; const index = journeyText.original.indexOf(input);
        assert.ok(index >= 0, 'only authored original text reaches the journey translator');
        output = journeyText.translation[index];
      } else if (input.candidates) {
        kind = 'relation';
        const subject = input.candidates.find(row => row.canonical_name === 'Eastman Kodak');
        const object = input.candidates.find(row => row.canonical_name === 'Brownie camera');
        const evidence = input.evidence.find(row => row.scope === 'focus' && row.quote === journeyText.original[0]);
        assert.ok(subject && object && evidence, 'relation uses the real current candidates and focus evidence');
        output = relationWireEnvelope(input, [{ subject_item_id: subject.id, object_item_id: object.id,
          predicate: 'released', polarity: 'positive', modality: 'asserted', status: 'active', evidence_ids: [evidence.id] }]);
      } else {
        kind = 'knowledge';
        const names = ['Eastman Kodak', 'Brownie camera'].filter(name => input.focus_segments.some(row => row.text.includes(name)));
        output = { items: names.map(name => {
          const segment = input.focus_segments.find(row => row.text.includes(name));
          assert.ok(segment, 'knowledge evidence belongs to actual prompt source');
          const existing = input.existing_candidates.find(row => row.canonical_name === name);
          return { action: existing ? 'repeat' : 'create', display_label: name === 'Eastman Kodak' ? 'organization' : 'product',
            canonical_name: name, role: '讨论对象', reason: '原文明确提及', existing_item_id: existing?.id ?? null,
            observed_candidate_id: null, correction_reason: null, aliases: [], certainty: 'clear',
            short_description: name === 'Eastman Kodak' ? '推出布朗尼相机的公司。' : '面向日常摄影的相机。',
            new_information: segment.text,
            evidence: [{ segment_id: segment.id, quote: name }] };
        }) };
      }
      const row = structuredClone({ sequence: providerLedger.length + 1, kind, input, output, startedAt: new Date().toISOString(), held: kind === 'relation' && holdRelation, completedAt: null, transport: [] });
      providerLedger.push(row);
      const record = type => row.transport.push({ type, at: new Date().toISOString(), writableEnded: transport.response.writableEnded, destroyed: transport.response.destroyed });
      transport.response.once('close', () => record('close')); transport.response.once('finish', () => record('finish'));
      if (row.held) {
        holdRelation = false; let release; const promise = new Promise(resolve => { release = resolve; });
        heldRelations.push({ row, release }); await promise;
      }
      row.completedAt = new Date().toISOString(); record('provider-return'); return output;
    }
  }); } catch (error) {
    const cleanup = await Promise.allSettled([workletCapture?.close(), rm(controlDirectory, { recursive: true, force: true })]);
    const errors = cleanup.filter(row => row.status === 'rejected').map(row => row.reason);
    if (errors.length) throw new AggregateError([error, ...errors], 'Journey fixture startup and cleanup failed');
    throw error;
  }
  async function importClock(command, extra = {}) {
    assert.ok(['state', 'expire'].includes(command)); const sequence = ++clockSequence;
    await writeFile(path.join(controlDirectory, 'command.next'), JSON.stringify({ sequence, command, ...extra }));
    await rename(path.join(controlDirectory, 'command.next'), path.join(controlDirectory, 'command.json'));
    let stopped = false;
    const result = await deadline(async () => {
      while (!stopped) {
        try { const value = JSON.parse(await readFile(path.join(controlDirectory, 'ack.json'), 'utf8')); if (value.sequence === sequence) return value; } catch {}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Journey import clock ended');
    }, 3000, 'Journey import clock acknowledgement').finally(() => { stopped = true; });
    assert.equal(result.error, null); clockEvents.push({ command, ...result }); return result;
  }
  return { ...fixture, fixtureId: workletCapture.fixtureId, providerLedger, ttsLedger, heldRelations, heldSpeech, clockEvents, workletCapture, importClock,
    holdNextRelation() { holdRelation = true; },
    releaseRelations() { for (const held of heldRelations) held.release(); },
    holdTts(value) { holdSpeech = value; },
    snapshot: () => databaseSnapshot(fixture.seeded.filename),
    async close() {
      for (const held of heldRelations) held.release();
      const errors = [];
      for (const close of [() => fixture.close(), () => workletCapture.close(), () => rm(controlDirectory, { recursive: true, force: true })]) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Journey fixture cleanup failed');
    }
  };
}
