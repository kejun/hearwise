// Synthetic evidence shape only; never an actual Chromium result.
import { randomUUID } from 'node:crypto';
import { playbackServedFiles } from './playback-provenance.mjs';
import { playbackWorkletFiles } from './playback-worklet-responses.mjs';
import { playbackGolden } from './playback-speech-fixture.mjs';
import { speechIntervalLedger } from './playback-text-contract.mjs';
export function syntheticBrowser(provenance) {
  const cut = playbackGolden.indexOf('。') + 1;
  const requests = [playbackGolden.slice(0, cut), playbackGolden.slice(cut).trim().slice(0, -4), 'END'];
  const served = mutant => {
    const fixtureId = randomUUID(), origin = 'http://127.0.0.1:12345';
    return { fixtureId, origin, errors: [], responses: playbackServedFiles.map(file => ({ fixtureId, origin, file, status: 200,
      source: playbackWorkletFiles.includes(file) ? 'server-response-finish' : 'page-response', method: 'GET', path: file.slice('public'.length),
      bytes: mutant && file === 'public/speech-controller.js' ? provenance.mutantControllerBytes : provenance.servedBytes[file],
      sha256: mutant && file === 'public/speech-controller.js' ? provenance.mutantControllerSha256 : provenance.snapshot.digests[file] })) };
  };
  const socket = { id: 1, readyState: 3, sent: [{ type: 'speech.transcript', epoch: 1 }, { type: 'speech.progress', epoch: 1, playedUnit: 3, consumedSamples: 18000 }],
    received: requests.flatMap((text, i) => [{ type: 'speech.unit', epoch: 1, unit: i + 1, text }, { type: 'pcm', epoch: 1, unit: i + 1, frame: 0, samples: 6000, bytes: 12016 },
      { type: 'speech.unit-end', epoch: 1, unit: i + 1, samples: 6000 }]).concat({ type: 'speech.finished', epoch: 1 }) };
  const paused = { enabled: true, paused: true, status: 'paused', contexts: ['closed', 'suspended'], contextIds: [1, 2],
    sockets: [{ id: 1, readyState: 3, sent: [], received: [] }, { id: 2, readyState: 1, sent: [{ paused: true, startPosition: 2 }], received: [] }] };
  const finished = { ...structuredClone(paused), enabled: false, contexts: ['closed', 'closed'] }; finished.sockets[1].readyState = 3;
  const unlocked = { enabled: true, paused: false, contexts: ['closed', 'running'], contextIds: [1, 2], sockets: [{ id: 1, readyState: 1, sent: [], received: [] }] };
  const stopped = { ...structuredClone(unlocked), enabled: false, contexts: ['closed', 'closed'] }; stopped.sockets[0].readyState = 3;
  return { complete: true, chromium: 'synthetic-contract-only', sourceStart: structuredClone(provenance.snapshot), sourceEnd: structuredClone(provenance.snapshot),
    mutation: { mutation: provenance.mutation, normalControllerSha256: provenance.normalControllerSha256, mutantControllerSha256: provenance.mutantControllerSha256 },
    widths: [1280, 390].map(width => ({ width, cases: [
      { scenario: 'text', normalized: playbackGolden, requests, ledger: speechIntervalLedger(playbackGolden, requests, { graphemeSafe: true }),
        state: { enabled: false, contexts: ['closed'], contextIds: [1], sockets: [structuredClone(socket)] }, served: served(false), errors: [] },
      { scenario: 'paused-seek', paused: structuredClone(paused), afterLate: structuredClone(paused), finished: structuredClone(finished),
        commitsWhilePaused: ['甲。'], commitsAfterLate: ['甲。'], commits: ['甲。', '乙。'], served: served(false), errors: [] },
      { scenario: 'unlock-race', before: structuredClone(unlocked), after: structuredClone(unlocked), stopped: structuredClone(stopped), commits: ['丙。'], served: served(false), errors: [] }
    ] })), negative: { caught: true, mutation: 'late-unlock', expectedSockets: 1, actualSockets: 2, before: structuredClone(unlocked),
      after: { ...structuredClone(unlocked), sockets: [...structuredClone(unlocked.sockets), { id: 2, readyState: 1, sent: [], received: [] }] }, served: served(true), errors: [] } };
}
