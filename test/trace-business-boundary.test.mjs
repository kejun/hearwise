import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFullTraceComparison, runSpeechTraceComparison, runTranslationTraceRecovery } from '../test-support/trace-business-boundary.mjs';

test('real ASR/MT/knowledge/relation and two speech providers agree with task queries and Trace ownership',
  { timeout: 25000 }, async () => { const result = await runFullTraceComparison(); assert.equal(result.ok, true); });
for (const failed of [false, true]) test(`actual speech ${failed ? 'failure' : 'cancel/old/duplicate feedback'} stays distinct from persisted content`,
  { timeout: 10000 }, () => runSpeechTraceComparison({ failed }));
test('actual failed translation and explicit retry remain one recovered business task', { timeout: 15000 }, runTranslationTraceRecovery);
