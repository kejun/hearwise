// Independent UTF-16 interval and sampled matching contract. No production imports.
export const seed = 0x4b454a70;
export const samples = 256;
export const units = text => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
export const fromUnits = values => values.map(value => String.fromCharCode(value)).join('');
const protectedPoint = value => Boolean(value) && (/^\p{Script=Latin}$/u.test(value) || value === '_' || /^[0-9]$/.test(value));
// ECMAScript /iu uses simple folding, not normalization or multi-character
// expansion. This independent scanner covers the finite alphabet below; it is
// deliberately not claimed to implement/prove the whole Unicode folding table.
const folds = new Map([...Array.from({ length: 26 }, (_, i) => [String.fromCharCode(65 + i), String.fromCharCode(97 + i)]),
  ['É', 'é'], ['Ä', 'ä'], ['K', 'k'], ['ſ', 's'], ['ẞ', 'ß']]);
const fold = value => folds.get(value) ?? value;
export function referenceMatches(text, source) {
  if (!source) return [];
  const points = [...text], term = [...source], positions = [0], matches = [];
  for (const point of points) positions.push(positions.at(-1) + point.length);
  for (let index = 0; index + term.length <= points.length;) {
    const equal = term.every((point, offset) => fold(point) === fold(points[index + offset]));
    const left = !protectedPoint(term[0]) || !protectedPoint(points[index - 1]);
    const right = !protectedPoint(term.at(-1)) || !protectedPoint(points[index + term.length]);
    if (equal && left && right) {
      matches.push({ start: positions[index], end: positions[index + term.length] });
      index += term.length;
    } else index++;
  }
  return matches;
}
export function referenceText(text, matches, target) {
  // Reverse splicing differs from the production forward pieces accumulator.
  let result = text;
  for (const { start, end } of [...matches].reverse()) result = result.slice(0, start) + target + result.slice(end);
  return result;
}
export function transport({ text, matches, target, anchors, source, nameOverride = null }) {
  if (typeof text !== 'string' || typeof target !== 'string' || !target.length || !Array.isArray(matches) || !Array.isArray(anchors))
    throw new TypeError('Outside Lean domain: UTF-16 strings, nonempty target and interval arrays required');
  let previous = 0;
  for (const { start, end } of matches) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previous || start >= end || end > text.length)
      throw new TypeError('Outside Lean domain: matches must be ordered, positive and nonoverlapping');
    previous = end;
  }
  for (const { start, end } of anchors) if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > text.length)
    throw new TypeError('Outside Lean domain: anchors must be legal nonempty old intervals');
  return { enabled: source === undefined || source !== target || Boolean(nameOverride), text: units(text), matches: matches.map(({ start, end }) => ({ start, end })), target: units(target),
    anchors: anchors.map(({ start, end }) => ({ start, end })) };
}
function anchorsFor(text, matches, random) {
  const anchors = new Map();
  const add = (start, end) => { if (0 <= start && start < end && end <= text.length) anchors.set(`${start}:${end}`, { start, end }); };
  if (!random && text.length <= 24) {
    for (let start = 0; start < text.length; start++) for (let end = start + 1; end <= text.length; end++) add(start, end);
  } else {
    add(0, text.length); add(0, 1); add(text.length - 1, text.length);
    for (const { start, end } of matches) {
      add(start, end); add(start + 1, end); add(start, end - 1); add(start - 1, start); add(end, end + 1);
      add(0, start); add(end, text.length); add(start - 1, end + 1);
    }
    if (random) for (let i = 0; i < 16 && text.length; i++) { const start = random(text.length); add(start, start + 1 + random(text.length - start)); }
  }
  return [...anchors.values()];
}
export function corpus() {
  const cases = [];
  const add = (id, group, text, source, target, options = {}) => {
    const matches = referenceMatches(text, source);
    cases.push({ id, group, text, source, target, nameOverride: options.nameOverride ?? null, matches, anchors: anchorsFor(text, matches, options.random),
      sqlite: options.sqlite ?? Boolean(source.trim() && text && text.isWellFormed() && source.isWellFormed() && target.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(source)) });
  };
  add('latin-long', 'latin', 'Deebo met DEEBO.', 'Deebo', 'Tibo Longname');
  add('latin-short', 'latin', 'Professor Deebo sees Deebo.', 'Deebo', 'T');
  add('whole-term-boundaries', 'boundary', 'Deebo Deeboverse xDeebo Deebo2 _Deebo Deebo_ DEEBO.', 'Deebo', 'Tibo');
  add('non-latin-neighbors', 'boundary', '中Deebo文 αDeeboβ', 'Deebo', 'T');
  add('digit-underscore-boundaries', 'boundary', '_A1 _A1x x_A1 _a1.', '_A1', 'N');
  add('cjk-adjacent', 'cjk', '张三张三说张三。', '张三', '李四五');
  add('cjk-no-spaces', 'cjk', '甲张三乙张三丙', '张三', '张');
  add('emoji-source', 'emoji', '😀😀和😀。', '😀', '🧑‍🔬');
  add('emoji-target', 'emoji', 'Deebo Camera Deebo.', 'Deebo', '😀X');
  add('emoji-prefix', 'emoji', '😀 Deebo Camera.', 'Deebo', 'T');
  add('zwj-source', 'emoji', '🧑‍🔬与🧑‍🔬', '🧑‍🔬', '人');
  add('combining-exact', 'combining', 'e\u0301 e\u0301 e\u0301x', 'e\u0301', 'é');
  add('no-normalization', 'combining', 'Café Cafe\u0301 CAFÉ', 'Café', 'Tea');
  add('combining-boundary', 'combining', 'e\u0301 e e\u0301', 'e', 'X');
  add('literal-space', 'whitespace', 'New York New  York NEW YORK', 'New York', 'NY');
  add('target-internal-space', 'whitespace', 'Deebo Deebo', 'Deebo', 'New  Name');
  add('unicode-whitespace', 'whitespace', '\tDeebo\nDeebo\u00a0Deebo\u3000', 'Deebo', 'Tibo');
  add('literal-tab', 'whitespace', 'A\tB A B A\tB', 'A\tB', 'X', { sqlite: false });
  add('regex-metacharacters', 'literal', 'A+B (v2) A+B (v2)x', 'A+B (v2)', 'Name');
  add('dollar-replacement-literal', 'literal', 'Deebo Deebo', 'Deebo', '$&-$1-$$');
  add('left-boundary-only', 'boundary', 'A+A+ xA+ A+x', 'A+', 'X');
  add('right-boundary-only', 'boundary', '+A+A x+A +Ax', '+A', 'X');
  add('adjacent-punctuation', 'adjacent', '----', '-', '++');
  add('nonoverlap-greedy', 'adjacent', '哈哈哈', '哈哈', '笑');
  add('entire-source', 'boundary', 'Deebo', 'Deebo', 'T');
  add('no-match', 'boundary', 'No matching names.', 'Deebo', 'T');
  add('empty-source', 'boundary', 'Deebo', '', 'T', { sqlite: false });
  add('empty-text', 'boundary', '', 'Deebo', 'T', { sqlite: false });
  add('simple-unicode-case-fold', 'case-fold', 'K k K S s ſ É é', 'K', 'Z');
  add('long-s-case-fold', 'case-fold', 'S s ſ', 'S', 'Z');
  add('no-multichar-case-fold', 'case-fold', 'ß ẞ SS ss', 'ß', 'Z');
  add('no-dotted-i-expansion', 'case-fold', 'İ i I i\u0307', 'İ', 'Z');
  add('unpaired-surrogate', 'utf16-only', '\ud800 Deebo \udfff', 'Deebo', 'T', { sqlite: false });
  add('unpaired-source-not-pair', 'utf16-only', '\ud83d 😀 \ud83d', '\ud83d', 'X', { sqlite: false });
  add('unpaired-target', 'utf16-only', 'Deebo', 'Deebo', '\udfff', { sqlite: false });
  add('nul-text', 'utf16-only', '\u0000Deebo\u0000Deebo', 'Deebo', 'T', { sqlite: false });
  add('noop-identical', 'no-op', 'Deebo Camera.', 'Deebo', 'Deebo');
  add('noop-segment-casefold', 'no-op', 'DEEBO Camera.', 'Deebo', 'DEEBO');
  add('noop-global-casefold', 'no-op', 'DEEBO Camera.', 'Deebo', 'Deebo');
  add('override-enables-casefold', 'no-op', 'DEEBO Camera.', 'Deebo', 'Deebo', { nameOverride: 'Old override' });
  let state = seed;
  const random = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
  const sources = ['Deebo', 'Café', '张三', '😀', 'e\u0301', 'New York', 'A+B', '_A1', 'K', '-', '哈哈'];
  const targets = ['T', 'Tibo Longname', '李四五', '😀X', 'e\u0301', 'New  Name', '$&-$1', '🧑‍🔬'];
  const separators = [' ', '。', '\n', '😀', '中', '_', 'x', '2', '\u0301', ''];
  for (let i = 0; i < samples; i++) {
    const source = sources[random(sources.length)], target = targets[random(targets.length)];
    let text = separators[random(separators.length)];
    for (let repeat = 0, count = 1 + random(5); repeat < count; repeat++) {
      const variant = source === 'Deebo' && random(2) ? 'DEEBO' : source === 'Café' && random(2) ? 'CAFÉ' : source;
      text += variant + separators[random(separators.length)];
    }
    text += ' Camera';
    add(`seeded-${i}`, 'seeded', text, source, target, { random, sqlite: i < 48 });
  }
  return { cases };
}
