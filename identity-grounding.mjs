// Identity equivalence is used only to locate an already-approved name. The
// evidence returned to callers is always an untouched slice of the source.
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const variants = value => value.replace(/[“”„]/gu, '"').replace(/[‘’‛]/gu, "'").replace(/[–—]/gu, '-');
const normalizePart = value => variants(value.normalize('NFKC').toLowerCase()).replace(/ς/gu, 'σ');

function normalizedSource(value) {
  let text = '';
  const positions = [];
  for (const part of graphemes.segment(value)) {
    const start = part.index, end = start + part.segment.length;
    for (const char of normalizePart(part.segment)) {
      if (/\s/u.test(char)) {
        if (text.endsWith(' ')) positions[positions.length - 1].end = end;
        else { text += ' '; positions.push({ start, end }); }
      } else {
        text += char;
        for (let i = 0; i < char.length; i++) positions.push({ start, end });
      }
    }
  }
  return { text, positions };
}

export function normalizeIdentity(value) {
  return typeof value === 'string' ? normalizedSource(value).text.trim() : '';
}

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const word = /[\p{L}\p{N}\p{M}_]/u;
const joinsWord = (left, right) => Boolean(left && right && word.test(left) && word.test(right) && !cjk.test(left) && !cjk.test(right));

export function findIdentitySpans(text, name) {
  if (typeof text !== 'string' || !text || typeof name !== 'string') return [];
  const needle = normalizeIdentity(name);
  if (!needle) return [];
  const normalized = normalizedSource(text), found = [], seen = new Set();
  let offset = 0;
  while (offset <= normalized.text.length - needle.length) {
    const start = normalized.text.indexOf(needle, offset);
    if (start < 0) break;
    const end = start + needle.length;
    offset = start + 1;
    const first = normalized.positions[start], last = normalized.positions[end - 1];
    // NFKC and case conversion can expand one source grapheme. A substring of
    // that expansion is not an independently observed identity (e.g. f in ﬃ).
    if ((start && normalized.positions[start - 1].start === first.start) ||
      (end < normalized.positions.length && normalized.positions[end].end === last.end)) continue;
    const before = Array.from(normalized.text.slice(0, start)).at(-1) || '';
    const after = Array.from(normalized.text.slice(end))[0] || '';
    if (joinsWord(before, Array.from(needle)[0]) || joinsWord(Array.from(needle).at(-1), after)) continue;
    const key = `${first.start}:${last.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ start: first.start, end: last.end, quote: text.slice(first.start, last.end) });
  }
  return found;
}
