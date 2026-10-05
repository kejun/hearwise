import { randomUUID, createHash } from 'node:crypto';

const norm = value => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const fail = (status, message) => { throw Object.assign(new Error(message), { status, knowledgeEdit: true }); };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function replaceKnowledgeTerm(text, source, target) {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Latin names must not alter substrings of other words. CJK names need no spaces.
  const left = /^[\p{Script=Latin}\d_]/u.test(source) ? '(?<![\\p{Script=Latin}\\d_])' : '';
  const right = /[\p{Script=Latin}\d_]$/u.test(source) ? '(?![\\p{Script=Latin}\\d_])' : '';
  return text.replace(new RegExp(`${left}${escaped}${right}`, 'giu'), () => target);
}
export function migrateKnowledgeEdits(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_manual_items (
      listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL, type TEXT NOT NULL, normalized_name TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(listening_id,item_id,normalized_name));
    CREATE TABLE IF NOT EXISTS knowledge_corrections (
      listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
      normalized_source TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, item_id TEXT NOT NULL,
      PRIMARY KEY(listening_id,normalized_source));
    PRAGMA user_version=10;
  `);
}

export function migrateKnowledgeEditJobs(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_edit_jobs (
    id TEXT PRIMARY KEY, listening_id TEXT NOT NULL REFERENCES listenings(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL, fingerprint TEXT NOT NULL, revision TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')), error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_knowledge_edit ON knowledge_edit_jobs(listening_id) WHERE state='running';
    PRAGMA user_version=11;`);
}

const editFingerprint = input => fingerprint([input?.name, input?.source, input?.revision]);
const publicEditJob = row => row && ({ id: row.id, state: row.state, name: row.name, source: row.source,
  saved: row.state === 'succeeded' ? true : row.state === 'failed' ? false : null, error: row.error });

