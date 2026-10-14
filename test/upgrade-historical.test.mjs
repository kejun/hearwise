import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ListeningStore } from '../storage.mjs';
import { fixtures, materializeHistorical, upgradeSnapshot, assertUpgradeProjection } from '../test-support/upgrade-fixture.mjs';

import { historicalUpgrade } from '../test-support/upgrade-scenarios.mjs';
for (const fixture of fixtures) test(`actual historical v${fixture.version} upgrades, preserves and reopens`, { timeout: 10000 }, () => historicalUpgrade(fixture.version));


test('upgrade oracle rejects missing history, text corruption, lost paid attempts and default drift', { timeout: 10000 }, async () => {
  const fixture = fixtures.at(-1), directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-upgrade-controls-')), filename = path.join(directory, 'old.sqlite');
  let store;
  try {
    materializeHistorical(fixture, filename); const startedAt = Date.now(); store = new ListeningStore(filename); const finishedAt = Date.now();
    const after = upgradeSnapshot(filename);
    for (const corrupt of [value => { value.schema = []; }, value => value.rows.segments.pop(), value => { value.rows.segments[0].original_text = 'lost'; },
      value => { value.rows.extraction_parts[0].initial_requests = 0; }, value => { value.rows.relation_requests[0].attempt = 0; },
      value => { value.rows.knowledge_items[0].name_override = 'invented'; }]) {
      const copy = structuredClone(after); corrupt(copy); assert.throws(() => assertUpgradeProjection(fixture, copy, { startedAt, finishedAt }));
    }
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});
