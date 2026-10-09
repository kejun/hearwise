import { createHash, randomUUID } from 'node:crypto';
import { knowledgeTermMatches, replaceKnowledgeTerm } from './knowledge-edit.mjs';
import { knowledgeDisplayName } from './knowledge-name.mjs';
import { assertKnowledgeRevision } from './knowledge-revision.mjs';

const norm = value => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = input => hash(JSON.stringify(['name_replace', input?.name, input?.revision]));
const fail = (status, message) => { throw Object.assign(new Error(message), { status, knowledgeEdit: true }); };

function mappedOffset(offset, matches, name, end = false) {
  let delta = 0;
  for (const match of matches) {
    if (offset <= match.start) break;
    if (offset < match.end) return match.start + delta + (end ? name.length : 0);
    delta += name.length - (match.end - match.start);
  }
  return offset + delta;
}

function replaceSegment(store, segment, source, name) {
  const matches = knowledgeTermMatches(segment.original_text, source);
  if (!matches.length) return false;
  const text = replaceKnowledgeTerm(segment.original_text, source, name);
  if (text === segment.original_text) return false;
  // Include anchors for other nodes and quotes after the corrected word. Their
  // offsets change too. Never reactivate historical evidence already marked stale.
  for (const support of store.db.prepare("SELECT * FROM relation_supports WHERE segment_id=? AND state='active'").all(segment.id)) {
    if (support.source_revision !== hash(segment.original_text) || segment.original_text.slice(support.start, support.end) !== support.quote)
      fail(409, '关联原文引用已改变，请刷新后核对');
    const start = mappedOffset(support.start, matches, name), end = mappedOffset(support.end, matches, name, true);
    store.db.prepare('UPDATE relation_supports SET source_revision=?,start=?,end=?,quote=? WHERE id=?')
      .run(hash(text), start, end, text.slice(start, end), support.id);
  }
  for (const mention of store.db.prepare('SELECT * FROM knowledge_mentions WHERE segment_id=?').all(segment.id)) {
    const quote = replaceKnowledgeTerm(mention.surface_text, source, name);
    if (quote === mention.surface_text) continue;
    store.db.prepare('DELETE FROM knowledge_mentions WHERE item_id=? AND segment_id=? AND surface_text=?')
      .run(mention.item_id, segment.id, mention.surface_text);
    store.db.prepare('INSERT OR IGNORE INTO knowledge_mentions VALUES (?,?,?)').run(mention.item_id, segment.id, quote);
  }
  for (const fact of store.db.prepare('SELECT * FROM knowledge_facts WHERE segment_id=?').all(segment.id))
    store.db.prepare('UPDATE knowledge_facts SET surface_text=?,content=? WHERE id=?')
      .run(replaceKnowledgeTerm(fact.surface_text, source, name), replaceKnowledgeTerm(fact.content, source, name), fact.id);
  store.db.prepare('UPDATE segments SET original_text=? WHERE id=?').run(text, segment.id);
  return true;
}

function replaceAssertions(store, listeningId, itemId, segments, source, name, time) {
  const segmentIds = new Set(segments.map(segment => segment.id));
  const assertions = store.db.prepare(`SELECT a.*,r.subject_item_id,r.object_item_id FROM relation_assertions a
    JOIN relations r ON r.id=a.relation_id WHERE r.listening_id=?`).all(listeningId);
  for (const assertion of assertions) {
    if (assertion.subject_item_id !== itemId && assertion.object_item_id !== itemId &&
        !store.db.prepare('SELECT segment_id FROM relation_supports WHERE assertion_id=?').all(assertion.id)
          .some(support => segmentIds.has(support.segment_id))) continue;
    const fields = ['statement', 'conditions', 'time_scope', 'attribution'];
    const next = { ...assertion };
    for (const field of fields) if (typeof next[field] === 'string') next[field] = replaceKnowledgeTerm(next[field], source, name);
    if (fields.every(field => next[field] === assertion[field])) continue;
    const key = hash(JSON.stringify([norm(next.statement), next.polarity, next.modality, next.conditions && norm(next.conditions),
      next.time_scope && norm(next.time_scope), next.attribution && norm(next.attribution), next.correction_of]));
    store.db.prepare(`UPDATE relation_assertions SET assertion_key=?,statement=?,conditions=?,time_scope=?,attribution=?,
      version=version+1,updated_at=? WHERE id=?`).run(key, next.statement, next.conditions, next.time_scope, next.attribution, time, next.id);
  }
}

