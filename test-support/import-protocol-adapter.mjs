import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { importProtocolFixture } from './import-protocol-fixture.mjs';

const clientFields = ['clientGeneration', 'clientMode', 'clientCurrentCount', 'clientAddedCount', 'clientSkippedCount'];
export async function createImportProtocolAdapter({ tokens = 1, mutation = 'none' } = {}) {
  assert.ok([1, 2].includes(tokens));
  const fixture = await importProtocolFixture({ tokens, mutation });
  const clients = Object.fromEntries(clientFields.map(field => [field, Object.fromEntries(Array.from({ length: tokens }, (_, t) =>
    [t, field === 'clientMode' ? '' : 0]))]));
  const reviews = Array.from({ length: tokens }, () => new Map()), timerIds = new Map();
  let lastHTTPStatus = 0, lastHTTPCode = '', current = fixture.snapshot(), violations = [];
  const events = [];
  function received(result, actor, isPreview) {
    lastHTTPStatus = result.status; lastHTTPCode = result.body.code || '';
    if (!isPreview || result.status !== 200) return;
    const body = result.body, generation = clients.clientGeneration[actor] + 1;
    assert.equal(body.databaseVersion, 12); assert.match(body.revision, /^[a-f0-9]{64}$/);
    assert.ok(['append', 'replace'].includes(body.mode));
    if (generation > 1) {
      assert.equal(body.token, reviews[actor].get(1).token);
      assert.notEqual(body.previewToken, reviews[actor].get(generation - 1).previewToken);
    }
    reviews[actor].set(generation, body);
    clients.clientGeneration[actor] = generation; clients.clientMode[actor] = body.mode;
    clients.clientCurrentCount[actor] = body.currentCount; clients.clientAddedCount[actor] = body.addedCount;
    clients.clientSkippedCount[actor] = body.skippedCount;
  }
  function observedIds() {
    return current.rows.listenings.map(row => fixture.seeds.findIndex(seed => seed.listeningId === row.id)).sort((a, b) => a - b);
  }
  function check() {
    return [...violations, ...(fixture.calls.length ? ['unexpected_provider_call'] : []),
      ...(current.integrity !== 'ok' || current.foreignKeyErrors.length ? ['database_integrity'] : []),
      ...(observedIds().includes(-1) ? ['unknown_business_identity'] : [])];
  }
  async function act(step) {
    const { action, actor, requestedMode, requestedGeneration, fault } = step;
    violations = [];
    const before = current, callCount = fixture.calls.length;
    let result = null;
    if (action === 'upload') {
      result = await fixture.upload(actor, requestedMode); received(result, actor, true);
      if (result.status === 200) {
        const clock = await fixture.control('state');
        timerIds.set(actor, clock.timers.at(-1).id);
        assert.equal(clock.timers.at(-1).requestedMilliseconds, 900000);
      }
    } else if (action === 'preview') {
      result = await fixture.request('/api/data/import/preview', { body: { token: reviews[actor].get(1).token, mode: requestedMode } });
      received(result, actor, true);
    } else if (action === 'commit') {
      const first = reviews[actor].get(1), selected = reviews[actor].get(requestedGeneration);
      if (fault) await fixture.control('fail-commit');
      result = await fixture.request('/api/data/import/commit', { body: { token: first.token, mode: requestedMode,
        previewToken: selected?.previewToken ?? 'unissued-synthetic-preview-token' } });
      received(result, actor, false);
    } else if (action === 'expire') await fixture.control('expire', { timer: timerIds.get(actor) });
    else if (action === 'same_write') await fixture.write('same');
    else if (action === 'other_write') await fixture.write('other');
    else if (action === 'restart') await fixture.restart();
    else if (!['cleanup', 'stutter'].includes(action)) throw new Error(`Unknown import trace action: ${action}`);
    current = fixture.snapshot();
    if (result && result.status !== 200 && !isDeepStrictEqual(current, before)) violations.push('rejected_http_changed_business');
    if (fixture.calls.length !== callCount) violations.push('action_sent_provider_request');
    events.push({ action, actor, requestedMode, requestedGeneration, fault, result,
      unchanged: isDeepStrictEqual(current, before), providerCallDelta: fixture.calls.length - callCount });
  }
  return { act, project: () => ({ lastHTTPStatus, lastHTTPCode, businessIds: observedIds(), ...structuredClone(clients) }),
    observe: () => structuredClone({ snapshot: current, backups: fixture.backupSnapshots, providerCalls: fixture.calls, lifecycle: fixture.lifecycle,
      clockEvents: fixture.clockEvents, events, mutation: fixture.mutationEvidence }), check, close: () => fixture.close() };
}
