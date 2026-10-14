import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { digest, sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { playbackControllerVariant } from './playback-controller-variant.mjs';
import { playbackWorkletFiles } from './playback-worklet-responses.mjs';

export const playbackServedFiles = ['public/app.js', 'public/speech-controller.js', 'public/speech-player.js', 'public/speech-output-processor.js', 'public/speech-buffer.js'];
const required = [...playbackServedFiles, 'dist/server/index.js', 'public/vendor/cytoscape.js', 'server.mjs', 'speech-service.mjs', 'qwen-tts.mjs',
  'package-lock.json', 'test-support/playback-provenance.mjs', 'test-support/playback-evidence.mjs', 'scripts/verify-playback-browser.mjs',
  'test-support/playback-worklet-responses.mjs', 'test-support/playback-worklet-preload.mjs'];
export async function playbackSourceSnapshot() {
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const files = [...new Set([...tracked, 'dist/server/index.js', 'public/vendor/cytoscape.js'])].sort();
  return { source: sourceVersion(), digests: Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(file))]))) };
}
export function stablePlaybackSources(start, end) {
  return Boolean(start && end && /^[a-f0-9]{40}$/.test(start.source?.sha) && typeof start.source?.dirty === 'boolean' &&
    required.every(file => /^[a-f0-9]{64}$/.test(start.digests?.[file])) && isDeepStrictEqual(start, end));
}
export async function playbackProvenance(snapshot) {
  snapshot ||= await playbackSourceSnapshot();
  const sources = Object.fromEntries(await Promise.all(playbackServedFiles.map(async file => [file, await readFile(file)])));
  if (playbackServedFiles.some(file => digest(sources[file]) !== snapshot.digests[file])) throw new Error('Playback modules changed while capturing provenance');
  const controller = sources['public/speech-controller.js'].toString('utf8');
  const mutant = playbackControllerVariant(controller, { mutation: 'late-unlock' });
  return { snapshot, mutation: 'late-unlock', normalControllerSha256: digest(controller),
    mutantControllerSha256: digest(mutant), mutantControllerBytes: Buffer.byteLength(mutant),
    servedBytes: Object.fromEntries(playbackServedFiles.map(file => [file, sources[file].length])) };
}
export function validPlaybackProvenance(browser, expected) {
  if (!expected || !stablePlaybackSources(browser?.sourceStart, browser?.sourceEnd) || !isDeepStrictEqual(browser.sourceStart, expected.snapshot) ||
    !isDeepStrictEqual(browser.mutation, { mutation: expected.mutation, normalControllerSha256: expected.normalControllerSha256, mutantControllerSha256: expected.mutantControllerSha256 })) return false;
  const fixtureIds = new Set();
  const check = (served, mutant) => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(served?.fixtureId || '') || fixtureIds.has(served.fixtureId)) return false;
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(served.origin || '') || Number(new URL(served.origin).port) > 65535) return false;
    fixtureIds.add(served.fixtureId);
    return Array.isArray(served.responses) && Array.isArray(served.errors) && served.errors.length === 0 &&
    playbackServedFiles.every(file => served.responses.some(row => row.file === file)) && served.responses.every(row => playbackServedFiles.includes(row.file) &&
      row.fixtureId === served.fixtureId && row.origin === served.origin && row.method === 'GET' && row.path === row.file.slice('public'.length) &&
      row.source === (playbackWorkletFiles.includes(row.file) ? 'server-response-finish' : 'page-response') &&
      row.bytes > 0 && row.bytes === (mutant && row.file === 'public/speech-controller.js' ? expected.mutantControllerBytes : expected.servedBytes[row.file]) &&
      row.status === 200 && row.sha256 === (mutant && row.file === 'public/speech-controller.js' ? expected.mutantControllerSha256 : expected.snapshot.digests[row.file])) &&
    (!mutant || served.responses.filter(row => row.file === 'public/speech-controller.js').length === 1);
  };
  return browser.widths.every(row => row.cases.every(item => check(item.served, false))) && check(browser.negative?.served, true);
}
