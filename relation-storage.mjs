import { createHash, randomUUID } from 'node:crypto';
import { buildRelationInput, canonicalizeRelation, isExplicitRelationCorrection, RELATION_LIMITS, RELATION_REQUEST_TIMEOUT_MS } from './relations.mjs';

export const RELATION_WINDOW_SIZE = 6;
export const RELATION_CONTEXT_SIZE = 3;
export const RELATION_QUIET_MS = 6000;
export const RELATION_RUN_LIMITS = Object.freeze({ maxWindowRequests: 3, requestTimeoutMs: RELATION_REQUEST_TIMEOUT_MS, maxConcurrent: 2 });
const safeUsage = usage => {
  if (!usage || typeof usage !== 'object') return null;
  const result = Object.fromEntries(['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'total_tokens']
    .filter(key => Number.isFinite(usage[key]) && usage[key] >= 0).map(key => [key, usage[key]]));
  return Object.keys(result).length ? result : null;
};
function usageSummary(requests) {
  const result = { requests: requests.length, inputTokens: 0, outputTokens: 0, totalTokens: 0, measuredRequests: 0 };
  for (const request of requests) if (request.usage_json) {
    const usage = safeUsage(JSON.parse(request.usage_json));
    if (!usage) continue;
    result.measuredRequests++;
    result.inputTokens += usage.prompt_tokens ?? usage.input_tokens ?? 0;
    result.outputTokens += usage.completion_tokens ?? usage.output_tokens ?? 0;
    result.totalTokens += usage.total_tokens ?? ((usage.prompt_tokens ?? usage.input_tokens ?? 0) + (usage.completion_tokens ?? usage.output_tokens ?? 0));
  }
  return result;
}
function currentRound(store, id) {
  return store.db.prepare('SELECT r.* FROM relation_rounds r JOIN listenings l ON l.id=r.listening_id AND l.relation_epoch=r.epoch WHERE l.id=?').get(id);
}
function roundRequests(store, round) {
  return store.db.prepare('SELECT q.* FROM relation_requests q JOIN relation_jobs j ON j.id=q.job_id WHERE j.listening_id=? AND j.epoch=?').all(round.listening_id, round.epoch);
}
function finishIdleRun(store, id, now = Date.now()) {
  if (!store.relationHasWork(id)) store.db.prepare("UPDATE relation_rounds SET finished_at=COALESCE(finished_at,?),wait_reason=NULL,next_ready_at=NULL WHERE listening_id=? AND state='active'").run(now, id);
}
function stopRound(store, round, reason, now, state = 'paused') {
  if (!round || round.state !== 'active') return false;
  store.db.prepare("UPDATE relation_rounds SET state=?,stop_reason=?,finished_at=?,wait_reason=NULL,next_ready_at=NULL WHERE id=? AND state='active'").run(state, reason, state === 'complete' ? round.finished_at ?? now : now, round.id);
  store.db.prepare("UPDATE relation_jobs SET state='cancelled',last_error=?,updated_at=? WHERE listening_id=? AND epoch=? AND state IN ('pending','running')").run(reason, stamp(), round.listening_id, round.epoch);
  store.db.prepare("UPDATE relation_windows SET state='dirty',ready_at=0,last_error=? WHERE listening_id=? AND state='pending'").run(reason, round.listening_id);
  store.db.prepare('UPDATE listenings SET relation_waiting_key=0 WHERE id=?').run(round.listening_id);
  return true;
}
const PROMPT_VERSION = 'relations-v1';
const MODEL_VERSION = 'qwen3.8-flash';
const hash = value => createHash('sha256').update(value).digest('hex');
const stableHash = value => hash(JSON.stringify(value));
const stamp = () => new Date().toISOString();
const norm = value => String(value).normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

// SQL triggers make dirtiness durable in the same transaction as every writer,
// including V1, V2 checkpoint commits, repeat-only mentions and future editors.
export function migrateRelations(store) {
  const db = store.db;
  const columns = new Set(db.prepare("PRAGMA table_info(listenings)").all().map(column => column.name));
  for (const name of ['relation_enabled', 'relation_epoch', 'relation_waiting_key', 'graph_revision']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE listenings ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS relation_windows (
      id TEXT PRIMARY KEY, listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
      from_sequence INTEGER NOT NULL, to_sequence INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'dirty',
      dirty_at INTEGER NOT NULL, ready_at INTEGER NOT NULL DEFAULT 0,
      last_fingerprint TEXT, last_error TEXT, UNIQUE(listening_id, from_sequence));
    CREATE INDEX IF NOT EXISTS relation_window_work ON relation_windows(listening_id,state,from_sequence);
    CREATE TABLE IF NOT EXISTS relation_jobs (
      id TEXT PRIMARY KEY, listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
      window_id TEXT NOT NULL REFERENCES relation_windows(id) ON DELETE CASCADE,
      window_revision INTEGER NOT NULL, epoch INTEGER NOT NULL, input_fingerprint TEXT NOT NULL,
      prompt_version TEXT NOT NULL, model_version TEXT NOT NULL, input_json TEXT NOT NULL,
      state TEXT NOT NULL, request_count INTEGER NOT NULL DEFAULT 0, max_requests INTEGER NOT NULL DEFAULT 3,
      ready_at INTEGER NOT NULL DEFAULT 0, rejected_json TEXT NOT NULL DEFAULT '[]',
      usage_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(window_id,window_revision,epoch));
    CREATE INDEX IF NOT EXISTS relation_job_work ON relation_jobs(listening_id,state,ready_at);
    CREATE TABLE IF NOT EXISTS relation_requests (
      job_id TEXT NOT NULL REFERENCES relation_jobs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL, started_at INTEGER NOT NULL, usage_json TEXT, outcome TEXT,
      PRIMARY KEY(job_id,attempt));
    CREATE INDEX IF NOT EXISTS relation_request_hour ON relation_requests(started_at);
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY, listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
      subject_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      object_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      predicate TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK(subject_item_id!=object_item_id), UNIQUE(listening_id,subject_item_id,object_item_id,predicate));
    CREATE TABLE IF NOT EXISTS relation_assertions (
      id TEXT PRIMARY KEY, relation_id TEXT NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
      assertion_key TEXT NOT NULL, statement TEXT NOT NULL,
      polarity TEXT NOT NULL CHECK(polarity IN ('positive','negative')),
      modality TEXT NOT NULL CHECK(modality IN ('asserted','planned','uncertain')),
      conditions TEXT, time_scope TEXT, attribution TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','needs_review','stale','superseded')),
      correction_of TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(relation_id,assertion_key));
    CREATE TABLE IF NOT EXISTS relation_supports (
      id TEXT PRIMARY KEY, assertion_id TEXT NOT NULL REFERENCES relation_assertions(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES relation_jobs(id) ON DELETE SET NULL,
      window_id TEXT NOT NULL REFERENCES relation_windows(id) ON DELETE CASCADE,
      window_revision INTEGER NOT NULL, segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      source_revision TEXT NOT NULL, group_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, quote TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('relation','subject_reference','object_reference')),
      state TEXT NOT NULL CHECK(state IN ('active','stale')), created_at TEXT NOT NULL,
      UNIQUE(assertion_id,group_id,segment_id,source_revision,start,end,role));
    CREATE INDEX IF NOT EXISTS relation_support_segment ON relation_supports(segment_id,state);
    CREATE TABLE IF NOT EXISTS relation_revisions (
      id TEXT PRIMARY KEY, relation_id TEXT NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
      assertion_id TEXT REFERENCES relation_assertions(id) ON DELETE CASCADE,
      action TEXT NOT NULL, old_value TEXT, new_value TEXT, reason TEXT, created_at TEXT NOT NULL);
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS relation_rounds (
    id TEXT PRIMARY KEY, listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active', started_at INTEGER NOT NULL,
    finished_at INTEGER, stop_reason TEXT, wait_reason TEXT, next_ready_at INTEGER,
    UNIQUE(listening_id,epoch));`);
  const windowColumns = new Set(db.prepare('PRAGMA table_info(relation_windows)').all().map(c => c.name));
  if (!windowColumns.has('source_change_revision')) {
    db.exec('ALTER TABLE relation_windows ADD COLUMN source_change_revision INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE relation_windows SET source_change_revision=revision WHERE EXISTS (SELECT 1 FROM relation_supports s WHERE s.window_id=relation_windows.id AND s.state='stale')");
  }
  // v8 removes whole-run quotas. Keep measured provider usage and the durable
  // per-window attempt journal; legacy paused/cancelled runs require explicit resume.
  const roundColumns = new Set(db.prepare('PRAGMA table_info(relation_rounds)').all().map(c => c.name));
  for (const column of ['deadline_at', 'max_requests', 'max_estimated_tokens']) {
    if (roundColumns.has(column)) db.exec(`ALTER TABLE relation_rounds DROP COLUMN ${column}`);
  }
  const requestColumns = new Set(db.prepare('PRAGMA table_info(relation_requests)').all().map(c => c.name));
  if (requestColumns.has('estimated_tokens')) db.exec('ALTER TABLE relation_requests DROP COLUMN estimated_tokens');
  // The fingerprint no longer treats generated assertion coverage as source
  // identity. Upgrade saved snapshots too, so migration alone cannot replay a
  // paid complete/partial result or discard a recoverable pending attempt.
  for (const row of db.prepare('SELECT id,window_id,input_json,input_fingerprint FROM relation_jobs').all()) {
    const input = JSON.parse(row.input_json);
    const fingerprint = stableHash({ ...input, input_fingerprint: undefined, window_revision: undefined,
      existing_assertions: undefined, coverage_limited: undefined });
    input.input_fingerprint = fingerprint;
    db.prepare('UPDATE relation_jobs SET input_fingerprint=?,input_json=? WHERE id=?').run(fingerprint, JSON.stringify(input), row.id);
    db.prepare('UPDATE relation_windows SET last_fingerprint=? WHERE id=? AND last_fingerprint=?').run(fingerprint, row.window_id, row.input_fingerprint);
  }
  // Replace deployed v6 triggers, not just triggers on fresh databases.
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'relation_%'").all()) db.exec(`DROP TRIGGER ${row.name}`);
  const clock = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
  const dirty = where => `UPDATE relation_windows SET revision=revision+1,state='dirty',dirty_at=${clock},ready_at=0,last_error=NULL WHERE ${where};`;
  const nodeWindows = ref => `listening_id=${ref}.listening_id AND (state='waiting_nodes' OR EXISTS (
    SELECT 1 FROM segments s WHERE s.listening_id=${ref}.listening_id
    AND s.sequence_no BETWEEN relation_windows.from_sequence-3 AND relation_windows.to_sequence
    AND (instr(lower(s.original_text),lower(${ref}.canonical_name))>0 OR EXISTS
      (SELECT 1 FROM knowledge_mentions m WHERE m.item_id=${ref}.id AND m.segment_id=s.id))))`;
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    const refs = event === 'UPDATE' ? ['OLD', 'NEW'] : [event === 'DELETE' ? 'OLD' : 'NEW'];
    const ref = refs[refs.length - 1];
    const identityChanged = event === 'UPDATE' ? ' AND (OLD.canonical_name IS NOT NEW.canonical_name OR OLD.type IS NOT NEW.type OR OLD.display_label IS NOT NEW.display_label OR OLD.certainty IS NOT NEW.certainty)' : '';
    db.exec(`CREATE TRIGGER relation_node_${event.toLowerCase()} AFTER ${event} ON knowledge_items BEGIN
      UPDATE listenings SET graph_revision=graph_revision+1 WHERE id=${ref}.listening_id;
      ${refs.map(r => dirty(`(${nodeWindows(r)})${identityChanged}`)).join('\n')}
    END;`);
  }
  for (const table of ['knowledge_mentions', 'knowledge_aliases']) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const refs = event === 'UPDATE' ? ['OLD', 'NEW'] : [event === 'DELETE' ? 'OLD' : 'NEW'];
      const scope = ref => table === 'knowledge_mentions'
        ? `EXISTS (SELECT 1 FROM segments s WHERE s.id=${ref}.segment_id AND s.sequence_no BETWEEN relation_windows.from_sequence-3 AND relation_windows.to_sequence)`
        : `(state='waiting_nodes' OR EXISTS (SELECT 1 FROM segments s WHERE s.listening_id=relation_windows.listening_id AND s.sequence_no BETWEEN relation_windows.from_sequence-3 AND relation_windows.to_sequence
            AND (instr(lower(s.original_text),lower(${ref}.alias))>0 OR EXISTS (SELECT 1 FROM knowledge_mentions m WHERE m.item_id=${ref}.item_id AND m.segment_id=s.id))))`;
      const fields = table === 'knowledge_mentions' ? ['item_id', 'segment_id', 'surface_text'] : ['item_id', 'alias', 'normalized_alias'];
      const when = event === 'UPDATE' ? `WHEN ${fields.map(f => `OLD.${f} IS NOT NEW.${f}`).join(' OR ')}` : '';
      db.exec(`CREATE TRIGGER relation_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} ${when} BEGIN
        ${refs.map(ref => `UPDATE listenings SET graph_revision=graph_revision+1 WHERE id=(SELECT listening_id FROM knowledge_items WHERE id=${ref}.item_id);
        ${dirty(`listening_id=(SELECT listening_id FROM knowledge_items WHERE id=${ref}.item_id) AND ${scope(ref)}`)}`).join('\n')}
      END;`);
    }
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS relation_segment_insert AFTER INSERT ON segments
      WHEN (SELECT relation_enabled FROM listenings WHERE id=NEW.listening_id)=1 BEGIN
      INSERT OR IGNORE INTO relation_windows(id,listening_id,from_sequence,to_sequence,dirty_at)
        VALUES(NEW.listening_id||':'||CAST((NEW.sequence_no-1)/6 AS INTEGER),NEW.listening_id,
          CAST((NEW.sequence_no-1)/6 AS INTEGER)*6+1,CAST((NEW.sequence_no-1)/6 AS INTEGER)*6+6,${clock});
      ${dirty('listening_id=NEW.listening_id AND NEW.sequence_no BETWEEN from_sequence-3 AND to_sequence')}
    END;
    CREATE TRIGGER IF NOT EXISTS relation_segment_update AFTER UPDATE OF original_text,translation_text,translation_state ON segments
      WHEN OLD.original_text IS NOT NEW.original_text OR
        (CASE WHEN OLD.translation_state='complete' THEN OLD.translation_text END) IS NOT
        (CASE WHEN NEW.translation_state='complete' THEN NEW.translation_text END) BEGIN
      ${dirty('listening_id=NEW.listening_id AND NEW.sequence_no BETWEEN from_sequence-3 AND to_sequence')}
      UPDATE relation_windows SET source_change_revision=revision WHERE listening_id=NEW.listening_id AND NEW.sequence_no BETWEEN from_sequence-3 AND to_sequence AND OLD.original_text IS NOT NEW.original_text;
      UPDATE relation_supports SET state='stale' WHERE group_id IN (SELECT group_id FROM relation_supports WHERE segment_id=NEW.id) AND OLD.original_text IS NOT NEW.original_text;
      INSERT INTO relation_revisions(id,relation_id,assertion_id,action,old_value,new_value,reason,created_at)
        SELECT lower(hex(randomblob(16))),a.relation_id,a.id,'source_invalidated',a.status,'support_group_stale','SOURCE_CHANGED',strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM relation_assertions a WHERE OLD.original_text IS NOT NEW.original_text AND a.id IN (SELECT assertion_id FROM relation_supports WHERE segment_id=NEW.id);
      UPDATE relation_assertions SET status='stale',version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE status IN ('active','needs_review') AND id IN (SELECT assertion_id FROM relation_supports WHERE segment_id=NEW.id)
        AND NOT EXISTS (SELECT 1 FROM relation_supports p WHERE p.assertion_id=relation_assertions.id AND p.state='active');
      UPDATE listenings SET graph_revision=graph_revision+1 WHERE id=NEW.listening_id;
    END;
    CREATE TRIGGER IF NOT EXISTS relation_segment_delete BEFORE DELETE ON segments BEGIN
      ${dirty('listening_id=OLD.listening_id AND OLD.sequence_no BETWEEN from_sequence-3 AND to_sequence')}
      UPDATE relation_windows SET source_change_revision=revision WHERE listening_id=OLD.listening_id AND OLD.sequence_no BETWEEN from_sequence-3 AND to_sequence;
      UPDATE relation_supports SET state='stale' WHERE group_id IN (SELECT group_id FROM relation_supports WHERE segment_id=OLD.id);
      INSERT INTO relation_revisions(id,relation_id,assertion_id,action,old_value,new_value,reason,created_at)
        SELECT lower(hex(randomblob(16))),a.relation_id,a.id,'source_invalidated',a.status,'support_group_stale','SOURCE_DELETED',strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM relation_assertions a WHERE a.id IN (SELECT assertion_id FROM relation_supports WHERE segment_id=OLD.id);
      UPDATE relation_assertions SET status='stale',version=version+1
        WHERE status IN ('active','needs_review') AND id IN (SELECT assertion_id FROM relation_supports WHERE segment_id=OLD.id)
        AND NOT EXISTS (SELECT 1 FROM relation_supports p WHERE p.assertion_id=relation_assertions.id AND p.state='active' AND p.segment_id!=OLD.id);
      UPDATE listenings SET graph_revision=graph_revision+1 WHERE id=OLD.listening_id;
    END;
    PRAGMA user_version=8;
  `);
}

