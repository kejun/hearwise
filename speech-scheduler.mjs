// Only immutable final translations enter this function. Do not split on token arrival.
export function speechUnits(text) {
  text = String(text || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
  if (!text) throw new Error('最终译文为空');
  const units = [];
  let start = 0;
  const stack = [];
  const pairs = { '“': '”', '‘': '’', '（': '）', '(': ')', '【': '】', '[': ']', '《': '》' };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (stack.at(-1) === c) stack.pop();
    const strong = /[。！？!?；;\n]/u.test(c) || (c === '.' && !/[\dA-Za-z]/.test(text[i - 1] || '') && !/\d/.test(text[i + 1] || ''));
    const clause = /[，,：:]/u.test(c) && i - start >= 48 && !/\d/.test(text[i - 1] || '') && !/\d/.test(text[i + 1] || '');
    if (!stack.length && (strong || clause)) {
      const part = text.slice(start, i + 1).trim();
      if (part) units.push(part);
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) units.push(text.slice(start).trim());
  // Unpunctuated input cannot be safely truncated; surface the problem instead of losing words.
  if (units.some(unit => [...unit].length > 600)) throw new Error('这句译文过长，无法安全断句；请跳到最新内容');
  return units;
}
