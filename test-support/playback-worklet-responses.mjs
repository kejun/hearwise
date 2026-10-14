import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const playbackWorkletFiles = ['public/speech-output-processor.js', 'public/speech-buffer.js'];

// An independent, per-server log. Only the actual server child imports the
// observer; the browser fixture never requests module copies to fill this log.
export async function capturePlaybackWorkletResponses() {
  const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-worklet-responses-'));
  const filename = path.join(directory, 'responses.jsonl'), fixtureId = randomUUID();
  try { await writeFile(filename, '', { mode: 0o600 }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    fixtureId,
    imports: [new URL('./playback-worklet-preload.mjs', import.meta.url).href],
    env: { HEARWISE_TEST_WORKLET_RESPONSES: filename, HEARWISE_TEST_WORKLET_FIXTURE: fixtureId },
    async read() { return (await readFile(filename, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); },
    close: () => rm(directory, { recursive: true, force: true })
  };
}
