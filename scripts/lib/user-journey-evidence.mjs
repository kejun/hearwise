import assert from 'node:assert/strict';
import { digest } from './verification-evidence.mjs';
import { checkNameCommittedTables } from './name-protocol-durable.mjs';
import { playbackWorkletFiles } from '../../test-support/playback-worklet-responses.mjs';
import { speechIntervalLedger } from '../../test-support/playback-text-contract.mjs';
import { journeyText } from '../../test-support/user-journey-fixture.mjs';
import { journeyWidths, journeyStages, journeyServedFiles, journeyLimits, journeyTitle, journeyUnrelatedTitle } from '../../test-support/user-journey-contract.mjs';
import { userJourneyProfile } from '../../verification/user-journey-properties.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const contextId = value => typeof value === 'string' && /^[0-9]+-(main|competitor|reopened|negative)$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const time = value => { assert.equal(typeof value, 'string', 'journey_time'); const n = Date.parse(value); assert.ok(Number.isFinite(n), 'journey_time'); return n; };
const ordered = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const equalRows = (left, right, reason) => assert.deepEqual(ordered(left), ordered(right), reason);
const one = (rows, predicate, reason) => { const found = rows.filter(predicate); assert.equal(found.length, 1, reason); return found[0]; };
const byId = (rows, id) => one(rows, row => row.id === id, `journey_unique_id:${id}`);
const subset = (publicRow, persisted, reason) => { for (const [key, value] of Object.entries(persisted)) assert.deepEqual(publicRow?.[key], value, `${reason}:${key}`); };
const interval = (from, to, budget) => { const a = time(from), b = time(to); assert.ok(b >= a && b - a <= budget, 'journey_interval'); return [a, b]; };
const atStage = (row, name) => row.stages[journeyStages.indexOf(name)];
const since = (row, before, after, key) => row[key].slice(before?.[`${key === 'actions' ? 'action' : key === 'providerLedger' ? 'provider' : key === 'websockets' ? 'websocket' : key}Through`] || 0,
  after[`${key === 'actions' ? 'action' : key === 'providerLedger' ? 'provider' : key === 'websockets' ? 'websocket' : key}Through`]);
const stageHttp = (row, name) => { const index = journeyStages.indexOf(name); return since(row, row.stages[index - 1], row.stages[index], 'http'); };
const stageActions = (row, name) => { const index = journeyStages.indexOf(name); return since(row, row.stages[index - 1], row.stages[index], 'actions'); };
const editPath = row => `/api/listenings/${row.mainId}/knowledge/${row.itemId}/name-replacements`;
const segments = (snapshot, id) => snapshot.rows.segments.filter(row => row.listening_id === id).sort((a, b) => a.sequence_no - b.sequence_no);
const activate = (rows, target) => one(rows, row => row.target === target && (row.type === 'click' || row.type === 'press' && row.value === 'Enter' || row.type === 'download'), `journey_ui_activation:${target}`);
const receiptView = value => ({ id: value.id, state: value.state, name: value.name, source: value.source, saved: value.state === 'succeeded', error: value.error });
const expectAction = (rows, type, target, value) => one(rows, row => row.type === type && row.target === target && (value === undefined || row.value === value), `journey_ui_action:${type}:${target}`);

