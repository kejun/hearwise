import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './verification-evidence.mjs';
import { atomicityEvidenceControls } from '../../test-support/import-atomicity-evidence.mjs';

export async function collectAtomicityControls(directory, report, generate = atomicityEvidenceControls) {
  try {
    const raw = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
    await writeJson(path.join(directory, 'controls.json'), generate(raw));
  } catch (error) {
    report.controlsError = { name: error.name, message: error.message };
    try { await writeJson(path.join(directory, 'controls.json'), { error: report.controlsError }); }
    catch (writeError) { report.controlsWriteError = { name: writeError.name, message: writeError.message }; }
  }
}
