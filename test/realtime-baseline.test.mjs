import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLatencies, validateBaselineRun } from '../scripts/lib/realtime-baseline.mjs';

test('baseline keeps raw samples, uses nearest-rank quantiles and never infers acceptance', () => {
  const samples = [1, 2, 3, 100].map(value => ({ phase: 'continuous', audioToCaptionMs: value }));
  assert.deepEqual(summarizeLatencies(samples).audioToCaptionMs, { count: 4, p50: 2, p95: 100, p99: 100, min: 1, max: 100 });
  assert.equal(samples[0].audioToCaptionMs, 1);
  assert.equal(validateBaselineRun({ complete: true, cleanup: { confirmed: true }, phases: [] }).ok, false);
});

test('missing phase, resource and incomplete evidence cannot look like measured success', () => {
  for (const run of [null, {}, { complete: false }, { complete: true, cleanup: { confirmed: false } }]) assert.equal(validateBaselineRun(run).ok, false);
  const valid = { complete: true, cleanup: { confirmed: true }, phases: ['warmup', 'continuous', 'stop-start', 'switching', 'background', 'post-import'].map(name => ({ name, complete: true })),
    samples: [{ audioToCaptionMs: 1, finalToTranslationMs: 2, finalToKnowledgeMs: 3 }], runs: [{ startToFirstPcmMs: 4 }], resourceSamples: 2, quiescent: [{}] };
  assert.equal(validateBaselineRun(valid).ok, true);
  for (const change of [{ phases: valid.phases.slice(1) }, { resourceSamples: 0 }, { samples: [] }, { error: 'timeout' }, { runs: [] }]) assert.equal(validateBaselineRun({ ...valid, ...change }).ok, false);
  assert.equal(validateBaselineRun(valid).acceptanceStatus, 'not_run');
});