export function journeyRecord(snapshot, id) {
  // Preserve the full record and every descendant column, including receipts,
  // revisions and pending-work rows. Collision checks must not compare titles only.
  const accepted = new Set([id]), selected = new Map(); let changed = true;
  const links = ['listening_id', 'item_id', 'segment_id', 'run_id', 'job_id', 'window_id', 'relation_id', 'assertion_id', 'round_id'];
  while (changed) {
    changed = false;
    for (const [table, rows] of Object.entries(snapshot.rows)) for (const [index, row] of rows.entries()) {
      const key = `${table}:${index}`;
      if (!selected.has(key) && (table === 'listenings' && row.id === id || links.some(field => accepted.has(row[field])))) {
        selected.set(key, { table, row }); if (row.id) accepted.add(row.id); changed = true;
      }
    }
  }
  return Object.fromEntries(Object.keys(snapshot.rows).sort().map(table => [table, ordered([...selected.values()].filter(row => row.table === table).map(row => row.row))]));
}
function database(snapshot) {
  assert.equal(snapshot?.integrity, 'ok', 'journey_sqlite_integrity'); assert.deepEqual(snapshot.foreignKeyErrors, [], 'journey_sqlite_foreign_keys');
  assert.ok(Array.isArray(snapshot.schema) && snapshot.schema.length, 'journey_sqlite_schema');
  const tables = snapshot.schema.filter(row => row.type === 'table').map(row => row.name).sort();
  assert.deepEqual(Object.keys(snapshot.rows).sort(), tables, 'journey_complete_table_inventory');
  for (const name of ['listenings', 'listening_runs', 'segments', 'knowledge_items', 'knowledge_facts', 'knowledge_mentions', 'knowledge_edit_jobs',
    'relations', 'relation_assertions', 'relation_supports', 'relation_jobs', 'relation_requests']) assert.ok(tables.includes(name), `journey_missing_table:${name}`);
  for (const rows of Object.values(snapshot.rows)) { assert.ok(Array.isArray(rows)); const ids = rows.filter(row => Object.hasOwn(row, 'id')).map(row => row.id); assert.equal(new Set(ids).size, ids.length, 'journey_duplicate_database_id'); }
}
function expectedName(name) {
  const index = journeyStages.indexOf(name);
  if (index < journeyStages.indexOf('name-corrected')) return 'Eastman Kodak';
  if (index < journeyStages.indexOf('conflict-rejected')) return 'Kodak';
  if (index < journeyStages.indexOf('conflict-recovered')) return 'Kodak Company';
  if (index < journeyStages.indexOf('receipt-recovered')) return 'Eastman Kodak Company';
  if (index < journeyStages.indexOf('save-uncertain')) return 'Kodak Incorporated';
  return 'Kodak Final';
}
function bindKnowledge(publicRows, snapshot, id) {
  const items = snapshot.rows.knowledge_items.filter(row => row.listening_id === id);
  equalRows(publicRows.map(row => row.id), items.map(row => row.id), 'journey_public_knowledge_ids');
  for (const item of items) {
    const value = byId(publicRows, item.id); subset(value, item, 'journey_public_item');
    assert.equal(value.display_name, item.canonical_name);
    for (const [field, table] of [['facts', 'knowledge_facts'], ['mentions', 'knowledge_mentions'], ['revisions', 'knowledge_revisions']])
      equalRows(value[field], snapshot.rows[table].filter(row => row.item_id === item.id), `journey_public_${field}`);
    equalRows(value.aliases, snapshot.rows.knowledge_aliases.filter(row => row.item_id === item.id).map(row => row.alias), 'journey_public_aliases');
  }
}
function bindPublic(stage, row) {
  const snapshot = stage.database, record = snapshot.rows.listenings.find(value => value.id === row.mainId);
  if (!record) { assert.equal(stage.detail, null); assert.equal(stage.graph, null); return; }
  if (stage.name === 'listening-started' || stage.name === 'captions') return;
  assert.ok(stage.detail && stage.graph, `journey_public_missing:${stage.name}`);
  subset(stage.detail.listening, record, 'journey_public_listening');
  equalRows(stage.detail.runs, snapshot.rows.listening_runs.filter(value => value.listening_id === row.mainId), 'journey_public_runs');
  assert.deepEqual(stage.detail.segments, segments(snapshot, row.mainId)); assert.equal(stage.detail.segmentCount, 2);
  bindKnowledge(stage.detail.knowledge, snapshot, row.mainId); bindKnowledge(stage.graph.nodes, snapshot, row.mainId);
  const owned = journeyRecord(snapshot, row.mainId);
  for (const [field, table] of [['relations', 'relations'], ['assertions', 'relation_assertions'], ['supports', 'relation_supports'], ['revisions', 'relation_revisions']]) {
    equalRows(stage.graph[field].map(value => value.id), owned[table].map(value => value.id), `journey_public_graph_${field}`);
    for (const value of owned[table]) subset(byId(stage.graph[field], value.id), value, `journey_public_graph_${field}`);
  }
}
export function assertJourneyView(stage, row, { name = expectedName(stage.name), title = journeyTitle, graph = true } = {}) {
  const source = journeyText.original.map(text => text.replaceAll('Eastman Kodak', name));
  const dbSegments = segments(stage.database, row.mainId), items = stage.database.rows.knowledge_items.filter(value => value.listening_id === row.mainId);
  assert.equal(stage.ui.recordTitle, title, 'journey_dom_title');
  assert.equal(stage.ui.notes, byId(stage.database.rows.listenings, row.mainId).notes, 'journey_dom_notes');
  assert.deepEqual(stage.ui.transcript.map(value => ({ id: value.id, original: value.original, translation: value.translation })), dbSegments.map((value, index) => ({
    id: value.id, original: source[index], translation: journeyText.translation[index] })), 'journey_dom_transcript');
  equalRows(stage.ui.knowledge.map(value => value.id), items.map(value => value.id), 'journey_dom_card_identity');
  for (const item of items) {
    const card = byId(stage.ui.knowledge, item.id); assert.equal(card.name, item.canonical_name, 'journey_dom_card_name');
    assert.equal(card.summary, item.short_description || item.dialogue_summary, 'journey_dom_card_summary');
    equalRows(card.facts, stage.database.rows.knowledge_facts.filter(value => value.item_id === item.id).map(value => `本次提到：${value.content}`), 'journey_dom_card_facts');
  }
  if (!graph) return;
  equalRows(stage.ui.graph.nodes.map(value => value.id), items.map(value => value.id), 'journey_dom_graph_identity');
  for (const item of items) assert.ok(byId(stage.ui.graph.nodes, item.id).text.startsWith(`${item.canonical_name} · `), 'journey_dom_graph_name');
  const relations = stage.database.rows.relations.filter(value => value.listening_id === row.mainId);
  equalRows(stage.ui.graph.relations.map(value => value.id), relations.map(value => value.id), 'journey_dom_relation_identity');
  for (const relation of relations) {
    assert.equal(relation.predicate, 'released'); const subject = byId(items, relation.subject_item_id), object = byId(items, relation.object_item_id);
    const text = `${subject.canonical_name} → 推出 → ${object.canonical_name}`, visible = byId(stage.ui.graph.relations, relation.id);
    assert.equal(visible.text, text, 'journey_dom_relation_text'); assert.equal(visible.label, `查看关系依据：${text}`, 'journey_dom_relation_label');
  }
  assert.equal(stage.ui.graph.detailTitle, name, 'journey_dom_graph_title');
  assert.ok(stage.ui.graph.detailText.includes(name), 'journey_dom_graph_detail');
}
function verifyListening(row) {
  const start = atStage(row, 'listening-started'), captions = atStage(row, 'captions'), stopped = atStage(row, 'stopped');
  assert.equal(atStage(row, 'empty').database.rows.listenings.length, 0, 'journey_starts_empty');
  assert.ok(Object.values(atStage(row, 'empty').database.rows).every(rows => rows.length === 0), 'journey_unseeded_database');
  assert.equal(start.database.rows.listenings.length, 1); assert.equal(start.database.rows.listening_runs.length, 1);
  assert.equal(start.database.rows.listening_runs[0].state, 'active'); assert.equal(start.database.rows.segments.length, 0);
  expectAction(stageActions(row, 'listening-started'), 'press', '#toggle', 'Enter');
  activate(stageActions(row, 'stopped'), '#toggle');
  const sockets = row.websockets.filter(value => value.path === '/ws'); assert.equal(sockets.length, 2, 'journey_two_ui_listenings');
  const runs = [byId(stopped.database.rows.listenings, row.mainId), byId(atStage(row, 'unrelated-created').database.rows.listenings, row.unrelatedId)];
  for (const record of runs) {
    const snapshot = record.id === row.mainId ? stopped.database : atStage(row, 'unrelated-created').database;
    const run = one(snapshot.rows.listening_runs, value => value.listening_id === record.id, 'journey_one_run'); assert.equal(run.state, 'complete');
    const socket = one(sockets, value => value.received.some(message => message.type === 'listening-ready' && message.listeningId === record.id), 'journey_socket_identity');
    const ready = one(socket.received, value => value.type === 'listening-ready', 'journey_ready_once'); assert.equal(ready.runId, run.id);
    assert.ok(socket.sent.some(message => message.type === 'start'), 'journey_ws_start');
    assert.ok(socket.sent.some(message => message.type === 'binary' && message.bytes > 0), 'journey_real_audio_frames');
    assert.ok(socket.sent.some(message => message.type === 'stop'), 'journey_ws_stop');
    const finals = socket.received.filter(message => message.type === 'segment-final'); assert.equal(finals.length, 2);
    for (const [index, message] of finals.entries()) { assert.equal(message.runId, run.id); assert.equal(message.segment.id, segments(snapshot, record.id)[index].id); assert.equal(message.segment.original_text, journeyText.original[index]); }
    assert.deepEqual(segments(snapshot, record.id).map(value => value.original_text), journeyText.original);
    assert.deepEqual(segments(snapshot, record.id).map(value => value.translation_text), journeyText.translation);
  }
  assert.equal(captions.ui.caption.original, journeyText.original[1]); assert.equal(captions.ui.caption.translation, journeyText.translation[1]);
  assert.ok(stopped.ui.microphoneTracks.length > 0 && stopped.ui.microphoneTracks.every(value => value.state === 'ended'), 'journey_microphone_released');
  assert.deepEqual(segments(captions.database, row.mainId).map(value => value.translation_text), journeyText.translation);
  assert.ok(stopped.database.rows.extraction_jobs.length > 0 && stopped.database.rows.extraction_jobs.every(value => value.state === 'complete'), 'journey_extraction_terminal');
  const translations = row.providerLedger.filter(value => value.kind === 'translation');
  assert.equal(translations.length, 4, 'journey_translation_request_budget');
  for (const text of journeyText.original) {
    const matches = translations.filter(value => value.input === text); assert.equal(matches.length, 2);
    for (const match of matches) assert.equal(match.output, journeyText.translation[journeyText.original.indexOf(text)]);
  }
  const knowledge = row.providerLedger.filter(value => value.kind === 'knowledge'); assert.ok(knowledge.length >= 2);
  const allSegments = atStage(row, 'unrelated-created').database.rows.segments;
  for (const request of knowledge) {
    assert.ok(request.input.focus_segments.length > 0); assert.ok(request.output.items.length > 0);
    for (const focus of request.input.focus_segments) assert.equal(byId(allSegments, focus.id).original_text, focus.text, 'journey_provider_source');
    const owners = new Set(request.input.focus_segments.map(value => byId(allSegments, value.id).listening_id)); assert.equal(owners.size, 1, 'journey_knowledge_single_owner');
    const listeningId = [...owners][0], snapshot = atStage(row, 'unrelated-created').database;
    const names = ['Eastman Kodak', 'Brownie camera'].filter(name => request.input.focus_segments.some(value => value.text.includes(name)));
    assert.deepEqual(request.output.items.map(value => value.canonical_name), names, 'journey_knowledge_authored_names');
    for (const proposal of request.output.items) {
      const name = proposal.canonical_name, focus = request.input.focus_segments.find(value => value.text.includes(name));
      const existing = request.input.existing_candidates.find(value => value.canonical_name === name);
      const description = name === 'Eastman Kodak' ? '推出布朗尼相机的公司。' : '面向日常摄影的相机。';
      assert.deepEqual(proposal, { action: existing ? 'repeat' : 'create', display_label: name === 'Eastman Kodak' ? 'organization' : 'product',
        canonical_name: name, role: '讨论对象', reason: '原文明确提及', existing_item_id: existing?.id ?? null, observed_candidate_id: null, correction_reason: null, aliases: [],
        certainty: 'clear', short_description: description, new_information: focus.text, evidence: [{ segment_id: focus.id, quote: name }] }, 'journey_knowledge_authored_proposal');
      const item = one(snapshot.rows.knowledge_items, value => value.listening_id === listeningId && value.canonical_name === name, 'journey_knowledge_persisted_item');
      assert.equal(item.short_description, description); assert.equal(item.display_label, proposal.display_label);
      if (existing) assert.equal(existing.id, item.id, 'journey_knowledge_repeat_identity');
      assert.ok(snapshot.rows.knowledge_facts.some(value => value.item_id === item.id && value.segment_id === focus.id && value.surface_text === name && value.content === focus.text), 'journey_knowledge_persisted_fact');
      assert.ok(snapshot.rows.knowledge_mentions.some(value => value.item_id === item.id && value.segment_id === focus.id && value.surface_text === name), 'journey_knowledge_persisted_mention');
    }
  }
}
function verifyGraph(row) {
  const held = atStage(row, 'graph-held'), cancelled = atStage(row, 'graph-cancelled'), current = atStage(row, 'graph-retry-complete'), late = atStage(row, 'graph-late-completed');
  const calls = row.providerLedger.filter(value => value.kind === 'relation'); assert.equal(calls.length, 2, 'journey_relation_request_budget');
  const old = calls[0], fresh = calls[1]; assert.equal(old.held, true); assert.equal(fresh.held, false);
  assert.ok(time(old.startedAt) <= time(held.at)); assert.ok(time(old.completedAt) > time(current.at));
  assert.ok(time(fresh.startedAt) >= time(cancelled.at) && time(fresh.completedAt) <= time(current.at), 'journey_continues_while_old_held');
  assert.ok(old.transport.some(value => value.type === 'close' && value.destroyed === true), 'journey_cancelled_transport_closed');
  assert.ok(old.transport.some(value => value.type === 'provider-return' && time(value.at) >= time(current.at)), 'journey_late_physical_completion');
  activate(stageActions(row, 'graph-cancelled'), '#graph-cancel');
  activate(stageActions(row, 'graph-retry-complete'), '#graph-generate');
  assert.ok(cancelled.database.rows.relation_jobs.some(value => value.state === 'cancelled'), 'journey_cancel_durable');
  for (const [stageName, method] of [['graph-held', 'POST'], ['graph-cancelled', 'DELETE'], ['graph-retry-complete', 'POST']]) {
    const wire = one(stageHttp(row, stageName), value => value.path === `/api/listenings/${row.mainId}/graph` && value.method === method, 'journey_graph_ui_http'); assert.equal(wire.status, 200);
  }
  assert.equal(current.graph.status.state, 'complete');
  assert.equal(current.database.rows.relation_requests.length, 2);
  assert.equal(current.database.rows.relation_jobs.reduce((n, value) => n + value.request_count, 0), 2);
  assert.deepEqual(late.database, current.database, 'journey_late_completion_no_write');
  assert.deepEqual(late.graph, current.graph, 'journey_late_completion_no_graph_change');
  const relation = one(current.database.rows.relations, value => value.listening_id === row.mainId, 'journey_one_authored_relation');
  assert.equal(relation.subject_item_id, row.itemId); assert.equal(relation.predicate, 'released');
  const camera = one(current.database.rows.knowledge_items, value => value.canonical_name === 'Brownie camera', 'journey_camera'); assert.equal(relation.object_item_id, camera.id);
  for (const request of calls) {
    assert.equal(request.output.relations.length, 1); const proposed = request.output.relations[0];
    assert.equal(proposed.subject_item_id, row.itemId); assert.equal(proposed.object_item_id, camera.id); assert.equal(proposed.predicate, 'released');
    assert.ok(proposed.evidence_ids.length > 0);
    for (const id of proposed.evidence_ids) assert.equal(byId(request.input.evidence, id).quote, journeyText.original[0]);
  }
}
function verifyEdits(row) {
  assert.equal(row.http.filter(value => value.path === editPath(row) && value.method === 'POST').length, 7, 'journey_no_hidden_name_resend');
  const names = [['name-corrected', 'Kodak'], ['conflict-rejected', 'Kodak Company'], ['conflict-recovered', 'Eastman Kodak Company'],
    ['receipt-recovered', 'Kodak Incorporated'], ['save-uncertain', 'Kodak Final']];
  const cameraId = one(atStage(row, 'unrelated-created').database.rows.knowledge_items, value => value.listening_id === row.mainId && value.canonical_name === 'Brownie camera', 'journey_main_camera').id;
  for (const [stageName, name] of names) {
    const index = journeyStages.indexOf(stageName), before = row.stages[index - 1], after = row.stages[index];
    const added = after.database.rows.knowledge_edit_jobs.filter(value => !before.database.rows.knowledge_edit_jobs.some(old => old.id === value.id));
    assert.equal(added.length, 1, `journey_one_edit_receipt:${stageName}`); const receipt = added[0];
    const request = one(stageHttp(row, stageName), value => value.path === editPath(row) && value.method === 'POST' && value.request?.name === name, `journey_ui_edit_post:${stageName}`);
    assert.equal(request.idempotencyKey, receipt.id); assert.equal(receipt.state, 'succeeded');
    if (request.status === 200) assert.deepEqual(request.response.job, receiptView(receipt), 'journey_public_committed_receipt');
    const checked = checkNameCommittedTables({ before: before.database.rows, after: after.database.rows,
      identities: { listeningId: row.mainId, itemId: row.itemId, cameraId, segmentId: segments(before.database, row.mainId)[0].id }, id: receipt.id, input: request.request });
    assert.equal(checked.ok, true, `journey_atomic_name_delta:${stageName}:${checked.reason}`);
  }
  const rejected = atStage(row, 'conflict-rejected'), stale = one(stageHttp(row, 'conflict-rejected'), value => value.path === editPath(row) && value.status === 409, 'journey_explicit_stale_rejection');
  assert.equal(stale.response.code, 'KNOWLEDGE_EDIT_STALE'); assert.equal(stale.response.saved, false);
  assert.equal(stale.request.name, 'Eastman Kodak Company'); assert.equal(rejected.ui.editor.draft, stale.request.name);
  assert.equal(rejected.ui.editor.source, 'Kodak Company'); assert.equal(rejected.ui.editor.open, true);
  assert.match(rejected.ui.editor.status, /输入已保留/); assert.equal(rejected.ui.editor.saveDisabled, false);
  assert.notEqual(stale.contextId, one(stageHttp(row, 'conflict-rejected'), value => value.path === editPath(row) && value.status === 200, 'journey_competing_ui_actor').contextId);
  for (const stageName of ['receipt-recovered', 'save-uncertain']) {
    const stage = atStage(row, stageName), requests = stageHttp(row, stageName);
    const post = one(requests, value => value.method === 'POST' && value.path === editPath(row), 'journey_one_uncertain_post');
    assert.equal(post.status, 502);
    const upstream = one(row.faults, value => value.idempotencyKey === post.idempotencyKey, 'journey_actual_committed_upstream');
    assert.equal(upstream.status, 200); assert.equal(upstream.contextId, post.contextId); assert.ok(time(upstream.at) <= time(stage.at));
    assert.deepEqual(upstream.request, post.request);
    const persistedReceipt = byId(stage.database.rows.knowledge_edit_jobs, post.idempotencyKey);
    assert.deepEqual(upstream.response.job, receiptView(persistedReceipt), 'journey_upstream_exact_receipt');
    const receipt = one(requests, value => value.method === 'GET' && value.path === editPath(row).replace('/name-replacements', `/edits/${post.idempotencyKey}`), 'journey_receipt_lookup');
    assert.equal(receipt.status, stageName === 'receipt-recovered' ? 200 : 502);
    if (receipt.status === 200) assert.deepEqual(receipt.response.job, receiptView(persistedReceipt), 'journey_lookup_exact_receipt');
  }
  for (const name of ['conflict-rejected', 'save-uncertain', 'save-reopened']) assert.equal(atStage(row, name).ui.activeElement.id, 'knowledge-edit-name', 'journey_recovery_focus');
  const uncertain = atStage(row, 'save-uncertain'); assert.equal(uncertain.ui.editor.open, true); assert.equal(uncertain.ui.editor.draft, 'Kodak Final');
  assert.equal(uncertain.ui.editor.saveDisabled, true); assert.equal(uncertain.ui.editor.closeDisabled, false); assert.match(uncertain.ui.editor.status, /保存结果尚未确认/);
  assert.deepEqual(atStage(row, 'save-reopened').database, uncertain.database, 'journey_reopen_does_not_resend');
  assert.equal(stageHttp(row, 'save-reopened').filter(value => value.method === 'POST' && value.path === editPath(row)).length, 0);
}
function verifyPlayback(row) {
  for (const [stageName, kind, source] of [['source-played', 'original', journeyText.original.map(text => text.replaceAll('Eastman Kodak', 'Kodak Final'))],
    ['translation-played', 'translation', journeyText.translation]]) {
    const stage = atStage(row, stageName), sockets = stage.playback.sockets;
    const socket = one(sockets, value => value.sent.some(message => message.type === 'speech.transcript' && message.kind === kind && message.listeningId === row.mainId), `journey_playback_${kind}`);
    const units = socket.received.filter(value => value.type === 'speech.unit'); assert.ok(units.length > 0);
    speechIntervalLedger(source.join(' '), units.map(value => value.text), { graphemeSafe: true });
    const pcm = socket.received.filter(value => value.type === 'pcm'); assert.ok(pcm.length > 0);
    assert.ok(pcm.every(value => value.bytes === 16 + value.samples * 2 && value.samples > 0), 'journey_pcm_headers');
    const progress = socket.sent.filter(value => value.type === 'speech.progress').at(-1);
    assert.deepEqual(stage.playback.commits, row.ttsLedger.slice(stage.playback.commitFrom, stage.playback.commitFrom + units.length).map(value => value.text));
    assert.deepEqual(stage.playback.commits, units.map(value => value.text), 'journey_playback_provider_wire');
    assert.equal(progress.playedUnit, units.length); assert.equal(progress.consumedSamples, pcm.reduce((n, value) => n + value.samples, 0), 'journey_consumed_audio');
    assert.equal(stage.ui.speech.enabled, false); assert.ok(stage.ui.speech.contexts.every(value => value.state === 'closed'));
  }
  const original = journeyText.original.map(text => text.replaceAll('Eastman Kodak', 'Kodak Final'));
  const acceptedTexts = [...original, ...journeyText.translation, ...journeyText.translation];
  assert.deepEqual(row.ttsLedger.map(value => value.text), acceptedTexts, 'journey_actual_tts_requests');
  assert.deepEqual(row.ttsLedger.map(value => value.delivered), [true, true, true, true, false, true], 'journey_actual_tts_delivery');
  assert.ok(row.ttsLedger.every(value => value.samples === 6000));
  const paused = atStage(row, 'paused-seek'), resumed = atStage(row, 'seek-resumed');
  assert.equal(paused.ui.speech.paused, true); assert.equal(paused.ui.speech.enabled, true); assert.equal(resumed.ui.speech.paused, false);
  const socket = paused.playback.sockets.at(-1), start = one(socket.sent, value => value.type === 'speech.transcript', 'journey_seek_transport');
  assert.equal(start.startPosition, 2); assert.equal(start.listeningId, row.mainId); assert.equal(start.paused, true);
  assert.ok(resumed.playback.sockets.at(-1).sent.some(value => value.type === 'speech.resume'), 'journey_seek_resume');
  assert.ok(stageActions(row, 'paused-seek').some(value => value.type === 'press' && value.target === '#transcript-speech-seek' && value.value === 'End'), 'journey_keyboard_seek');
}
function verifyImports(row) {
  assert.equal(row.downloads.length, 2, 'journey_two_ui_exports');
  const initial = row.downloads[0], final = row.downloads[1];
  for (const [download, stageName] of [[initial, 'exported'], [final, 'final-exported']]) {
    assert.ok(hash(download.sha256)); assert.ok(download.bytes > 100); assert.ok(download.path.endsWith('.sqlite'));
    assert.deepEqual(download.database, atStage(row, stageName).database, 'journey_export_complete_snapshot');
    assert.equal(row.actions[download.actionIndex].type, 'download');
    activate(stageActions(row, stageName), '#data-export');
    assert.ok(stageHttp(row, stageName).some(value => value.method === 'GET' && value.path === '/api/data/export' && value.status === 200));
  }
  const documents = new Map(), urls = new Map();
  for (const request of row.http.filter(value => value.path.startsWith('/api/data/import/'))) {
    const document = `${request.contextId}:${request.documentIndex}`, url = row.base + request.path + request.query;
    assert.ok(request.fetch, 'journey_fetch_observation_missing'); assert.equal(request.fetch.url, url, 'journey_fetch_url');
    assert.equal(request.fetch.method, request.method, 'journey_fetch_method');
    assert.equal(request.fetch.index, documents.get(document) || 0, 'journey_fetch_document_index'); documents.set(document, request.fetch.index + 1);
    const key = `${document}:${url}`; assert.equal(request.responseIndex, urls.get(key) || 0, 'journey_fetch_url_index'); urls.set(key, request.responseIndex + 1);
  }
  const validations = row.http.filter(value => value.method === 'POST' && value.path === '/api/data/import/validate');
  const commits = row.http.filter(value => value.method === 'POST' && value.path === '/api/data/import/commit');
  const refresh = one(row.http, value => value.path === '/api/data/import/preview', 'journey_single_stale_preview_refresh');
  assert.equal(validations.length, 3); assert.equal(commits.length, 4); assert.equal(refresh.status, 200);
  for (const request of [...validations, refresh]) {
    assert.ok(hash(request.response.tokenSha256) && hash(request.response.previewTokenSha256), 'journey_import_capability_hashes');
    assert.equal(request.response.mode, 'append'); assert.equal(request.response.currentCount, 1);
    assert.equal(request.response.listeningCount, 2); assert.equal(request.response.addedCount, 1); assert.equal(request.response.skippedCount, 1);
  }
  assert.equal(refresh.request.tokenSha256, validations[0].response.tokenSha256); assert.equal(refresh.response.tokenSha256, validations[0].response.tokenSha256);
  assert.notEqual(refresh.response.previewTokenSha256, validations[0].response.previewTokenSha256);
  const previews = [validations[0], refresh, validations[1], validations[2]];
  for (const [index, commit] of commits.entries()) for (const key of ['tokenSha256', 'previewTokenSha256']) assert.equal(commit.request[key], previews[index].response[key], `journey_import_correlation:${index}:${key}`);
  assert.equal(new Set(validations.map(value => value.response.tokenSha256)).size, 3, 'journey_new_upload_capabilities');
  const current = atStage(row, 'import-reviewed-stale'), stale = atStage(row, 'import-stale-rejected'), expired = atStage(row, 'import-expiry-rejected');
  const edited = journeyRecord(stale.database, row.mainId), prior = journeyRecord(current.database, row.mainId);
  assert.notDeepEqual(edited.listenings, prior.listenings, 'journey_competing_metadata_edit');
  const changed = structuredClone(prior); changed.listenings[0].notes = edited.listenings[0].notes;
  assert.deepEqual(edited, changed, 'journey_competing_notes_only');
  const post = one(stageHttp(row, 'import-stale-rejected'), value => value.path === '/api/data/import/commit', 'journey_stale_import_once');
  assert.equal(post.status, 409); assert.equal(post.response.code, 'IMPORT_PREVIEW_STALE');
  const expiry = one(stageHttp(row, 'import-expiry-rejected'), value => value.path === '/api/data/import/commit', 'journey_expired_import_once');
  assert.equal(expiry.status, 410); assert.equal(expiry.response.code, 'IMPORT_EXPIRED');
  assert.deepEqual(expired.database, stale.database, 'journey_expired_import_no_write');
  assert.deepEqual(atStage(row, 'import-token-expired').database, stale.database);
  const expiryEvent = one(row.clockEvents, value => value.command === 'expire', 'journey_actual_expiry_callback');
  assert.equal(expiryEvent.error, null); assert.ok(expiryEvent.timers.some(value => value.active === false && value.requestedMilliseconds === 900000));
  for (const [stageName, download] of [['import-reviewed-stale', initial], ['import-reuploaded', initial], ['import-reviewed', final]]) {
    const actions = stageActions(row, stageName), upload = one(actions, value => value.type === 'upload' && value.target === '#data-import-file', 'journey_actual_file_input');
    assert.equal(upload.value.sha256, download.sha256); assert.equal(upload.value.bytes, download.bytes);
    const request = one(stageHttp(row, stageName), value => value.method === 'POST' && value.path.startsWith('/api/data/import/validate'), 'journey_actual_upload_request');
    const observed = request.fetch?.requestBody;
    assert.equal(observed?.kind, 'File', 'journey_actual_file_body'); assert.equal(observed.name, download.path);
    assert.equal(observed.sha256, download.sha256, 'journey_observed_upload_hash'); assert.equal(observed.size, download.bytes, 'journey_observed_upload_bytes');
    assert.equal(request.query, '?mode=append'); assert.equal(request.request.mode, 'append');
    if (request.request.uploadSha256 === null || request.request.uploadBytes === null) {
      assert.equal(request.request.uploadSha256, null); assert.equal(request.request.uploadBytes, null);
    } else { assert.equal(request.request.uploadSha256, download.sha256); assert.equal(request.request.uploadBytes, download.bytes); }
    assert.equal(request.status, 200); assert.equal(request.response.mode, 'append');
    assert.equal(atStage(row, stageName).ui.import.append, true); assert.equal(atStage(row, stageName).ui.import.confirmDisabled, false);
  }
  for (const stageName of ['import-stale-rejected', 'import-expiry-rejected', 'import-collision-preserved', 'import-restored']) {
    activate(stageActions(row, stageName), '#data-import-confirm');
    const commit = one(stageHttp(row, stageName), value => value.path === '/api/data/import/commit', 'journey_explicit_import_commit');
    assert.equal(commit.method, 'POST'); assert.equal(commit.request.mode, 'append');
    assert.ok(hash(commit.request.tokenSha256) && hash(commit.request.previewTokenSha256), 'journey_redacted_import_capabilities');
    if (['import-collision-preserved', 'import-restored'].includes(stageName)) {
      assert.equal(commit.status, 200); assert.equal(commit.response.addedCount, 1); assert.equal(commit.response.skippedCount, 1);
    }
  }
  const collision = atStage(row, 'import-collision-preserved');
  assert.deepEqual(journeyRecord(collision.database, row.mainId), edited, 'journey_append_full_local_collision');
  assert.deepEqual(journeyRecord(collision.database, row.unrelatedId), journeyRecord(initial.database, row.unrelatedId), 'journey_restore_auxiliary_from_backup');
  for (const [stageName, id] of [['unrelated-deleted', row.unrelatedId], ['main-deleted', row.mainId]]) {
    const stage = atStage(row, stageName); assert.equal(stage.database.rows.listenings.some(value => value.id === id), false);
    assert.ok(stageActions(row, stageName).some(value => value.type === 'dialog-accept'), 'journey_explicit_delete_confirmation');
    assert.equal(one(stageHttp(row, stageName), value => value.method === 'DELETE' && value.path === `/api/listenings/${id}`, 'journey_ui_delete').status, 200);
  }
  assert.deepEqual(atStage(row, 'import-restored').database, final.database, 'journey_restore_exact_backup');
  assert.deepEqual(atStage(row, 'restored-reopened').database, final.database, 'journey_restore_reopen');
}
function verifyNegative(row, sourceDigests, mutation) {
  const negative = row.negative; assert.equal(negative.property, 'HW-11-06');
  assert.equal(negative.screenshot, `journey-${row.width}-negative.png`); assert.deepEqual(negative.mutation, mutation);
  assert.equal(mutation.file, 'public/knowledge-editor.js'); assert.equal(mutation.sourceSha256, sourceDigests[mutation.file]);
  assert.ok(hash(mutation.mutantSha256) && mutation.mutantSha256 !== mutation.sourceSha256);
  assert.equal(negative.before.dbPathSha256, row.stages[0].dbPathSha256); assert.equal(negative.after.dbPathSha256, negative.before.dbPathSha256);
  assert.deepEqual(negative.before.database, atStage(row, 'restored-reopened').database);
  assertJourneyView(negative.before, row, { name: 'Kodak Final', graph: false });
  assert.equal(byId(negative.after.database.rows.knowledge_items, row.itemId).canonical_name, 'Kodak Broken Refresh');
  assert.deepEqual(negative.after.ui.knowledge, negative.before.ui.knowledge, 'journey_negative_actual_stale_cards');
  assert.throws(() => assertJourneyView(negative.after, row, { name: 'Kodak Broken Refresh', graph: false }), 'journey_negative_must_trip_real_reader');
  const before = negative.before, after = negative.after; database(after.database);
  assert.equal(before.selectedId, row.mainId); assert.equal(after.selectedId, row.mainId); assert.equal(after.contextId, negative.contextId);
  assert.ok(time(before.at) >= time(row.stages.at(-1).at) && time(after.at) >= time(before.at) && time(after.at) <= time(row.cleanupStartedAt), 'journey_negative_time_containment');
  const posts = row.http.slice(before.httpThrough, after.httpThrough).filter(value => value.method !== 'GET');
  const post = one(posts, value => value.path === editPath(row), 'journey_negative_exact_post'); assert.equal(posts.length, 1);
  assert.equal(post.status, 200); assert.equal(post.request.name, 'Kodak Broken Refresh');
  assert.deepEqual(post.response.job, receiptView(byId(after.database.rows.knowledge_edit_jobs, post.idempotencyKey)), 'journey_negative_exact_receipt');
  const cameraId = one(before.database.rows.knowledge_items, value => value.listening_id === row.mainId && value.canonical_name === 'Brownie camera', 'journey_negative_camera').id;
  const delta = checkNameCommittedTables({ before: before.database.rows, after: after.database.rows,
    identities: { listeningId: row.mainId, itemId: row.itemId, cameraId, segmentId: segments(before.database, row.mainId)[0].id }, id: post.idempotencyKey, input: post.request });
  assert.equal(delta.ok, true, `journey_negative_exact_transaction:${delta.reason}`);
  expectAction(row.actions.slice(before.actionThrough, after.actionThrough), 'fill', '#knowledge-edit-name', 'Kodak Broken Refresh');
  expectAction(row.actions.slice(before.actionThrough, after.actionThrough), 'press', '#knowledge-edit-name', 'Enter');
  assert.ok(row.served.some(value => value.file === mutation.file && value.sha256 === mutation.mutantSha256 && value.contextId === negative.after.contextId), 'journey_negative_served_mutant');
}
function inspectWidth(row, { sourceDigests, mutation }) {
  const [start, finish] = interval(row.startedAt, row.finishedAt, journeyLimits.browserMs);
  assert.equal(row.complete, true); assert.ok(!row.failure, 'journey_width_failure');
  assert.ok(uuid(row.fixtureId) && uuid(row.mainId) && uuid(row.unrelatedId) && uuid(row.itemId)); assert.notEqual(row.mainId, row.unrelatedId);
  assert.ok(['127.0.0.1', '[::1]'].includes(new URL(row.base).hostname), 'journey_loopback_only');
  assert.deepEqual(row.errors, []); assert.deepEqual(row.stages.map(value => value.name), journeyStages, 'journey_exact_stage_order');
  for (const key of ['actions', 'http', 'websockets', 'providerLedger', 'served', 'downloads', 'clockEvents']) assert.ok(Array.isArray(row[key]), `journey_raw_array:${key}`);
  for (const key of ['actions', 'http', 'websockets']) for (const [index, value] of row[key].entries()) { assert.equal(value.index, index); assert.ok(contextId(value.contextId) || key === 'actions' && value.contextId === 'supplier'); }
  for (const action of row.actions) {
    assert.ok(['click', 'fill', 'press', 'upload', 'download', 'dialog-accept', 'focus', 'check', 'uncheck', 'goto', 'close-context', 'context-open', 'select', 'supplier-final', 'supplier-release', 'clock-expire'].includes(action.type), 'journey_only_ui_actions');
    assert.equal(typeof action.target, 'string'); assert.ok(time(action.at) >= start && time(action.at) <= finish);
  }
  for (const request of row.http) {
    assert.ok(Number.isInteger(request.documentIndex) && request.documentIndex >= 1, 'journey_http_document'); assert.equal(typeof request.query, 'string');
    assert.ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)); assert.ok(request.path.startsWith('/api/'));
    assert.ok(!request.bodyError && !request.failure, 'journey_incomplete_http_observation');
    assert.ok(time(request.at) >= start && time(request.at) <= finish); assert.ok(Number.isInteger(request.status) && request.status >= 200 && request.status <= 599);
  }
  for (const [index, stage] of row.stages.entries()) {
    const expectedSelected = ['empty', 'main-deleted', 'import-reviewed', 'import-restored'].includes(stage.name) ? null : stage.name === 'unrelated-created' ? row.unrelatedId : row.mainId;
    assert.equal(stage.selectedId, expectedSelected, 'journey_selected_identity');
    assert.equal(stage.index, index); assert.ok(contextId(stage.contextId)); assert.ok(hash(stage.dbPathSha256));
    assert.equal(stage.dbPathSha256, row.stages[0].dbPathSha256, 'journey_single_real_database');
    assert.ok(time(stage.at) >= (index ? time(row.stages[index - 1].at) : start) && time(stage.at) <= finish);
    for (const [field, collection] of [['actionThrough', 'actions'], ['httpThrough', 'http'], ['providerThrough', 'providerLedger'], ['websocketThrough', 'websockets']]) {
      assert.ok(Number.isInteger(stage[field]) && stage[field] >= (index ? row.stages[index - 1][field] : 0) && stage[field] <= row[collection].length, `journey_cumulative_cursor:${field}`);
      if (['actions', 'http'].includes(collection)) for (const event of row[collection].slice(0, stage[field])) assert.ok(time(event.at) <= time(stage.at), 'journey_future_event_at_checkpoint');
    }
    database(stage.database); bindPublic(stage, row);
    assert.equal(stage.screenshot, `journey-${row.width}-${stage.name}.png`);
    assert.equal(stage.ui.viewport.width, row.width); assert.ok(stage.ui.viewport.scrollWidth <= row.width, 'journey_narrow_no_horizontal_overflow');
    if (stage.ui.editor.open) assert.equal(stage.ui.editor.fits, true, 'journey_editor_fits');
    const main = stage.database.rows.listenings.find(value => value.id === row.mainId);
    const indexStopped = journeyStages.indexOf('stopped');
    if (main && index >= indexStopped) {
      assert.equal(main.title, journeyTitle); const expected = expectedName(stage.name), source = segments(stage.database, row.mainId);
      assert.deepEqual(source.map(value => value.original_text), journeyText.original.map(text => text.replaceAll('Eastman Kodak', expected)), 'journey_source_continuity');
      assert.deepEqual(source.map(value => value.translation_text), journeyText.translation, 'journey_translation_not_rewritten');
      assert.ok(source.every(value => value.translation_state === 'complete')); assert.equal(byId(stage.database.rows.knowledge_items, row.itemId).canonical_name, expected);
      for (const support of journeyRecord(stage.database, row.mainId).relation_supports.filter(value => value.state === 'active')) {
        const text = byId(stage.database.rows.segments, support.segment_id).original_text;
        assert.equal(support.quote, text.slice(support.start, support.end), 'journey_live_anchor_text'); assert.equal(support.source_revision, digest(text), 'journey_live_anchor_revision');
      }
    }
  }
  for (const served of row.served) {
    const expected = served.file === mutation.file && served.contextId === row.negative.contextId ? mutation.mutantSha256 : sourceDigests[served.file];
    assert.ok(hash(expected), 'journey_unbound_served_file'); assert.equal(served.sha256, expected, 'journey_mixed_served_source');
    assert.equal(served.origin, row.base, 'journey_served_origin');
    if (served.source === 'page-response') assert.ok(contextId(served.contextId), 'journey_served_context');
    else { assert.ok(playbackWorkletFiles.includes(served.file)); assert.equal(served.source, 'server-response-finish'); assert.equal(served.fixtureId, row.fixtureId, 'journey_worklet_fixture'); } 
  }
  for (const file of playbackWorkletFiles) assert.ok(row.served.some(value => value.file === file && value.source === 'server-response-finish' && value.fixtureId === row.fixtureId && value.status === 200 && value.bytes > 0), `journey_actual_worklet_response:${file}`);
  for (const file of journeyServedFiles) assert.ok(row.served.some(value => value.file === file && value.sha256 === sourceDigests[file] && value.status === 200 && value.bytes > 0), `journey_served_source:${file}`);
  const stableViews = ['name-corrected', 'conflict-recovered', 'receipt-recovered', 'source-played', 'translation-played', 'paused-seek', 'seek-resumed', 'history-reopened', 'context-reopened', 'restored-reopened'];
  for (const name of stableViews) assertJourneyView(atStage(row, name), row);
  assertJourneyView(atStage(row, 'save-reopened'), row, { graph: false });
  assert.equal(atStage(row, 'save-reopened').ui.editor.draft, 'Kodak Final');
  for (const name of ['conflict-opened', 'save-reopened', 'source-played', 'translation-played', 'paused-seek', 'seek-resumed', 'history-reopened', 'context-reopened', 'exported', 'import-reviewed-stale', 'import-token-expired', 'import-expiry-rejected', 'import-reuploaded', 'final-exported', 'import-reviewed', 'restored-reopened']) {
    const index = journeyStages.indexOf(name); assert.deepEqual(row.stages[index].database, row.stages[index - 1].database, `journey_read_only_stage:${name}`);
  }
  assert.deepEqual(journeyRecord(atStage(row, 'unrelated-created').database, row.mainId), journeyRecord(atStage(row, 'graph-late-completed').database, row.mainId), 'journey_aux_creation_preserves_main');
  const unrelated = atStage(row, 'unrelated-created'); assert.equal(byId(unrelated.database.rows.listenings, row.unrelatedId).title, journeyUnrelatedTitle);
  for (const stage of row.stages.slice(journeyStages.indexOf('unrelated-created'), journeyStages.indexOf('unrelated-deleted')))
    assert.deepEqual(journeyRecord(stage.database, row.unrelatedId), journeyRecord(unrelated.database, row.unrelatedId), 'journey_unrelated_full_record_preserved');
  assert.notEqual(atStage(row, 'history-reopened').contextId, atStage(row, 'context-reopened').contextId, 'journey_fresh_context');
  assert.deepEqual(atStage(row, 'history-reopened').database, atStage(row, 'context-reopened').database);
  verifyListening(row); verifyGraph(row); verifyEdits(row); verifyPlayback(row); verifyImports(row); verifyNegative(row, sourceDigests, mutation);
  const contexts = new Set(row.actions.filter(value => value.contextId !== 'supplier').map(value => value.contextId));
  assert.deepEqual(row.cleanup.map(value => value.resource).sort(), [...Array.from({ length: contexts.size }, (_, index) => `context-${index}`), 'fixture'].sort(), 'journey_all_contexts_cleaned');
  assertJourneyCleanup(row.cleanup, row.cleanupStartedAt, row.finishedAt, 'fixture');
}
export function assertJourneyCleanup(cleanup, startedAt, finishedAt, terminal) {
  interval(startedAt, finishedAt, journeyLimits.cleanupMs);
  assert.ok(Array.isArray(cleanup) && cleanup.length > 0, 'journey_missing_cleanup');
  assert.ok(cleanup.every(value => value.status === 'fulfilled' && !value.error), 'journey_cleanup_failed');
  assert.equal(cleanup.filter(value => value.resource === terminal).length, 1, 'journey_cleanup_resource');
  assert.equal(new Set(cleanup.map(value => value.resource)).size, cleanup.length);
}
export function validateUserJourneyEvidence(browser, { source, sourceDigests, mutation } = {}) {
  const result = { ok: false, reasons: [], propertyRows: userJourneyProfile.map(id => ({ id, status: 'incomplete', reasons: [] })), fullProjectAcceptance: false };
  try {
    assert.ok(!browser.failure, 'journey_browser_failure');
    assert.equal(browser.profile, 'user-journey'); assert.equal(browser.schemaVersion, 1); assert.equal(browser.complete, true);
    assert.deepEqual(browser.source, source); assert.ok(typeof browser.chromium === 'string' && browser.chromium); assert.ok(typeof browser.playwright === 'string' && browser.playwright);
    interval(browser.startedAt, browser.finishedAt, journeyLimits.browserMs); assert.deepEqual(browser.widths.map(value => value.width), journeyWidths);
    assert.equal(new Set(browser.widths.map(value => value.fixtureId)).size, 2); assert.equal(new Set(browser.widths.map(value => value.stages[0].dbPathSha256)).size, 2);
    let previousFinished = time(browser.startedAt);
    for (const row of browser.widths) {
      assert.ok(time(row.startedAt) >= previousFinished && time(row.finishedAt) <= time(browser.cleanupStartedAt), 'journey_width_time_containment');
      inspectWidth(row, { sourceDigests, mutation }); previousFinished = time(row.finishedAt);
    }
    assert.ok(time(browser.cleanupStartedAt) >= previousFinished && time(browser.cleanupStartedAt) <= time(browser.finishedAt), 'journey_browser_cleanup_interval');
    assertJourneyCleanup(browser.cleanup, browser.cleanupStartedAt, browser.finishedAt, 'chromium');
    result.ok = true; result.propertyRows = userJourneyProfile.map(id => ({ id, status: 'passed', reasons: [] }));
  } catch (error) { result.reasons.push(error.message); }
  return result;
}