export const knowledgeEditMethods = {
  recoverKnowledgeEditJobs() {
    this.db.prepare("UPDATE knowledge_edit_jobs SET state='failed',error=?,updated_at=? WHERE state='running'")
      .run('服务在生成期间重启，原内容未更改，请重新保存。', new Date().toISOString());
  },
  knowledgeEditJob(listeningId, itemId, jobId, input) {
    const row = this.db.prepare('SELECT * FROM knowledge_edit_jobs WHERE id=? AND listening_id=? AND item_id=?').get(jobId, listeningId, itemId);
    if (row && input && row.fingerprint !== editFingerprint(input)) fail(409, '同一保存任务不能提交不同的修改');
    return publicEditJob(row);
  },
  knowledgeEditForSnapshot(listeningId, itemId, revision) {
    return publicEditJob(this.db.prepare(`SELECT * FROM knowledge_edit_jobs WHERE listening_id=? AND item_id=?
      AND (state='running' OR (state='failed' AND revision=?)) ORDER BY rowid DESC LIMIT 1`).get(listeningId, itemId, revision));
  },
  createKnowledgeEditJob(listeningId, itemId, jobId, input) {
    const time = new Date().toISOString();
    this.db.prepare("INSERT INTO knowledge_edit_jobs VALUES (?,?,?,?,?,?,?,'running',NULL,?,?)")
      .run(jobId, listeningId, itemId, editFingerprint(input), input.revision, input.name.trim(), input.source.trim(), time, time);
    return this.knowledgeEditJob(listeningId, itemId, jobId);
  },
  failKnowledgeEditJob(jobId, message) {
    this.db.prepare("UPDATE knowledge_edit_jobs SET state='failed',error=?,updated_at=? WHERE id=? AND state='running'")
      .run(message, new Date().toISOString(), jobId);
  },
  correctKnowledgeText(listeningId, text) {
    // One pass over original matches: replacement strings cannot trigger other rules.
    const rules = this.db.prepare('SELECT source,target FROM knowledge_corrections WHERE listening_id=? ORDER BY length(source) DESC').all(listeningId);
    if (!rules.length) return text;
    const matches = [];
    for (const rule of rules) {
      // Collect exact spans with the same word-boundary policy as manual editing.
      const escaped = rule.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const left = /^[\p{Script=Latin}\d_]/u.test(rule.source) ? '(?<![\\p{Script=Latin}\\d_])' : '';
      const right = /[\p{Script=Latin}\d_]$/u.test(rule.source) ? '(?![\\p{Script=Latin}\\d_])' : '';
      for (const match of text.matchAll(new RegExp(`${left}${escaped}${right}`, 'giu'))) {
        const start = match.index, end = start + match[0].length;
        if (!matches.some(m => start < m.end && end > m.start)) matches.push({ start, end, target: rule.target });
      }
    }
    for (const match of matches.sort((a, b) => b.start - a.start)) text = text.slice(0, match.start) + match.target + text.slice(match.end);
    return text;
  },
  manualKnowledgeDecision(listeningId, item) {
    const names = [item.canonical_name, ...(item.aliases || [])].map(norm);
    const rules = this.db.prepare('SELECT * FROM knowledge_manual_items WHERE listening_id=?').all(listeningId);
    const rule = rules.find(rule => rule.item_id === item.existing_item_id || rule.type === item.type && names.includes(rule.normalized_name));
    if (rule && !rule.deleted) {
      // Retain new, grounded mentions without allowing extraction to overwrite the manual card.
      for (const evidence of item.evidence || []) {
        const segment = this.db.prepare('SELECT original_text FROM segments WHERE id=? AND listening_id=?').get(evidence.segment_id, listeningId);
        if (segment && evidence.quote && segment.original_text.includes(evidence.quote))
          this.db.prepare('INSERT OR IGNORE INTO knowledge_mentions VALUES (?,?,?)').run(rule.item_id, evidence.segment_id, evidence.quote);
      }
    }
    return rule;
  },
  knowledgeEditSnapshot(listeningId, itemId) {
    const item = this.knowledge(listeningId).find(item => item.id === itemId);
    if (!item) fail(404, '知识条目不存在');
    if (this.db.prepare("SELECT 1 FROM listening_runs WHERE listening_id=? AND state='active'").get(listeningId))
      fail(409, '请先停止收听，再修改或删除知识条目');
    if (this.db.prepare("SELECT 1 FROM extraction_jobs WHERE listening_id=? AND state IN ('pending','running')").get(listeningId) ||
        this.db.prepare("SELECT 1 FROM segments WHERE listening_id=? AND translation_state='pending'").get(listeningId))
      fail(409, '请等待原文翻译和知识整理结束；未完成的任务可先重试');
    const segments = this.db.prepare(`SELECT DISTINCT s.* FROM segments s JOIN knowledge_mentions m ON m.segment_id=s.id
      WHERE m.item_id=? AND s.listening_id=? ORDER BY s.sequence_no`).all(itemId, listeningId);
    return { item, segments, revision: fingerprint({ item, segments }) };
  },
  prepareKnowledgeEdit(listeningId, itemId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['key', 'name', 'source', 'revision'].includes(key))) fail(400, '修改请求格式无效');
    for (const key of ['name', 'source']) if (typeof input[key] !== 'string' || !input[key].trim() ||
        input[key].trim().length > 160 || /[\u0000-\u001f\u007f]/.test(input[key])) fail(400, '名称和原文错误词须为 1–160 个字符');
    const snapshot = this.knowledgeEditSnapshot(listeningId, itemId);
    if (input.revision !== snapshot.revision) fail(409, '条目或原文已改变，请关闭后重新打开编辑');
    const name = input.name.trim(), source = input.source.trim();
    if (this.knowledge(listeningId).some(item => item.id !== itemId && [item.canonical_name, ...item.aliases].some(alias => norm(alias) === norm(name))))
      fail(409, '已存在同名条目，请使用可区分的名称');
    const existing = this.db.prepare('SELECT * FROM knowledge_corrections WHERE listening_id=? AND normalized_source=?').get(listeningId, norm(source));
    if (existing && existing.item_id !== itemId) fail(409, '这个错误词已用于其他条目的纠正');
    const segments = snapshot.segments.map(segment => ({ ...segment, original_text: replaceKnowledgeTerm(segment.original_text, source, name) }));
    if (!snapshot.segments.some(segment => replaceKnowledgeTerm(segment.original_text, source, '\u0000') !== segment.original_text))
      fail(400, '条目引用的原文中找不到这个错误词，请填写原文中的实际写法');
    return { ...snapshot, name, source, correctedSegments: segments };
  },
  saveKnowledgeEdit(listeningId, itemId, prepared, card, jobId = null) {
    return this.tx(() => {
      const current = this.prepareKnowledgeEdit(listeningId, itemId, { name: prepared.name, source: prepared.source, revision: prepared.revision });
      const time = new Date().toISOString();
      for (const segment of current.correctedSegments) {
        this.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run(segment.original_text, segment.id);
        // A quote may also support another node. Keep those verbatim anchors valid.
        for (const mention of this.db.prepare('SELECT * FROM knowledge_mentions WHERE segment_id=? AND item_id!=?').all(segment.id, itemId)) {
          const quote = replaceKnowledgeTerm(mention.surface_text, current.source, current.name);
          if (quote === mention.surface_text) continue;
          this.db.prepare('DELETE FROM knowledge_mentions WHERE item_id=? AND segment_id=? AND surface_text=?').run(mention.item_id, segment.id, mention.surface_text);
          this.db.prepare('INSERT OR IGNORE INTO knowledge_mentions VALUES (?,?,?)').run(mention.item_id, segment.id, quote);
        }
        for (const fact of this.db.prepare('SELECT * FROM knowledge_facts WHERE segment_id=? AND item_id!=?').all(segment.id, itemId)) {
          const quote = replaceKnowledgeTerm(fact.surface_text, current.source, current.name);
          this.db.prepare('UPDATE knowledge_facts SET surface_text=? WHERE id=?').run(quote, fact.id);
        }
      }
      // Existing quotes and facts about this identity are rebuilt from the corrected source.
      this.db.prepare('DELETE FROM knowledge_facts WHERE item_id=?').run(itemId);
      this.db.prepare('DELETE FROM knowledge_mentions WHERE item_id=?').run(itemId);
      const mentions = current.item.mentions.map(mention => ({ segment_id: mention.segment_id,
        quote: replaceKnowledgeTerm(mention.surface_text, current.source, current.name) }));
      for (const evidence of [...mentions, ...card.evidence]) this.db.prepare('INSERT OR IGNORE INTO knowledge_mentions VALUES (?,?,?)').run(itemId, evidence.segment_id, evidence.quote);
      for (const fact of card.facts) this.db.prepare('INSERT OR IGNORE INTO knowledge_facts VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), itemId, fact.segment_id, fact.quote, fact.content, 'clear', time);
      this.db.prepare('DELETE FROM knowledge_aliases WHERE item_id=?').run(itemId);
      this.db.prepare(`UPDATE knowledge_items SET canonical_name=?,normalized_name=?,short_description=?,dialogue_summary=?,
        background_note=NULL,certainty='clear',content_version=content_version+1,updated_at=? WHERE id=?`)
        .run(current.name, norm(current.name), card.short_description, card.dialogue_summary, time, itemId);
      this.db.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(), itemId, 'manual', current.item.canonical_name, current.name, null, '人工纠正并重新生成', time);
      for (const value of [current.item.canonical_name, ...current.item.aliases, current.source, current.name])
        this.db.prepare('INSERT OR REPLACE INTO knowledge_manual_items VALUES (?,?,?,?,0)').run(listeningId, itemId, current.item.type, norm(value));
      // If the user corrects this item twice, earlier spellings resolve directly to its latest name.
      this.db.prepare('UPDATE knowledge_corrections SET target=? WHERE listening_id=? AND item_id=?').run(current.name, listeningId, itemId);
      if (current.source !== current.name) this.db.prepare('INSERT OR REPLACE INTO knowledge_corrections VALUES (?,?,?,?,?)')
        .run(listeningId, norm(current.source), current.source, current.name, itemId);
      // Failed extraction snapshots contain obsolete offsets/quotes. Explicit retry rebuilds them.
      for (const job of this.db.prepare("SELECT id,progress_json,from_sequence,to_sequence FROM extraction_jobs WHERE listening_id=? AND (state='failed' OR outcome='partial')").all(listeningId)) {
        if (!current.correctedSegments.some(segment => segment.sequence_no >= job.from_sequence && segment.sequence_no <= job.to_sequence)) continue;
        this.db.prepare('DELETE FROM extraction_parts WHERE job_id=?').run(job.id);
        const progress = job.progress_json ? JSON.parse(job.progress_json) : {};
        this.db.prepare('UPDATE extraction_jobs SET progress_json=? WHERE id=?').run(JSON.stringify({ ...progress, contract_revision: 'v2.1', extra_requests: 0, protocol_retries: 0 }), job.id);
      }
      this.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run(time, listeningId);
      // Commit the receipt with the card and transcript, so restart recovery cannot report
      // a committed edit as failed or launch the same paid generation again.
      if (jobId && this.db.prepare("UPDATE knowledge_edit_jobs SET state='succeeded',updated_at=? WHERE id=? AND listening_id=? AND item_id=? AND state='running'")
        .run(time, jobId, listeningId, itemId).changes !== 1) fail(409, '保存任务状态已改变，请重新打开核对');
      return this.knowledge(listeningId).find(item => item.id === itemId);
    });
  },
  deleteKnowledgeItem(listeningId, itemId, revision) {
    return this.tx(() => {
      const { item, revision: current } = this.knowledgeEditSnapshot(listeningId, itemId);
      if (revision !== current) fail(409, '条目或原文已改变，请关闭后重新打开编辑');
      for (const value of [item.canonical_name, ...item.aliases])
        this.db.prepare('INSERT OR REPLACE INTO knowledge_manual_items VALUES (?,?,?,?,1)').run(listeningId, itemId, item.type, norm(value));
      this.db.prepare('UPDATE knowledge_manual_items SET deleted=1 WHERE listening_id=? AND item_id=?').run(listeningId, itemId);
      this.db.prepare('DELETE FROM knowledge_items WHERE id=? AND listening_id=?').run(itemId, listeningId);
      return { ok: true };
    });
  }
};