function publicJob(row) {
  if (!row) return null;
  const { input_json, rejected_json, usage_json, ...job } = row;
  return { ...job, input: JSON.parse(input_json), rejected: JSON.parse(rejected_json), usage: usage_json ? JSON.parse(usage_json) : null };
}

function inputFor(store, window) {
  const segments = store.db.prepare(`SELECT * FROM segments WHERE listening_id=? AND sequence_no BETWEEN ? AND ? ORDER BY sequence_no`)
    .all(window.listening_id, Math.max(1, window.from_sequence - RELATION_CONTEXT_SIZE), window.to_sequence);
  const ids = new Set(segments.map(s => s.id));
  const all = store.db.prepare('SELECT id,listening_id,canonical_name,type,display_label,certainty FROM knowledge_items WHERE listening_id=?').all(window.listening_id);
  const aliases = store.db.prepare('SELECT a.* FROM knowledge_aliases a JOIN knowledge_items k ON k.id=a.item_id WHERE k.listening_id=?').all(window.listening_id);
  const mentions = store.db.prepare(`SELECT m.* FROM knowledge_mentions m JOIN segments s ON s.id=m.segment_id
    WHERE s.listening_id=? AND s.sequence_no BETWEEN ? AND ?`).all(window.listening_id, Math.max(1, window.from_sequence - RELATION_CONTEXT_SIZE), window.to_sequence);
  for (const item of all) { item.aliases = aliases.filter(a => a.item_id === item.id).map(a => a.alias); item.mentions = mentions.filter(m => m.item_id === item.id); }
  const text = norm(segments.map(s => s.original_text).join('\n'));
  const recalled = all.filter(item => item.mentions.some(m => ids.has(m.segment_id)) || [item.canonical_name, ...item.aliases].some(name => name && text.includes(norm(name))))
    .sort((a, b) => Number(b.mentions.some(m => ids.has(m.segment_id))) - Number(a.mentions.some(m => ids.has(m.segment_id))) || a.id.localeCompare(b.id));
  const candidates = recalled.slice(0, 48).sort((a, b) => a.id.localeCompare(b.id)).map(item => ({ id: item.id, listening_id: item.listening_id,
    canonical_name: item.canonical_name, type: item.type, display_label: item.display_label,
    certainty: item.certainty,
    aliases: [...item.aliases].sort((a, b) => Number(text.includes(norm(b))) - Number(text.includes(norm(a))) || a.localeCompare(b)).slice(0, 12),
    identity_revision: stableHash([item.canonical_name, item.type, item.display_label, [...item.aliases].sort(), item.certainty]) }));
  const candidateIds = new Set(candidates.map(c => c.id));
  const existing = store.db.prepare(`SELECT a.*,r.subject_item_id,r.object_item_id,r.predicate FROM relation_assertions a JOIN relations r ON r.id=a.relation_id
    WHERE r.listening_id=? ORDER BY a.id`).all(window.listening_id)
    .filter(a => candidateIds.has(a.subject_item_id) && candidateIds.has(a.object_item_id));
  let sourceRemaining = RELATION_LIMITS.sourceChars, translationRemaining = RELATION_LIMITS.translationChars;
  let clipped = false;
  // Focus text receives the budget first; input order remains chronological.
  const mapped = new Map();
  for (const s of [...segments.filter(s => s.sequence_no >= window.from_sequence), ...segments.filter(s => s.sequence_no < window.from_sequence)]) {
    const source = s.original_text.slice(0, Math.max(0, sourceRemaining)); sourceRemaining -= source.length;
    const translation = s.translation_state === 'complete' ? (s.translation_text || '') : null;
    const translated = translation == null ? null : translation.slice(0, Math.max(0, translationRemaining)); translationRemaining -= translated?.length || 0;
    clipped ||= source.length !== s.original_text.length || (translation?.length || 0) !== (translated?.length || 0);
    mapped.set(s.id, { id: s.id, sequence_no: s.sequence_no, text: source,
      source_revision: hash(s.original_text), translation: translated,
      translation_revision: translation == null ? null : hash(translation) });
  }
  const input = { listening_id: window.listening_id, window_id: window.id, window_revision: window.revision,
    prompt_version: PROMPT_VERSION, model_version: MODEL_VERSION,
    input_mode: segments.some(s => s.translation_state === 'complete' && s.translation_text) ? 'bilingual' : 'source_only',
    focus_segments: segments.filter(s => s.sequence_no >= window.from_sequence).map(s => mapped.get(s.id)),
    context_segments: segments.filter(s => s.sequence_no < window.from_sequence).map(s => mapped.get(s.id)),
    candidates, existing_assertions: existing.slice(0, 48).map(a => ({ id: a.id, relation_id: a.relation_id,
      subject_item_id: a.subject_item_id, object_item_id: a.object_item_id, predicate: a.predicate,
      statement: a.statement, polarity: a.polarity, modality: a.modality, conditions: a.conditions,
      time_scope: a.time_scope, attribution: a.attribution, status: a.status })),
    coverage_limited: clipped || recalled.length > candidates.length || existing.length > 48 || recalled.some(c => c.aliases.length > 12),
    candidate_count: recalled.length };
  // Enforce the actual wire-byte budget as well as character counts (CJK text
  // occupies multiple bytes). Prefer keeping focus source over optional context.
  for (;;) {
    try { buildRelationInput(input); break; } catch (error) {
      if (error.reason !== 'INPUT_BUDGET_EXCEEDED') throw error;
      input.coverage_limited = true;
      if (input.existing_assertions.length) { input.existing_assertions.pop(); continue; }
      const aliasCandidate = input.candidates.find(c => c.aliases.length);
      if (aliasCandidate) { aliasCandidate.aliases.pop(); continue; }
      const translated = [...input.context_segments, ...input.focus_segments].find(s => s.translation?.length);
      if (translated) { translated.translation = null; continue; }
      const context = input.context_segments.find(s => s.text.length);
      if (context) { context.text = ''; continue; }
      const longest = [...input.focus_segments].sort((a, b) => b.text.length - a.text.length)[0];
      if (!longest?.text.length) throw error;
      longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2));
    }
  }
  input.input_mode = [...input.focus_segments, ...input.context_segments].some(s => s.translation) ? 'bilingual' : 'source_only';
  // Existing assertion changes do not invalidate a parallel, independent window.
  // Corrections are checked against their saved identity and current status at commit.
  input.input_fingerprint = stableHash({ ...input, window_revision: undefined, existing_assertions: undefined, coverage_limited: undefined });
  return { input, pendingTranslation: segments.some(s => s.translation_state === 'pending') };
}

