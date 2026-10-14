import assert from 'node:assert/strict';
import { isDeepStrictEqual as same } from 'node:util';
import { createHash } from 'node:crypto';
import { knowledgeRevision } from '../../knowledge-revision.mjs';
import { referenceMatches, referenceText } from '../../verification/name-interval/corpus.mjs';

const names = ['Deebo', 'Tibo', 'Mira'];
const tables = ['extraction_jobs', 'extraction_parts', 'knowledge_aliases', 'knowledge_candidates', 'knowledge_corrections', 'knowledge_edit_jobs',
  'knowledge_facts', 'knowledge_items', 'knowledge_manual_items', 'knowledge_mentions', 'knowledge_revisions', 'listening_runs', 'listenings',
  'relation_assertions', 'relation_jobs', 'relation_requests', 'relation_revisions', 'relation_rounds', 'relation_supports', 'relation_windows', 'relations', 'segments'];
const digest = text => createHash('sha256').update(text).digest('hex');
const fingerprint = input => digest(JSON.stringify(['name_replace', input.name, input.revision]));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => typeof value === 'string' && new Date(value).toISOString() === value;
const canonical = value => JSON.stringify(value, Object.keys(value).sort());
const ordered = rows => [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
const equalRows = (a, b) => same(ordered(a), ordered(b));
const row = (values, id) => { const selected = values.filter(value => value.id === id); assert.equal(selected.length, 1, `Unique row ${id}`); return selected[0]; };
const norm = value => value.toLowerCase(); // Frozen finite names are ASCII; no general normalization claim.
function equalTables(left, right, label) {
  assert.deepEqual(Object.keys(left).sort(), tables, `${label}: complete table inventory`);
  assert.deepEqual(Object.keys(right).sort(), tables, `${label}: complete table inventory`);
  for (const name of tables) assert.ok(equalRows(left[name], right[name]), `${label}: ${name} differs`);
}
function validSnapshot(snapshot, values, ids) {
  assert.equal(snapshot.revisionVersion, 1); assert.ok(hash(snapshot.revision));
  const item = row(values.knowledge_items, ids.itemId);
  assert.equal(item.listening_id, ids.listeningId);
  for (const [key, value] of Object.entries(item)) assert.deepEqual(snapshot.item[key], value, `Snapshot item ${key}`);
  assert.equal(snapshot.item.display_name, item.canonical_name);
  for (const [field, table] of [['mentions', 'knowledge_mentions'], ['facts', 'knowledge_facts'], ['revisions', 'knowledge_revisions']])
    assert.ok(equalRows(snapshot.item[field], values[table].filter(value => value.item_id === ids.itemId)), `Snapshot ${field}`);
  assert.deepEqual([...snapshot.item.aliases].sort(), values.knowledge_aliases.filter(value => value.item_id === ids.itemId).map(value => value.alias).sort());
  assert.ok(equalRows(snapshot.segments, [row(values.segments, ids.segmentId)]));
  assert.equal(knowledgeRevision(snapshot), snapshot.revision, 'Snapshot revision rederived from raw-bound fields');
}
function anchorsValid(values, segmentId) {
  const text = row(values.segments, segmentId).original_text;
  return values.relation_supports.filter(value => value.segment_id === segmentId && value.state === 'active').every(value =>
    Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 && value.start < value.end && value.end <= text.length &&
    value.quote === text.slice(value.start, value.end) && value.source_revision === digest(text));
}
function receiptView(value) {
  return { id: value.id, state: value.state, name: value.name, source: value.source, saved: value.state === 'succeeded', error: value.error };
}
// Independent expected full-table delta for this bounded fixture. Matching uses
// KEJ-70's reverse-splice reference, never the production replacement function.
// Every column not listed here, including other listening descendants and old
// stale supports, must stay byte-for-byte equal to its recorded prior value.
function committedTables(before, after, ids, id, input) {
  const expected = structuredClone(before), source = row(before.knowledge_items, ids.itemId).canonical_name, name = input.name.trim();
  const receipt = row(after.knowledge_edit_jobs, id), stamp = receipt.created_at;
  assert.ok(time(stamp), 'Receipt timestamp');
  expected.knowledge_edit_jobs.push({ id, listening_id: ids.listeningId, item_id: ids.itemId, fingerprint: fingerprint(input), revision: input.revision,
    name, source, state: 'succeeded', error: null, created_at: stamp, updated_at: stamp, operation: 'manual_regenerate', context_hash: null,
    applied_context_hash: null, result_json: '{"kind":"name_replace"}', request_reserved: 0 });
  if (source === name) return expected;
  const replace = text => text === null ? null : referenceText(text, referenceMatches(text, source), name);
  const segment = row(expected.segments, ids.segmentId), matches = referenceMatches(segment.original_text, source);
  const coordinate = (offset, end) => {
    const inside = matches.find(value => value.start < offset && offset < value.end);
    const earlier = matches.filter(value => value.end <= (inside ? inside.start : offset));
    return (inside ? inside.start + (end ? name.length : 0) : offset) + earlier.reduce((sum, value) => sum + name.length - (value.end - value.start), 0);
  };
  segment.original_text = replace(segment.original_text);
  for (const support of expected.relation_supports.filter(value => value.segment_id === ids.segmentId && value.state === 'active')) {
    support.start = coordinate(support.start, false); support.end = coordinate(support.end, true);
    support.quote = segment.original_text.slice(support.start, support.end); support.source_revision = digest(segment.original_text);
  }
  for (const mention of expected.knowledge_mentions.filter(value => value.segment_id === ids.segmentId)) mention.surface_text = replace(mention.surface_text);
  for (const fact of expected.knowledge_facts.filter(value => value.segment_id === ids.segmentId)) {
    fact.surface_text = replace(fact.surface_text); fact.content = replace(fact.content);
  }
  for (const id of [ids.itemId, ids.cameraId]) {
    const item = row(expected.knowledge_items, id);
    for (const field of ['dialogue_summary', 'short_description', 'background_note']) item[field] = replace(item[field]);
    item.content_version++; item.updated_at = stamp;
  }
  Object.assign(row(expected.knowledge_items, ids.itemId), { canonical_name: name, normalized_name: norm(name), name_override: null, name_override_identity: null });
  expected.knowledge_aliases = expected.knowledge_aliases.flatMap(value => value.item_id !== ids.itemId ? [value] :
    norm(replace(value.alias)) === norm(name) ? [] : [{ ...value, alias: replace(value.alias), normalized_alias: norm(replace(value.alias)) }]);
  const relation = expected.relations.find(value => value.listening_id === ids.listeningId);
  assert.ok(relation);
  for (const assertion of expected.relation_assertions.filter(value => value.relation_id === relation.id)) {
    for (const field of ['statement', 'conditions', 'time_scope', 'attribution']) assertion[field] = replace(assertion[field]);
    assertion.assertion_key = digest(JSON.stringify([norm(assertion.statement), assertion.polarity, assertion.modality,
      assertion.conditions && norm(assertion.conditions), assertion.time_scope && norm(assertion.time_scope), assertion.attribution && norm(assertion.attribution), assertion.correction_of]));
    assertion.version++; assertion.updated_at = stamp;
  }
  const additions = after.knowledge_revisions.filter(value => !before.knowledge_revisions.some(old => old.id === value.id));
  assert.equal(additions.length, 1); assert.ok(uuid(additions[0].id));
  expected.knowledge_revisions.push({ id: additions[0].id, item_id: ids.itemId, action: 'name_replace', old_value: source, new_value: name,
    merged_from_id: null, reason: '人工纠正名称误识别', created_at: stamp });
  for (const correction of expected.knowledge_corrections.filter(value => value.listening_id === ids.listeningId && value.item_id === ids.itemId)) correction.target = name;
  expected.knowledge_corrections = expected.knowledge_corrections.filter(value => value.listening_id !== ids.listeningId || value.normalized_source !== norm(source));
  expected.knowledge_corrections.push({ listening_id: ids.listeningId, normalized_source: norm(source), source, target: name, item_id: ids.itemId });
  const listening = row(expected.listenings, ids.listeningId); listening.updated_at = stamp; listening.graph_revision++;
  return expected;
}

// Validate the same complete table delta for the browser's one-commit cases.
export function checkNameCommittedTables({ before, after, identities, id, input }) {
  try { equalTables(after, committedTables(before, after, identities, id, input), 'Committed name tables'); return { ok: true, reason: null }; }
  catch (error) { return { ok: false, reason: error.message }; }
}

function inspectNameDurable(observation, config, previousObservation, mutation = null) {
  try {
    const { actual: state, durable: raw } = observation, ids = raw.identities;
    assert.ok(['independent', 'reuse'].includes(config.mode)); assert.equal(raw.providerCalls, 0);
    assert.equal(new Set(Object.values(ids)).size, Object.values(ids).length, 'Distinct fixture identities');
    assert.ok(raw.operationIds.length === 2 && raw.operationIds.every(uuid) && new Set(raw.operationIds).size === 2);
    assert.ok(raw.versions.every(hash) && new Set(raw.versions).size === raw.versions.length);
    assert.equal(raw.versions.length, state.revision + 1); assert.equal(raw.versions[state.revision], raw.snapshot.revision);
    equalTables(raw.baseline, raw.baseline, 'Baseline'); validSnapshot(raw.baselineSnapshot, raw.baseline, ids);
    assert.equal(raw.versions[0], raw.baselineSnapshot.revision);
    const stale = row(raw.baseline.relation_supports, ids.staleId);
    assert.equal(stale.state, 'stale'); assert.equal(stale.quote, 'historical-invalid-name-evidence');
    assert.ok(row(raw.baseline.listenings, ids.unrelatedId)); assert.equal(raw.baseline.knowledge_edit_jobs.length, 0);
    assert.equal(raw.baseline.knowledge_revisions.length, 0); assert.equal(raw.baselineSnapshot.item.canonical_name, 'Deebo');
    assert.equal(raw.baseline.relation_supports.filter(value => value.segment_id === ids.segmentId && value.state === 'active').length, 4);
    if (previousObservation) {
      assert.deepEqual(raw.baseline, previousObservation.durable.baseline, 'Immutable initial full tables');
      assert.deepEqual(ids, previousObservation.durable.identities); assert.deepEqual(raw.operationIds, previousObservation.durable.operationIds);
      assert.equal(raw.events.length, previousObservation.durable.events.length + 1, 'One checkpoint for each replay step');
      assert.deepEqual(raw.events.slice(0, -1), previousObservation.durable.events, 'Immutable observation history');
      equalTables(raw.events.at(-1).before, previousObservation.durable.tables, 'Step boundary');
    }
    let prior = raw.baseline, priorSnapshot = raw.baselineSnapshot, changes = 0, background = 'none';
    const seenVersions = [priorSnapshot.revision], outcomes = new Map(), commits = new Map();
    const clients = [0, 1].map(actor => ({ phase: 'unused', rawName: '', submittedName: -1, submittedRevision: -1,
      operationId: actor, requests: 0, txResult: 'none', reply: 'none', commitBaseRevision: -1, commitBaseAnchorValid: true,
      loadedRevision: -1, loadedName: -1 }));
    let previousFinish = 0, violatedProperty = null;
    for (const [eventIndex, event] of raw.events.entries()) {
      assert.ok(Number.isSafeInteger(event.startedAtMs) && Number.isSafeInteger(event.finishedAtMs) && event.startedAtMs > 0 &&
        event.finishedAtMs >= event.startedAtMs && event.startedAtMs >= previousFinish, 'Ordered real event clock');
      previousFinish = event.finishedAtMs;
      const client = clients[event.actor], global = ['background_change', 'stutter'].includes(event.action);
      assert.ok(global ? event.actor === -1 : Boolean(client), 'Actual event actor');
      const choices = { prepare: ['new', 'same', 'exact', 'raw_mismatch', 'revision_mismatch'], send: [''], cancel: [''],
        transaction: ['ok', 'associated_fail', 'receipt_fail'], deliver: [''], lose_response: ['lost', 'proxy502'],
        lookup: ['ok', 'unavailable'], refresh: [''], background_change: ['revision', 'anchor'], stutter: [''] };
      assert.ok(choices[event.action]?.includes(event.argument), 'Actual event action/argument');
      equalTables(event.before, prior, 'Checkpoint continuity'); assert.deepEqual(event.beforeSnapshot, priorSnapshot);
      validSnapshot(event.beforeSnapshot, event.before, ids); validSnapshot(event.afterSnapshot, event.after, ids);
      let expected = structuredClone(event.before);
      if (event.action === 'background_change') {
        assert.equal(background, 'none'); background = event.argument;
        if (event.argument === 'revision') {
          const segment = row(expected.segments, ids.segmentId);
          segment.translation_text = 'Synthetic changed linked translation';
          row(expected.listenings, ids.listeningId).graph_revision++;
          for (const window of expected.relation_windows.filter(value => value.listening_id === ids.listeningId &&
            segment.sequence_no >= value.from_sequence - 3 && segment.sequence_no <= value.to_sequence)) {
            const actual = row(event.after.relation_windows, window.id);
            assert.ok(Number.isSafeInteger(actual.dirty_at) && actual.dirty_at >= event.startedAtMs - 2 && actual.dirty_at <= event.finishedAtMs + 2,
              'SQLite trigger clock within observed update boundary');
            Object.assign(window, { revision: window.revision + 1, state: 'dirty', dirty_at: actual.dirty_at, ready_at: 0, last_error: null });
          }
        }
        else {
          assert.equal(event.argument, 'anchor');
          for (const support of expected.relation_supports.filter(value => value.segment_id === ids.segmentId && value.state === 'active')) support.source_revision = 'f'.repeat(64);
        }
      } else if (event.action === 'transaction') {
        assert.equal(client.phase, 'pending'); assert.equal(client.txResult, 'none');
        assert.ok(!outcomes.has(event.actor), 'One actual transaction per attempt');
        const attempt = raw.attempts[event.actor], input = attempt.actualRequest, id = raw.operationIds[attempt.operationId];
        assert.equal(event.id, id); assert.deepEqual(event.response, attempt.actualResponse);
        const response = event.response, body = JSON.parse(response.text), existing = event.before.knowledge_edit_jobs.find(value => value.id === id);
        const current = event.beforeSnapshot.item.canonical_name, changed = input.name.trim() !== current;
        const baseRevision = seenVersions.indexOf(event.beforeSnapshot.revision), anchorValid = anchorsValid(event.before, ids.segmentId) || !changed;
        assert.equal(state.commitBaseRevision[event.actor], baseRevision); assert.equal(state.commitBaseAnchorValid[event.actor], anchorValid);
        let outcome;
        if (existing) outcome = existing.fingerprint === fingerprint(input) ? 'duplicate' : 'fingerprint_conflict';
        else if (input.revision !== event.beforeSnapshot.revision) outcome = 'revision_conflict';
        else if (!anchorValid) outcome = 'anchor_conflict';
        else if (event.argument === 'receipt_fail' || event.argument === 'associated_fail' && changed) outcome = 'rolled_back';
        else outcome = 'committed';
        if (mutation && eventIndex === raw.events.length - 1) {
          assert.equal(event.action, 'transaction');
          assert.equal(raw.mutation?.mutation, mutation);
          if (mutation === 'bypass_fingerprint') {
            assert.equal(outcome, 'fingerprint_conflict'); assert.equal(config.mode, 'reuse');
            outcome = 'duplicate'; violatedProperty = 'exactReplay';
          } else if (mutation === 'bypass_revision') {
            assert.equal(outcome, 'revision_conflict'); assert.equal(anchorValid, true); assert.equal(event.argument, 'ok');
            outcome = 'committed'; violatedProperty = 'revisionRechecked';
          } else if (mutation === 'bypass_anchor') {
            assert.equal(outcome, 'anchor_conflict'); assert.equal(event.argument, 'ok');
            outcome = 'committed'; violatedProperty = 'anchorsRechecked';
          } else {
            assert.equal(mutation, 'non_atomic_receipt'); assert.equal(outcome, 'rolled_back');
            assert.equal(event.argument, 'receipt_fail'); assert.equal(changed, true);
            expected = committedTables(event.before, event.after, ids, id, input);
            row(expected.knowledge_edit_jobs, id).state = 'running';
            changes++; violatedProperty = 'atomicRollback';
          }
        }
        client.commitBaseRevision = baseRevision; client.commitBaseAnchorValid = anchorValid; client.txResult = outcome;
        outcomes.set(event.actor, outcome);
        if (['committed', 'duplicate'].includes(outcome)) {
          assert.equal(response.status, 200); assert.equal(body.changed, outcome === 'committed' && changed);
          if (outcome === 'committed') {
            expected = committedTables(event.before, event.after, ids, id, input); changes += Number(changed);
            assert.ok(!commits.has(id)); commits.set(id, { actor: event.actor, rawName: input.name, inputRevision: seenVersions.indexOf(input.revision), revision: event.afterSnapshot.revision });
          }
          assert.deepEqual(body.job, receiptView(row(event.after.knowledge_edit_jobs, id)), 'HTTP immutable raw-bound receipt');
        } else {
          assert.equal(body.saved, false); assert.equal(response.status, outcome === 'rolled_back' ? 502 : 409);
          if (outcome === 'revision_conflict') { assert.equal(body.code, 'KNOWLEDGE_EDIT_STALE'); assert.equal(body.revision, event.beforeSnapshot.revision); }
          else if (outcome === 'fingerprint_conflict') assert.match(body.error, /同一保存任务/);
          else if (outcome === 'anchor_conflict') assert.match(body.error, /引用已改变/);
          else assert.equal(body.code, 'KNOWLEDGE_EDIT_FAILED');
        }
      } else if (event.action === 'lookup') {
        assert.equal(client.phase, 'recovering');
        const attempt = raw.attempts[event.actor], id = raw.operationIds[attempt.operationId], receipt = event.before.knowledge_edit_jobs.find(value => value.id === id);
        assert.equal(event.id, id);
        assert.equal(event.status, event.argument === 'unavailable' ? 502 : receipt ? 200 : 404);
        assert.deepEqual(event.receipt, event.argument === 'ok' && receipt ? receiptView(receipt) : null);
        client.phase = event.receipt?.saved === true ? 'saved' : 'unknown'; client.reply = event.receipt?.saved === true ? 'receipt' : 'unknown';
      } else if (event.action === 'prepare') {
        assert.equal(client.phase, 'unused');
        const reuse = ['exact', 'raw_mismatch', 'revision_mismatch'].includes(event.argument), first = clients[0];
        assert.ok(event.actor === 0 || config.mode === 'independent' ? !reuse : reuse);
        if (reuse) { assert.equal(event.actor, 1); assert.equal(config.mode, 'reuse'); assert.equal(first.requests, 1); }
        const current = seenVersions.indexOf(event.beforeSnapshot.revision), name = names.indexOf(event.beforeSnapshot.item.canonical_name);
        if (event.argument === 'revision_mismatch') assert.notEqual(current, first.submittedRevision);
        client.submittedName = reuse ? first.submittedName : event.argument === 'same' ? name : event.actor + 1;
        client.rawName = reuse ? event.argument === 'raw_mismatch' ? ` ${names[client.submittedName]} ` : first.rawName : names[client.submittedName];
        client.submittedRevision = reuse && event.argument !== 'revision_mismatch' ? first.submittedRevision : current;
        client.operationId = reuse ? 0 : event.actor; client.loadedRevision = current; client.loadedName = name; client.phase = 'prepared';
      } else if (event.action === 'send') {
        assert.equal(client.phase, 'prepared'); client.requests++; client.phase = 'pending';
      } else if (event.action === 'cancel') {
        assert.equal(client.phase, 'prepared'); client.phase = 'cancelled';
      } else if (event.action === 'deliver' || event.action === 'lose_response') {
        assert.equal(client.phase, 'pending'); assert.notEqual(client.txResult, 'none');
        const received = event.client;
        assert.ok(received && Object.keys(received).sort().join(',') === 'error,result', 'Observed client delivery');
        if (event.action === 'lose_response') {
          assert.equal(received.result, null); assert.ok(received.error && typeof received.error.message === 'string');
          assert.notEqual(received.error.outcomeUnknown, false);
          client.phase = 'recovering'; client.reply = 'unknown';
        } else if (['committed', 'duplicate'].includes(client.txResult)) {
          assert.equal(received.error, null);
          assert.deepEqual(received.result, JSON.parse(raw.attempts[event.actor].actualResponse.text), 'Delivered actual HTTP bytes');
          client.phase = 'saved'; client.reply = 'ok';
        } else {
          assert.equal(received.result, null); assert.equal(received.error?.outcomeUnknown, false);
          assert.ok(received.error.message.includes(`HTTP ${raw.attempts[event.actor].actualResponse.status}`));
          client.phase = client.txResult === 'rolled_back' ? 'failed' : 'conflict'; client.reply = client.phase;
        }
      } else if (event.action === 'refresh') {
        assert.ok(['saved', 'unknown', 'conflict', 'failed', 'cancelled'].includes(client.phase));
        client.loadedRevision = seenVersions.indexOf(event.beforeSnapshot.revision);
        client.loadedName = names.indexOf(event.beforeSnapshot.item.canonical_name); client.phase = 'done';
      } else assert.equal(event.action, 'stutter');
      equalTables(event.after, expected, `${event.action} full durable transition`);
      if (!seenVersions.includes(event.afterSnapshot.revision)) seenVersions.push(event.afterSnapshot.revision);
      prior = event.after; priorSnapshot = event.afterSnapshot;
    }
    equalTables(raw.tables, prior, 'Final raw tables'); assert.deepEqual(raw.snapshot, priorSnapshot);
    validSnapshot(raw.snapshot, raw.tables, ids); assert.deepEqual(raw.versions, seenVersions);
    assert.equal(state.name, names.indexOf(raw.snapshot.item.canonical_name)); assert.equal(state.background, background);
    for (const field of ['changes', 'sourceVersion', 'associatedVersion', 'evidenceVersion']) assert.equal(state[field], changes, field);
    for (const field of ['sourceName', 'associatedName', 'evidenceName']) assert.equal(state[field], state.name, field);
    assert.equal(state.anchorValid, anchorsValid(raw.tables, ids.segmentId));
    for (const field of ['stalePreserved', 'scopePreserved', 'identitiesPreserved']) assert.equal(state[field], true);
    assert.deepEqual(row(raw.tables.relation_supports, ids.staleId), stale, 'Original stale identity never reactivated');
    assert.equal(raw.attempts.length, 2); assert.equal(raw.operations.length, 2);
    for (const actor of [0, 1]) {
      const attempt = raw.attempts[actor], own = raw.events.filter(event => event.actor === actor), sends = own.filter(event => event.action === 'send'), prepares = own.filter(event => event.action === 'prepare');
      assert.equal(attempt.actor, actor); assert.ok(prepares.length <= 1); assert.ok(sends.length <= 1);
      for (const [field, value] of Object.entries(clients[actor])) assert.deepEqual(state[field][actor], value, `Event-derived client ${field}`);
      for (const field of ['phase', 'rawName', 'submittedRevision', 'submittedName', 'operationId', 'requests', 'txResult', 'reply', 'commitBaseRevision', 'commitBaseAnchorValid', 'loadedRevision', 'loadedName'])
        assert.deepEqual(attempt[field], state[field][actor], `Raw attempt ${field}`);
      assert.equal(state.requests[actor], sends.length); assert.equal(state.txResult[actor], outcomes.get(actor) || 'none');
      const input = prepares.length ? { name: state.rawName[actor], revision: raw.versions[state.submittedRevision[actor]] } : null;
      assert.deepEqual(attempt.actualRequest, sends.length ? input : null, 'Observed exact HTTP request');
      if (!outcomes.has(actor)) assert.equal(attempt.actualResponse, null);
      const latestRead = own.filter(event => ['prepare', 'refresh'].includes(event.action)).at(-1);
      assert.equal(state.loadedRevision[actor], latestRead ? seenVersions.indexOf(latestRead.afterSnapshot.revision) : -1);
      assert.equal(state.loadedName[actor], latestRead ? names.indexOf(latestRead.afterSnapshot.item.canonical_name) : -1);
      const committed = commits.get(raw.operationIds[actor]), operation = raw.operations[actor];
      const expected = committed ? { receipt: 'succeeded', receiptRawName: committed.rawName, receiptInputRevision: committed.inputRevision,
        receiptCommitRevision: seenVersions.indexOf(committed.revision), receiptOwner: committed.actor, commits: 1 } :
        { receipt: 'none', receiptRawName: '', receiptInputRevision: -1, receiptCommitRevision: -1, receiptOwner: -1, commits: 0 };
      assert.deepEqual(operation, expected, 'Receipt bookkeeping bound to first raw commit');
      for (const [field, value] of Object.entries(expected)) assert.deepEqual(state[field][actor], value);
    }
    if (mutation) assert.ok(violatedProperty && raw.events.at(-1)?.action === 'transaction', 'Precise first negative boundary');
    return { ok: true, reason: null, ...(mutation ? { violatedProperty } : {}) };
  } catch (error) { return { ok: false, reason: error.message }; }
}
export const inspectMatchedNameDurable = (observation, config, previousObservation) => inspectNameDurable(observation, config, previousObservation);
export function inspectNameNegativeDurable(observation, config, previousObservation, mutation) {
  if (!previousObservation || !inspectMatchedNameDurable(previousObservation, config).ok ||
      inspectMatchedNameDurable(observation, config, previousObservation).ok) return { ok: false, reason: 'Negative requires a valid normal prefix and a genuine first violation' };
  return inspectNameDurable(observation, config, previousObservation, mutation);
}
export const validMatchedNameDurable = (observation, config, previousObservation) => inspectMatchedNameDurable(observation, config, previousObservation).ok;

function listeningRows(values, listeningId) {
  const ids = new Set([listeningId]);
  const belongs = value => Object.entries(value).some(([key, id]) => (key === 'id' || key.endsWith('_id')) && ids.has(id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const rows of Object.values(values)) for (const value of rows) if (belongs(value) && value.id && !ids.has(value.id)) { ids.add(value.id); changed = true; }
  }
  return Object.fromEntries(Object.entries(values).map(([table, rows]) => [table, ordered(rows.filter(belongs))]));
}
// Browser/HTTP consumers can validate business rows without constructing model
// ordinals or attempt maps. This bounded fixture projection supports arbitrary
// replacement strings; full transition/receipt validation remains a separate gate.
export function inspectNameBusinessTables({ baseline, tables: current, identities: ids }) {
  const violations = [], projection = {};
  const check = (label, operation) => { try { assert.ok(operation(), label); } catch { violations.push(label); } };
  try {
    equalTables(baseline, baseline, 'Business baseline');
    assert.deepEqual(Object.keys(current).sort(), Object.keys(baseline).sort());
    const initialItem = row(baseline.knowledge_items, ids.itemId), item = row(current.knowledge_items, ids.itemId);
    projection.name = item.canonical_name;
    projection.sourceText = row(current.segments, ids.segmentId).original_text;
    const replace = text => text === null ? null : referenceText(text, referenceMatches(text, initialItem.canonical_name), projection.name);
    projection.stalePreserved = baseline.relation_supports.filter(value => value.state === 'stale')
      .every(value => same(current.relation_supports.find(actual => actual.id === value.id), value));
    projection.scopePreserved = same(listeningRows(baseline, ids.unrelatedId), listeningRows(current, ids.unrelatedId)) &&
      same(row(baseline.segments, ids.unlinkedId), row(current.segments, ids.unlinkedId));
    const identityTables = ['knowledge_items', 'knowledge_facts', 'relations', 'relation_assertions', 'relation_supports', 'segments', 'listening_runs'];
    const identities = values => ordered(values.map(value => Object.fromEntries(Object.entries(value).filter(([key]) => key === 'id' || key.endsWith('_id')))));
    projection.identitiesPreserved = identityTables.every(table => same(identities(current[table]), identities(baseline[table]))) &&
      same(ordered(current.relations), ordered(baseline.relations));
    const activeIds = baseline.relation_supports.filter(value => value.state === 'active').map(value => value.id).sort();
    projection.activeSupportsValid = same(current.relation_supports.filter(value => value.state === 'active').map(value => value.id).sort(), activeIds) &&
      [...new Set(current.relation_supports.filter(value => value.state === 'active').map(value => value.segment_id))].every(id => anchorsValid(current, id));
    for (const field of ['stalePreserved', 'scopePreserved', 'identitiesPreserved', 'activeSupportsValid']) check(field, () => projection[field]);
    check('Source text matches independent replacement', () => projection.sourceText === replace(row(baseline.segments, ids.segmentId).original_text));
    const initialRelation = baseline.relations.find(value => value.listening_id === ids.listeningId);
    const selected = [['knowledge_items', ids.itemId, ['dialogue_summary', 'short_description', 'background_note']],
      ['knowledge_items', ids.cameraId, ['dialogue_summary', 'short_description', 'background_note']], ['knowledge_facts', ids.factId, ['content', 'surface_text']],
      ...baseline.relation_assertions.filter(value => value.relation_id === initialRelation.id).map(value => ['relation_assertions', value.id, ['statement', 'conditions', 'time_scope', 'attribution']])];
    projection.associatedTexts = selected.map(([table, id, fields]) => {
      const before = row(baseline[table], id), after = row(current[table], id);
      for (const field of fields) check(`Associated ${table}.${field}`, () => after[field] === replace(before[field]));
      return { table, id, ...Object.fromEntries(fields.map(field => [field, after[field]])) };
    });
  } catch (error) { violations.push(`Malformed raw business tables: ${error.message}`); }
  return { ok: violations.length === 0, violations, projection };
}
