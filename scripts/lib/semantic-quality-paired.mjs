// Synthetic same-source paired rehearsal only. No live configuration is accepted.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { qualitySources } from './quality-collector.mjs';
import { contractDigest, hashBytes } from './quality-contract.mjs';
import { openSemanticQualityBudget } from './quality-budget.mjs';
import { captureSemanticOffline } from './semantic-quality-capture.mjs';
import { readSemanticCapture } from './semantic-quality-evidence.mjs';
import { writeJson } from './verification-evidence.mjs';
import { KNOWLEDGE_MODEL, CONTRACT_REVISION, parseKnowledgeV2 } from '../../knowledge.mjs';
import { RELATION_MODEL, RELATION_CONTRACT_VERSION, buildRelationRequest } from '../../relations.mjs';
import { semanticFixtureSample, semanticFixtureResponse } from '../../test-support/semantic-quality-fixture.mjs';
const same = (a, b) => assert.equal(contractDigest(a), contractDigest(b));
const boundary = { qualityStatus: 'not_run', qualityEvaluated: false, fullQualityAcceptance: false, releaseEligible: false, liveCalls: 0 };
const specs = ['qualified', 'empty'].flatMap(sample => [0, 1].map(repetition => ({ sample, repetition })));
const trial = (role, spec) => `${role}:${spec.sample}:${spec.repetition}`;
const relative = (role, spec) => `${role}/${spec.sample}-${spec.repetition}`;
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
function frozenPlan(directory, source, frozenAt) {
  const expiresAt = new Date(Date.parse(frozenAt) + 300000).toISOString();
  return { schemaVersion: 1, kind: 'synthetic-semantic-pair-freeze', mode: 'offline', comparison: 'same-source-rehearsal',
    directory: path.resolve(directory), frozenAt, source, samples: ['qualified', 'empty'].map(semanticFixtureSample), specs,
    models: { knowledge: KNOWLEDGE_MODEL, relation: RELATION_MODEL, knowledgeContract: CONTRACT_REVISION, relationContract: RELATION_CONTRACT_VERSION },
    budget: { id: 'synthetic-pair-ledger', currency: 'USD', ceilingMicros: 384, maxAttempts: { knowledge: 192, relation: 192 },
      attemptMicros: { knowledge: 1, relation: 1 }, maxTrialAttempts: { knowledge: 24, relation: 24 }, expiresAt },
    billingMeaning: 'Synthetic accounting units only; no price, approval or provider billing claim.', ...boundary };
}
function readLedger(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    same(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    return { binding: db.prepare('SELECT digest FROM binding WHERE id=1').get().digest,
      attempts: db.prepare('SELECT * FROM attempts ORDER BY id').all().map(row => ({ ...row })),
      runs: db.prepare('SELECT * FROM runs ORDER BY role').all().map(row => ({ ...row })) };
  } finally { db.close(); }
}
// Recompute business meaning from the fixed original responses through the
// production parsers. Matching database bytes to a self-reported snapshot alone
// would allow a coordinated DB/snapshot/hash forgery to change polarity or facts.
function verifySyntheticPersistence(capture) {
  const t = capture.after.tables, ordered = rows => [...rows].sort((a,b) => contractDigest(a).localeCompare(contractDigest(b)));
  const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
  const itemKeys = ['type','display_label','canonical_name','short_description','certainty'];
  const expectedItems = [], expectedFacts = [], expectedMentions = [], expectedAssertions = [], expectedRelations = [];
  for (const call of capture.calls) {
    if (call.kind === 'knowledge') {
      const parsed = parseKnowledgeV2(JSON.stringify(call.response), JSON.parse(call.request.messages[1].content));
      same(parsed.rejected, []);
      for (const item of parsed.items) {
        assert.equal(item.action, 'create'); same(item.aliases, []);
        const rows = t.knowledge_items.filter(row => row.canonical_name === item.canonical_name); assert.equal(rows.length, 1);
        const id = rows[0].id;
        expectedItems.push({ ...pick(item, itemKeys), id, listening_id: capture.run.listeningId,
          normalized_name: item.canonical_name.toLowerCase(), dialogue_summary: item.new_information,
          background_note: null, policy_version: 2, content_version: 1, name_override: null, name_override_identity: null });
        for (const evidence of item.evidence) {
          expectedMentions.push({ item_id: id, segment_id: evidence.segment_id, surface_text: evidence.quote });
          expectedFacts.push({ item_id: id, segment_id: evidence.segment_id, surface_text: evidence.quote, content: item.new_information, certainty: item.certainty });
        }
      }
    } else {
      assert.equal(call.kind, 'relation');
      const parsed = buildRelationRequest(call.reservation.input).parse(JSON.stringify(call.response)); same(parsed.rejected, []);
      for (const relation of parsed.relations) {
        const relationKeys = ['subject_item_id','object_item_id','predicate'];
        expectedRelations.push(pick(relation, relationKeys));
        const assertionKeys = ['statement','polarity','modality','conditions','time_scope','attribution','status','correction_of'];
        expectedAssertions.push({ ...pick(relation, relationKeys), ...pick(relation, assertionKeys), version: 1,
          supports: ordered(relation.supports.map(row => ({ ...row, job_id: call.jobId, window_id: call.reservation.window_id,
            window_revision: call.reservation.window_revision, state: 'active' }))) });
      }
    }
  }
  const omit = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
  same(ordered(t.knowledge_items.map(row => omit(row, ['created_at','updated_at']))), ordered(expectedItems));
  same(t.knowledge_aliases, []); same(ordered(t.knowledge_mentions), ordered(expectedMentions));
  same(ordered(t.knowledge_facts.map(row => omit(row, ['id','created_at']))), ordered(expectedFacts));
  const relationKeys = ['subject_item_id','object_item_id','predicate'];
  same(ordered(t.relations.map(row => pick(row, relationKeys))), ordered([...new Map(expectedRelations.map(row => [contractDigest(row), row])).values()]));
  const actual = t.relation_assertions.map(row => {
    const relation = t.relations.find(parent => parent.id === row.relation_id); assert.ok(relation);
    return { ...pick(relation, relationKeys), ...pick(row, ['statement','polarity','modality','conditions','time_scope','attribution','status','correction_of','version']),
      supports: ordered(t.relation_supports.filter(support => support.assertion_id === row.id).map(support => omit(support, ['id','assertion_id','group_id','created_at']))) };
  });
  assert.equal(t.relation_supports.length, actual.reduce((n, row) => n + row.supports.length, 0));
  same(ordered(actual), ordered(expectedAssertions));
}
export async function runSemanticPairedOffline(directory, { signal } = {}) {
  directory = path.resolve(directory); await mkdir(directory, { recursive: false, mode: 0o700 });
  const sourceStart = await qualitySources(), startedAt = new Date().toISOString();
  const plan = frozenPlan(directory, sourceStart, startedAt), freezeDigest = contractDigest(plan);
  await writeFile(path.join(directory, 'freeze.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const timer = new AbortController(), timeout = setTimeout(() => timer.abort(), 150000);
  const combined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  const captures = [], roleSnapshots = []; let ledger, activeRole, errorCode;
  try {
    for (const role of ['baseline', 'candidate']) {
      combined.throwIfAborted();
      ledger = openSemanticQualityBudget(path.join(directory, 'budget.sqlite'), plan.budget, freezeDigest);
      await mkdir(path.join(directory, role));
      ledger.claimRun({ role, sourceSha: sourceStart.sha, directory: path.join(directory, role), expectedSnapshot: ledger.snapshot() }); activeRole = role;
      for (const spec of specs) {
        combined.throwIfAborted();
        const capture = await captureSemanticOffline({ directory: path.join(directory, relative(role, spec)),
          sample: semanticFixtureSample(spec.sample), response: semanticFixtureResponse(), signal: combined,
          pairedBudget: { ledger, trialId: trial(role, spec), expiresAt: plan.budget.expiresAt } });
        captures.push({ role, ...spec, directory: relative(role, spec), complete: capture.complete });
        assert.equal(capture.complete, true);
        // Reopen the database and validate every production request before the
        // role is marked complete or a candidate claim can be made.
        await readSemanticCapture(path.join(directory, relative(role, spec)), sourceStart);
      }
      ledger.finishRun(role, true); activeRole = null;
      roleSnapshots.push({ role, snapshot: ledger.snapshot() }); ledger.close(); ledger = null;
    }
  } catch { errorCode = combined.aborted ? 'SEMANTIC_PAIR_CANCELLED' : 'SEMANTIC_PAIR_INCOMPLETE'; }
  finally {
    clearTimeout(timeout);
    if (ledger) { try { if (activeRole) ledger.finishRun(activeRole, false); } finally { ledger.close(); } }
  }
  let sourceEnd = null;
  try { sourceEnd = await qualitySources(); } catch { errorCode = 'SEMANTIC_SOURCE_UNREADABLE'; }
  if (sourceEnd && contractDigest(sourceStart) !== contractDigest(sourceEnd)) errorCode = 'SEMANTIC_SOURCE_CHANGED';
  const report = { schemaVersion: 1, kind: 'synthetic-semantic-pair', mode: 'offline', comparison: 'same-source-rehearsal', ...boundary,
    sourceStart, sourceEnd, startedAt, finishedAt: new Date().toISOString(), freezeDigest, complete: !errorCode, errorCode, captures, roleSnapshots };
  await writeJson(path.join(directory, 'paired.json'), report); return report;
}
export async function inspectSemanticPairedOffline(directory, targetSource, { release = false } = {}) {
  directory = path.resolve(directory); const artifacts = [];
  try {
    const plan = await json(path.join(directory, 'freeze.json')), run = await json(path.join(directory, 'paired.json'));
    same(plan, frozenPlan(directory, targetSource, plan.frozenAt));
    assert.ok(Number.isFinite(Date.parse(plan.frozenAt)) && Date.parse(plan.frozenAt) <= Date.now());
    same(run.sourceStart, targetSource); same(run.sourceEnd, targetSource); if (release) assert.equal(targetSource.dirty, false);
    for (const [name, value] of Object.entries(boundary)) same(run[name], value);
    assert.equal(run.schemaVersion, 1); assert.equal(run.kind, 'synthetic-semantic-pair'); assert.equal(run.mode, 'offline');
    assert.equal(run.comparison, 'same-source-rehearsal'); assert.equal(run.complete, true); assert.equal(run.errorCode, undefined);
    assert.equal(run.startedAt, plan.frozenAt); assert.ok(Date.parse(run.finishedAt) >= Date.parse(run.startedAt) && Date.parse(run.finishedAt) <= Date.now());
    const freezeDigest = contractDigest(plan); assert.equal(run.freezeDigest, freezeDigest);
    const expectedCaptures = ['baseline', 'candidate'].flatMap(role => specs.map(spec => ({ role, ...spec, directory: relative(role, spec), complete: true })));
    same(run.captures, expectedCaptures);
    const ledger = readLedger(path.join(directory, 'budget.sqlite'));
    assert.equal(ledger.binding, hashBytes(JSON.stringify({ config: { ...plan.budget, requireRunClaim: true }, freezeDigest, domain: 'semantic-v1' })));
    same(ledger.runs.map(row => [row.role, row.source_sha, row.directory, row.state]), ['baseline','candidate'].map(role => [role, targetSource.sha, path.join(directory, role), 'complete']));
    const [baseline, candidate] = ledger.runs;
    assert.ok(Date.parse(baseline.started_at) >= Date.parse(plan.frozenAt) && Date.parse(candidate.started_at) >= Date.parse(baseline.finished_at));
    const reserved = ledger.attempts.reduce((total, row) => total + row.reserved_micros, 0);
    assert.ok(Number.isSafeInteger(reserved) && reserved <= plan.budget.ceilingMicros);
    const seen = new Set();
    for (const spec of expectedCaptures) {
      const { report: capture, artifacts: captureArtifacts } = await readSemanticCapture(path.join(directory, spec.directory), targetSource, { release });
      same(capture.sample, semanticFixtureSample(spec.sample));
      const owner = ledger.runs.find(row => row.role === spec.role);
      assert.ok(Date.parse(capture.startedAt) >= Date.parse(owner.started_at) && Date.parse(capture.finishedAt) <= Date.parse(owner.finished_at));
      const response = semanticFixtureResponse();
      for (const [index, call] of capture.calls.entries()) same(call.response, response({ kind: call.kind, input: JSON.parse(call.request.messages.at(-1).content), sample: capture.sample, calls: capture.calls.slice(0, index) }));
      verifySyntheticPersistence(capture);
      const transport = capture.transport, trialId = trial(spec.role, spec);
      assert.equal(transport.trialId, trialId); assert.equal(transport.observations.length, capture.calls.length);
      assert.equal(transport.budgetBindings.length, capture.calls.length); assert.ok(capture.calls.length <= 24);
      const perKind = { knowledge: 0, relation: 0 };
      for (const [index, call] of capture.calls.entries()) {
        const observation = transport.observations[index], binding = transport.budgetBindings[index];
        const kind = call.kind === 'relation' ? 'relation' : 'knowledge';
        assert.equal(binding.kind, kind); assert.equal(binding.trialId, trialId); assert.equal(binding.jobId, call.jobId);
        assert.equal(binding.requestSha256, call.requestSha256); assert.equal(binding.reservationDigest, contractDigest(call.reservation));
        assert.equal(observation.attemptId, binding.attemptId); assert.equal(observation.kind, kind);
        assert.equal(observation.mode, 'offline'); assert.equal(observation.status, 'succeeded'); assert.equal(observation.reservationStatus, 'confirmed');
        assert.equal(observation.endpoint, call.endpoint + '/'); assert.equal(observation.model, call.request.model);
        assert.equal(observation.requestWire, call.requestWire); assert.equal(observation.requestSha256, hashBytes(call.requestWire));
        assert.equal(observation.requestBytes, Buffer.byteLength(call.requestWire)); assert.equal(observation.httpStatus, 200);
        assert.equal(observation.responseSha256, hashBytes(observation.responseWire)); assert.equal(observation.responseBytes, Buffer.byteLength(observation.responseWire));
        same(JSON.parse(JSON.parse(observation.responseWire).choices[0].message.content), call.response);
        const attempt = ledger.attempts.find(row => String(row.id) === binding.attemptId); assert.ok(attempt && !seen.has(attempt.id)); seen.add(attempt.id);
        assert.equal(attempt.kind, kind); assert.equal(attempt.trial_id, trialId); assert.equal(attempt.reserved_micros, plan.budget.attemptMicros[kind]);
        assert.equal(attempt.observation_json, null);
        const times = [capture.startedAt, observation.startedAt, attempt.reserved_at, observation.reservedAt, observation.forwardedAt, call.at, observation.completedAt, capture.finishedAt].map(Date.parse);
        assert.ok(times.every(Number.isFinite) && times.every((time, i) => i === 0 || time >= times[i - 1]));
        assert.ok(Date.parse(attempt.reserved_at) < Date.parse(plan.budget.expiresAt));
        assert.ok(++perKind[kind] <= plan.budget.maxTrialAttempts[kind]);
      }
      artifacts.push(...captureArtifacts.map(row => ({ ...row, path: `${spec.directory}/${row.path}` })));
    }
    assert.equal(seen.size, ledger.attempts.length);
    ledger.attempts.forEach((row, index) => assert.equal(row.id, index + 1));
    for (const kind of ['knowledge','relation']) assert.ok(ledger.attempts.filter(row => row.kind === kind).length <= plan.budget.maxAttempts[kind]);
    assert.equal(run.roleSnapshots.length, 2);
    for (const [index, role] of ['baseline','candidate'].entries()) {
      const attempts = ledger.attempts.filter(row => index === 1 || row.trial_id.startsWith('baseline:'));
      same(run.roleSnapshots[index], { role, snapshot: { id: plan.budget.id, currency: plan.budget.currency, binding: ledger.binding, freezeDigest,
        ceilingMicros: plan.budget.ceilingMicros, reservedMicros: attempts.reduce((sum, row) => sum + row.reserved_micros, 0), attempts, runs: ledger.runs.slice(0, index + 1) } });
    }
    assert.ok(Date.parse(candidate.finished_at) <= Date.parse(run.finishedAt));
    for (const filename of ['freeze.json','budget.sqlite','paired.json']) artifacts.push({ path: filename, sha256: hashBytes(await readFile(path.join(directory, filename))) });
    return { schemaVersion: 1, kind: 'semantic-paired-offline-summary', ...boundary, complete: true, infrastructurePassed: true,
      comparison: 'same-source-rehearsal', source: targetSource, scope: { pairs: specs.length, captures: expectedCaptures.length, attempts: seen.size, reservedMicros: reserved }, artifacts };
  } catch { return { schemaVersion: 1, kind: 'semantic-paired-offline-summary', ...boundary, complete: false, infrastructurePassed: false,
    source: targetSource, errorCode: 'SEMANTIC_PAIR_EVIDENCE_REJECTED', artifacts }; }
}