function cleanText(value, max, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('INVALID_TEXT');
  return value.trim();
}

function validateEntry(store, job, entry) {
  const ids = new Set(job.input.candidates.map(c => c.id));
  const { subject_item_id: subject, object_item_id: object, predicate } = canonicalizeRelation(entry.subject_item_id, entry.object_item_id, entry.predicate);
  if (!ids.has(subject) || !ids.has(object) || subject === object) throw new Error('INVALID_ENDPOINT_OR_PREDICATE');
  let endpointNeedsReview = false;
  for (const id of [subject, object]) {
    const endpoint = store.db.prepare('SELECT certainty FROM knowledge_items WHERE id=? AND listening_id=?').get(id, job.listening_id);
    if (!endpoint) throw new Error('MISSING_ENDPOINT');
    endpointNeedsReview ||= endpoint.certainty !== 'clear';
  }
  if (!['positive', 'negative'].includes(entry.polarity) || !['asserted', 'planned', 'uncertain'].includes(entry.modality) || !['active', 'needs_review'].includes(entry.status || 'active')) throw new Error('INVALID_QUALIFIERS');
  const statement = cleanText(entry.statement, 1000), conditions = cleanText(entry.conditions, 500, true),
    time_scope = cleanText(entry.time_scope, 300, true), attribution = cleanText(entry.attribution, 300, true);
  if (!Array.isArray(entry.supports) || !entry.supports.length || entry.supports.length > 12) throw new Error('INVALID_SUPPORTS');
  const scope = new Map([...job.input.focus_segments, ...job.input.context_segments].map(s => [s.id, s]));
  const focus = new Set(job.input.focus_segments.map(s => s.id));
  let relationFocus = false;
  const supports = entry.supports.map(s => {
    const saved = scope.get(s.segment_id);
    const source = store.db.prepare('SELECT original_text FROM segments WHERE id=? AND listening_id=?').get(s.segment_id, job.listening_id)?.original_text;
    if (!saved || source == null || hash(source) !== saved.source_revision || s.source_revision !== saved.source_revision ||
      !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start || s.end > saved.text.length ||
      source.slice(s.start, s.end) !== s.quote || !s.quote?.trim() || s.quote.length > 2500 ||
      !['relation', 'subject_reference', 'object_reference'].includes(s.role)) throw new Error('INVALID_SUPPORT');
    if (s.role === 'relation' && focus.has(s.segment_id)) relationFocus = true;
    return { segment_id: s.segment_id, source_revision: s.source_revision, start: s.start, end: s.end, quote: s.quote, role: s.role };
  });
  if (!relationFocus) throw new Error('MISSING_FOCUS_RELATION');
  const correction = entry.correction_of ?? null;
  if (correction) {
    const old = job.input.existing_assertions.find(a => a.id === correction);
    const current = store.db.prepare('SELECT a.*,r.subject_item_id,r.object_item_id,r.predicate FROM relation_assertions a JOIN relations r ON r.id=a.relation_id WHERE a.id=? AND r.listening_id=?').get(correction, job.listening_id);
    if (!old || !current || current.subject_item_id !== subject || current.object_item_id !== object || current.predicate !== predicate ||
      !supports.some(s => isExplicitRelationCorrection(s.quote))) throw new Error('INVALID_CORRECTION');
  }
  return { subject_item_id: subject, object_item_id: object, predicate, statement, polarity: entry.polarity,
    modality: entry.modality, conditions, time_scope, attribution, correction_of: correction, status: endpointNeedsReview ? 'needs_review' : entry.status || 'active', supports };
}

