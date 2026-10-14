import assert from 'node:assert/strict';
import { validEditDurableEnvelope, validMatchedEditDurable } from './edit-protocol-durable.mjs';
const names = ['Deebo', 'Tibo', 'Mira'];
const uuid = value => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);

export function validateEditDurableReplay(replay, config, { negative = false, mutation } = {}) {
  assert.ok(Array.isArray(replay.observations) && replay.observations.length);
  for (const [index, observation] of replay.observations.entries()) {
    assert.equal(observation.step, index - 1);
    const previous = replay.observations[index - 1];
    if (previous) {
      assert.deepEqual(observation.durable.versions.slice(0, previous.durable.versions.length), previous.durable.versions);
      assert.deepEqual(observation.durable.events.slice(0, previous.durable.events.length), previous.durable.events);
      for (const [actor, client] of observation.durable.clients.entries()) assert.deepEqual(client.jobs.slice(0, previous.durable.clients[actor].jobs.length), previous.durable.clients[actor].jobs);
    }
    if (!negative || index < replay.observations.length - 1 || mutation === 'bypass_revision') {
      assert.equal(validMatchedEditDurable(observation, config), true); continue;
    }
    assert.equal(mutation, 'auto_revision_resend'); assert.equal(validEditDurableEnvelope(observation, config), true); assert.ok(previous);
    const raw = observation.durable, before = previous.durable, state = observation.actual;
    for (const key of ['snapshot', 'graph', 'versions', 'jobs', 'events', 'providerCalls']) assert.deepEqual(raw[key], before[key]);
    // This declared negative witness refreshes one rejected client and sends
    // exactly one new real POST. It performs no transaction or persistent write.
    const actor = replay.counterexample.steps.at(-1).actor; assert.ok(Number.isInteger(actor) && actor >= 0 && actor < config.clients);
    for (const [id, client] of raw.clients.entries()) {
      const original = before.clients[id];
      if (id !== actor) { assert.deepEqual(client, original); continue; }
      assert.equal(original.phase, 'conflict'); assert.equal(original.actualResponse.status, 409);
      assert.equal(JSON.parse(original.actualResponse.text).code, 'KNOWLEDGE_EDIT_STALE');
      assert.equal(client.jobs.length, original.jobs.length + 1); assert.ok(uuid(client.jobs.at(-1)) && !original.jobs.includes(client.jobs.at(-1)));
      assert.deepEqual(client, { ...original, phase: 'pending', jobs: client.jobs, requests: original.requests + 1,
        loadedToken: raw.snapshot.revision, submittedToken: raw.snapshot.revision,
        actualRequest: { name: names[previous.actual.draft[id]], revision: raw.snapshot.revision }, actualResponse: null });
      assert.equal(client.userSaves, 1); assert.equal(client.requests, 2);
    }
    const expected = structuredClone(previous.actual);
    for (const [field, value] of Object.entries({ loadedRevision: expected.revision, loadedName: expected.name, submittedRevision: expected.revision,
      submittedName: expected.draft[actor], requests: expected.requests[actor] + 1, phase: 'pending', txResult: 'none', receipt: 'none', reply: 'none', notification: 'none' })) expected[field][actor] = value;
    assert.deepEqual(state, expected);
  }
  if (negative) {
    const last = replay.observations.at(-1); assert.equal(last.step, replay.difference.step); assert.deepEqual(last.actual, replay.difference.actual);
    assert.notDeepEqual(replay.difference.actual, replay.difference.expected); assert.deepEqual(replay.counterexample.steps.at(-1).expected, replay.difference.expected);
  }
  return true;
}
