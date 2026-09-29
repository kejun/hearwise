// Only persisted final text enters this function. Do not split on token arrival.
export function speechUnits(text) {
  text = String(text || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
  if (!text) throw new Error('待播报文本为空');
  const units = [];
  let start = 0;
  const stack = [];
  const pairs = { '“': '”', '‘': '’', '（': '）', '(': ')', '【': '】', '[': ']', '《': '》' };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (stack.at(-1) === c) stack.pop();
    const word = c === '.' ? text.slice(0, i).match(/[A-Za-z.]+$/)?.[0] || '' : '';
    const abbreviation = /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)$/i.test(word) || /^[A-Z]$|^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word);
    const period = c === '.' && (!text[i + 1] || /\s/.test(text[i + 1])) && !abbreviation;
    const strong = /[。！？!?；;\n]/u.test(c) || period;
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
