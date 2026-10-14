// Test-only synthetic UI envelope around genuine HTTP/SQLite transactions.
// This helper never counts as an actual Chromium run.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNameProtocolFixture } from './name-protocol-fixture.mjs';
import { installNameWriteFault, removeNameWriteFault } from './name-transaction-fixture.mjs';
import { nameBrowserScenarios, nameBrowserModules, nameSourceSnapshot, nameBrowserMutation } from './name-protocol-browser-evidence.mjs';
const clone = structuredClone;
export async function nameBrowserContractFixture() {
  const source = await nameSourceSnapshot(), mutation = await nameBrowserMutation(), rows = [];
  for (const [scenario, negative] of [...nameBrowserScenarios.map(name => [name, false]), ['held-double-submit', true]]) {
    const f = await createNameProtocolFixture();
    try {
      const s = f.seeded, ids = { listeningId: f.listeningId, itemId: f.itemId, segmentId: s.segment.id, unlinkedId: s.other.id,
        unrelatedId: s.unrelated.listeningId, staleId: s.staleId, cameraId: s.camera.id, factId: s.factId };
      const baseline = f.tables(), initial = f.snapshot(), requests = [], responses = [], upstream = [], checkpoints = [];
      const name = scenario === 'cancel-noop' ? 'Deebo' : scenario === 'rollback-retry' ? 'Ｔｉｂｏ  Longer' : 'Tibo', input = { name, revision: initial.revision };
      const editor = (draft = name, extra = {}) => ({ open: true, draft, source: 'Deebo', status: '', saveDisabled: false, closeDisabled: false, fits: true, ...extra });
      const capture = (label, ui = editor()) => {
        if (label === 'final' || label === 'reopened-unknown' || label === 'committed-held' && negative) ui.source = f.snapshot().item.canonical_name;
        checkpoints.push({ label, tables: f.tables(), snapshot: f.snapshot(), editor: ui });
      };
      capture('opened', editor('Deebo'));
      const submit = async () => {
        const id = randomUUID(), headers = { 'idempotency-key': id }, url = f.url + '/name-replacements';
        requests.push({ method: 'POST', url, headers, body: clone(input) });
        const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });
        const text = await response.text(); return { id, request: clone(input), url, status: response.status, text };
      };
      if (scenario === 'rollback-retry') {
        installNameWriteFault(f.store, 'receipt-success'); const failed = await submit(); assert.equal(failed.status, 502); responses.push(failed);
        capture('rolled-back'); removeNameWriteFault(f.store, 'receipt-success');
      }
      if (scenario === 'cancel-noop') capture('cancelled-reopened', editor('Deebo'));
      const saved = await submit(); assert.equal(saved.status, 200); responses.push(saved);
      if (['held-double-submit', 'receipt-recovery', 'unknown-502', 'unknown-lost'].includes(scenario)) upstream.push(saved);
      if (scenario === 'held-double-submit') {
        capture('committed-held', editor(name, { closeDisabled: true }));
        if (negative) { const conflict = await submit(); assert.equal(conflict.status, 409); upstream.push(conflict); responses.push(conflict); }
      }
      if (['receipt-recovery', 'unknown-502', 'unknown-lost'].includes(scenario)) {
        const url = f.url + '/edits/' + saved.id; requests.push({ method: 'GET', url, headers: { 'idempotency-key': null }, body: null });
        const response = await fetch(url), text = await response.text(); assert.equal(response.status, 200);
        responses.push({ url, status: scenario === 'receipt-recovery' ? 200 : 502, text: scenario === 'receipt-recovery' ? text : 'synthetic unavailable receipt' });
        if (scenario.startsWith('unknown-')) { capture('unknown', editor(name, { saveDisabled: true, status: '输入已保留，保存结果尚未确认' })); capture('reopened-unknown'); }
      }
      capture('final'); const final = f.snapshot(), origin = new URL(f.url).origin;
      rows.push({ scenario, negative, identities: ids, baseline, checkpoints, upstream, requests, responses, complete: true, errors: [], providerCalls: [],
        explicitSaves: scenario === 'rollback-retry' ? 2 : 1, mutation: negative ? mutation : null,
        views: { list: { id: ids.itemId, name, transcript: final.segments.map(row => row.original_text).join('\n'), summary: final.item.dialogue_summary, fact: final.item.facts.map(row => row.content).join('\n') },
          graph: { entries: [{ id: ids.itemId, text: name }, { id: ids.cameraId, text: 'camera' }], name, details: name }, reopened: editor() },
        sources: nameBrowserModules.map(module => ({ url: origin + '/' + module, status: 200, bytes: 1,
          sha256: negative && module === 'knowledge-editor.js' ? mutation.mutantSha256 : source.files['public/' + module] })) });
    } finally { await f.close(); }
  }
  const sized = (row, width) => ({ ...clone(row), width, screenshot: `name-${width}-${row.negative ? 'double-submit-negative' : row.scenario}.png` });
  return { source, mutation, browser: { source: { sha: source.sha, dirty: source.dirty }, complete: true, chromium: 'SYNTHETIC CONTRACT ONLY',
    widths: [1280, 390].map(width => ({ width, results: rows.filter(row => !row.negative).map(row => sized(row, width)) })), negative: sized(rows.at(-1), 390) } };
}
