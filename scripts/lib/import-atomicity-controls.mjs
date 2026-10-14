import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './verification-evidence.mjs';
import { atomicityEvidenceControls } from '../../test-support/import-atomicity-evidence.mjs';

export async function collectAtomicityControls(directory, report) {
  try {
    const raw = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
    await writeJson(path.join(directory, 'controls.json'), atomicityEvidenceControls(raw));
  } catch (error) { report.error ||= { name: error.name, message: error.message }; }
}
