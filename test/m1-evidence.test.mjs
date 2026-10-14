import test from 'node:test';
import assert from 'node:assert/strict';
import { m1Coverage, summarizeM1, validateM1Evidence } from '../scripts/lib/m1-evidence.mjs';

test('M1 coverage preserves all twelve original acceptance IDs and current-domain dependencies', () => {
  assert.deepEqual(m1Coverage.map(row => row.acceptance), Array.from({ length: 12 }, (_, i) => `AC-P${String(i + 1).padStart(2, '0')}`));
  assert.ok(m1Coverage.every(row => row.requirements.length > 0));
  const domains = ['relation', 'knowledge', 'process', 'generation'].map(id => ({ id, status: 'passed' }));
  assert.equal(summarizeM1(domains).ok, true, 'pure status-combiner unit test, not an evidence pass');
  for (const domain of domains) for (const status of ['not_run', 'stale', 'incomplete']) {
    const changed = structuredClone(domains); changed.find(row => row.id === domain.id).status = status;
    assert.equal(summarizeM1(changed).ok, false);
    assert.ok(summarizeM1(changed).rows.some(row => row.status === 'incomplete'));
  }
  assert.equal(summarizeM1(domains.slice(1)).ok, false);
});

test('M1 reader cannot turn previous asset availability or missing reports into current verification', async () => {
  const result = await validateM1Evidence({}, { release: true });
  assert.equal(result.ok, false); assert.equal(result.rows.length, 12);
  assert.equal(result.domains.length, 4); assert.ok(result.domains.every(row => row.status === 'not_run'));
  assert.ok(result.rows.every(row => row.status === 'incomplete'));
});
