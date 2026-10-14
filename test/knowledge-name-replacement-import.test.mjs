import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importedInvalidAnchors } from '../test-support/name-replacement-import-fixture.mjs';

test('append and restore cannot revive malformed active anchors during name replacement', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'name-interval-import-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const results = importedInvalidAnchors(directory);
  assert.equal(results.length, 12);
  assert.ok(results.every(row => row.imported && row.status === 409 && row.unchanged && row.reopened && row.receiptAbsent));
  for (const mode of ['append', 'replace']) assert.deepEqual(results.find(row => row.id === `import-${mode}-reversed`).after,
    { start: 3, end: 2, quote: '', state: 'active' });
});
