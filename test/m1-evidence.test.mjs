import test from 'node:test';
import assert from 'node:assert/strict';
import { m1Coverage, summarizeM1, validateM1Evidence } from '../scripts/lib/m1-evidence.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceVersion, digest } from '../scripts/lib/verification-evidence.mjs';
import { createRelationProtocolAdapter } from '../test-support/relation-protocol-adapter.mjs';
import { createKnowledgeProtocolAdapter } from '../test-support/knowledge-protocol-adapter.mjs';

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

test('M1 singleton artifact downloads use the exact domain directories consumed by discovery', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const artifact of ['relation-protocol', 'knowledge-protocol', 'process-crash', 'generation-protocol']) {
    const pattern = `${artifact}-evidence-${'${{ github.sha }}'}`;
    assert.ok(workflow.includes(`pattern: ${pattern}\n          path: verification-evidence/m1-inputs/${pattern}`));
  }
});

for (const [domain, create] of [['relation', createRelationProtocolAdapter], ['knowledge', createKnowledgeProtocolAdapter]]) {
  test(`M1 ${domain} reader independently checks real durable normal and negative frames`, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'm1-durable-wiring-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const captures = [];
    for (const mutation of ['none', 'skip_reservation']) {
      const adapter = await create({ mutation });
      try {
        const observations = [], capture = () => observations.push(JSON.parse(JSON.stringify({
          step: observations.length - 1, actual: adapter.project(), durable: adapter.observe(), durableViolations: adapter.check()
        })));
        capture(); await adapter.act({ action: 'admit', actor: 0 }); capture();
        const replay = { observations, sourceTrace: 'raw-wiring-only', complete: true, ok: mutation === 'none',
          classification: mutation === 'none' ? 'matched' : 'implementation_mismatch', steps: 1 };
        if (mutation !== 'none') {
          const actual = observations.at(-1).actual, expected = structuredClone(actual);
          (domain === 'relation' ? expected.counts : expected.initial_requests)[0] = 1;
          Object.assign(replay, { difference: { step: 0, actual, expected }, counterexample: { steps: [{ expected }] } });
        }
        captures.push(replay);
      } finally { await adapter.close(); }
    }
    // Intentionally incomplete formal report. Only the real durable-reader
    // wiring is under test; this fixture can never pass the full M1 gate.
    const report = { profile: 'fast', source: sourceVersion(), complete: false, artifacts: [], results: [] };
    const saveReplay = async (id, replay) => {
      const data = `${id}.json`, log = `${id}.log`, rows = [replay];
      const contents = { [data]: JSON.stringify(rows), [log]: JSON.stringify(rows.map(row => ({
        trace: row.sourceTrace, classification: row.classification, complete: row.complete, ok: row.ok, steps: row.steps
      }))) };
      for (const [file, bytes] of Object.entries(contents)) {
        await writeFile(path.join(directory, file), bytes);
        report.artifacts = report.artifacts.filter(row => row.path !== file);
        report.artifacts.push({ path: file, sha256: digest(bytes) });
      }
      if (!report.results.some(row => row.id === id)) report.results.push({ id, kind: id === 'negative-replay' ? 'implementation-negative' : 'implementation-replay', data, log });
      await writeFile(path.join(directory, 'report.json'), JSON.stringify(report));
    };
    for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) await saveReplay(id, captures[id === 'negative-replay' ? 1 : 0]);
    const read = async () => (await validateM1Evidence({ [domain]: directory }, { release: false })).domains.find(row => row.id === domain);
    const baseline = await read(); assert.notEqual(baseline.status, 'passed');
    assert.ok(!baseline.reasons.some(reason => reason.startsWith('invalid_durable_evidence:')));
    for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) {
      const original = captures[id === 'negative-replay' ? 1 : 0], changed = structuredClone(original);
      changed.observations.at(-1).durable = {}; await saveReplay(id, changed);
      assert.ok((await read()).reasons.includes(`invalid_durable_evidence:${id}`), `${domain} ${id} raw erasure rejected after recomputing artifact hashes`);
      await saveReplay(id, original);
    }
  });
}
