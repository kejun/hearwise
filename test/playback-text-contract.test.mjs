import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechUnits, transcriptSpeechUnits } from '../speech-scheduler.mjs';
import { createIncrementalLedger } from '../incremental-speech.mjs';
import { speechIntervalLedger } from '../test-support/playback-text-contract.mjs';

const normalizedCases = [
  { input: '  **甲**。\n\n`乙`！  ', normalized: '甲。\n\n乙！' },
  { input: '**A**\n\n`B`', normalized: 'A\n\nB' },
  { input: 'a' + ' '.repeat(400) + 'b', normalized: 'a' + ' '.repeat(400) + 'b' },
  { input: ' \t**bold** and `code`, **unfinished and `unclosed。\r\n尾段\u00a0', normalized: 'bold and code, **unfinished and `unclosed。\r\n尾段' },
  { input: 'Dr. Smith works in the U.S. today. It costs 3.14 dollars. Tail', normalized: 'Dr. Smith works in the U.S. today. It costs 3.14 dollars. Tail' },
  { input: '👨‍👩‍👧‍👦e\u0301𠮷。第二句', normalized: '👨‍👩‍👧‍👦e\u0301𠮷。第二句' }
];

test('accepted speech intervals retain all lexical content and explicitly account for permitted whitespace normalization', () => {
  for (const { input, normalized } of normalizedCases) {
    for (const units of [speechUnits(input), transcriptSpeechUnits(input)]) {
      const ledger = speechIntervalLedger(normalized, units);
      assert.ok(ledger.accepted.length); assert.ok(ledger.omitted.every(span => /^\s+$/u.test(span.text)));
    }
  }
  assert.equal(transcriptSpeechUnits(normalizedCases[1].input).join(''), 'A\nB');
  assert.ok(speechIntervalLedger(normalizedCases[2].normalized, transcriptSpeechUnits(normalizedCases[2].input)).omitted.length > 0);
  for (const input of ['', ' \t\r\n\u00a0 ']) {
    assert.throws(() => speechUnits(input), /为空/); assert.throws(() => transcriptSpeechUnits(input), /为空/);
  }
});

test('Unicode, long input, final tails and rate boundaries preserve exact accepted spans without claiming raw-byte losslessness', () => {
  const cluster = '👨‍👩‍👧‍👦e\u0301𠮷';
  for (const text of ['字'.repeat(5000), 'word '.repeat(700).trim(), '“' + '长引号。'.repeat(150) + '”',
    '(' + '没有右括号'.repeat(200), cluster.repeat(100), '1234567890'.repeat(120), 'a' + '\u0301'.repeat(300), '末']) {
    for (const rate of [.5, 1, 1.1, 1.2, 2]) speechIntervalLedger(text, transcriptSpeechUnits(text, { rate }), { graphemeSafe: true });
  }
  assert.deepEqual(speechUnits('字'.repeat(600)), ['字'.repeat(600)]);
  assert.throws(() => speechUnits('字'.repeat(601)), /过长/);
  for (const rate of [0, .49, 2.01, NaN, Infinity]) assert.throws(() => transcriptSpeechUnits('text', { rate }), /语速无效/);
  // A single huge grapheme intentionally takes precedence over the soft budget.
  const giant = 'a' + '\u0301'.repeat(300); assert.deepEqual(transcriptSpeechUnits(giant, { rate: .5 }), [giant]);
});

test('interval oracle kills lexical omission, duplication, reorder and internal separator deletion mutants', () => {
  const source = 'alpha beta.\n\nTail!';
  assert.doesNotThrow(() => speechIntervalLedger(source, ['alpha beta.', 'Tail!']));
  for (const bad of [['alpha beta.'], ['alpha beta.', 'alpha beta.', 'Tail!'], ['Tail!', 'alpha beta.'], ['alphabeta.', 'Tail!']])
    assert.throws(() => speechIntervalLedger(source, bad));
});

test('incremental accepted source spans reject duplicates, final-before-commit and covered-prefix rewrites', () => {
  const first = 'The company released a product. The team improved the service.';
  const extended = first + ' More words follow.';
  const make = () => { const corrections = [], ledger = createIncrementalLedger({ epoch: 7, runId: 'run', onCorrection: value => corrections.push(value) });
    ledger.observe('sentence', first); ledger.observe('sentence', extended); return { ledger, corrections }; };
  const a = make(), candidate = a.ledger.candidate(); assert.ok(candidate);
  assert.equal(a.ledger.commit({ ...candidate, epoch: 8 }), false);
  assert.equal(a.ledger.commit({ ...candidate, runId: 'other' }), false);
  assert.equal(a.ledger.commit(candidate), true); assert.equal(a.ledger.commit(candidate), false);
  const final = extended + '  Tail.  ', remainder = a.ledger.finalize({ asr_sentence_id: 'sentence', original_text: final });
  assert.equal(remainder.preFinal, false); assert.equal(remainder.source, final.slice(candidate.end).trim());
  const ledger = speechIntervalLedger(final, [candidate.source, remainder.source]);
  assert.equal(ledger.accepted[0].end, candidate.end); assert.equal(ledger.accepted[1].start, remainder.start);
  a.ledger.complete('sentence'); a.ledger.observe('sentence', extended + ' duplicate'); assert.equal(a.ledger.candidate(), null); a.ledger.close();
  const b = make(), stale = b.ledger.candidate(); b.ledger.finalize({ asr_sentence_id: 'sentence', original_text: extended });
  assert.equal(b.ledger.commit(stale), false); b.ledger.close();
  const c = make(); assert.equal(c.ledger.commit(c.ledger.candidate()), true);
  c.ledger.observe('sentence', extended.replace('released', 'recalled'));
  assert.equal(c.corrections.length, 1); assert.equal(c.corrections[0].reason, 'source-prefix-revised');
  assert.equal(c.ledger.candidate(), null); c.ledger.close();
});
