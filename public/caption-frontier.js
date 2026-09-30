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
  let committed = '', previous = '', context = '', displayed = '', pending = false, revisionContext = null;
  return {
    reset() { committed = previous = context = displayed = ''; pending = false; revisionContext = null; },
    update(text, { sourceContext = text, final = false } = {}) {
      text = String(text ?? ''); sourceContext = String(sourceContext ?? '');
      if (final) {
        const corrected = pending || Boolean(committed && !text.startsWith(committed));
        committed = previous = displayed = text; context = sourceContext; pending = false; revisionContext = null;
        return { committed: text, tail: '', text, correctionPending: false, corrected };
      }
      let correctionPending = false;
      if (committed && !text.startsWith(committed)) {
        // One distinct-context confirmation protects a committed prefix from transient deep rewrites.
        // It is a display debounce, NOT permission to speak. Never hold through a second new context.
        if (revisionContext == null || sourceContext === revisionContext) {
          revisionContext = sourceContext;
          return { committed, tail: displayed.slice(committed.length), text: displayed, correctionPending: true, corrected: false };
        }
        // Rebase only the affected suffix, visibly, and let subsequent context continue immediately.
        committed = displayBoundary(commonPrefix(committed, text), 0);
        previous = ''; context = ''; pending = true; correctionPending = true;
      }
      revisionContext = null;
      {
        if (context && sourceContext.length > context.length && sourceContext.startsWith(context)) {
          const agreed = displayBoundary(commonPrefix(previous, text), mutableCharacters);
          if (agreed.startsWith(committed) && agreed.length > committed.length) committed = agreed;
        }
        displayed = text;
      }
      previous = text; context = sourceContext;
      return { committed, tail: displayed.slice(committed.length), text: displayed, correctionPending, corrected: false };
    }
  };
}
