import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';

// Keep the original nested logs/report even if its parent's assertion fails.
// This directory is already an always-uploaded CI artifact, unlike os.tmpdir().
export async function profileEvidenceDirectory(name) {
  if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid profile evidence label');
  const root = path.resolve(process.env.TEST_EVIDENCE_DIR || 'test-evidence', 'nested-profiles');
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, `${name}-`));
}
