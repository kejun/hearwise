function speechText(text) {
  text = String(text || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
  if (!text) throw new Error('待播报文本为空');
  return text;
}
function sentencePeriod(text, i) {
  if (text[i] !== '.') return false;
  const word = text.slice(0, i).match(/[A-Za-z.]+$/)?.[0] || '';
  const abbreviation = /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)$/i.test(word) || /^[A-Z]$|^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word);
  return (!text[i + 1] || /\s/.test(text[i + 1])) && !abbreviation;
}

// Only persisted final text enters this function. Do not split on token arrival.
export function speechUnits(text) {
  text = speechText(text);
  const units = [];
  let start = 0;
  const stack = [];
  const pairs = { '“': '”', '‘': '’', '（': '）', '(': ')', '【': '】', '[': ']', '《': '》' };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (stack.at(-1) === c) stack.pop();
    const strong = /[。！？!?；;\n]/u.test(c) || sentencePeriod(text, i);
    const clause = /[，,：:]/u.test(c) && i - start >= 48 && !/\d/.test(text[i - 1] || '') && !/\d/.test(text[i + 1] || '');
    if (!stack.length && (strong || clause)) {
      const part = text.slice(start, i + 1).trim();
      if (part) units.push(part);
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) units.push(text.slice(start).trim());
  // Unpunctuated input cannot be safely truncated; surface the problem instead of losing words.
  if (units.some(unit => [...unit].length > 600)) throw new Error('这句文本过长，无法安全断句；播报已停止，完整文字仍保留');
  return units;
}

// Full records can contain long ASR paragraphs, missing punctuation or unmatched quotes.
// Use a conservative speech-length budget, not the provider's maximum input size.
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function transcriptSpeechUnits(input, { rate = 1 } = {}) {
  const text = speechText(input);
  if (!Number.isFinite(rate) || rate < .5 || rate > 2) throw new Error('播报语速无效');
  // At 1x: up to 180 ASCII characters or 60 Chinese characters. Slower voices get smaller units.
  const budget = Math.floor(180 * rate), units = [];
  const chars = Array.from(graphemes.segment(text));
  for (let start = 0; start < chars.length;) {
    let end = start, weight = 0, strong, clause, word;
    for (; end < chars.length; end++) {
      const { segment: c, index } = chars[end];
      // Digits may be read individually, so don't give long numbers the cheaper Latin budget.
      const cost = /^[\x00-\x7f]+$/.test(c) && !/\d/.test(c) ? c.length : [...c].length * 3;
      if (end > start && weight + cost > budget) break;
      weight += cost;
      const boundary = { end: end + 1, weight };
      if (/[\r\n]/.test(c)) { end++; break; } // Preserve paragraph breaks even in quotations.
      if (/[。！？!?；;]/u.test(c) || sentencePeriod(text, index)) strong = boundary;
      else if (/[，,：:]/u.test(c) && !/\d/.test(text[index - 1] || '') && !/\d/.test(text[index + c.length] || '')) clause = boundary;
      else if (/\s/u.test(c)) word = boundary;
      // Keep trailing punctuation and closing quotes with the preceding sentence/clause.
      if (/[”’」』）)】\]》]/u.test(c)) {
        if (strong?.end === end) strong = boundary;
        if (clause?.end === end) clause = boundary;
      }
    }
    const paragraphEnd = /[\r\n]/.test(chars[end - 1].segment);
    if (end < chars.length && !paragraphEnd) {
      end = strong?.weight >= budget / 2 ? strong.end : clause?.weight >= budget / 2 ? clause.end : word?.end || end;
    }
    // Slice original text rather than rejoining tokens: no missing or duplicated words, no added punctuation.
    const part = text.slice(chars[start].index, chars[end]?.index ?? text.length);
    if (part.trim()) units.push(part);
    start = end;
  }
  return units;
}
