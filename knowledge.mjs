import { readFileSync } from 'node:fs';

const promptDocument = readFileSync(new URL('./docs/knowledge-extraction-prompt.md', import.meta.url), 'utf8');
export const SYSTEM_PROMPT = promptDocument.match(/## System Message：固定提示词\s*```text\n([\s\S]*?)\n```/)?.[1];
if (!SYSTEM_PROMPT) throw new Error('知识抽取提示词缺失');

const isString = (value, max, allowEmpty = false) => typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);
const fail = message => { throw new Error(`知识结果无效：${message}`); };

export function parseKnowledge(raw, input) {
  if (typeof raw !== 'string' || raw.length > 30000) fail('响应过长');
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try { data = JSON.parse(cleaned); } catch { fail('不是 JSON'); }
  if (!data || !Array.isArray(data.items) || data.items.length > 12) fail('条目数量');
  const focus = new Map(input.focus_segments.map(s => [s.id, s.text]));
  const candidates = new Map(input.existing_candidates.map(c => [c.id, c]));
  return data.items.map(item => {
    if (!item || !['person','term','event','other'].includes(item.type) ||
      !isString(item.canonical_name, 120) || !isString(item.dialogue_summary, 500) ||
      !(item.background_note === null || isString(item.background_note, 500)) ||
      !['clear','needs_review'].includes(item.certainty) || !['create','link','correct'].includes(item.decision) ||
      !Array.isArray(item.aliases) || item.aliases.length > 12 || item.aliases.some(a => !isString(a, 120)) ||
      !Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 12) fail('字段');
    const sourceText = [...input.focus_segments, ...(input.context_segments || [])].map(s => s.text);
    const existingAliases = candidates.get(item.existing_item_id)?.aliases || [];
    if (item.aliases.some(alias => !sourceText.some(text => text.includes(alias)) && !existingAliases.includes(alias))) fail('别名缺少原文依据');
    if (item.decision === 'create' && item.existing_item_id !== null) fail('新条目 ID');
    if (item.decision !== 'create' && (!isString(item.existing_item_id, 100) || candidates.get(item.existing_item_id)?.type !== item.type)) fail('旧条目 ID');
    if (item.decision === 'correct' && !isString(item.correction_reason, 300)) fail('纠正原因');
    if (item.decision !== 'correct' && item.correction_reason !== null) fail('纠正原因');
    const evidence = item.evidence.map(e => {
      const text = focus.get(e?.segment_id);
      if (!text || !isString(e.quote, 300) || !text.includes(e.quote)) fail('原文证据');
      return { segment_id: e.segment_id, quote: e.quote, text };
    });
    return { type: item.type, canonical_name: item.canonical_name.trim(), aliases: item.aliases.map(a => a.trim()),
      dialogue_summary: item.dialogue_summary.trim(), background_note: item.background_note?.trim() || null,
      certainty: item.certainty, decision: item.decision, existing_item_id: item.existing_item_id,
      correction_reason: item.correction_reason, evidence };
  });
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

export async function extractKnowledge(key, input, endpoint) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen-doc-turbo', messages: [
      { role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(input) }
    ] }), signal: AbortSignal.timeout(30000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || result.message || `知识服务 HTTP ${response.status}`);
  return parseKnowledge(result.choices?.[0]?.message?.content, input);
}
