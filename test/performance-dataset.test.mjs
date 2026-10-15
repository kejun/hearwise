import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedPerformanceDatabase, inspectPerformanceDataset, validatePerformanceRecipe } from '../test-support/performance-dataset.mjs';

const recipe = { version: 1, tier: 'unit', listenings: 3, segmentsPerBackground: 2,
  graphRecords: 2, nodesPerGraph: 6, isolatedPerGraph: 2, textCharacters: 160, seed: 20261014 };
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-performance-data-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test('performance dataset uses real persisted business rows and records exact scale/topology', async t => {
  const directory = await temporary(t), filename = path.join(directory, 'data.sqlite');
  const manifest = await seedPerformanceDatabase(filename, recipe);
  assert.equal(manifest.recipeDigest.length, 64); assert.equal(manifest.semanticDigest.length, 64);
  assert.equal(manifest.counts.listenings, 3); assert.equal(manifest.counts.runs, 3);
  assert.equal(manifest.counts.nodes, 12); assert.equal(manifest.counts.relations, 16);
  assert.equal(manifest.counts.assertions, 16); assert.equal(manifest.counts.supports, 16);
  assert.equal(manifest.counts.segments, 30);
  assert.ok(manifest.counts.originalTextUtf8Bytes > manifest.counts.originalTextCodePoints);
  for (const record of [manifest.primary, manifest.secondary]) {
    assert.equal(record.nodeCount, 6); assert.equal(record.edgeCount, 8);
    assert.equal(record.topology.components, 3); assert.equal(record.topology.isolatedNodes, 2);
    assert.equal(record.topology.largestComponent, 4);
    assert.equal(record.segmentCount, 14);
  }
  const actual = await inspectPerformanceDataset(filename);
  assert.equal(actual.semanticDigest, manifest.semanticDigest);
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM listening_runs WHERE state!='complete'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM segments WHERE translation_state!='complete'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM relation_jobs WHERE state NOT IN ('complete','partial')").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM relation_assertions WHERE status!='active'").get().n, 0);
  } finally { db.close(); }
});

test('generated UUIDs and wall-clock stamps do not disguise identical loads or changed text', async t => {
  const directory = await temporary(t), a = path.join(directory, 'a.sqlite'), b = path.join(directory, 'b.sqlite');
  const first = await seedPerformanceDatabase(a, recipe), second = await seedPerformanceDatabase(b, recipe);
  assert.notEqual(first.primary.id, second.primary.id);
  assert.equal(first.semanticDigest, second.semanticDigest);
  assert.deepEqual(first.counts, second.counts);
  const db = new DatabaseSync(b);
  try { db.prepare("UPDATE listenings SET notes=notes || ' changed' WHERE id=?").run(second.primary.id); }
  finally { db.close(); }
  assert.notEqual((await inspectPerformanceDataset(b)).semanticDigest, first.semanticDigest);
});

test('dataset recipes reject missing, unbounded, inconsistent and unknown domains', () => {
  assert.equal(validatePerformanceRecipe(recipe), true);
  for (const patch of [{ nodesPerGraph: 0 }, { nodesPerGraph: 4, isolatedPerGraph: 2 },
    { graphRecords: 4 }, { listenings: Infinity }, { seed: 1.5 }, { textCharacters: 10 }, { unknown: true }, { version: 2 }]) {
    assert.equal(validatePerformanceRecipe({ ...recipe, ...patch }), false, JSON.stringify(patch));
  }
});
