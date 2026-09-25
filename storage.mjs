import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const normalized = value => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

export class ListeningStore {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000');
    this.migrate();
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
    if (version > 1) throw new Error(`不支持的数据库版本：${version}`);
    if (version === 1) return;
    this.tx(() => {
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
        this.db.prepare('INSERT INTO listenings VALUES (?,?,?,?)').run(id, title, time, time);
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
    return this.db.prepare("SELECT s.*, r.target_lang FROM segments s JOIN listening_runs r ON r.id=s.run_id WHERE s.listening_id=? AND s.translation_state!='complete' ORDER BY s.sequence_no").all(listeningId);
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
    const jobs = this.db.prepare('SELECT * FROM extraction_jobs WHERE listening_id=? ORDER BY from_sequence').all(id);
    const processing = this.db.prepare(`SELECT
      SUM(CASE WHEN translation_state='failed' THEN 1 ELSE 0 END) AS failedTranslations,
      SUM(CASE WHEN translation_state='pending' THEN 1 ELSE 0 END) AS pendingTranslations
      FROM segments WHERE listening_id=?`).get(id);
    return { listening, runs, segments, latestSegment, segmentCount, knowledge, jobs, processing, page, pageSize };
  }
  exportText(id, kind) {
    const listening = this.db.prepare('SELECT title FROM listenings WHERE id=?').get(id);
    if (!listening) return null;
    const sql = kind === 'translation'
      ? "SELECT translation_text AS text FROM segments WHERE listening_id=? AND translation_text IS NOT NULL AND translation_text<>'' ORDER BY sequence_no"
      : 'SELECT original_text AS text FROM segments WHERE listening_id=? ORDER BY sequence_no';
    return { title: listening.title, text: this.db.prepare(sql).all(id).map(row => row.text).join('\n') };
  }
  knowledge(id) {
    const items = this.db.prepare('SELECT * FROM knowledge_items WHERE listening_id=? ORDER BY created_at, id').all(id);
    const aliases = this.db.prepare('SELECT a.* FROM knowledge_aliases a JOIN knowledge_items k ON k.id=a.item_id WHERE k.listening_id=?').all(id);
    const mentions = this.db.prepare('SELECT m.* FROM knowledge_mentions m JOIN knowledge_items k ON k.id=m.item_id WHERE k.listening_id=?').all(id);
    const revisions = this.db.prepare('SELECT r.* FROM knowledge_revisions r JOIN knowledge_items k ON k.id=r.item_id WHERE k.listening_id=? ORDER BY r.created_at').all(id);
    return items.map(item => ({ ...item, aliases: aliases.filter(a => a.item_id === item.id).map(a => a.alias),
      mentions: mentions.filter(m => m.item_id === item.id), revisions: revisions.filter(r => r.item_id === item.id) }));
  }
  extractionRange(listeningId) {
    const last = this.db.prepare('SELECT COALESCE(MAX(to_sequence),0) AS n FROM extraction_jobs WHERE listening_id=?').get(listeningId).n;
    const rows = this.db.prepare('SELECT id, sequence_no, original_text FROM segments WHERE listening_id=? AND sequence_no>? ORDER BY sequence_no LIMIT 3').all(listeningId, last);
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
      const previous = this.db.prepare("SELECT * FROM extraction_jobs WHERE listening_id=? AND state='pending' ORDER BY to_sequence DESC LIMIT 1").get(listeningId);
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
      this.db.prepare('INSERT OR IGNORE INTO extraction_jobs VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, listeningId, rows[0].sequence_no,
        rows.at(-1).sequence_no, 1, 'pending', 0, null, time, time);
      return this.db.prepare('SELECT * FROM extraction_jobs WHERE listening_id=? AND from_sequence=? AND to_sequence=? AND prompt_version=1')
        .get(listeningId, rows[0].sequence_no, rows.at(-1).sequence_no);
    });
  }
  pendingJobCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM extraction_jobs WHERE state='pending'").get().n;
  }
  nextJob(listeningId) {
    return this.db.prepare("SELECT * FROM extraction_jobs WHERE listening_id=? AND state='pending' ORDER BY from_sequence LIMIT 1").get(listeningId);
  }
  markJob(id, state, error = null) {
    this.db.prepare('UPDATE extraction_jobs SET state=?, attempts=attempts+?, last_error=?, updated_at=? WHERE id=?')
      .run(state, state === 'running' ? 1 : 0, error, now(), id);
  }
  jobInput(job) {
    const focus = this.db.prepare('SELECT id, original_text AS text FROM segments WHERE listening_id=? AND sequence_no BETWEEN ? AND ? ORDER BY sequence_no')
      .all(job.listening_id, job.from_sequence, job.to_sequence);
    const context = this.db.prepare('SELECT id, original_text AS text FROM segments WHERE listening_id=? AND sequence_no<? ORDER BY sequence_no DESC LIMIT 3')
      .all(job.listening_id, job.from_sequence).reverse().map(row => ({ ...row, text: row.text.slice(-250) }));
    const focusText = focus.map(row => row.text).join(' ').normalize('NFKC').toLocaleLowerCase();
    const candidates = this.knowledge(job.listening_id)
      .map((item, index) => ({ item, index, relevant: [item.canonical_name, ...item.aliases]
        .some(name => focusText.includes(name.normalize('NFKC').toLocaleLowerCase())) }))
      .sort((a, b) => Number(b.relevant) - Number(a.relevant) || b.index - a.index)
      .slice(0, 6).map(({ item: { id, type, canonical_name, aliases, dialogue_summary } }) =>
        ({ id, type, canonical_name, aliases: aliases.slice(0, 2), dialogue_summary: dialogue_summary.slice(0, 100) }));
    return { listening_id: job.listening_id, context_segments: context, focus_segments: focus, existing_candidates: candidates };
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
          this.db.prepare('INSERT INTO knowledge_items VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, listeningId, item.type,
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
          this.db.prepare('UPDATE knowledge_items SET canonical_name=?, normalized_name=?, dialogue_summary=?, background_note=?, certainty=?, updated_at=? WHERE id=?')
            .run(name, normalized(name), item.dialogue_summary || match.dialogue_summary,
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
  retry(listeningId) {
    this.db.prepare("UPDATE segments SET translation_state='pending' WHERE listening_id=? AND translation_state='failed'").run(listeningId);
    this.db.prepare("UPDATE extraction_jobs SET state='pending', updated_at=? WHERE listening_id=? AND state IN ('failed','running')").run(now(), listeningId);
  }
}
