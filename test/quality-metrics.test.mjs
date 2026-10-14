import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editCounts, scoreReferences, aggregateErrors, normalizeQualityText, scoreAsr } from '../scripts/lib/quality-metrics.mjs';

test('quality metric reports independently worked WER substitutions, insertions and omissions', () => {
  assert.deepEqual(editCounts('one two three', 'one four three five', 'wer'), {
    errors: 2, insertions: 1, deletions: 0, substitutions: 1, referenceUnits: 3, hypothesisUnits: 4, errorRate: 2 / 3, omissionRate: 0 });
  assert.equal(editCounts('do not pay 15', 'do pay 15', 'wer').deletions, 1);
  assert.equal(editCounts('do not pay 15', '', 'wer').omissionRate, 1);
});
test('CER uses code points and frozen normalization retains critical punctuation and digits', () => {
  assert.equal(editCounts('甲😀乙', '甲乙', 'cer').referenceUnits, 3);
  assert.equal(editCounts('甲😀乙', '甲乙', 'cer').deletions, 1);
  assert.equal(normalizeQualityText(' E\u0301\t15.50 '), 'é 15.50');
  assert.equal(editCounts('15.50', '1550', 'cer').errors, 1);
});
test('reasonable alternate references use declared selection and corpus aggregation uses denominators', () => {
  assert.equal(scoreReferences(['send it now', 'please send it'], 'please send it', 'wer').referenceIndex, 1);
  assert.equal(scoreReferences(['A', 'a'], 'A', 'wer').referenceIndex, 0);
  const total = aggregateErrors([editCounts('one two three', 'one two', 'wer'), editCounts('four', '', 'wer')]);
  assert.equal(total.errorRate, 0.5); assert.equal(total.omissionRate, 0.5); assert.equal(total.referenceUnits, 4);
  assert.throws(() => editCounts('', 'text', 'wer'), /EMPTY_REFERENCE/);
});

test('real silence references have a separate hallucination result, never a fabricated zero WER', () => {
  assert.deepEqual(scoreAsr([''], '', 'cer'), { metric: 'empty-reference-hallucination', referenceUnits: 0, errorRate: null, omissionRate: null, hallucination: false });
  assert.equal(scoreAsr([''], 'invented words', 'cer').hallucination, true);
});
