import { createHash } from 'node:crypto';
import { commonPrefix } from './public/caption-frontier.js';

// Conservative structural English canary, NOT a parser or semantic correctness guarantee.
// This policy is intentionally independent of subject/topic vocabulary. Unsupported dependencies,
// numeric claims, ambiguous reporting complements and entity expansions wait for final.
const risk = /\d|[^\x20-\x7e]|\b(?:not|no|never|n't|unless|except|without|only|if|because|although|but|which|who|that|when|while|where|whether|actually|sorry|correction|rather|either|neither|may|might)\b|["'()[\]{}:]/i;
const subject = '(?:the [a-z]+(?: [a-z]+){0,3}|a [a-z]+(?: [a-z]+){0,2}|an [a-z]+(?: [a-z]+){0,2}|we|they|it|he|she|I|[A-Z][A-Za-z]+)';
// Finite verbs constrain structural completeness, not the domain of the subject or object.
const action = '(?:released|launched|announced|introduced|published|completed|improved|expanded|increased|decreased|grew|fell|rose|won|joined|opened|closed|built|created|developed|delivered|supports|support|uses|use|offers|offer|provides|provide|includes|include|works|work|runs|run|helps|help)';
const structure = new RegExp('^(' + subject + ') (' + action + '|is|are|was|were|has|have) (.+)$');
const incompleteEnd = /\b(?:a|an|the|and|or|to|of|for|with|from|by|in|on|at|than|as|its|their|our|my|your|his|her|very|more|most)\s*$/i;
export function independentClause(plain) {
  if (plain.length < 8 || plain.length > 240 || risk.test(plain) || incompleteEnd.test(plain)) return false;
  const normalized = plain.replace(/^(The|A|An|We|They|It|He|She)\b/, word => word.toLowerCase());
  const match = normalized.match(structure);
  if (!match) return false;
  const predicate = match[3];
  // Mid-clause capitalized names, initials and title/name extensions are deliberately deferred.
  if (/\b(?!(?:AI|API|GPU|CPU|LLM)\b)[A-Z][A-Za-z]*\b/.test(predicate)) return false;
  if (/\b(?:said|says|thinks|believes|expects|plans|wants|seems|appears|become|becomes|going|able)\b/i.test(predicate)) return false;
  if (/^[A-Z]/.test(match[1]) && /^(?:is|are|was|were|has|have)$/.test(match[2])) return false;
  return true;
}
export function eligiblePhrase(text, agreed, start = 0, { allowClauses = true } = {}) {
  for (let i = start; i < agreed.length; i++) {
    if (!/[.!?,;]/.test(text[i])) continue;
    const phrase = text.slice(start, i + 1), plain = phrase.trim().replace(/[.!?,;]$/, '');
    const continuation = text.slice(i + 1).trimStart();
    if (!independentClause(plain)) continue;
    if (agreed.length - i < 12) continue; // Actual agreed lookahead, not elapsed wall time.
    // At weak boundaries require a second independently complete finite clause, not simply "and".
    if (/[,;]/.test(text[i])) {
      if (!allowClauses) continue;
      const following = continuation.replace(/^(?:and|then)\s+/i, '').split(/[,.!?;]/)[0];
      if (!/^(?:and|then)\s+/i.test(continuation) || !independentClause(following)) continue;
    }
    if (/^(?:but|except|unless|actually|sorry|rather|not|no)\b/i.test(continuation)) continue;
    return { start, end: i + 1, source: text.slice(start, i + 1) };
  }
  return null;
}
export function createIncrementalLedger({ epoch, runId, allowClauses = true, onCorrection = () => {} }) {
  const states = new Map(), finalizedIds = new Set();
  let serial = 0, closed = false;
  function state(id) {
    id = String(id);
    if (!states.has(id)) states.set(id, { id, text: '', previous: '', agreed: '', revision: 0, end: 0, covered: '', final: false });
    return states.get(id);
  }
  function conflict(s, text) {
    if (s.end && !text.startsWith(s.covered)) {
      closed = true; onCorrection({ sentenceId: s.id, reason: 'source-prefix-revised', coveredCharacters: s.end });
      return true;
    }
    return false;
  }
  return {
    observe(id, text) {
      if (closed || id == null || typeof text !== 'string' || finalizedIds.has(String(id))) return;
      const s = state(id);
      if (s.final || s.text === text) return;
      if (conflict(s, text)) return;
      s.revision++;
      s.agreed = s.text && text.length > s.text.length && text.startsWith(s.text) ? commonPrefix(s.text, text) : '';
      s.previous = s.text; s.text = text;
      // Only unspoken hypotheses can be evicted. Bounded failure is safer than dropping coverage.
      if (states.size > 32) {
        const disposable = [...states.values()].find(item => !item.end && item !== s);
        if (disposable) states.delete(disposable.id);
        else { closed = true; onCorrection({ reason: 'coverage-limit' }); }
      }
    },
    candidate() {
      if (closed) return null;
      for (const s of states.values()) {
        if (s.final) continue;
        const span = eligiblePhrase(s.text, s.agreed, s.end, { allowClauses });
        if (span) return Object.freeze({ ...span, epoch, runId, sentenceId: s.id, revision: s.revision,
          sequence: ++serial, hash: createHash('sha256').update(span.source).digest('hex'), preFinal: true });
        // A later ASR sentence cannot overtake this one's uncovered suffix.
        return null;
      }
      return null;
    },
    valid(unit) {
      if (unit?.epoch !== epoch || unit?.runId !== runId) return false;
      const s = states.get(unit.sentenceId);
      return !closed && s && !s.final && s.end === unit.start && s.text.slice(unit.start, unit.end) === unit.source;
    },
    commit(unit) {
      if (!this.valid(unit)) return false;
      const s = states.get(unit.sentenceId); s.end = unit.end; s.covered = s.text.slice(0, s.end);
      return true;
    },
    finalize(segment) {
      finalizedIds.add(String(segment.asr_sentence_id));
      if (finalizedIds.size > 4096) { closed = true; onCorrection({ reason: 'coverage-limit' }); return { conflict: true }; }
      const s = states.get(String(segment.asr_sentence_id));
      if (!s) return null;
      if (conflict(s, segment.original_text)) return { conflict: true };
      if (s.final && s.text !== segment.original_text) { closed = true; onCorrection({ sentenceId: s.id, reason: 'final-revised' }); return { conflict: true }; }
      s.final = true; s.text = segment.original_text;
      if (!s.end) return null;
      if (!s.finalUnit) {
        const suffix = segment.original_text.slice(s.end);
        const start = s.end + suffix.length - suffix.trimStart().length;
        const end = Math.max(start, segment.original_text.trimEnd().length);
        const source = segment.original_text.slice(start, end);
        s.finalUnit = Object.freeze({ start, end, source, epoch, runId, sentenceId: s.id, revision: s.revision,
          sequence: ++serial, hash: createHash('sha256').update(source).digest('hex'), preFinal: false });
      }
      return s.finalUnit;
    },
    complete(id) { states.delete(String(id)); },
    close() { closed = true; states.clear(); finalizedIds.clear(); }
  };
}
