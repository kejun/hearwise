import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateRelations, relationMethods } from './relation-storage.mjs';

const now = () => new Date().toISOString();
const normalized = value => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

export class ListeningStore {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000');
    this.migrate();
    this.recoverKnowledgeCheckpoints();
    this.recoverRelationJobs();
    this.db.prepare("UPDATE listening_runs SET state='interrupted', ended_at=? WHERE state='active'").run(now());
    this.db.prepare("UPDATE extraction_jobs SET state='pending', updated_at=? WHERE state='running'").run(now());
  }
  close() { this.db.close(); }
  tx(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 6) throw new Error(`不支持的数据库版本：${version}`);
    if (version === 0) this.tx(() => {
      this.db.exec(`
        CREATE TABLE listenings (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE listening_runs (id TEXT PRIMARY KEY, listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
          run_no INTEGER NOT NULL, audio_source TEXT NOT NULL, source_lang TEXT NOT NULL, target_lang TEXT NOT NULL,
          started_at TEXT NOT NULL, ended_at TEXT, state TEXT NOT NULL CHECK (state IN ('active','complete','interrupted')),
          UNIQUE(listening_id, run_no));
        CREATE UNIQUE INDEX one_active_run ON listening_runs(listening_id) WHERE state='active';
        CREATE TABLE segments (id TEXT PRIMARY KEY, listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES listening_runs(id) ON DELETE CASCADE, sequence_no INTEGER NOT NULL,
          asr_sentence_id TEXT NOT NULL, original_text TEXT NOT NULL, translation_text TEXT,
          translation_state TEXT NOT NULL CHECK (translation_state IN ('pending','complete','failed')),
          begin_ms INTEGER, end_ms INTEGER, created_at TEXT NOT NULL,
          UNIQUE(run_id, asr_sentence_id), UNIQUE(listening_id, sequence_no));
        CREATE TABLE knowledge_items (id TEXT PRIMARY KEY, listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK (type IN ('person','term','event','other')), canonical_name TEXT NOT NULL,
          normalized_name TEXT NOT NULL, dialogue_summary TEXT NOT NULL, background_note TEXT,
          certainty TEXT NOT NULL CHECK (certainty IN ('clear','needs_review')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX knowledge_name ON knowledge_items(listening_id, type, normalized_name);
        CREATE TABLE knowledge_aliases (item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
          alias TEXT NOT NULL, normalized_alias TEXT NOT NULL, PRIMARY KEY(item_id, normalized_alias));
        CREATE TABLE knowledge_mentions (item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
          segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE, surface_text TEXT NOT NULL,
          PRIMARY KEY(item_id, segment_id, surface_text));
        CREATE TABLE knowledge_revisions (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
          action TEXT NOT NULL, old_value TEXT, new_value TEXT, merged_from_id TEXT, reason TEXT, created_at TEXT NOT NULL);
        CREATE TABLE extraction_jobs (id TEXT PRIMARY KEY, listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
          from_sequence INTEGER NOT NULL, to_sequence INTEGER NOT NULL, prompt_version INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','running','complete','failed')), attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(listening_id, from_sequence, to_sequence, prompt_version));
        CREATE INDEX segments_order ON segments(listening_id, sequence_no);
        PRAGMA user_version = 1;
      `);
    });
    if (version < 2) this.tx(() => {
      this.db.exec(`
        ALTER TABLE listenings ADD COLUMN knowledge_policy_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE knowledge_items ADD COLUMN display_label TEXT;
        ALTER TABLE knowledge_items ADD COLUMN short_description TEXT;
        ALTER TABLE knowledge_items ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE knowledge_items ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
        UPDATE knowledge_items SET short_description=dialogue_summary WHERE short_description IS NULL;
        CREATE TABLE knowledge_candidates (id TEXT PRIMARY KEY,
          listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
          type TEXT NOT NULL, display_label TEXT NOT NULL, canonical_name TEXT NOT NULL,
          normalized_name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('observe','exclude')),
          role TEXT NOT NULL, reason TEXT NOT NULL, first_segment_id TEXT REFERENCES segments(id) ON DELETE CASCADE,
          first_quote TEXT,
          last_segment_id TEXT REFERENCES segments(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX knowledge_candidate_name ON knowledge_candidates(listening_id,type,normalized_name);
        CREATE TABLE knowledge_facts (id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
          segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
          surface_text TEXT NOT NULL, content TEXT NOT NULL, certainty TEXT NOT NULL,
          created_at TEXT NOT NULL, UNIQUE(item_id,segment_id,content));
        CREATE INDEX knowledge_fact_item ON knowledge_facts(item_id);
        PRAGMA user_version = 2;
      `);
    });
    if (version < 3) this.tx(() => {
      this.db.exec(`ALTER TABLE extraction_jobs ADD COLUMN retry_at TEXT;
        PRAGMA user_version = 3;`);
    });
    if (version < 4) this.tx(() => {
      this.db.exec(`ALTER TABLE extraction_jobs ADD COLUMN outcome TEXT;
        ALTER TABLE extraction_jobs ADD COLUMN progress_json TEXT;
        CREATE TABLE extraction_parts (
          job_id TEXT NOT NULL REFERENCES extraction_jobs(id) ON DELETE CASCADE,
          part_no INTEGER NOT NULL, focus_refs TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('extract_pending','extract_inflight','repair_pending','repair_inflight','done')),
          ready_at INTEGER NOT NULL DEFAULT 0, initial_requests INTEGER NOT NULL DEFAULT 0,
          repair_reserved INTEGER NOT NULL DEFAULT 0, unresolved TEXT NOT NULL DEFAULT '[]',
          results TEXT NOT NULL DEFAULT '[]', stats TEXT NOT NULL DEFAULT '{}', input_snapshot TEXT,
          updated_at TEXT NOT NULL, PRIMARY KEY(job_id,part_no));
        UPDATE extraction_jobs SET outcome='legacy' WHERE state='complete';
        UPDATE extraction_jobs SET state='failed',outcome='legacy',last_error='LEGACY_RECOVERY_REQUIRED',retry_at=NULL
          WHERE prompt_version=2 AND state!='complete';
        PRAGMA user_version = 4;`);
    });
    if (version < 5) this.tx(() => {
      this.db.exec(`ALTER TABLE listenings ADD COLUMN notes TEXT NOT NULL DEFAULT '';
        PRAGMA user_version = 5;`);
    });
    if (version < 6) this.tx(() => migrateRelations(this));
  }
  createRun(listeningId, settings, title) {
    return this.tx(() => {
      const time = now();
      let id = listeningId;
      if (id) {
        if (!this.db.prepare('SELECT id FROM listenings WHERE id=?').get(id)) throw new Error('收听记录不存在');
        if (this.db.prepare("SELECT id FROM listening_runs WHERE listening_id=? AND state='active'").get(id)) throw new Error('这条收听正在另一个页面进行');
      } else {
        id = randomUUID();
        this.db.prepare('INSERT INTO listenings (id,title,created_at,updated_at,knowledge_policy_version) VALUES (?,?,?,?,2)').run(id, title, time, time);
      }
      const runNo = this.db.prepare('SELECT COALESCE(MAX(run_no),0)+1 AS no FROM listening_runs WHERE listening_id=?').get(id).no;
      const runId = randomUUID();
      this.db.prepare('INSERT INTO listening_runs VALUES (?,?,?,?,?,?,?,?,?)').run(runId, id, runNo, settings.audioSource, settings.source, settings.targetLang, time, null, 'active');
      this.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run(time, id);
      return { listeningId: id, runId, runNo };
    });
  }
  finishRun(runId, interrupted = false) {
    if (!runId) return;
    const run = this.db.prepare('SELECT listening_id FROM listening_runs WHERE id=?').get(runId);
    const time = now();
    this.db.prepare("UPDATE listening_runs SET state=?, ended_at=? WHERE id=? AND state='active'").run(interrupted ? 'interrupted' : 'complete', time, runId);
    if (run) this.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run(time, run.listening_id);
  }
  addSegment(listeningId, runId, sentence) {
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM segments WHERE run_id=? AND asr_sentence_id=?').get(runId, String(sentence.id));
      if (existing) return { segment: existing, inserted: false };
      const id = randomUUID(), time = now();
      const sequence = this.db.prepare('SELECT COALESCE(MAX(sequence_no),0)+1 AS no FROM segments WHERE listening_id=?').get(listeningId).no;
      this.db.prepare('INSERT INTO segments VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, listeningId, runId, sequence, String(sentence.id), sentence.text,
        null, 'pending', sentence.beginMs ?? null, sentence.endMs ?? null, time);
      this.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run(time, listeningId);
      return { segment: this.db.prepare('SELECT * FROM segments WHERE id=?').get(id), inserted: true };
    });
  }
  setTranslation(id, text, error) {
    this.db.prepare('UPDATE segments SET translation_text=?, translation_state=? WHERE id=? AND translation_state!=\'complete\'').run(text || null, error ? 'failed' : 'complete', id);
    const segment = this.db.prepare('SELECT * FROM segments WHERE id=?').get(id);
    if (segment) this.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run(now(), segment.listening_id);
    return segment;
  }
  pendingTranslations(listeningId) {
    return this.db.prepare("SELECT s.*, r.source_lang, r.target_lang FROM segments s JOIN listening_runs r ON r.id=s.run_id WHERE s.listening_id=? AND s.translation_state!='complete' ORDER BY s.sequence_no").all(listeningId);
  }
  list(page = 1, pageSize = 20) {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM listenings').get().n;
    const items = this.db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM segments s WHERE s.listening_id=l.id) AS segment_count,
      (SELECT COUNT(*) FROM knowledge_items k WHERE k.listening_id=l.id) AS knowledge_count,
      (SELECT MAX(COALESCE(ended_at, started_at)) FROM listening_runs r WHERE r.listening_id=l.id) AS last_listened_at
      FROM listenings l ORDER BY l.updated_at DESC, l.id DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize);
    return { items, total, page, pageSize };
  }
  hasListening(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM listenings WHERE id=?').get(id));
  }
  updateMetadata(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('标题和备注请求格式无效');
    const fields = Object.keys(input);
    if (!fields.length || fields.some(field => !['title', 'notes'].includes(field))) throw new TypeError('仅支持修改标题或备注');
    const hasTitle = Object.hasOwn(input, 'title'), hasNotes = Object.hasOwn(input, 'notes');
    if (hasTitle && (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 200)) {
      throw new TypeError('标题需为 1–200 字的文本');
    }
    if (hasNotes && (typeof input.notes !== 'string' || input.notes.length > 10000)) {
      throw new TypeError('备注需为不超过 10000 字的文本');
    }
    return this.tx(() => {
      const listening = this.db.prepare('SELECT * FROM listenings WHERE id=?').get(id);
      if (!listening) return 'missing';
      if (this.db.prepare("SELECT 1 FROM listening_runs WHERE listening_id=? AND state='active'").get(id)) return 'active';
      // Metadata edits do not change the time/order of the last listening activity.
      this.db.prepare('UPDATE listenings SET title=?, notes=? WHERE id=?').run(
        hasTitle ? input.title.trim() : listening.title, hasNotes ? input.notes : listening.notes, id);
      return this.db.prepare('SELECT * FROM listenings WHERE id=?').get(id);
    });
  }
  removeListening(id) {
    return this.tx(() => {
      if (!this.hasListening(id)) return 'missing';
      if (this.db.prepare("SELECT 1 FROM listening_runs WHERE listening_id=? AND state='active'").get(id)) return 'active';
      this.db.prepare('DELETE FROM listenings WHERE id=?').run(id);
      return 'deleted';
    });
  }
  detail(id, page = 1, pageSize = 100) {
    const listening = this.db.prepare('SELECT * FROM listenings WHERE id=?').get(id);
    if (!listening) return null;
    const runs = this.db.prepare('SELECT * FROM listening_runs WHERE listening_id=? ORDER BY run_no').all(id);
    const segmentCount = this.db.prepare('SELECT COUNT(*) AS n FROM segments WHERE listening_id=?').get(id).n;
    const segments = this.db.prepare('SELECT * FROM segments WHERE listening_id=? ORDER BY sequence_no LIMIT ? OFFSET ?').all(id, pageSize, (page - 1) * pageSize);
    const latestSegment = this.db.prepare('SELECT * FROM segments WHERE listening_id=? ORDER BY sequence_no DESC LIMIT 1').get(id);
    const knowledge = this.knowledge(id);
    const jobs = this.db.prepare('SELECT * FROM extraction_jobs WHERE listening_id=? ORDER BY from_sequence').all(id).map(job => this.publicKnowledgeJob(job));
    const processing = this.processing(id);
    return { listening, runs, segments, latestSegment, segmentCount, knowledge, jobs, processing, graph: this.graphMetadata(id), graph_revision: listening.graph_revision, page, pageSize };
  }
  speechRun(listeningId, runId) {
    if (typeof listeningId !== 'string' || typeof runId !== 'string') return null;
    return this.db.prepare(`SELECT r.*, COALESCE((SELECT MAX(sequence_no) FROM segments WHERE run_id=r.id),0) AS maxSequence
      FROM listening_runs r WHERE r.id=? AND r.listening_id=?`).get(runId, listeningId) || null;
  }
  speechNext(listeningId, runId, afterSequence) {
    return this.db.prepare(`SELECT * FROM segments WHERE listening_id=? AND run_id=? AND sequence_no>?
      ORDER BY sequence_no LIMIT 1`).get(listeningId, runId, afterSequence) || null;
  }
  speechSegment(listeningId, runId, id) {
    if (typeof id !== 'string') return null;
    return this.db.prepare('SELECT * FROM segments WHERE listening_id=? AND run_id=? AND id=?').get(listeningId, runId, id) || null;
  }
  speechBacklog(listeningId, runId, afterSequence) {
    return this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(COALESCE(translation_text,original_text))),0) AS characters
      FROM segments WHERE listening_id=? AND run_id=? AND sequence_no>?`).get(listeningId, runId, afterSequence);
  }
  speechTranscript(listeningId) {
    if (typeof listeningId !== 'string') return null;
    return this.db.prepare(`SELECT l.id,
      EXISTS(SELECT 1 FROM listening_runs WHERE listening_id=l.id AND state='active') AS active,
      (SELECT COUNT(*) FROM segments WHERE listening_id=l.id) AS total,
      COALESCE((SELECT MAX(sequence_no) FROM segments WHERE listening_id=l.id),0) AS maxSequence
      FROM listenings l WHERE l.id=?`).get(listeningId) || null;
  }
  speechTranscriptNext(listeningId, afterSequence, throughSequence) {
    return this.db.prepare(`SELECT * FROM segments WHERE listening_id=? AND sequence_no>? AND sequence_no<=?
      ORDER BY sequence_no LIMIT 1`).get(listeningId, afterSequence, throughSequence) || null;
  }
  processing(id) {
    const translations = this.db.prepare(`SELECT
      COALESCE(SUM(translation_state='failed'),0) AS failedTranslations,
      COALESCE(SUM(translation_state='pending'),0) AS pendingTranslations
      FROM segments WHERE listening_id=?`).get(id);
    const knowledge = this.db.prepare(`SELECT
      COALESCE(SUM(state='pending' AND retry_at IS NULL),0) AS pendingJobs,
      COALESCE(SUM(state='pending' AND retry_at IS NOT NULL),0) AS retryingJobs,
      COALESCE(SUM(state='running'),0) AS runningJobs,
      COALESCE(SUM(state='failed' AND COALESCE(outcome,'')!='legacy'),0) AS failedJobs,
      COALESCE(SUM(outcome='partial'),0) AS partialJobs,
      COALESCE(SUM(outcome='legacy' AND last_error='LEGACY_RECOVERY_REQUIRED'),0) AS legacyRecoveryJobs
      FROM extraction_jobs WHERE listening_id=?`).get(id);
    const jobs = this.db.prepare('SELECT * FROM extraction_jobs WHERE listening_id=?').all(id);
    knowledge.unresolvedItems = 0;
    knowledge.visibleChangeCount = 0;
    const visibleIds = new Set();
    knowledge.repairPendingJobs = 0;
    knowledge.repairingJobs = 0;
    for (const job of jobs) {
      const { parts, progress } = this.knowledgeCheckpoint(job.id);
      knowledge.unresolvedItems += parts.reduce((sum, part) => sum + part.unresolved.length, 0);
      if (job.state === 'pending' && parts.some(part => part.phase === 'repair_pending')) knowledge.repairPendingJobs++;
      if (job.state === 'running' && parts.some(part => part.phase === 'repair_inflight')) knowledge.repairingJobs++;
      if (job.outcome === 'partial') for (const part of parts) for (const result of part.results) {
        if (result.visibleChange && result.itemId && (result.cycle || 1) === (progress?.cycle || 1)) visibleIds.add(result.itemId);
      }
    }
    knowledge.visibleChangeCount = visibleIds.size;
    knowledge.bufferedSegments = this.db.prepare(`SELECT COUNT(*) AS n FROM segments
      WHERE listening_id=? AND sequence_no>(SELECT COALESCE(MAX(to_sequence),0) FROM extraction_jobs WHERE listening_id=?)`).get(id, id).n;
    return { ...translations, knowledge, relations: this.relationProcessing(id) };
  }
  segmentsQuery(listeningId, { runId = null, latest = null, afterSequence = null, beforeSequence = null, ids = null, limit = 50 } = {}) {
    if (!this.hasListening(listeningId)) return null;
    if (runId && !this.db.prepare('SELECT 1 FROM listening_runs WHERE id=? AND listening_id=?').get(runId, listeningId)) return 'missing-run';
    const scopeColumn = runId ? 'run_id' : 'listening_id';
    const scopeValue = runId || listeningId;
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM segments WHERE ${scopeColumn}=?`).get(scopeValue).n;
    const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM segments WHERE ${scopeColumn}=? AND translation_state!='complete'`).get(scopeValue).n;
    let items;
    if (ids) {
      const marks = ids.map(() => '?').join(',');
      items = this.db.prepare(`SELECT * FROM segments WHERE ${scopeColumn}=? AND id IN (${marks}) ORDER BY sequence_no`).all(scopeValue, ...ids);
    } else if (latest != null) {
      items = this.db.prepare(`SELECT * FROM (SELECT * FROM segments WHERE ${scopeColumn}=? ORDER BY sequence_no DESC LIMIT ?) ORDER BY sequence_no`).all(scopeValue, latest);
    } else if (afterSequence != null) {
      items = this.db.prepare(`SELECT * FROM segments WHERE ${scopeColumn}=? AND sequence_no>? ORDER BY sequence_no LIMIT ?`).all(scopeValue, afterSequence, limit);
    } else if (beforeSequence != null) {
      items = this.db.prepare(`SELECT * FROM (SELECT * FROM segments WHERE ${scopeColumn}=? AND sequence_no<? ORDER BY sequence_no DESC LIMIT ?) ORDER BY sequence_no`).all(scopeValue, beforeSequence, limit);
    } else {
      items = this.db.prepare(`SELECT * FROM segments WHERE ${scopeColumn}=? ORDER BY sequence_no LIMIT ?`).all(scopeValue, limit);
    }
    return { items, total, pending };
  }
  exportText(id, kind) {
    const listening = this.db.prepare('SELECT title, notes FROM listenings WHERE id=?').get(id);
    if (!listening) return null;
    const sql = kind === 'translation'
      ? "SELECT translation_text AS text FROM segments WHERE listening_id=? AND translation_text IS NOT NULL AND translation_text<>'' ORDER BY sequence_no"
      : 'SELECT original_text AS text FROM segments WHERE listening_id=? ORDER BY sequence_no';
    const body = this.db.prepare(sql).all(id).map(row => row.text).join('\n');
    const hasBody = Boolean(body.trim());
    return { title: listening.title, hasBody,
      text: hasBody && listening.notes.trim() ? `${listening.notes}\n\n${body}` : body };
  }
  knowledge(id) {
    const items = this.db.prepare('SELECT * FROM knowledge_items WHERE listening_id=? ORDER BY created_at, rowid').all(id);
    const aliases = this.db.prepare('SELECT a.* FROM knowledge_aliases a JOIN knowledge_items k ON k.id=a.item_id WHERE k.listening_id=?').all(id);
    const mentions = this.db.prepare('SELECT m.* FROM knowledge_mentions m JOIN knowledge_items k ON k.id=m.item_id WHERE k.listening_id=?').all(id);
    const revisions = this.db.prepare('SELECT r.* FROM knowledge_revisions r JOIN knowledge_items k ON k.id=r.item_id WHERE k.listening_id=? ORDER BY r.created_at').all(id);
    const facts = this.db.prepare('SELECT f.* FROM knowledge_facts f JOIN knowledge_items k ON k.id=f.item_id WHERE k.listening_id=? ORDER BY f.created_at,f.rowid').all(id);
    return items.map(item => ({ ...item, aliases: aliases.filter(a => a.item_id === item.id).map(a => a.alias),
      mentions: mentions.filter(m => m.item_id === item.id), revisions: revisions.filter(r => r.item_id === item.id),
      facts: facts.filter(f => f.item_id === item.id) }));
  }
  extractionRange(listeningId) {
    const last = this.db.prepare('SELECT COALESCE(MAX(to_sequence),0) AS n FROM extraction_jobs WHERE listening_id=?').get(listeningId).n;
    const rows = this.db.prepare('SELECT id, sequence_no, original_text, created_at FROM segments WHERE listening_id=? AND sequence_no>? ORDER BY sequence_no LIMIT 3').all(listeningId, last);
    const selected = [];
    let length = 0;
    for (const row of rows) {
      if (selected.length && length + row.original_text.length > 2500) break;
      selected.push(row); length += row.original_text.length;
    }
    return selected;
  }
  createExtractionJob(listeningId, rows) {
    if (!rows.length) return null;
    return this.tx(() => {
      const previous = this.db.prepare("SELECT * FROM extraction_jobs WHERE listening_id=? AND state='pending' AND attempts=0 AND retry_at IS NULL AND NOT EXISTS (SELECT 1 FROM extraction_parts p WHERE p.job_id=extraction_jobs.id) ORDER BY to_sequence DESC LIMIT 1").get(listeningId);
      if (previous && previous.to_sequence + 1 === rows[0].sequence_no &&
          rows.at(-1).sequence_no - previous.from_sequence < 6) {
        const totalChars = this.db.prepare('SELECT SUM(LENGTH(original_text)) AS n FROM segments WHERE listening_id=? AND sequence_no BETWEEN ? AND ?')
          .get(listeningId, previous.from_sequence, rows.at(-1).sequence_no).n;
        if (totalChars <= 2500) {
          this.db.prepare('UPDATE extraction_jobs SET to_sequence=?, updated_at=? WHERE id=?').run(rows.at(-1).sequence_no, now(), previous.id);
          return this.db.prepare('SELECT * FROM extraction_jobs WHERE id=?').get(previous.id);
        }
      }
      const id = randomUUID(), time = now();
      const policyVersion = this.db.prepare('SELECT knowledge_policy_version AS version FROM listenings WHERE id=?').get(listeningId).version;
      this.db.prepare(`INSERT OR IGNORE INTO extraction_jobs
        (id,listening_id,from_sequence,to_sequence,prompt_version,state,attempts,last_error,created_at,updated_at,progress_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, listeningId, rows[0].sequence_no,
        rows.at(-1).sequence_no, policyVersion, 'pending', 0, null, time, time,
        policyVersion === 2 ? JSON.stringify({ contract_revision: 'v2.1', cycle: 1, extra_requests: 0, protocol_retries: 0 }) : null);
      return this.db.prepare('SELECT * FROM extraction_jobs WHERE listening_id=? AND from_sequence=? AND to_sequence=? AND prompt_version=?')
        .get(listeningId, rows[0].sequence_no, rows.at(-1).sequence_no, policyVersion);
    });
  }
  pendingJobCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM extraction_jobs WHERE state='pending'").get().n;
  }
  nextJob(listeningId) {
    const job = this.db.prepare("SELECT * FROM extraction_jobs WHERE listening_id=? AND state='pending' ORDER BY from_sequence LIMIT 1").get(listeningId);
    if (job) {
      job.ready_at = this.db.prepare("SELECT ready_at FROM extraction_parts WHERE job_id=? AND phase!='done' ORDER BY part_no LIMIT 1").get(job.id)?.ready_at || 0;
      for (const row of this.db.prepare('SELECT progress_json FROM extraction_jobs WHERE listening_id=? AND prompt_version=2 AND progress_json IS NOT NULL').all(listeningId)) {
        const progress = JSON.parse(row.progress_json);
        if (Number.isFinite(progress.last_request_at)) job.ready_at = Math.max(job.ready_at, progress.last_request_at + 2000);
        if (Number.isFinite(progress.rate_limit_until)) job.ready_at = Math.max(job.ready_at, progress.rate_limit_until);
      }
    }
    return job;
  }
  markJob(id, state, error = null, retryAt = null) {
    return this.tx(() => {
      let outcome;
      const checkpoint = this.knowledgeCheckpoint(id);
      if (checkpoint?.job.prompt_version === 2 && state === 'failed' && checkpoint.job.outcome !== 'legacy') {
        const accepted = checkpoint.parts.some(part => part.results.length);
        state = accepted ? 'complete' : 'failed';
        outcome = accepted ? 'partial' : 'invalid';
        for (const part of checkpoint.parts) if (part.phase !== 'done') {
          part.stats.failure_code ||= 'EXECUTION_FAILED';
          part.stats.failure_message ||= error;
          this.writeKnowledgePart(id, part);
        }
      }
      this.db.prepare('UPDATE extraction_jobs SET state=?, attempts=attempts+?, last_error=?, retry_at=?, outcome=?, updated_at=? WHERE id=?')
        .run(state, state === 'running' ? 1 : 0, error, retryAt,
          outcome === undefined ? (checkpoint?.job.outcome ?? null) : outcome, now(), id);
      return this.db.prepare('SELECT * FROM extraction_jobs WHERE id=?').get(id);
    });
  }
  knowledgeCheckpoint(jobId) {
    const job = this.db.prepare('SELECT * FROM extraction_jobs WHERE id=?').get(jobId);
    if (!job) return null;
    const progress = job.progress_json ? JSON.parse(job.progress_json) : null;
    const parts = this.db.prepare('SELECT * FROM extraction_parts WHERE job_id=? ORDER BY part_no').all(jobId).map(part => ({
      ...part, focus_refs: JSON.parse(part.focus_refs), unresolved: JSON.parse(part.unresolved), results: JSON.parse(part.results),
      stats: JSON.parse(part.stats), input_snapshot: part.input_snapshot ? JSON.parse(part.input_snapshot) : null
    }));
    return { job, progress, parts };
  }
  checkpointJSON(value, maxLength = 60000) {
    const text = JSON.stringify(value, (key, item) => {
      if (/^(api[_-]?key|authorization|access[_-]?token|secret)$/i.test(key)) throw new Error('检查点不能包含凭据');
      return item;
    });
    if (text.length > maxLength) throw new Error('知识检查点载荷超出限制');
    return text;
  }
  writeKnowledgePart(jobId, part) {
    if (!Number.isInteger(part.part_no) || part.part_no < 0) throw new Error('无效知识分片');
    if (!Array.isArray(part.unresolved) || part.unresolved.length > 12 || !Array.isArray(part.results) || part.results.length > 12) {
      throw new Error('知识分片条目超出限制');
    }
    this.db.prepare(`INSERT INTO extraction_parts
      (job_id,part_no,focus_refs,phase,ready_at,initial_requests,repair_reserved,unresolved,results,stats,input_snapshot,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,part_no) DO UPDATE SET
      phase=excluded.phase,ready_at=excluded.ready_at,initial_requests=excluded.initial_requests,
      repair_reserved=excluded.repair_reserved,unresolved=excluded.unresolved,results=excluded.results,
      stats=excluded.stats,input_snapshot=excluded.input_snapshot,updated_at=excluded.updated_at`)
      .run(jobId, part.part_no, this.checkpointJSON(part.focus_refs, 12000), part.phase, part.ready_at || 0,
        part.initial_requests || 0, Number(Boolean(part.repair_reserved)), this.checkpointJSON(part.unresolved),
        this.checkpointJSON(part.results, 12000), this.checkpointJSON(part.stats, 6000),
        part.input_snapshot == null ? null : this.checkpointJSON(part.input_snapshot, 30000), now());
  }
  initializeKnowledgeParts(jobId, parts, contractRevision = 'v2.1') {
    return this.tx(() => {
      const current = this.knowledgeCheckpoint(jobId);
      if (!current || current.job.prompt_version !== 2 || current.job.outcome === 'legacy') throw new Error('任务不支持知识检查点');
      if (current.parts.length) return current;
      if (current.progress?.contract_revision && current.progress.contract_revision !== contractRevision) throw new Error('不支持的知识协议版本');
      for (const [index, part] of parts.entries()) {
        for (const ref of part.focus_refs) {
          const segment = this.db.prepare('SELECT original_text FROM segments WHERE id=? AND listening_id=? AND sequence_no BETWEEN ? AND ?')
            .get(ref.segment_id, current.job.listening_id, current.job.from_sequence, current.job.to_sequence);
          if (!segment || !Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start < 0 || ref.end <= ref.start || ref.end > segment.original_text.length) {
            throw new Error('无效知识分片原文范围');
          }
        }
        this.writeKnowledgePart(jobId, { part_no: index, phase: 'extract_pending', ready_at: 0, initial_requests: 0,
          repair_reserved: false, unresolved: [], results: [], stats: {}, input_snapshot: null, ...part });
      }
      const progress = { contract_revision: contractRevision, cycle: 1, extra_requests: 0, protocol_retries: 0, ...current.progress };
      this.db.prepare('UPDATE extraction_jobs SET progress_json=?,updated_at=? WHERE id=?').run(this.checkpointJSON(progress, 6000), now(), jobId);
      return this.knowledgeCheckpoint(jobId);
    });
  }
  saveKnowledgeCheckpoint(jobId, patch, accepted = []) {
    return this.tx(() => {
      const current = this.knowledgeCheckpoint(jobId);
      if (!current || current.job.prompt_version !== 2 || current.job.outcome === 'legacy') throw new Error('任务不支持知识检查点');
      let part = null;
      const changedIds = new Set(), results = [];
      if (patch.part) {
        const previous = current.parts.find(value => value.part_no === patch.part.part_no);
        if (!previous) throw new Error('知识分片不存在');
        part = { ...previous, ...patch.part, focus_refs: previous.focus_refs,
          stats: { ...previous.stats, ...patch.part.stats }, results: [...previous.results] };
        const applied = new Set(previous.results.map(result => result.sourceIndex));
        for (const entry of accepted) {
          if (!Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0 || entry.sourceIndex > 11) throw new Error('无效知识条目索引');
          if (applied.has(entry.sourceIndex)) continue;
          const appliedResult = this.applyKnowledgeV2WithinTransaction(current.job.listening_id, [entry.item]);
          const result = { sourceIndex: entry.sourceIndex, cycle: current.progress?.cycle || 1, ...appliedResult.results[0] };
          for (const item of appliedResult.changedItems) changedIds.add(item.id);
          part.results.push(result); results.push(result); applied.add(entry.sourceIndex);
        }
        part.unresolved = part.unresolved.filter(entry => !applied.has(entry.sourceIndex));
        if (part.phase === 'done' && !part.unresolved.length) part.input_snapshot = null;
        this.writeKnowledgePart(jobId, part);
      } else if (accepted.length) throw new Error('知识写入缺少分片检查点');
      const job = current.job;
      const progress = { ...current.progress, ...patch.progress };
      if (changedIds.size && progress.first_content_at == null) progress.first_content_at = Date.now();
      this.db.prepare('UPDATE extraction_jobs SET progress_json=?,state=?,outcome=?,last_error=?,retry_at=?,updated_at=? WHERE id=?')
        .run(progress == null ? null : this.checkpointJSON(progress, 6000), patch.state ?? job.state,
          patch.outcome === undefined ? job.outcome : patch.outcome, patch.lastError === undefined ? job.last_error : patch.lastError,
          patch.retryAt === undefined ? job.retry_at : patch.retryAt, now(), jobId);
      return { changedItems: this.knowledge(job.listening_id).filter(item => changedIds.has(item.id)), part, results };
    });
  }
  recoverKnowledgeCheckpoints() {
    this.tx(() => {
      const jobs = this.db.prepare("SELECT id FROM extraction_jobs WHERE prompt_version=2 AND state IN ('pending','running') AND progress_json IS NOT NULL").all();
      for (const { id } of jobs) {
        const checkpoint = this.knowledgeCheckpoint(id);
        if (checkpoint.progress.contract_revision !== 'v2.1') continue;
        for (const part of checkpoint.parts) {
          if (part.phase === 'extract_inflight') {
            part.phase = 'extract_pending';
            this.writeKnowledgePart(id, part);
          } else if (part.phase === 'repair_inflight') {
            part.phase = 'done';
            part.stats.repair_error = 'REPAIR_INTERRUPTED';
            part.unresolved = part.unresolved.map(entry => ({ ...entry, issues: [...(entry.issues || []),
              { code: 'REPAIR_INTERRUPTED', path: '', details: {} }] }));
            this.writeKnowledgePart(id, part);
          }
        }
      }
    });
  }
  publicKnowledgeJob(job) {
    const { id, listening_id, from_sequence, to_sequence, prompt_version, state, attempts, last_error,
      created_at, updated_at, retry_at, outcome } = job;
    const { progress, parts } = this.knowledgeCheckpoint(id);
    const results = parts.flatMap(part => part.results);
    const visible = new Set(results.filter(result => result.visibleChange && result.itemId &&
      (result.cycle || 1) === (progress?.cycle || 1)).map(result => result.itemId));
    return { id, listening_id, from_sequence, to_sequence, prompt_version, state, attempts, last_error,
      created_at, updated_at, retry_at, outcome, contract_revision: progress?.contract_revision || null,
      unresolved_count: parts.reduce((sum, part) => sum + part.unresolved.length, 0), resolved_count: results.length,
      visible_change_count: visible.size,
      repair_pending: parts.some(part => part.phase === 'repair_pending'),
      repairing: parts.some(part => part.phase === 'repair_inflight') };
  }
  jobMetrics(job) {
    return this.db.prepare(`SELECT COUNT(*) AS segment_count, MIN(created_at) AS first_final_at, MAX(created_at) AS last_final_at
      FROM segments WHERE listening_id=? AND sequence_no BETWEEN ? AND ?`).get(job.listening_id, job.from_sequence, job.to_sequence);
  }
  knowledgeCandidateIds(listeningId) {
    return {
      existing: new Set(this.db.prepare('SELECT id FROM knowledge_items WHERE listening_id=?').all(listeningId).map(row => row.id)),
      observed: new Set(this.db.prepare("SELECT id FROM knowledge_candidates WHERE listening_id=? AND state='observe'").all(listeningId).map(row => row.id))
    };
  }
  jobInput(job, focusSegments = null) {
    const focus = focusSegments || this.db.prepare('SELECT id, original_text AS text FROM segments WHERE listening_id=? AND sequence_no BETWEEN ? AND ? ORDER BY sequence_no')
      .all(job.listening_id, job.from_sequence, job.to_sequence);
    const context = this.db.prepare('SELECT id, original_text AS text FROM segments WHERE listening_id=? AND sequence_no<? ORDER BY sequence_no DESC LIMIT 3')
      .all(job.listening_id, job.from_sequence).reverse().map(row => ({ ...row, text: job.prompt_version === 2 ? row.text.slice(0, 700) : row.text.slice(-250) }));
    const focusText = focus.map(row => row.text).join(' ').normalize('NFKC').toLocaleLowerCase();
    let candidateBudget = 3600;
    const candidates = this.knowledge(job.listening_id)
      .map((item, index) => ({ item, index, relevant: [item.canonical_name, ...item.aliases]
        .some(name => focusText.includes(name.normalize('NFKC').toLocaleLowerCase())) }))
      .sort((a, b) => Number(b.relevant) - Number(a.relevant) || b.index - a.index)
      .slice(0, job.prompt_version === 2 ? 12 : 6).map(({ item }) => {
        const { id, type, display_label, canonical_name, aliases, dialogue_summary } = item;
        const candidate = { id, type, display_label, canonical_name, aliases: aliases.slice(0, 4) };
        if (job.prompt_version !== 2) return { ...candidate, dialogue_summary: dialogue_summary.slice(0, 100) };
        let remaining = Math.min(600, candidateBudget);
        candidate.short_description = (item.short_description || dialogue_summary).slice(0, remaining);
        remaining -= candidate.short_description.length;
        candidate.recent_facts = [];
        for (const fact of item.facts.slice(-2).reverse()) {
          if (!remaining) break;
          if (fact.content.length > remaining) continue;
          candidate.recent_facts.push(fact.content);
          remaining -= fact.content.length;
        }
        candidate.recent_facts.reverse();
        candidateBudget -= candidate.short_description.length + candidate.recent_facts.reduce((n, text) => n + text.length, 0);
        return candidate;
      });
    const input = { listening_id: job.listening_id, context_segments: context, focus_segments: focus, existing_candidates: candidates };
    if (job.prompt_version === 2) {
      const matching = this.db.prepare(`SELECT * FROM knowledge_candidates WHERE listening_id=? AND state='observe'
        AND INSTR(?, normalized_name)>0 ORDER BY updated_at DESC LIMIT 8`).all(job.listening_id, focusText);
      const recent = this.db.prepare("SELECT * FROM knowledge_candidates WHERE listening_id=? AND state='observe' ORDER BY updated_at DESC LIMIT 8")
        .all(job.listening_id);
      input.observed_candidates = [...new Map([...matching, ...recent].map(c => [c.id, c])).values()]
        .slice(0, 8).map(({ id, type, display_label, canonical_name, role, reason, first_segment_id }) =>
          ({ id, type, display_label, canonical_name, role, reason, first_segment_id }));
      input.policy_version = 2;
    }
    return input;
  }
  applyKnowledge(listeningId, items) {
    return this.tx(() => {
      const changed = new Set(), time = now();
      for (let item of items) {
        const norm = normalized(item.canonical_name);
        const existing = this.knowledge(listeningId);
        let match = existing.find(k => k.id === item.existing_item_id && k.type === item.type);
        const isLink = item.decision === 'link' && match && item.certainty === 'clear' &&
          (match.normalized_name === norm || match.aliases.some(a => normalized(a) === norm) ||
           item.aliases.some(a => normalized(a) === match.normalized_name));
        const isCorrection = item.decision === 'correct' && match && item.certainty === 'clear' &&
          item.correction_reason && item.evidence.some(e => /\b(i mean|actually|sorry|correction|rather)\b|更正|我是说|应该是|指的是/i.test(e.text || e.quote));
        if (!isLink && !isCorrection) match = null;
        if (item.decision === 'create') {
          const sameEvidence = existing.filter(k => k.type === item.type && k.normalized_name === norm &&
            k.mentions.some(m => item.evidence.some(e => e.segment_id === m.segment_id && e.quote === m.surface_text)));
          if (sameEvidence.length === 1) match = sameEvidence[0];
        }
        if (item.decision !== 'create' && !match) item = { ...item, certainty: 'needs_review' };
        if (!match) {
          const id = randomUUID();
          this.db.prepare(`INSERT INTO knowledge_items
            (id,listening_id,type,canonical_name,normalized_name,dialogue_summary,background_note,certainty,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, listeningId, item.type,
            item.canonical_name, norm, item.dialogue_summary, item.background_note, item.certainty, time, time);
          match = { id, canonical_name: item.canonical_name };
        } else {
          let name = match.canonical_name;
          if (item.decision === 'correct' && item.correction_reason && item.certainty === 'clear' && item.evidence.length >= 1 &&
              item.evidence.some(e => e.quote.toLocaleLowerCase().includes(item.canonical_name.toLocaleLowerCase())) && name !== item.canonical_name) {
            this.db.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), match.id, 'correct', name,
              item.canonical_name, null, item.correction_reason, time);
            this.db.prepare('INSERT OR IGNORE INTO knowledge_aliases VALUES (?,?,?)').run(match.id, name, normalized(name));
            name = item.canonical_name;
          }
          match.canonical_name = name;
          this.db.prepare('UPDATE knowledge_items SET canonical_name=?, normalized_name=?, dialogue_summary=?, short_description=?, background_note=?, certainty=?, updated_at=? WHERE id=?')
            .run(name, normalized(name), item.dialogue_summary || match.dialogue_summary,
              item.dialogue_summary || match.dialogue_summary,
              item.background_note || match.background_note, item.certainty, time, match.id);
        }
        for (const alias of item.aliases) if (normalized(alias) !== normalized(match.canonical_name))
          this.db.prepare('INSERT OR IGNORE INTO knowledge_aliases VALUES (?,?,?)').run(match.id, alias, normalized(alias));
        for (const evidence of item.evidence)
          this.db.prepare('INSERT OR IGNORE INTO knowledge_mentions VALUES (?,?,?)').run(match.id, evidence.segment_id, evidence.quote);
        changed.add(match.id);
      }
      this.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run(time, listeningId);
      const knowledge = this.knowledge(listeningId);
      return knowledge.filter(k => changed.has(k.id));
    });
  }
  applyKnowledgeV2(listeningId, items) {
    return this.tx(() => this.applyKnowledgeV2WithinTransaction(listeningId, items).changedItems);
  }
  applyKnowledgeV2WithinTransaction(listeningId, items) {
    const changed = new Set(), results = [], time = now();
    const saveCandidate = (item, state) => {
      const norm = normalized(item.canonical_name);
      const matches = this.db.prepare('SELECT * FROM knowledge_candidates WHERE listening_id=? AND type=? AND display_label=? AND normalized_name=?')
        .all(listeningId, item.type, item.display_label, norm);
      const candidate = matches.find(c => c.id === item.observed_candidate_id) || (matches.length === 1 ? matches[0] : null);
      const last = item.evidence.at(-1)?.segment_id || null;
      if (candidate) {
        this.db.prepare('UPDATE knowledge_candidates SET state=?,role=?,reason=?,last_segment_id=?,updated_at=? WHERE id=?')
          .run(state, item.role, item.reason, last, time, candidate.id);
      } else {
        this.db.prepare(`INSERT INTO knowledge_candidates
          (id,listening_id,type,display_label,canonical_name,normalized_name,state,role,reason,first_segment_id,first_quote,last_segment_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), listeningId, item.type, item.display_label,
          item.canonical_name, norm, state, item.role, item.reason,
          item.evidence[0]?.segment_id || null, item.evidence[0]?.quote || null, last, time, time);
      }
    };
    for (const item of items) {
      if (item.action === 'observe' || item.action === 'exclude') {
        saveCandidate(item, item.action);
        results.push({ status: item.action === 'observe' ? 'observed' : 'excluded', visibleChange: false });
        continue;
      }
      const existing = this.knowledge(listeningId);
      let match = item.existing_item_id ? existing.find(k => k.id === item.existing_item_id && k.type === item.type &&
        (!k.display_label || k.display_label === item.display_label)) : null;
      if (match) {
        const known = [match.canonical_name, ...match.aliases].some(name => normalized(name) === normalized(item.canonical_name));
        const explicit = item.evidence.some(e => /\b(i mean|actually|also called|known as|short for)\b|也叫|简称|我是说|更正|指的是/.test(e.quote.toLowerCase()) &&
          normalized(e.quote).includes(match.normalized_name));
        if (!known && !explicit) match = null;
      }
      if (!match && item.action !== 'create') { saveCandidate(item, 'observe'); results.push({ status: 'deferred_identity', visibleChange: false }); continue; }
      if (!match && item.action === 'create') {
        const collisions = existing.filter(k => k.type === item.type && k.display_label === item.display_label &&
          [k.canonical_name, ...k.aliases].some(name => normalized(name) === normalized(item.canonical_name)));
        // 重试同一句的创建才可自动复用；其他同名对象先待观察，不猜测身份。
        const retry = collisions.filter(k => k.facts.some(f => normalized(f.content) === normalized(item.new_information) &&
          item.evidence.some(e => e.segment_id === f.segment_id)));
        if (retry.length === 1) match = retry[0];
        else if (collisions.length) { saveCandidate(item, 'observe'); results.push({ status: 'deferred_identity', visibleChange: false }); continue; }
      }
      let status = 'repeated', visibleChange = false;
      if (!match) {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO knowledge_items
          (id,listening_id,type,canonical_name,normalized_name,dialogue_summary,background_note,certainty,created_at,updated_at,
           display_label,short_description,policy_version,content_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,2,1)`)
          .run(id, listeningId, item.type, item.canonical_name, normalized(item.canonical_name), item.new_information,
            null, item.certainty, time, time, item.display_label, item.short_description);
        match = { id, canonical_name: item.canonical_name, aliases: [], short_description: item.short_description, content_version: 1, facts: [] };
        changed.add(id); status = 'created'; visibleChange = true;
      } else if (item.action === 'update' && item.correction_reason &&
                 normalized(item.canonical_name) !== normalized(match.canonical_name) &&
                 item.evidence.some(e => /\b(i mean|actually|correction|rather)\b|更正|我是说|应该是/.test(e.quote.toLowerCase()) &&
                   normalized(e.quote).includes(normalized(item.canonical_name)))) {
        this.db.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?,?)')
          .run(randomUUID(), match.id, 'correct', match.canonical_name, item.canonical_name, null, item.correction_reason, time);
        this.db.prepare('INSERT OR IGNORE INTO knowledge_aliases VALUES (?,?,?)')
          .run(match.id, match.canonical_name, normalized(match.canonical_name));
        this.db.prepare(`UPDATE knowledge_items SET canonical_name=?,normalized_name=?,updated_at=? WHERE id=?`)
          .run(item.canonical_name, normalized(item.canonical_name), time, match.id);
        match.canonical_name = item.canonical_name;
        changed.add(match.id); status = 'updated'; visibleChange = true;
      } else if (normalized(item.canonical_name) !== normalized(match.canonical_name) &&
                 item.evidence.some(e => normalized(e.quote).includes(normalized(item.canonical_name)))) {
        this.db.prepare('INSERT OR IGNORE INTO knowledge_aliases VALUES (?,?,?)')
          .run(match.id, item.canonical_name, normalized(item.canonical_name));
      }
      if (item.observed_candidate_id) {
        const candidate = this.db.prepare('SELECT * FROM knowledge_candidates WHERE id=? AND listening_id=?')
          .get(item.observed_candidate_id, listeningId);
        if (candidate?.first_segment_id && candidate.first_quote) {
          this.db.prepare('INSERT OR IGNORE INTO knowledge_mentions VALUES (?,?,?)')
            .run(match.id, candidate.first_segment_id, candidate.first_quote);
        }
        this.db.prepare('DELETE FROM knowledge_candidates WHERE id=? AND listening_id=?').run(item.observed_candidate_id, listeningId);
      }
      for (const alias of item.aliases) if (normalized(alias) !== normalized(match.canonical_name))
        this.db.prepare('INSERT OR IGNORE INTO knowledge_aliases VALUES (?,?,?)').run(match.id, alias, normalized(alias));
      for (const evidence of item.evidence)
        this.db.prepare('INSERT OR IGNORE INTO knowledge_mentions VALUES (?,?,?)').run(match.id, evidence.segment_id, evidence.quote);
      if (item.action !== 'repeat') {
        const knownFacts = this.db.prepare('SELECT content FROM knowledge_facts WHERE item_id=?').all(match.id);
        if (!knownFacts.some(f => normalized(f.content) === normalized(item.new_information))) {
          const evidence = item.evidence[0];
          this.db.prepare(`INSERT OR IGNORE INTO knowledge_facts
            (id,item_id,segment_id,surface_text,content,certainty,created_at) VALUES (?,?,?,?,?,?,?)`)
            .run(randomUUID(), match.id, evidence.segment_id, evidence.quote, item.new_information, item.certainty, time);
          if (status !== 'created') { status = 'updated'; visibleChange = true; changed.add(match.id); }
        }
      }
      if (status === 'updated') {
        this.db.prepare(`UPDATE knowledge_items SET short_description=?, content_version=content_version+1,updated_at=? WHERE id=?`)
          .run(item.short_description || match.short_description, time, match.id);
      }
      results.push({ status, itemId: match.id, visibleChange });
    }
    if (changed.size) this.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run(time, listeningId);
    return { changedItems: this.knowledge(listeningId).filter(k => changed.has(k.id)), results };
  }
  retry(listeningId) {
    return this.tx(() => {
      this.db.prepare("UPDATE segments SET translation_state='pending' WHERE listening_id=? AND translation_state='failed'").run(listeningId);
      const time = now();
      this.db.prepare("UPDATE extraction_jobs SET state='pending', attempts=0, retry_at=?, last_error=NULL, updated_at=? WHERE listening_id=? AND prompt_version=1 AND state='failed'")
        .run(time, time, listeningId);
      const jobs = this.db.prepare("SELECT * FROM extraction_jobs WHERE listening_id=? AND prompt_version=2 AND (state='failed' OR outcome='partial') AND COALESCE(outcome,'')!='legacy'").all(listeningId);
      let resumed = 0;
      for (const job of jobs) {
        if (job.state === 'pending' || job.state === 'running') continue;
        const checkpoint = this.knowledgeCheckpoint(job.id);
        if (!checkpoint.progress || checkpoint.progress.contract_revision !== 'v2.1') continue;
        let hasWork = !checkpoint.parts.length;
        for (const part of checkpoint.parts) {
          if (part.unresolved.length) {
            part.phase = 'repair_pending'; part.repair_reserved = false; hasWork = true;
          } else if (part.phase !== 'done' || part.stats.initial_complete === false || part.stats.failure_code) {
            part.phase = 'extract_pending'; part.initial_requests = 0; part.repair_reserved = false; hasWork = true;
          } else continue;
          part.ready_at = 0;
          delete part.stats.failure_code; delete part.stats.failure_message; delete part.stats.repair_error;
          this.writeKnowledgePart(job.id, part);
        }
        if (!hasWork) continue;
        const progress = { ...checkpoint.progress, cycle: (checkpoint.progress.cycle || 1) + 1, extra_requests: 0, protocol_retries: 0 };
        this.db.prepare("UPDATE extraction_jobs SET state='pending',outcome=NULL,attempts=0,retry_at=NULL,last_error=NULL,progress_json=?,updated_at=? WHERE id=?")
          .run(this.checkpointJSON(progress, 6000), time, job.id);
        resumed++;
      }
      return resumed;
    });
  }
}

Object.assign(ListeningStore.prototype, relationMethods);