export const knowledgeNameReplacementMethods = {
  replaceKnowledgeName(listeningId, itemId, jobId, input, { busy = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'revision'].includes(key)) ||
        typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 160 || /[\u0000-\u001f\u007f]/.test(input.name) ||
        typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) fail(400, '名称须为 1–160 个字符，且需提供当前版本');
    if (typeof jobId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(jobId)) fail(400, '保存任务编号无效');
    return this.tx(() => {
      const previous = this.db.prepare('SELECT * FROM knowledge_edit_jobs WHERE id=?').get(jobId);
      if (previous) {
        if (previous.listening_id !== listeningId || previous.item_id !== itemId || previous.operation !== 'manual_regenerate' ||
            previous.fingerprint !== fingerprint(input)) fail(409, '同一保存任务不能提交不同的修改');
        return { job: this.knowledgeEditJob(listeningId, itemId, jobId), changed: false };
      }
      if (busy || this.db.prepare("SELECT 1 FROM knowledge_edit_jobs WHERE listening_id=? AND state='running'").get(listeningId))
        fail(409, '正在保存知识修改，请稍后再试');
      const snapshot = this.knowledgeEditSnapshot(listeningId, itemId);
      assertKnowledgeRevision(snapshot, input.revision, '条目或原文已改变，请核对最新内容后再提交');
      if (this.db.prepare("SELECT 1 FROM relation_jobs WHERE listening_id=? AND state IN ('pending','running')").get(listeningId))
        fail(409, '请等待图谱关系整理结束后再纠正名称');
      const name = input.name.trim(), source = snapshot.item.canonical_name;
      if (this.knowledge(listeningId).some(item => item.id !== itemId && [item.canonical_name, knowledgeDisplayName(item), ...item.aliases]
        .some(alias => norm(alias) === norm(name)))) fail(409, '已存在同名条目，请使用可区分的名称');
      const rule = this.db.prepare('SELECT item_id FROM knowledge_corrections WHERE listening_id=? AND normalized_source=?').get(listeningId, norm(source));
      if (rule && rule.item_id !== itemId) fail(409, '这个错误词已用于其他条目的纠正');
      const time = new Date().toISOString();
      // Reuse the existing manual receipt table without a schema migration.
      // This local operation is atomic, unlike the legacy manual regeneration.
      this.db.prepare(`INSERT INTO knowledge_edit_jobs
        (id,listening_id,item_id,fingerprint,revision,name,source,state,created_at,updated_at,result_json)
        VALUES (?,?,?,?,?,?,?,'running',?,?,?)`)
        .run(jobId, listeningId, itemId, fingerprint(input), input.revision, name, source, time, time, JSON.stringify({ kind: 'name_replace' }));
      const changed = name !== source || Boolean(snapshot.item.name_override);
      if (changed) {
        const changedSegments = snapshot.segments.filter(segment => replaceSegment(this, segment, source, name));
        const affected = new Set([itemId]);
        for (const segment of changedSegments) for (const row of this.db.prepare(`SELECT item_id FROM knowledge_mentions WHERE segment_id=?
          UNION SELECT item_id FROM knowledge_facts WHERE segment_id=?`).all(segment.id, segment.id)) affected.add(row.item_id);
        for (const id of affected) {
          const item = this.db.prepare('SELECT * FROM knowledge_items WHERE id=?').get(id);
          const texts = ['dialogue_summary', 'short_description', 'background_note'].map(field => item[field] === null ? null : replaceKnowledgeTerm(item[field], source, name));
          this.db.prepare(`UPDATE knowledge_items SET dialogue_summary=?,short_description=?,background_note=?,
            content_version=content_version+1,updated_at=? WHERE id=?`).run(...texts, time, id);
        }
        this.db.prepare(`UPDATE knowledge_items SET canonical_name=?,normalized_name=?,name_override=NULL,name_override_identity=NULL WHERE id=?`)
          .run(name, norm(name), itemId);
        this.db.prepare('DELETE FROM knowledge_aliases WHERE item_id=?').run(itemId);
        for (const alias of snapshot.item.aliases) {
          const next = replaceKnowledgeTerm(alias, source, name);
          if (norm(next) !== norm(name)) this.db.prepare('INSERT OR IGNORE INTO knowledge_aliases VALUES (?,?,?)').run(itemId, next, norm(next));
        }
        replaceAssertions(this, listeningId, itemId, changedSegments, source, name, time);
        this.db.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?,?)')
          .run(randomUUID(), itemId, 'name_replace', source, name, null, '人工纠正名称误识别', time);
        this.db.prepare('UPDATE knowledge_corrections SET target=? WHERE listening_id=? AND item_id=?').run(name, listeningId, itemId);
        if (source !== name) this.db.prepare('INSERT OR REPLACE INTO knowledge_corrections VALUES (?,?,?,?,?)').run(listeningId, norm(source), source, name, itemId);
        for (const job of this.db.prepare("SELECT * FROM extraction_jobs WHERE listening_id=? AND (state='failed' OR outcome='partial')").all(listeningId)) {
          if (!changedSegments.some(segment => segment.sequence_no >= job.from_sequence && segment.sequence_no <= job.to_sequence)) continue;
          this.db.prepare('DELETE FROM extraction_parts WHERE job_id=?').run(job.id);
          const progress = job.progress_json ? JSON.parse(job.progress_json) : {};
          this.db.prepare('UPDATE extraction_jobs SET progress_json=? WHERE id=?')
            .run(JSON.stringify({ ...progress, contract_revision: 'v2.1', extra_requests: 0, protocol_retries: 0 }), job.id);
        }
        this.db.prepare('UPDATE listenings SET updated_at=?,graph_revision=graph_revision+1 WHERE id=?').run(time, listeningId);
      }
      this.db.prepare("UPDATE knowledge_edit_jobs SET state='succeeded',updated_at=? WHERE id=?").run(time, jobId);
      return { item: this.knowledge(listeningId).find(item => item.id === itemId), job: this.knowledgeEditJob(listeningId, itemId, jobId), changed };
    });
  }
};
