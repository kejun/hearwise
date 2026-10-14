import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const sourceUrl = new URL('../relation-storage.mjs', import.meta.url);
export const relationCommitGuardAnchor = "if (!window || !['running', 'pending'].includes(job.state) || round?.state !== 'active' || window.relation_epoch !== job.epoch || inputFor(this, window).input.input_fingerprint !== job.input_fingerprint) {";
const replacement = 'if (false) { // Isolated negative control: omitted stale-context transaction guard.';
const digest = value => createHash('sha256').update(value).digest('hex');

export function relationCommitGuardVariant(source) {
  assert.equal(source.split(relationCommitGuardAnchor).length, 2, 'exactly one complete production commit guard is required');
  const variant = source.replace(relationCommitGuardAnchor, replacement);
  assert.equal(variant.replace(replacement, relationCommitGuardAnchor), source);
  return { source: variant, metadata: { path: 'relation-storage.mjs', originalSha256: digest(source), variantSha256: digest(variant),
    anchor: relationCommitGuardAnchor, replacement, replacedCount: 1, boundary: 'direct-old-context-transaction-call' } };
}

export async function loadRelationCommitGuardVariant() {
  const original = await readFile(sourceUrl, 'utf8'), variant = relationCommitGuardVariant(original);
  // A data module has no relative resolution base. Only import specifiers are
  // made absolute; all helpers and the single changed function body stay intact.
  const imports = [];
  const moduleSource = variant.source.replace(/from '(\.\/[^']+)'/g, (match, relative) => {
    const absolute = new URL(relative, sourceUrl).href; imports.push({ relative, absolute }); return `from '${absolute}'`;
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
  return { commit: module.relationMethods.commitRelationJob, metadata: { ...variant.metadata, moduleSha256: digest(moduleSource), imports } };
}
