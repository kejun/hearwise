import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIncrementalLedger, eligiblePhrase } from '../incremental-speech.mjs';

const first = 'The weather is warm, and the sky is clear';
const second = first + ' above the quiet city';
function ready() {
  const corrections = [];
  const ledger = createIncrementalLedger({ epoch: 3, runId: 'run', onCorrection: event => corrections.push(event) });
  ledger.observe('sentence', first); ledger.observe('sentence', second);
  return { ledger, corrections };
}
test('growing agreement commits immutable source span before any terminal punctuation', () => {
  const { ledger } = ready(), unit = ledger.candidate();
  assert.equal(unit.source, 'The weather is warm,');
  assert.equal(Object.isFrozen(unit), true); assert.equal(unit.epoch, 3); assert.equal(unit.hash.length, 64);
  assert.equal(ledger.commit(unit), true); assert.equal(ledger.commit(unit), false);
  assert.equal(ledger.candidate(), null);
  const remainder = ledger.finalize({ asr_sentence_id: 'sentence', original_text: second + '.' });
  assert.equal(remainder.source, 'and the sky is clear above the quiet city.');
  assert.equal(second.slice(unit.end, remainder.start).trim(), '');
  assert.equal(remainder.source, (second + '.').slice(remainder.start, remainder.end));
  assert.equal(remainder.hash, createHash('sha256').update(remainder.source).digest('hex'));
  assert.equal(Object.isFrozen(remainder), true);
  assert.equal(ledger.finalize({ asr_sentence_id: 'sentence', original_text: second + '.' }), remainder);
});
test('duplicates and non-growing correction do not create agreement', () => {
  const ledger = createIncrementalLedger({ epoch: 1, runId: 'run' });
  ledger.observe('s', first); ledger.observe('s', first); assert.equal(ledger.candidate(), null);
  ledger.observe('s', first.replace('warm', 'cold')); assert.equal(ledger.candidate(), null);
  ledger.observe('s', first.replace('warm', 'cold') + ' outside'); assert.equal(ledger.candidate().source, 'The weather is cold,');
});
test('numbers, units, negation, names, reordering, dependent and mixed-language clauses are final-only', () => {
  for (const source of ['The weather is not warm', 'The water is 30 degrees', 'Alice is ready', 'The room is warm but noisy',
    'The weather which we expected is warm', '天气很暖和', 'The weather is 暖和', 'It is warm only', 'Dr. Smith is ready', 'The weather is may be warm']) {
    const text = source + ', and the sky is clear while we wait';
    assert.equal(eligiblePhrase(text, text), null, source);
  }
  assert.equal(eligiblePhrase('The weather is warm, but the sky is dark', 'The weather is warm, but the sky is dark'), null);
});
test('final race invalidates unspoken candidate; spoken prefix revision is surfaced and blocks more units', () => {
  const a = ready(), unit = a.ledger.candidate();
  a.ledger.finalize({ asr_sentence_id: 'sentence', original_text: second + '.' });
  assert.equal(a.ledger.commit(unit), false); assert.equal(a.corrections.length, 0);
  const b = ready(); b.ledger.commit(b.ledger.candidate());
  b.ledger.observe('sentence', second.replace('warm', 'not warm'));
  assert.equal(b.corrections.length, 1); assert.equal(b.ledger.candidate(), null);
});
test('coverage belongs to consumer epoch, close rejects stale work', () => {
  const a = ready(), b = ready(), unit = a.ledger.candidate(); a.ledger.commit(unit);
  assert.ok(b.ledger.candidate()); a.ledger.close(); assert.equal(a.ledger.valid(unit), false);
});


test('late partial after canonical completion cannot be admitted again', () => {
  const { ledger } = ready();
  ledger.commit(ledger.candidate());
  ledger.finalize({ asr_sentence_id: 'sentence', original_text: second + '.' });
  ledger.complete('sentence');
  ledger.observe('sentence', first); ledger.observe('sentence', second);
  assert.equal(ledger.candidate(), null);
});
test('sentence-only conservative policy disables comma admission', () => {
  assert.equal(eligiblePhrase(first, first, 0, { allowClauses: false }), null);
});


test('foreign epoch or run cannot advance another ledger coverage', () => {
  const { ledger } = ready(), unit = ledger.candidate();
  assert.equal(ledger.commit({ ...unit, epoch: unit.epoch + 1 }), false);
  assert.equal(ledger.commit({ ...unit, runId: 'other-run' }), false);
  assert.equal(ledger.commit(unit), true);
});
