import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { digest, sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { playbackControllerVariant } from './playback-controller-variant.mjs';

export const playbackServedFiles = ['public/app.js', 'public/speech-controller.js', 'public/speech-player.js', 'public/speech-output-processor.js', 'public/speech-buffer.js'];
const required = [...playbackServedFiles, 'dist/server/index.js', 'public/vendor/cytoscape.js', 'server.mjs', 'speech-service.mjs', 'qwen-tts.mjs',
  'package-lock.json', 'test-support/playback-provenance.mjs', 'test-support/playback-evidence.mjs', 'scripts/verify-playback-browser.mjs'];
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
  const controller = await readFile('public/speech-controller.js', 'utf8');
  if (digest(controller) !== snapshot.digests['public/speech-controller.js']) throw new Error('Playback controller changed while capturing provenance');
  return { snapshot, mutation: 'late-unlock', normalControllerSha256: digest(controller),
    mutantControllerSha256: digest(playbackControllerVariant(controller, { mutation: 'late-unlock' })) };
}
export function validPlaybackProvenance(browser, expected) {
  if (!expected || !stablePlaybackSources(browser?.sourceStart, browser?.sourceEnd) || !isDeepStrictEqual(browser.sourceStart, expected.snapshot) ||
    !isDeepStrictEqual(browser.mutation, { mutation: expected.mutation, normalControllerSha256: expected.normalControllerSha256, mutantControllerSha256: expected.mutantControllerSha256 })) return false;
  const check = (served, mutant) => Array.isArray(served?.responses) && Array.isArray(served.errors) && served.errors.length === 0 &&
    playbackServedFiles.every(file => served.responses.some(row => row.file === file)) && served.responses.every(row => playbackServedFiles.includes(row.file) &&
      row.status === 200 && row.sha256 === (mutant && row.file === 'public/speech-controller.js' ? expected.mutantControllerSha256 : expected.snapshot.digests[row.file])) &&
    (!mutant || served.responses.filter(row => row.file === 'public/speech-controller.js').length === 1);
  return browser.widths.every(row => row.cases.every(item => check(item.served, false))) && check(browser.negative?.served, true);
}
