import { createHash, randomUUID } from 'node:crypto';
import { findIdentitySpans } from './identity-grounding.mjs';

export const NAME_CORRECTION_MODEL = 'qwen3.8-flash';
export const NAME_CORRECTION_OPERATION = 'name_correction';
export const NAME_CORRECTION_PROMPT_VERSION = 1;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm = value => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const fail = (status, message) => { throw Object.assign(new Error(message), { status, knowledgeEdit: true }); };
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['revision', 'key'].includes(key)) ||
      typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) ||
      input.key !== undefined && typeof input.key !== 'string') fail(400, '名称校正请求格式无效');
}
export const nameCorrectionFingerprint = input => hash([NAME_CORRECTION_OPERATION, input?.revision]);
export const nameIdentity = item => hash([item.canonical_name, item.type, item.display_label ?? null]);
export const knowledgeDisplayName = item => item.name_override && item.name_override_identity === nameIdentity(item)
  ? item.name_override : item.canonical_name;

export function migrateKnowledgeNames(store) {
  const columns = {
    knowledge_items: { name_override: 'TEXT', name_override_identity: 'TEXT' },
    knowledge_edit_jobs: { operation: "TEXT NOT NULL DEFAULT 'manual_regenerate' CHECK(operation IN ('manual_regenerate','name_correction'))",
      context_hash: 'TEXT', applied_context_hash: 'TEXT', result_json: 'TEXT',
      request_reserved: 'INTEGER NOT NULL DEFAULT 0 CHECK(request_reserved IN (0,1))' }
  };
  for (const [table, additions] of Object.entries(columns)) {
    const existing = new Set(store.db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
    for (const [name, type] of Object.entries(additions)) if (!existing.has(name))
      store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  store.db.exec(`CREATE INDEX IF NOT EXISTS name_correction_context ON knowledge_edit_jobs(listening_id,item_id,context_hash)
      WHERE operation='name_correction';
    CREATE INDEX IF NOT EXISTS name_correction_applied ON knowledge_edit_jobs(listening_id,item_id,applied_context_hash)
      WHERE operation='name_correction';
    PRAGMA user_version=12;`);
}

export function publicNameCorrectionJob(row) {
  if (!row) return undefined;
  const result = row.result_json ? JSON.parse(row.result_json) : null;
  return { id: row.id, operation: row.operation, state: row.state, name: row.name, source: row.source,
    revision: row.revision, saved: row.state === 'running' ? null : row.state === 'succeeded' && result?.changed === true,
    changed: result?.changed === true, result, error: row.error };
}

// Whole paragraphs are retained. The final JSON payload (not just the prose)
// has a bounded size; evidence and context cannot silently change roles.
function correctionContext(store, snapshot) {
  const { item } = snapshot;
  const input = { operation: NAME_CORRECTION_OPERATION, item_id: item.id,
    name: knowledgeDisplayName(item), original_name: item.canonical_name,
    type: item.type, display_label: item.display_label, aliases: item.aliases.slice(0, 8), segments: [] };
  // Very large legacy names/aliases must not bypass the text budget.
  if (JSON.stringify(input).length > 8000) input.aliases = [];
  if (JSON.stringify(input).length > 8000) fail(400, '条目名称信息过长，请先通过人工编辑核对');
  const add = (segment, linked) => {
    if (input.segments.some(row => row.id === segment.id)) return false;
    const row = { id: segment.id, linked, original: segment.original_text,
      translation: segment.translation_state === 'complete' ? segment.translation_text || '' : '' };
    if (JSON.stringify({ ...input, segments: [...input.segments, row] }).length > 8000) return false;
    input.segments.push(row); return true;
  };
  const linked = [];
  for (const segment of snapshot.segments) {
    if (linked.length === 6) break;
    if (add(segment, true)) linked.push(segment);
  }
  for (const segment of linked) {
    for (const direction of ['<', '>']) {
      const neighbor = store.db.prepare(`SELECT * FROM segments WHERE listening_id=? AND run_id=? AND sequence_no${direction}?
        ORDER BY sequence_no ${direction === '<' ? 'DESC' : 'ASC'} LIMIT 1`)
        .get(item.listening_id, segment.run_id, segment.sequence_no);
      if (neighbor) add(neighbor, snapshot.segments.some(row => row.id === neighbor.id));
    }
  }
  return { ...snapshot, input, contextHash: hash([NAME_CORRECTION_OPERATION, NAME_CORRECTION_PROMPT_VERSION,
    NAME_CORRECTION_MODEL, false, snapshot.revision, input]) };
}

export function validateNameCorrectionResult(result, input) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).some(key => !['outcome', 'name', 'reason', 'evidence'].includes(key)) ||
      !['corrected', 'unchanged', 'insufficient_evidence'].includes(result.outcome) ||
      typeof result.name !== 'string' || !result.name.trim() || result.name.trim().length > 160 ||
      /[\u0000-\u001f\u007f]/.test(result.name) || typeof result.reason !== 'string' ||
      !result.reason.trim() || result.reason.length > 500 || !Array.isArray(result.evidence) || result.evidence.length > 6) {
    fail(502, '名称校正结果格式无效，原名称未更改');
  }
  const name = result.name.trim(), reason = result.reason.trim();
  const evidence = result.evidence.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
        Object.keys(ref).some(key => !['segment_id', 'source_kind', 'quote'].includes(key)) ||
        !['original', 'translation'].includes(ref.source_kind) || typeof ref.quote !== 'string' ||
        !ref.quote.trim() || ref.quote.length > 3000) fail(502, '名称校正引用格式无效，原名称未更改');
    const segment = input.segments.find(row => row.id === ref.segment_id);
    if (!segment || !segment[ref.source_kind]?.includes(ref.quote)) fail(502, '名称校正引用未通过校验，原名称未更改');
    return { segment_id: segment.id, source_kind: ref.source_kind, quote: ref.quote };
  });
  if (result.outcome !== 'corrected' && name !== input.name) fail(502, '名称校正结论与名称不一致，原名称未更改');
  if (result.outcome === 'corrected') {
    // An unrelated neighboring entity or a name guessed only from model memory
    // is insufficient. The new spelling must occur in a target-linked quote.
    const grounded = evidence.some(ref => input.segments.find(row => row.id === ref.segment_id)?.linked &&
      findIdentitySpans(ref.quote, name).some(span => span.quote === name));
    if (!grounded) return { outcome: 'insufficient_evidence', name: input.name,
      reason: '关联原文或译文中没有可核对的新名称，已保留原名。', evidence: [] };
    if (name === input.name) return { outcome: 'unchanged', name, reason, evidence };
  }
  return { outcome: result.outcome, name, reason, evidence };
}

