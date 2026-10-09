import { createHash } from 'node:crypto';

// Independent reproduction of pre-fix code: object spread/SELECT * order matters.
// Call before adding any test-only columns or display fields.
export function preFixRevision(snapshot, version = 12) {
  const item = { ...snapshot.item };
  if (version === 11) {
    delete item.name_override; delete item.name_override_identity; delete item.display_name;
  }
  return createHash('sha256').update(JSON.stringify({ item, segments: snapshot.segments })).digest('hex');
}
export const preFixContextHash = (revision, input) => createHash('sha256')
  .update(JSON.stringify(['name_correction', 1, 'qwen3.8-flash', false, revision, input])).digest('hex');
