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
    if (version > 2) throw new Error(`不支持的数据库版本：${version}`);
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
    const listening = this.db.prepare('SELECT title FROM listenings WHERE id=?').get(id);
    if (!listening) return null;
    const sql = kind === 'translation'
      ? "SELECT translation_text AS text FROM segments WHERE listening_id=? AND translation_text IS NOT NULL AND translation_text<>'' ORDER BY sequence_no"
      : 'SELECT original_text AS text FROM segments WHERE listening_id=? ORDER BY sequence_no';
    return { title: listening.title, text: this.db.prepare(sql).all(id).map(row => row.text).join('\n') };
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
      const policyVersion = this.db.prepare('SELECT knowledge_policy_version AS version FROM listenings WHERE id=?').get(listeningId).version;
      this.db.prepare('INSERT OR IGNORE INTO extraction_jobs VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, listeningId, rows[0].sequence_no,
        rows.at(-1).sequence_no, policyVersion, 'pending', 0, null, time, time);
      return this.db.prepare('SELECT * FROM extraction_jobs WHERE listening_id=? AND from_sequence=? AND to_sequence=? AND prompt_version=?')
        .get(listeningId, rows[0].sequence_no, rows.at(-1).sequence_no, policyVersion);
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
  jobInput(job, focusSegments = null) {
    const focus = focusSegments || this.db.prepare('SELECT id, original_text AS text FROM segments WHERE listening_id=? AND sequence_no BETWEEN ? AND ? ORDER BY sequence_no')
      .all(job.listening_id, job.from_sequence, job.to_sequence);
    const context = this.db.prepare('SELECT id, original_text AS text FROM segments WHERE listening_id=? AND sequence_no<? ORDER BY sequence_no DESC LIMIT 3')
      .all(job.listening_id, job.from_sequence).reverse().map(row => ({ ...row, text: job.prompt_version === 2 ? row.text.slice(0, 700) : row.text.slice(-250) }));
    const focusText = focus.map(row => row.text).join(' ').normalize('NFKC').toLocaleLowerCase();
    const candidates = this.knowledge(job.listening_id)
      .map((item, index) => ({ item, index, relevant: [item.canonical_name, ...item.aliases]
        .some(name => focusText.includes(name.normalize('NFKC').toLocaleLowerCase())) }))
      .sort((a, b) => Number(b.relevant) - Number(a.relevant) || b.index - a.index)
      .slice(0, job.prompt_version === 2 ? 12 : 6).map(({ item: { id, type, display_label, canonical_name, aliases, dialogue_summary } }) =>
        ({ id, type, display_label, canonical_name, aliases: aliases.slice(0, 4), dialogue_summary: dialogue_summary.slice(0, 100) }));
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
    return this.tx(() => {
      const changed = new Set(), time = now();
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
        if (!match && item.action !== 'create') { saveCandidate(item, 'observe'); continue; }
        if (!match && item.action === 'create') {
          const collisions = existing.filter(k => k.type === item.type && k.display_label === item.display_label &&
            [k.canonical_name, ...k.aliases].some(name => normalized(name) === normalized(item.canonical_name)));
          // 重试同一句的创建才可自动复用；其他同名对象先待观察，不猜测身份。
          const retry = collisions.filter(k => k.facts.some(f => normalized(f.content) === normalized(item.new_information) &&
            item.evidence.some(e => e.segment_id === f.segment_id)));
          if (retry.length === 1) match = retry[0];
          else if (collisions.length) { saveCandidate(item, 'observe'); continue; }
        }
        if (!match && item.action === 'repeat') continue;
        if (!match) {
          const id = randomUUID();
          this.db.prepare(`INSERT INTO knowledge_items
            (id,listening_id,type,canonical_name,normalized_name,dialogue_summary,background_note,certainty,created_at,updated_at,
             display_label,short_description,policy_version,content_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,2,1)`)
            .run(id, listeningId, item.type, item.canonical_name, normalized(item.canonical_name), item.new_information,
              null, item.certainty, time, time, item.display_label, item.short_description);
          match = { id, canonical_name: item.canonical_name, aliases: [], short_description: item.short_description, content_version: 1, facts: [] };
          changed.add(id);
        } else if (item.action === 'update' && item.correction_reason &&
                   normalized(item.canonical_name) !== normalized(match.canonical_name) &&
                   item.evidence.some(e => /\b(i mean|actually|correction|rather)\b|更正|我是说|应该是/.test(e.quote.toLowerCase()) &&
                     normalized(e.quote).includes(normalized(item.canonical_name)))) {
          this.db.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?,?)')
            .run(randomUUID(), match.id, 'correct', match.canonical_name, item.canonical_name, null, item.correction_reason, time);
          this.db.prepare('INSERT OR IGNORE INTO knowledge_aliases VALUES (?,?,?)')
            .run(match.id, match.canonical_name, normalized(match.canonical_name));
          this.db.prepare(`UPDATE knowledge_items SET canonical_name=?,normalized_name=?,content_version=content_version+1,updated_at=? WHERE id=?`)
            .run(item.canonical_name, normalized(item.canonical_name), time, match.id);
          match.canonical_name = item.canonical_name;
          changed.add(match.id);
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
            if (!changed.has(match.id)) {
              this.db.prepare(`UPDATE knowledge_items SET short_description=?, content_version=content_version+1,updated_at=? WHERE id=?`)
                .run(item.short_description, time, match.id);
              changed.add(match.id);
            }
          }
        }
      }
      if (changed.size) this.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run(time, listeningId);
      return this.knowledge(listeningId).filter(k => changed.has(k.id));
    });
  }
  retry(listeningId) {
    this.db.prepare("UPDATE segments SET translation_state='pending' WHERE listening_id=? AND translation_state='failed'").run(listeningId);
    this.db.prepare("UPDATE extraction_jobs SET state='pending', updated_at=? WHERE listening_id=? AND state IN ('failed','running')").run(now(), listeningId);
  }
}