function finishCorrection(store, listeningId, itemId, jobId, prepared, generated, cacheHit = false) {
  const current = correctionContext(store, store.knowledgeEditSnapshot(listeningId, itemId));
  if (current.contextHash !== prepared.contextHash) fail(409, '条目或关联原文已改变，请重新打开核对');
  const result = validateNameCorrectionResult(generated, current.input);
  const changed = result.outcome === 'corrected' && result.name !== current.input.name;
  if (changed && store.knowledge(listeningId).some(item => item.id !== itemId &&
      [item.canonical_name, knowledgeDisplayName(item), ...item.aliases].some(name => norm(name) === norm(result.name)))) {
    fail(409, '已存在同名条目，原名称未更改；请使用人工编辑确认');
  }
  const time = new Date().toISOString();
  if (changed) {
    store.db.prepare(`UPDATE knowledge_items SET name_override=?,name_override_identity=?,
      content_version=content_version+1,updated_at=? WHERE id=? AND listening_id=?`)
      .run(result.name, nameIdentity(current.item), time, itemId, listeningId);
    store.db.prepare('INSERT INTO knowledge_revisions VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), itemId, NAME_CORRECTION_OPERATION, current.input.name, result.name, null, result.reason, time);
    store.db.prepare('UPDATE listenings SET updated_at=? WHERE id=?').run(time, listeningId);
  }
  const applied = correctionContext(store, store.knowledgeEditSnapshot(listeningId, itemId));
  const output = { ...result, previous_name: current.input.name, changed, cache_hit: cacheHit };
  if (store.db.prepare(`UPDATE knowledge_edit_jobs SET state='succeeded',result_json=?,applied_context_hash=?,updated_at=?
    WHERE id=? AND listening_id=? AND item_id=? AND operation='name_correction' AND state='running'`)
    .run(JSON.stringify(output), applied.contextHash, time, jobId, listeningId, itemId).changes !== 1) {
    fail(409, '校正任务状态已改变，请重新打开核对');
  }
  return store.knowledgeEditJob(listeningId, itemId, jobId);
}

export const knowledgeNameMethods = {
  prepareNameCorrection(listeningId, itemId, input) {
    validateInput(input);
    const snapshot = this.knowledgeEditSnapshot(listeningId, itemId);
    if (snapshot.revision !== input.revision) fail(409, '条目或原文已改变，请重新打开核对');
    if (!knowledgeDisplayName(snapshot.item)?.trim() || knowledgeDisplayName(snapshot.item).length > 160)
      fail(400, '名称须为 1–160 个字符，请先通过人工编辑核对');
    return correctionContext(this, snapshot);
  },
  nameCorrectionForRevision(listeningId, itemId, revision) {
    return publicNameCorrectionJob(this.db.prepare(`SELECT * FROM knowledge_edit_jobs
      WHERE listening_id=? AND item_id=? AND operation='name_correction' AND revision=? ORDER BY rowid DESC LIMIT 1`)
      .get(listeningId, itemId, revision));
  },
  nameCorrectionForSnapshot(listeningId, itemId, snapshot) {
    const prepared = correctionContext(this, snapshot);
    return publicNameCorrectionJob(this.db.prepare(`SELECT * FROM knowledge_edit_jobs WHERE listening_id=? AND item_id=?
      AND operation='name_correction' AND (state='running' OR state='failed' AND revision=? OR
        state='succeeded' AND (context_hash=? OR applied_context_hash=?)) ORDER BY rowid DESC LIMIT 1`)
      .get(listeningId, itemId, snapshot.revision, prepared.contextHash, prepared.contextHash));
  },
  acceptNameCorrection(listeningId, itemId, jobId, input, { hasKey = false, busy = false } = {}) {
    validateInput(input);
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM knowledge_edit_jobs WHERE id=?').get(jobId);
      if (existing) {
        if (existing.listening_id !== listeningId || existing.item_id !== itemId || existing.operation !== NAME_CORRECTION_OPERATION ||
            existing.fingerprint !== nameCorrectionFingerprint(input)) fail(409, '同一校正任务不能提交不同的输入');
        return { job: publicNameCorrectionJob(existing) };
      }
      const prepared = this.prepareNameCorrection(listeningId, itemId, input);
      const running = this.db.prepare("SELECT * FROM knowledge_edit_jobs WHERE listening_id=? AND state='running'").get(listeningId);
      if (running?.operation === NAME_CORRECTION_OPERATION && running.item_id === itemId && running.context_hash === prepared.contextHash) {
        return { job: publicNameCorrectionJob(running) };
      }
      if (busy || running) fail(409, '正在保存知识修改，请稍后再试');
      const cached = this.db.prepare(`SELECT * FROM knowledge_edit_jobs WHERE listening_id=? AND item_id=?
        AND operation='name_correction' AND state='succeeded' AND (context_hash=? OR applied_context_hash=?)
        ORDER BY rowid DESC LIMIT 1`).get(listeningId, itemId, prepared.contextHash, prepared.contextHash);
      let local;
      if (cached) {
        const previous = JSON.parse(cached.result_json);
        // After applying a cached correction the old input no longer describes
        // the visible name. Reuse the receipt as an unchanged check.
        local = previous.name === prepared.input.name ? { outcome: previous.outcome === 'corrected' ? 'unchanged' : previous.outcome,
          name: prepared.input.name, reason: '已检查，复用此前的校正结果。', evidence: previous.evidence } :
          { outcome: previous.outcome, name: previous.name, reason: previous.reason, evidence: previous.evidence };
      } else if (!prepared.input.segments.some(row => row.linked)) {
        local = { outcome: 'insufficient_evidence', name: prepared.input.name, reason: '缺少可用的关联原文或译文，已保留原名。', evidence: [] };
      } else if (this.db.prepare('SELECT 1 FROM knowledge_corrections WHERE listening_id=? AND item_id=? AND target=?')
        .get(listeningId, itemId, prepared.input.name)) {
        local = { outcome: 'unchanged', name: prepared.input.name, reason: '当前名称已经人工校正。', evidence: [] };
      }
      if (!local && !hasKey) fail(400, '请先在连接设置填写 API Key');
      const time = new Date().toISOString();
      this.db.prepare(`INSERT INTO knowledge_edit_jobs
        (id,listening_id,item_id,fingerprint,revision,name,source,state,created_at,updated_at,operation,context_hash)
        VALUES (?,?,?,?,?,?,?,'running',?,?,?,?)`)
        .run(jobId, listeningId, itemId, nameCorrectionFingerprint(input), input.revision, prepared.input.name,
          prepared.item.canonical_name, time, time, NAME_CORRECTION_OPERATION, prepared.contextHash);
      if (local) return { job: finishCorrection(this, listeningId, itemId, jobId, prepared, local, Boolean(cached)), created: true };
      return { job: this.knowledgeEditJob(listeningId, itemId, jobId), prepared };
    });
  },
  reserveNameCorrection(jobId) {
    return this.db.prepare(`UPDATE knowledge_edit_jobs SET request_reserved=1
      WHERE id=? AND operation='name_correction' AND state='running' AND request_reserved=0`).run(jobId).changes === 1;
  },
  saveNameCorrection(listeningId, itemId, jobId, prepared, result) {
    return this.tx(() => finishCorrection(this, listeningId, itemId, jobId, prepared, result));
  }
};
