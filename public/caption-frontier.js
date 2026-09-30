// Display stability only. Agreement is evidence of survival, never a confidence score.
// Different, growing source context is required; duplicate responses are not evidence.
export function commonPrefix(a, b) {
  const aa = Array.from(a), bb = Array.from(b);
  let i = 0;
  while (i < aa.length && aa[i] === bb[i]) i++;
  return aa.slice(0, i).join('');
}
function displayBoundary(text, retain) {
  const chars = Array.from(text);
  const candidate = chars.slice(0, Math.max(0, chars.length - retain)).join('');
  // Never freeze part of a Latin word; CJK characters are independent display boundaries.
  return candidate.replace(/[\p{Script=Latin}\d'’-]+$/u, '');
}
export function createCaptionFrontier({ mutableCharacters = 12 } = {}) {
  let committed = '', previous = '', context = '', displayed = '', pending = false;
  return {
    reset() { committed = previous = context = displayed = ''; pending = false; },
    update(text, { sourceContext = text, final = false } = {}) {
      text = String(text ?? ''); sourceContext = String(sourceContext ?? '');
      if (final) {
        const corrected = pending || Boolean(committed && !text.startsWith(committed));
        committed = previous = displayed = text; context = sourceContext; pending = false;
        return { committed: text, tail: '', text, correctionPending: false, corrected };
      }
      if (committed && !text.startsWith(committed)) pending = true;
      if (!pending) {
        if (context && sourceContext.length > context.length && sourceContext.startsWith(context)) {
          const agreed = displayBoundary(commonPrefix(previous, text), mutableCharacters);
          if (agreed.startsWith(committed) && agreed.length > committed.length) committed = agreed;
        }
        displayed = text;
      }
      previous = text; context = sourceContext;
      return { committed, tail: displayed.slice(committed.length), text: displayed, correctionPending: pending, corrected: false };
    }
  };
}
