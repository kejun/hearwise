import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCaptionFrontier } from '../public/caption-frontier.js';

test('new growing context commits common prefix, duplicates and time alone do not', () => {
  const f = createCaptionFrontier({ mutableCharacters: 5 });
  const first = f.update('The weather is warm today');
  assert.equal(first.committed, '');
  assert.equal(f.update(first.text).committed, '');
  const next = f.update('The weather is warm today and sunny');
  assert.equal(next.committed, 'The weather is warm ');
  assert.equal(next.committed + next.tail, next.text);
  assert.ok(next.tail.endsWith('and sunny'));
});
test('incompatible revision visibly rebases affected suffix and keeps growing without stitching', () => {
  const f = createCaptionFrontier({ mutableCharacters: 3 });
  f.update('The weather is warm today'); f.update('The weather is warm today and sunny');
  const revision = f.update('The weather is not warm today and cloudy');
  assert.equal(revision.correctionPending, true);
  assert.equal(revision.text, 'The weather is warm today and sunny');
  const growing = f.update('The weather is not warm today and cloudy outside');
  assert.equal(growing.correctionPending, true);
  assert.ok(growing.text.endsWith('outside'));
  const converged = f.update('The weather is not warm today and cloudy outside now');
  assert.equal(converged.correctionPending, false);
  assert.ok(converged.committed.startsWith('The weather is not'));
  const final = f.update('The weather is not warm.', { final: true });
  assert.equal(final.text, 'The weather is not warm.'); assert.equal(final.corrected, true);
});
test('target agreement needs distinct growing source, not repeated MT outputs', () => {
  const f = createCaptionFrontier({ mutableCharacters: 2 });
  f.update('今天天气十分温暖舒适', { sourceContext: 'It is warm' });
  assert.equal(f.update('今天天气十分温暖舒适', { sourceContext: 'It is warm' }).committed, '');
  assert.equal(f.update('今天天气十分温暖舒适，适合散步', { sourceContext: 'It is warm today' }).committed, '今天天气十分温暖');
  f.reset(); assert.equal(f.update('另一个句子').committed, '');
});
test('unicode surrogate pairs stay intact and source reordering is not growth', () => {
  const f = createCaptionFrontier({ mutableCharacters: 1 });
  f.update('你好😀世界'); assert.equal(f.update('你好😀世界！').committed, '你好😀世');
  const g = createCaptionFrontier({ mutableCharacters: 1 });
  g.update('I saw Alice'); assert.equal(g.update('Alice was seen by me').committed, '');
});


test('synthetic trace compares actual visible erasure against whole-replacement baseline', () => {
  const trace = ['The weather is warm today', 'The weather is warm today and sunny',
    'The weather is not warm today and sunny', 'The weather is warm today and sunny outside',
    'The weather is warm today and sunny outside now'];
  const f = createCaptionFrontier({ mutableCharacters: 3 });
  const candidate = trace.map(text => f.update(text).text);
  function erased(outputs) {
    let total = 0;
    for (let i = 1; i < outputs.length; i++) {
      let shared = 0;
      while (shared < outputs[i - 1].length && outputs[i - 1][shared] === outputs[i][shared]) shared++;
      total += outputs[i - 1].length - shared;
    }
    return total;
  }
  assert.ok(erased(candidate) < erased(trace));
  assert.equal(candidate.at(-1), trace.at(-1));
  assert.equal(candidate[2], candidate[1]); // Precisely one revised context is held, not a hidden whole-utterance freeze.
});
