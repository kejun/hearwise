import { createHash } from 'node:crypto';

export const KNOWLEDGE_REVISION_VERSION = 1;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key] ?? null]));
const ordered = values => values.sort((a, b) => {
  const left = JSON.stringify(a), right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
});
const itemKeys = ['id', 'listening_id', 'type', 'canonical_name', 'normalized_name', 'dialogue_summary',
  'background_note', 'certainty', 'display_label', 'short_description', 'policy_version', 'content_version',
  'name_override', 'name_override_identity'];
const segmentKeys = ['id', 'listening_id', 'run_id', 'sequence_no', 'asr_sentence_id', 'original_text',
  'translation_text', 'translation_state', 'begin_ms', 'end_ms'];
const mentionKeys = ['item_id', 'segment_id', 'surface_text'];
const revisionKeys = ['id', 'item_id', 'action', 'old_value', 'new_value', 'merged_from_id', 'reason'];
const factKeys = ['id', 'item_id', 'segment_id', 'surface_text', 'content', 'certainty'];

// This is a wire contract, not the shape of SELECT * or of a display object.
// Any future semantic change to this projection needs a new version and a bridge.
export function knowledgeRevision({ item, segments }) {
  return hash({ version: KNOWLEDGE_REVISION_VERSION, item: { ...pick(item, itemKeys),
    aliases: ordered([...(item.aliases || [])]),
    mentions: ordered((item.mentions || []).map(row => pick(row, mentionKeys))),
    revisions: ordered((item.revisions || []).map(row => pick(row, revisionKeys))),
    facts: ordered((item.facts || []).map(row => pick(row, factKeys))) },
  segments: ordered(segments.map(row => pick(row, segmentKeys))) });
}

// Frozen v11/v12 contracts reproduce the historical JSON key order, including
// timestamps and query order. Never remove fields dynamically from SELECT *.
function legacyRevision({ item, segments }, version) {
  const legacyItem = pick(item, ['id', 'listening_id', 'type', 'canonical_name', 'normalized_name',
    'dialogue_summary', 'background_note', 'certainty', 'created_at', 'updated_at', 'display_label',
    'short_description', 'policy_version', 'content_version']);
  if (version === 12) {
    Object.assign(legacyItem, pick(item, ['name_override', 'name_override_identity']));
    const identity = hash([item.canonical_name, item.type, item.display_label ?? null]);
    legacyItem.display_name = item.name_override && item.name_override_identity === identity
      ? item.name_override : item.canonical_name;
  }
  Object.assign(legacyItem, { aliases: [...(item.aliases || [])],
    mentions: (item.mentions || []).map(row => pick(row, mentionKeys)),
    revisions: (item.revisions || []).map(row => pick(row, [...revisionKeys, 'created_at'])),
    facts: (item.facts || []).map(row => pick(row, [...factKeys, 'created_at'])) });
  return hash({ item: legacyItem, segments: segments.map(row => pick(row, [...segmentKeys, 'created_at'])) });
}

export function compatibleKnowledgeRevisions(snapshot) {
  const revisions = [knowledgeRevision(snapshot), legacyRevision(snapshot, 12)];
  // A v11 client never observed an override. Do not ignore one to accept its token.
  if (snapshot.item.name_override == null && snapshot.item.name_override_identity == null)
    revisions.push(legacyRevision(snapshot, 11));
  return [...new Set(revisions)];
}
export const matchesKnowledgeRevision = (snapshot, revision) => typeof revision === 'string' &&
  compatibleKnowledgeRevisions(snapshot).includes(revision);

export function knowledgeStale(snapshot, submittedRevision, message) {
  return Object.assign(new Error(message), { status: 409, knowledgeEdit: true, code: 'KNOWLEDGE_EDIT_STALE',
    revision: snapshot.revision, revisionVersion: KNOWLEDGE_REVISION_VERSION, submittedRevision });
}
export function assertKnowledgeRevision(snapshot, revision, message) {
  if (!matchesKnowledgeRevision(snapshot, revision)) throw knowledgeStale(snapshot, revision, message);
}

export function logKnowledgeRevisionConflict(error, listeningId, itemId, operation) {
  if (error.code !== 'KNOWLEDGE_EDIT_STALE') return;
  const prefix = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value.slice(0, 8) : 'invalid';
  console.warn('knowledge_revision_conflict', JSON.stringify({ listening_id: listeningId, item_id: itemId,
    operation, expected: prefix(error.revision), actual: prefix(error.submittedRevision) }));
}
