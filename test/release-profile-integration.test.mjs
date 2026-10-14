import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { technicalSuites, purposes, domainSuites } from '../verification/release/policy.mjs';
import { browserChecks, browserScreenshots } from '../scripts/lib/runner-evidence-contract.mjs';
import { readTechnicalEvidence } from '../scripts/lib/release-evidence.mjs';

// Main now requires real import/edit protocol jobs and three additional browser
// profiles. A previous baseline's green roster cannot silently omit those jobs.
test('release policy includes every newly required import and edit protocol suite', () => {
  for (const suite of ['import-protocol', 'edit-protocol']) {
    assert.ok(technicalSuites.includes(suite), `${suite} must be required technical evidence`);
    assert.ok(purposes.pr.includes(suite)); assert.ok(purposes.release.includes(suite));
  }
  assert.ok(domainSuites['HW-06'].includes('edit-protocol'));
  assert.ok(domainSuites['HW-09'].includes('import-protocol'));
});
test('release browser roster retains security, import and edit profiles with concrete screenshot contracts', () => {
  for (const name of ['security', 'import-protocol', 'edit-consistency']) {
    assert.equal(browserChecks.filter(value => value === name).length, 1, `${name} must run exactly once`);
    assert.ok(browserScreenshots[name]?.length > 0, `${name} must bind screenshots`);
  }
  assert.equal(browserChecks.length, 17);
});
for (const suite of ['import-protocol', 'edit-protocol']) test(`${suite} is a registered raw reader and missing actual evidence stays not run`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-added-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await readTechnicalEvidence(suite, directory, { release: false });
  assert.equal(result.ok, false); assert.equal(result.status, 'not_run');
});
