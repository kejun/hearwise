import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFullTraceComparison } from '../test-support/trace-business-boundary.mjs';

test('real ASR/MT/knowledge/relation and two speech providers agree with task queries and Trace ownership',
  { timeout: 25000 }, async () => { const result = await runFullTraceComparison(); assert.equal(result.ok, true); });
