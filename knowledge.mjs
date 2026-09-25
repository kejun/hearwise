import { readFileSync } from 'node:fs';

const promptDocument = readFileSync(new URL('./docs/knowledge-extraction-prompt.md', import.meta.url), 'utf8');
export const SYSTEM_PROMPT = promptDocument.match(/## System Message：固定提示词\s*```text\n([\s\S]*?)\n```/)?.[1];
if (!SYSTEM_PROMPT) throw new Error('知识抽取提示词缺失');

const fail = message => { throw new Error(`知识结果无效：${message}`); };
const clip = (value, max) => value.trim().slice(0, max);

// 模型转写引用时常"顺手美化"（弯引号、破折号、空白、大小写），
// 先精确匹配，再按变体宽松匹配，命中后取原文逐字子串，保证证据可追溯。
const QUOTE_VARIANTS = { '"': '[\u0022\u201C\u201D\u201E]', "'": "[\u0027\u2018\u2019\u201B]", '\u2014': '[\u2014\u2013-]', '\u2013': '[\u2014\u2013-]', '\u2026': '[\u2026.]' };
export function findVerbatim(text, quote) {
  if (typeof quote !== 'string') return null;
  const q = quote.trim();
  if (!q || q.length > 300) return null;
  if (text.includes(q)) return q;
  let pattern = '';
  for (const ch of q) {
    if (QUOTE_VARIANTS[ch]) pattern += QUOTE_VARIANTS[ch];
    else if (/\s/.test(ch)) { if (!pattern.endsWith('\\s+')) pattern += '\\s+'; }
    else pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try {
    const match = text.match(new RegExp(pattern)) || text.match(new RegExp(pattern, 'i'));
    return match ? match[0] : null;
  } catch { return null; }
}

// 单条独立校验与挽救：可修复的缺陷就地修复，修不了的丢弃该条并记录原因，不拖累同批其他条目。
function sanitizeItem(item, focus, candidates, sourceText) {
  if (!item || !['person','term','event','other'].includes(item.type) ||
    !['clear','needs_review'].includes(item.certainty) || !['create','link','correct'].includes(item.decision) ||
    typeof item.canonical_name !== 'string' || !item.canonical_name.trim() ||
    typeof item.dialogue_summary !== 'string' || !item.dialogue_summary.trim()) fail('字段');
  let decision = item.decision;
  let existingItemId = decision === 'create' ? null : item.existing_item_id;
  let correctionReason = decision === 'correct' ? item.correction_reason : null;
  const candidate = typeof existingItemId === 'string' ? candidates.get(existingItemId) : null;
  // link/correct 目标条目无效时退回 create；applyKnowledge 仍会按名称与别名做确定性去重
  if (decision !== 'create' && (!candidate || candidate.type !== item.type || existingItemId.length > 100)) {
    decision = 'create'; existingItemId = null; correctionReason = null;
  }
  // 纠正原因缺失或不合规时降级为 link，不整条丢弃
  if (decision === 'correct' && !(typeof correctionReason === 'string' && correctionReason.trim() && correctionReason.length <= 300)) {
    decision = 'link'; correctionReason = null;
  }
  const existingAliases = candidate?.aliases || [];
  const aliases = [];
  if (Array.isArray(item.aliases)) for (const alias of item.aliases.slice(0, 12)) {
    if (typeof alias !== 'string' || !alias.trim() || alias.length > 120) continue;
    const name = alias.trim();
    if (aliases.includes(name)) continue;
    // 无原文依据的别名直接丢弃，不再拒绝整条
    if (sourceText.some(text => findVerbatim(text, name)) || existingAliases.includes(name)) aliases.push(name);
  }
  const evidence = [];
  if (Array.isArray(item.evidence)) for (const entry of item.evidence.slice(0, 12)) {
    const text = focus.get(entry?.segment_id);
    const quote = text ? findVerbatim(text, entry?.quote) : null;
    if (quote) evidence.push({ segment_id: entry.segment_id, quote, text });
  }
  if (!evidence.length) fail('原文证据');
  return { type: item.type, canonical_name: clip(item.canonical_name, 120), aliases,
    dialogue_summary: clip(item.dialogue_summary, 500),
    background_note: typeof item.background_note === 'string' && item.background_note.trim() ? clip(item.background_note, 500) : null,
    certainty: item.certainty, decision, existing_item_id: existingItemId,
    correction_reason: typeof correctionReason === 'string' && correctionReason.trim() ? clip(correctionReason, 300) : null, evidence };
}

export function parseKnowledge(raw, input) {
  if (typeof raw !== 'string' || raw.length > 30000) fail('响应过长');
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try { data = JSON.parse(cleaned); } catch { fail('不是 JSON'); }
  if (!data || !Array.isArray(data.items) || data.items.length > 12) fail('条目数量');
  const focus = new Map(input.focus_segments.map(s => [s.id, s.text]));
  const candidates = new Map(input.existing_candidates.map(c => [c.id, c]));
  const sourceText = [...input.focus_segments, ...(input.context_segments || [])].map(s => s.text);
  const items = [], rejected = [];
  data.items.forEach((item, index) => {
    const label = String(typeof item?.canonical_name === 'string' && item.canonical_name.trim() ? item.canonical_name.trim() : `条目${index + 1}`).slice(0, 60);
    try { items.push(sanitizeItem(item, focus, candidates, sourceText)); }
    catch (error) { rejected.push({ index, name: label, reason: String(error?.message || error) }); }
  });
  return { items, rejected };
}

export function splitFocusSegments(input, maxChars = 2500) {
  const groups = [];
  let group = [], size = 0;
  for (const segment of input.focus_segments) {
    for (let offset = 0; offset < segment.text.length; offset += maxChars) {
      const piece = { id: segment.id, text: segment.text.slice(offset, offset + maxChars) };
      if (group.length && size + piece.text.length > maxChars) { groups.push(group); group = []; size = 0; }
      group.push(piece); size += piece.text.length;
    }
  }
  if (group.length) groups.push(group);
  return groups.map(focus_segments => ({ ...input, focus_segments }));
}

export const KNOWLEDGE_MODEL = 'qwen3.8-flash';

export async function extractKnowledge(key, input, endpoint) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: KNOWLEDGE_MODEL, enable_thinking: false, messages: [
      { role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(input) }
    ] }), signal: AbortSignal.timeout(30000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || result.message || `知识服务 HTTP ${response.status}`);
  return parseKnowledge(result.choices?.[0]?.message?.content, input);
}