export const relationMethods = {
  recoverRelationJobs() {
    this.db.prepare("UPDATE relation_jobs SET state=CASE WHEN request_count>=max_requests THEN 'failed' ELSE 'pending' END,last_error='REQUEST_INTERRUPTED',updated_at=? WHERE state='running'").run(stamp());
    this.db.exec("UPDATE relation_windows SET state='failed',last_error='REQUEST_BUDGET_EXHAUSTED' WHERE state='pending' AND EXISTS (SELECT 1 FROM relation_jobs j WHERE j.window_id=relation_windows.id AND j.window_revision=relation_windows.revision AND j.state='failed')");
    // Legacy work without a run record still needs an explicit resume. Restart
    // never resets window attempts or reopens cancelled/paused work.
    const now = Date.now();
    for (const l of this.db.prepare('SELECT id,relation_epoch FROM listenings WHERE relation_enabled=1').all()) {
      if (!currentRound(this, l.id)) this.db.prepare(`INSERT INTO relation_rounds(id,listening_id,epoch,state,started_at,finished_at,stop_reason)
        VALUES(?,?,?,'paused',?,?,'REQUEST_INTERRUPTED')`).run(randomUUID(), l.id, l.relation_epoch, now, now);
    }
    this.db.exec('UPDATE listenings SET relation_waiting_key=relation_enabled');
  },
  enableRelations(listeningId, { retry = false, now = Date.now() } = {}) {
    return this.tx(() => {
      const listening = this.db.prepare('SELECT * FROM listenings WHERE id=?').get(listeningId);
      if (!listening) return null;
      const round = currentRound(this, listeningId);
      const hasPending = Boolean(this.db.prepare("SELECT 1 FROM relation_windows WHERE listening_id=? AND state IN ('dirty','pending')").get(listeningId));
      if (round?.state === 'active' && hasPending) {
        this.db.prepare('UPDATE listenings SET relation_waiting_key=0 WHERE id=?').run(listeningId);
        return this.graphMetadata(listeningId);
      }
      if (!listening.relation_enabled || !round || round.state !== 'active' || retry) {
        const epoch = listening.relation_epoch + 1;
        this.db.prepare("UPDATE relation_rounds SET state='complete',finished_at=?,wait_reason=NULL,next_ready_at=NULL WHERE listening_id=? AND state='active'").run(now, listeningId);
        this.db.prepare('UPDATE listenings SET relation_enabled=1,relation_epoch=?,relation_waiting_key=0 WHERE id=?').run(epoch, listeningId);
        this.db.prepare('INSERT INTO relation_rounds(id,listening_id,epoch,started_at) VALUES(?,?,?,?)')
          .run(randomUUID(), listeningId, epoch, now);
        const ranges = this.db.prepare('SELECT DISTINCT CAST((sequence_no-1)/6 AS INTEGER)*6+1 AS first FROM segments WHERE listening_id=?').all(listeningId);
        for (const { first } of ranges) this.db.prepare('INSERT OR IGNORE INTO relation_windows(id,listening_id,from_sequence,to_sequence,dirty_at) VALUES(?,?,?,?,?)')
          .run(`${listeningId}:${Math.floor((first - 1) / 6)}`, listeningId, first, first + 5, now);
        this.db.prepare("UPDATE relation_windows SET revision=revision+1,state='dirty',dirty_at=?,ready_at=0,last_error=NULL WHERE listening_id=? AND state IN ('failed','waiting_nodes','pending','dirty')").run(now, listeningId);
        this.db.prepare("UPDATE relation_jobs SET state='superseded',updated_at=? WHERE listening_id=? AND state IN ('pending','running')").run(stamp(), listeningId);
      }
      return this.graphMetadata(listeningId);
    });
  },
  cancelRelations(listeningId, { reason = 'USER_CANCELLED', now = Date.now() } = {}) {
    return this.tx(() => {
      stopRound(this, currentRound(this, listeningId), reason, now, 'cancelled');
      return this.graphMetadata(listeningId);
    });
  },
  setRelationWaitReason(listeningId, reason = null, nextReadyAt = null) {
    this.db.prepare(`UPDATE relation_rounds SET wait_reason=?,next_ready_at=? WHERE listening_id=? AND state='active'
      AND (wait_reason IS NOT ? OR next_ready_at IS NOT ?)`)
      .run(reason, nextReadyAt, listeningId, reason, nextReadyAt);
  },
  markRelationWaitingKey(listeningId, waiting) {
    this.db.prepare('UPDATE listenings SET relation_waiting_key=? WHERE id=? AND relation_enabled=1').run(Number(Boolean(waiting)), listeningId);
  },
  relationListeningIds() {
    return this.db.prepare('SELECT id FROM listenings WHERE relation_enabled=1 ORDER BY created_at').all().map(row => row.id);
  },
  relationHasWork(listeningId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM relation_windows w JOIN listenings l ON l.id=w.listening_id
      JOIN relation_rounds r ON r.listening_id=l.id AND r.epoch=l.relation_epoch AND r.state='active'
      WHERE w.listening_id=? AND l.relation_enabled=1 AND w.state IN ('dirty','pending') LIMIT 1`).get(listeningId));
  },
  relationProcessing(listeningId) {
    const l = this.db.prepare('SELECT relation_enabled,relation_waiting_key FROM listenings WHERE id=?').get(listeningId);
    if (!l) return null;
    const rows = this.db.prepare('SELECT state,COUNT(*) AS n FROM relation_windows WHERE listening_id=? GROUP BY state').all(listeningId);
    const counts = Object.fromEntries(rows.map(r => [r.state, r.n]));
    const jobs = this.db.prepare(`SELECT COALESCE(SUM(state='running'),0) AS runningJobs,COALESCE(SUM(request_count),0) AS requestCount,
      MIN(CASE WHEN state='pending' AND ready_at>0 THEN ready_at END) AS nextReadyAt FROM relation_jobs WHERE listening_id=?`).get(listeningId);
    const windowsReady = this.db.prepare("SELECT MIN(ready_at) AS n FROM relation_windows WHERE listening_id=? AND state='dirty' AND ready_at>0").get(listeningId).n;
    const round = currentRound(this, listeningId);
    const ready = [jobs.nextReadyAt, windowsReady, round?.next_ready_at].filter(Number.isFinite);
    const actionable = (counts.dirty || 0) + (counts.pending || 0);
    const result = { enabled: Boolean(l.relation_enabled), pendingJobs: round?.state === 'active' ? Math.max(0, actionable - jobs.runningJobs) : 0,
      runningJobs: round?.state === 'active' ? jobs.runningJobs : 0, failedJobs: counts.failed || 0, partialJobs: counts.partial || 0,
      waitingNodes: counts.waiting_nodes || 0, requestCount: jobs.requestCount, nextReadyAt: ready.length ? Math.min(...ready) : null,
      waitReason: round?.wait_reason || null, limits: { ...RELATION_RUN_LIMITS },
      progress: { totalWindows: rows.reduce((n, row) => n + row.n, 0), completedWindows: (counts.complete || 0) + (counts.partial || 0),
        remainingWindows: actionable + (counts.failed || 0) + (counts.waiting_nodes || 0), partialWindows: counts.partial || 0 } };
    const requests = this.db.prepare('SELECT q.usage_json FROM relation_requests q JOIN relation_jobs j ON j.id=q.job_id WHERE j.listening_id=? AND q.started_at>=?').all(listeningId, Date.now() - 3600000);
    result.usageLastHour = usageSummary(requests);
    if (round) {
      const requests = roundRequests(this, round), usage = usageSummary(requests);
      result.round = { id: round.id, epoch: round.epoch, state: round.state, startedAt: round.started_at, finishedAt: round.finished_at,
        requestCount: usage.requests, measuredRequests: usage.measuredRequests, totalTokens: usage.totalTokens,
        stopReason: round.stop_reason || (round.state === 'complete' && actionable ? 'INPUT_CHANGED' : null) };
    }
    const relations = this.db.prepare("SELECT COUNT(DISTINCT r.id) AS n FROM relations r JOIN relation_assertions a ON a.relation_id=r.id WHERE r.listening_id=? AND a.status IN ('active','needs_review')").get(listeningId).n;
    result.state = !result.enabled ? 'not_generated' : round?.state === 'cancelled' ? 'cancelled' :
      round?.state === 'paused' || (round?.state === 'complete' && actionable) ? 'paused' :
      l.relation_waiting_key && (result.pendingJobs || result.runningJobs) ? 'waiting_key' : result.runningJobs ? 'running' : result.pendingJobs ? 'queued' : result.failedJobs ? 'failed' : result.partialJobs ? 'partial' : result.waitingNodes ? 'waiting_nodes' : relations ? 'complete' : 'empty';
    return result;
  },
  graphMetadata(listeningId) {
    const l = this.db.prepare('SELECT graph_revision,relation_enabled FROM listenings WHERE id=?').get(listeningId);
    return l ? { listeningId, graphRevision: l.graph_revision, graph_revision: l.graph_revision,
      enabled: Boolean(l.relation_enabled), status: this.relationProcessing(listeningId) } : null;
  },
  graph(listeningId) {
    const metadata = this.graphMetadata(listeningId);
    if (!metadata) return null;
    const relations = this.db.prepare('SELECT * FROM relations WHERE listening_id=? ORDER BY created_at,id').all(listeningId);
    const assertions = this.db.prepare('SELECT a.* FROM relation_assertions a JOIN relations r ON r.id=a.relation_id WHERE r.listening_id=? ORDER BY a.created_at,a.id').all(listeningId);
    const supports = this.db.prepare('SELECT p.* FROM relation_supports p JOIN relation_assertions a ON a.id=p.assertion_id JOIN relations r ON r.id=a.relation_id WHERE r.listening_id=? ORDER BY p.created_at,p.id').all(listeningId);
    const revisions = this.db.prepare('SELECT * FROM relation_revisions WHERE relation_id IN (SELECT id FROM relations WHERE listening_id=?) ORDER BY created_at,id').all(listeningId);
    for (const a of assertions) a.supports = supports.filter(p => p.assertion_id === a.id);
    for (const r of relations) r.assertions = assertions.filter(a => a.relation_id === r.id);
    return { ...metadata, nodes: this.knowledge(listeningId), relations, assertions, supports, revisions };
  },
  getRelationJob(jobId) {
    const job = publicJob(this.db.prepare('SELECT * FROM relation_jobs WHERE id=?').get(jobId));
    if (!job) return null;
    return { ...job, window_request_count: this.db.prepare('SELECT COALESCE(SUM(request_count),0) AS n FROM relation_jobs WHERE window_id=? AND epoch=?').get(job.window_id, job.epoch).n };
  },
  nextRelationJob(listeningId, { now = Date.now(), quietMs = RELATION_QUIET_MS, maxConcurrent = 1 } = {}) {
    return this.tx(() => {
      const l = this.db.prepare('SELECT * FROM listenings WHERE id=? AND relation_enabled=1').get(listeningId);
      const round = currentRound(this, listeningId);
      if (!l || round?.state !== 'active') return null;
      this.db.prepare("UPDATE relation_jobs SET state='superseded',updated_at=? WHERE listening_id=? AND epoch!=? AND state IN ('pending','running')").run(stamp(), listeningId, l.relation_epoch);
      const running = this.db.prepare("SELECT * FROM relation_jobs WHERE listening_id=? AND state='running'").all(listeningId);
      const concurrency = Math.max(1, Math.min(2, Number.isInteger(maxConcurrent) ? maxConcurrent : 1));
      if (running.length >= concurrency) return null;
      const activeWindows = this.db.prepare("SELECT * FROM relation_windows WHERE listening_id=? AND state IN ('dirty','pending') ORDER BY from_sequence").all(listeningId);
      const runningWindows = new Set(running.map(j => j.window_id));
      // Explicit corrections form a chronological barrier. They must see prior
      // completed assertions, and later windows cannot overtake them.
      const barrier = activeWindows.find(w => this.db.prepare('SELECT original_text FROM segments WHERE listening_id=? AND sequence_no BETWEEN ? AND ?')
        .all(listeningId, w.from_sequence, w.to_sequence).some(s => isExplicitRelationCorrection(s.original_text)));
      const eligible = window => !runningWindows.has(window.id) && (!barrier || window.from_sequence < barrier.from_sequence ||
        (window.id === barrier.id && !running.length && !activeWindows.some(w => w.from_sequence < barrier.from_sequence)));
      const queued = this.db.prepare("SELECT * FROM relation_jobs WHERE listening_id=? AND state='pending' ORDER BY created_at,id").all(listeningId);
      for (const row of queued) {
        const window = this.db.prepare('SELECT * FROM relation_windows WHERE id=?').get(row.window_id);
        if (window && !eligible(window)) continue;
        const input = window && inputFor(this, window).input;
        if (!input || input.input_fingerprint !== row.input_fingerprint) {
          this.db.prepare("UPDATE relation_jobs SET state='superseded',last_error='STALE_INPUT',updated_at=? WHERE id=?").run(stamp(), row.id);
          if (window) this.db.prepare("UPDATE relation_windows SET revision=revision+1,state='dirty',ready_at=0 WHERE id=? AND state!='dirty'").run(window.id);
          continue;
        }
        // A revision-only bump cannot reset the durable retry budget/cooldown.
        if (window.revision !== row.window_revision) {
          row.window_revision = window.revision; row.input_json = JSON.stringify(input);
          this.db.prepare('UPDATE relation_jobs SET window_revision=?,input_json=? WHERE id=?').run(row.window_revision, row.input_json, row.id);
        }
        this.db.prepare("UPDATE relation_windows SET state='pending' WHERE id=?").run(window.id);
        if (row.request_count >= row.max_requests) {
          this.db.prepare("UPDATE relation_jobs SET state='failed',last_error='REQUEST_BUDGET_EXHAUSTED' WHERE id=?").run(row.id);
          this.db.prepare("UPDATE relation_windows SET state='failed',last_error='REQUEST_BUDGET_EXHAUSTED' WHERE id=?").run(row.window_id);
        } else if (row.ready_at <= now) return publicJob(row);
      }
      const windows = this.db.prepare("SELECT * FROM relation_windows WHERE listening_id=? AND state='dirty' ORDER BY from_sequence").all(listeningId);
      for (const window of windows) {
        if (!eligible(window)) continue;
        const { input } = inputFor(this, window);
        if (input.candidates.length < 2 || !input.focus_segments.length) {
          this.db.prepare("UPDATE relation_windows SET state='waiting_nodes',ready_at=0 WHERE id=?").run(window.id);
          continue;
        }
        // Reuse identical input only if checked after the latest source change.
        // Historical stale supports alone must not cause endless paid rechecks.
        const previous = this.db.prepare("SELECT state FROM relation_jobs WHERE window_id=? AND input_fingerprint=? AND window_revision>=? AND state IN ('complete','partial') ORDER BY created_at DESC LIMIT 1")
          .get(window.id, input.input_fingerprint, window.source_change_revision);
        if (previous) { this.db.prepare('UPDATE relation_windows SET state=?,last_fingerprint=?,ready_at=0 WHERE id=?').run(previous.state, input.input_fingerprint, window.id); continue; }
        const readyAt = window.dirty_at + Math.max(0, Math.min(30000, quietMs));
        if (now < readyAt) {
          this.db.prepare('UPDATE relation_windows SET ready_at=? WHERE id=?').run(readyAt, window.id); continue;
        }
        const spent = this.db.prepare('SELECT COALESCE(SUM(request_count),0) AS n FROM relation_jobs WHERE window_id=? AND epoch=?').get(window.id, l.relation_epoch).n;
        if (spent >= 3) { this.db.prepare("UPDATE relation_windows SET state='failed',last_error='WINDOW_REQUEST_LIMIT',ready_at=0 WHERE id=?").run(window.id); continue; }
        const id = randomUUID(), time = stamp();
        this.db.prepare(`INSERT INTO relation_jobs(id,listening_id,window_id,window_revision,epoch,input_fingerprint,prompt_version,model_version,input_json,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, listeningId, window.id, window.revision, l.relation_epoch, input.input_fingerprint, PROMPT_VERSION, MODEL_VERSION, JSON.stringify(input), time, time);
        this.db.prepare("UPDATE relation_windows SET state='pending',ready_at=0 WHERE id=?").run(window.id);
        return publicJob(this.db.prepare('SELECT * FROM relation_jobs WHERE id=?').get(id));
      }
      finishIdleRun(this, listeningId, now);
      return null;
    });
  },
  beginRelationRequest(jobId, { now = Date.now(), maxRequests = 3 } = {}) {
    return this.tx(() => {
      const job = this.db.prepare('SELECT * FROM relation_jobs WHERE id=?').get(jobId);
      if (!job || job.state !== 'pending' || job.ready_at > now) return null;
      const round = currentRound(this, job.listening_id);
      if (round?.state !== 'active' || round.epoch !== job.epoch) return null;
      const window = this.db.prepare('SELECT * FROM relation_windows WHERE id=?').get(job.window_id);
      const input = window && inputFor(this, window).input;
      if (!input || input.input_fingerprint !== job.input_fingerprint) {
        this.db.prepare("UPDATE relation_jobs SET state='superseded',last_error='STALE_INPUT' WHERE id=?").run(jobId);
        if (window) this.db.prepare("UPDATE relation_windows SET revision=revision+1,state='dirty',ready_at=0 WHERE id=? AND state!='dirty'").run(window.id);
        return null;
      }
      const limit = Math.min(job.max_requests, Number.isInteger(maxRequests) && maxRequests > 0 ? maxRequests : 3);
      const windowCount = this.db.prepare('SELECT COALESCE(SUM(request_count),0) AS n FROM relation_jobs WHERE window_id=? AND epoch=?').get(job.window_id, job.epoch).n;
      if (job.request_count >= limit || windowCount >= 3) {
        this.db.prepare("UPDATE relation_jobs SET state='failed',last_error='WINDOW_REQUEST_LIMIT' WHERE id=?").run(jobId);
        this.db.prepare("UPDATE relation_windows SET state='failed',last_error='WINDOW_REQUEST_LIMIT' WHERE id=?").run(job.window_id); return null;
      }
      this.db.prepare("UPDATE relation_jobs SET state='running',request_count=request_count+1,max_requests=?,window_revision=?,input_json=?,updated_at=? WHERE id=?")
        .run(limit, window.revision, JSON.stringify(input), stamp(), jobId);
      this.db.prepare("UPDATE relation_windows SET state='pending',ready_at=0 WHERE id=?").run(window.id);
      this.db.prepare('INSERT INTO relation_requests(job_id,attempt,started_at) VALUES(?,?,?)').run(jobId, job.request_count + 1, now);
      this.db.prepare('UPDATE relation_rounds SET finished_at=NULL WHERE id=?').run(round.id);
      return { ...publicJob(this.db.prepare('SELECT * FROM relation_jobs WHERE id=?').get(jobId)), window_request_count: windowCount + 1,
        round: { id: round.id } };
    });
  },
  recordRelationUsage(jobId, { usage = null, outcome = null, attempt = null } = {}) {
    const safe = safeUsage(usage);
    const job = this.db.prepare('SELECT request_count FROM relation_jobs WHERE id=?').get(jobId);
    if (!job) return false;
    const number = Number.isInteger(attempt) && attempt > 0 ? attempt : job.request_count;
    return Boolean(this.db.prepare(`UPDATE relation_requests SET usage_json=COALESCE(?,usage_json),outcome=COALESCE(?,outcome) WHERE job_id=? AND attempt=?`)
      .run(safe ? JSON.stringify(safe) : null, outcome && String(outcome).slice(0, 160), jobId, number).changes);
  },
  failRelationJob(jobId, { code = 'RELATION_FAILED', retryAt = null, terminal = false } = {}) {
    return this.tx(() => {
      const job = this.db.prepare('SELECT * FROM relation_jobs WHERE id=?').get(jobId);
      if (!job || !['pending', 'running'].includes(job.state)) return null;
      this.db.prepare('UPDATE relation_requests SET outcome=? WHERE job_id=? AND attempt=?').run(String(code).slice(0, 160), jobId, job.request_count);
      const failed = terminal || job.request_count >= job.max_requests;
      const ready = Number.isFinite(retryAt) ? Math.max(0, retryAt) : Date.now() + 2000;
      this.db.prepare('UPDATE relation_jobs SET state=?,ready_at=?,last_error=?,updated_at=? WHERE id=?').run(failed ? 'failed' : 'pending', failed ? 0 : ready, String(code).slice(0, 160), stamp(), jobId);
      this.db.prepare('UPDATE relation_windows SET state=?,last_error=? WHERE id=? AND revision=?').run(failed ? 'failed' : 'pending', String(code).slice(0, 160), job.window_id, job.window_revision);
      finishIdleRun(this, job.listening_id);
      return publicJob(this.db.prepare('SELECT * FROM relation_jobs WHERE id=?').get(jobId));
    });
  },
  commitRelationJob(jobId, { relations = [], rejected = [], usage = null, now = Date.now() } = {}) {
    return this.tx(() => {
      const job = publicJob(this.db.prepare('SELECT * FROM relation_jobs WHERE id=?').get(jobId));
      if (!job) return { stale: true, changed: false, missing: true };
      if (['complete', 'partial'].includes(job.state)) return { stale: false, changed: false, duplicate: true, graphRevision: this.graphMetadata(job.listening_id)?.graphRevision };
      const sanitizedUsage = safeUsage(usage);
      this.recordRelationUsage(jobId, { usage });
      const window = this.db.prepare('SELECT w.*,l.relation_epoch FROM relation_windows w JOIN listenings l ON l.id=w.listening_id WHERE w.id=?').get(job.window_id);
      const round = currentRound(this, job.listening_id);
      if (!window || !['running', 'pending'].includes(job.state) || round?.state !== 'active' || window.relation_epoch !== job.epoch || inputFor(this, window).input.input_fingerprint !== job.input_fingerprint) {
        this.recordRelationUsage(jobId, { usage, outcome: 'stale' });
        if (['running', 'pending'].includes(job.state)) this.db.prepare("UPDATE relation_jobs SET state='superseded',last_error='STALE_INPUT',usage_json=COALESCE(?,usage_json),updated_at=? WHERE id=? AND state IN ('running','pending')").run(sanitizedUsage ? JSON.stringify(sanitizedUsage) : null, stamp(), jobId);
        if (window && round?.state === 'active' && window.relation_epoch === job.epoch && window.state !== 'dirty') this.db.prepare("UPDATE relation_windows SET revision=revision+1,state='dirty',dirty_at=?,ready_at=0 WHERE id=?").run(Date.now(), window.id);
        return { stale: true, changed: false, graphRevision: this.graphMetadata(job.listening_id)?.graphRevision };
      }
      if (!Array.isArray(relations) || relations.length > RELATION_LIMITS.relations || !Array.isArray(rejected)) throw new Error('RELATION_RESULT_LIMIT');
      const rejects = rejected.slice(0, 64).map(r => ({ code: String(r.code || r.reason || 'REJECTED').slice(0, 160), ...(Number.isInteger(r.index) ? { index: r.index } : {}) }));
      let changed = false, accepted = 0;
      const time = stamp();
      for (const [index, raw] of relations.entries()) {
        let entry;
        try { entry = validateEntry(this, job, raw); } catch (error) { rejects.push({ index, code: error.message }); continue; }
        const relationId = `rel_${stableHash([job.listening_id, entry.subject_item_id, entry.object_item_id, entry.predicate])}`;
        const inserted = this.db.prepare('INSERT OR IGNORE INTO relations(id,listening_id,subject_item_id,object_item_id,predicate,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(relationId, job.listening_id, entry.subject_item_id, entry.object_item_id, entry.predicate, time, time).changes;
        const key = stableHash([norm(entry.statement), entry.polarity, entry.modality, entry.conditions && norm(entry.conditions), entry.time_scope && norm(entry.time_scope), entry.attribution && norm(entry.attribution), entry.correction_of]);
        const assertionId = `assert_${stableHash([relationId, key])}`;
        const assertionInserted = this.db.prepare(`INSERT OR IGNORE INTO relation_assertions(id,relation_id,assertion_key,statement,polarity,modality,conditions,time_scope,attribution,status,correction_of,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(assertionId, relationId, key, entry.statement, entry.polarity, entry.modality, entry.conditions, entry.time_scope, entry.attribution, entry.status, entry.correction_of, time, time).changes;
        let supportsInserted = 0;
        const groupId = `group_${stableHash([assertionId, [...new Set(entry.supports.map(p => JSON.stringify([p.segment_id, p.source_revision, p.start, p.end, p.role])))].sort()])}`;
        for (const support of entry.supports) {
          const id = `support_${stableHash([assertionId, groupId, support.segment_id, support.source_revision, support.start, support.end, support.role])}`;
          supportsInserted += this.db.prepare(`INSERT OR IGNORE INTO relation_supports(id,assertion_id,job_id,window_id,window_revision,segment_id,source_revision,group_id,start,end,quote,role,state,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'active',?)`).run(id, assertionId, jobId, window.id, window.revision, support.segment_id, support.source_revision, groupId, support.start, support.end, support.quote, support.role, time).changes;
          supportsInserted += this.db.prepare("UPDATE relation_supports SET state='active' WHERE id=? AND state='stale'").run(id).changes;
        }
        const downgraded = entry.status === 'needs_review' ? this.db.prepare("UPDATE relation_assertions SET status='needs_review',version=version+1,updated_at=? WHERE id=? AND status='active'").run(time, assertionId).changes : 0;
        const revived = this.db.prepare("UPDATE relation_assertions SET status=?,version=version+1,updated_at=? WHERE id=? AND status='stale'").run(entry.status, time, assertionId).changes;
        if (entry.correction_of && entry.correction_of !== assertionId) {
          const before = this.db.prepare('SELECT status FROM relation_assertions WHERE id=?').get(entry.correction_of);
          if (before.status !== 'superseded') {
            this.db.prepare("UPDATE relation_assertions SET status='superseded',version=version+1,updated_at=? WHERE id=?").run(time, entry.correction_of);
            this.db.prepare('INSERT INTO relation_revisions VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), relationId, entry.correction_of, 'explicit_correction', before.status, 'superseded', assertionId, time);
            changed = true;
          }
        }
        if (inserted || assertionInserted || supportsInserted || revived || downgraded) {
          if (!inserted) this.db.prepare('UPDATE relations SET version=version+1,updated_at=? WHERE id=?').run(time, relationId);
          this.db.prepare('INSERT INTO relation_revisions VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), relationId, assertionId, assertionInserted ? 'assertion_added' : 'support_added', null, assertionId, jobId, time);
          changed = true;
        }
        accepted++;
      }
      if (changed) this.db.prepare('UPDATE listenings SET graph_revision=graph_revision+1 WHERE id=?').run(job.listening_id);
      const state = rejects.length || job.input.coverage_limited ? 'partial' : 'complete';
      this.recordRelationUsage(jobId, { usage, outcome: state });
      this.db.prepare('UPDATE relation_jobs SET state=?,rejected_json=?,usage_json=?,window_revision=?,last_error=NULL,updated_at=? WHERE id=?').run(state, JSON.stringify(rejects.slice(0, 96)), sanitizedUsage ? JSON.stringify(sanitizedUsage) : null, window.revision, time, jobId);
      this.db.prepare('UPDATE relation_windows SET state=?,last_fingerprint=?,last_error=NULL,ready_at=0 WHERE id=?').run(state, job.input_fingerprint, window.id);
      finishIdleRun(this, job.listening_id, now);
      return { stale: false, changed, accepted, rejected: rejects, state, graphRevision: this.graphMetadata(job.listening_id).graphRevision };
    });
  }
};
