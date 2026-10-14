import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { userJourneyEvidenceFixture } from '../test-support/user-journey-evidence-fixture.mjs';
import { journeyStages, journeyWidths, journeyScreenshots, journeyLimits } from '../test-support/user-journey-contract.mjs';
import { userJourneyProfile } from '../verification/user-journey-properties.mjs';
import { properties } from '../verification/properties.mjs';
import { validateUserJourneyEvidence, journeyRecord } from '../scripts/lib/user-journey-evidence.mjs';
import { validateUserJourneyReleaseContract, validateUserJourneyBrowserReleaseEvidence } from '../scripts/lib/user-journey-release-evidence.mjs';
import { browserChecks, browserScreenshots, hashEvidenceFiles, evidenceFiles } from '../scripts/lib/runner-evidence-contract.mjs';
import { digest, writeJson } from '../scripts/lib/verification-evidence.mjs';

const stage = (browser, name) => browser.widths[0].stages.find(value => value.name === name);
const validate = (fixture, value = fixture.browser) => validateUserJourneyEvidence(value, { source: fixture.source.source, sourceDigests: fixture.source.digests, mutation: fixture.mutation });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'user-journey-reader-')); t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, ...await userJourneyEvidenceFixture(directory) };
}

test('continuous journey reader reconstructs its synthetic contract across two native SQLite exports and five registered cards', async t => {
  const f = await fixture(t), checked = validate(f); assert.equal(checked.ok, true, checked.reasons.join('\n'));
  assert.deepEqual(checked.propertyRows.map(row => row.id), userJourneyProfile); assert.equal(checked.fullProjectAcceptance, false);
  assert.equal(userJourneyProfile.length, 5); assert.ok(properties.filter(row => userJourneyProfile.includes(row.id)).every(row => row.evidenceStatus === 'not_run'));
  assert.deepEqual(journeyWidths, [1280, 390]); assert.equal(journeyStages.length, 35); assert.equal(journeyScreenshots.length, 72);
  assert.equal(browserChecks.filter(row => row === 'user-journey').length, 1); assert.deepEqual(browserScreenshots['user-journey'], journeyScreenshots);
  assert.deepEqual(journeyLimits, { browserMs: 140000, overallMs: 150000, aggregateMs: 180000, cleanupMs: 10000 });
  assert.equal((await validateUserJourneyReleaseContract(f.report, f.directory)).ok, true);
  const row = f.browser.widths[0], projection = journeyRecord(stage(f.browser, 'unrelated-created').database, row.unrelatedId);
  assert.equal(projection.knowledge_facts.length, 2); assert.equal(projection.knowledge_mentions.length, 2);
});

test('raw journey rejects skipped stages, cross-context replacement, forged DOM, provider and database evidence', async t => {
  const f = await fixture(t);
  const mutations = [
    ['stage omitted', b => b.widths[0].stages.splice(4, 1)],
    ['stage reordered', b => { [b.widths[0].stages[4], b.widths[0].stages[5]] = [b.widths[0].stages[5], b.widths[0].stages[4]]; }],
    ['replaced database', b => { stage(b, 'history-reopened').dbPathSha256 = '0'.repeat(64); }],
    ['wrong main identity', b => { b.widths[0].mainId = b.widths[0].unrelatedId; }],
    ['same browser context', b => { stage(b, 'context-reopened').contextId = stage(b, 'history-reopened').contextId; }],
    ['future stage event', b => { stage(b, 'name-corrected').at = b.startedAt; }],
    ['missing raw action cursor', b => { delete stage(b, 'name-corrected').actionThrough; }],
    ['UI source stale', b => { stage(b, 'name-corrected').ui.transcript[0].original = 'Eastman Kodak'; }],
    ['UI translation rewritten', b => { stage(b, 'name-corrected').ui.transcript[0].translation = 'Rewritten translation'; }],
    ['graph DOM stale', b => { stage(b, 'name-corrected').ui.graph.nodes[0].text = 'stale'; }],
    ['graph detail stale', b => { stage(b, 'name-corrected').ui.graph.detailTitle = 'Eastman Kodak'; }],
    ['second fact omitted', b => { stage(b, 'name-corrected').ui.knowledge[0].facts = []; }],
    ['public detail wrong', b => { stage(b, 'history-reopened').detail.listening.id = 'invented'; }],
    ['public graph wrong', b => { stage(b, 'history-reopened').graph.nodes[0].canonical_name = 'invented'; }],
    ['SQLite integrity error', b => { stage(b, 'stopped').database.integrity = 'corrupt'; }],
    ['SQLite missing table', b => { delete stage(b, 'stopped').database.rows.relation_supports; }],
    ['SQLite changed indirect unrelated fact', b => { const row = b.widths[0], db = stage(b, 'name-corrected').database; const item = db.rows.knowledge_items.find(item => item.listening_id === row.unrelatedId); db.rows.knowledge_facts.find(fact => fact.item_id === item.id).content = 'damaged'; }],
    ['empty database fabricated', b => { stage(b, 'empty').database.rows.listenings.push(stage(b, 'stopped').database.rows.listenings[0]); }],
    ['provider translated other text', b => { b.widths[0].providerLedger.find(row => row.kind === 'translation').input = 'Other source'; }],
    ['missing actual microphone audio', b => { b.widths[0].websockets[0].sent = [{ type: 'start' }, { type: 'stop' }]; }],
    ['wrong websocket identity', b => { b.widths[0].websockets[0].received[0].runId = 'wrong'; }],
    ['supplier evidence not in prompt', b => { b.widths[0].providerLedger.find(row => row.kind === 'knowledge').output.items[0].evidence[0].quote = 'invented'; }],
    ['cancelled provider completed too early', b => { b.widths[0].providerLedger.find(row => row.held).completedAt = stage(b, 'graph-held').at; }],
    ['cancel transport closure absent', b => { b.widths[0].providerLedger.find(row => row.held).transport = []; }],
    ['hidden name auto-resave', b => { const x = b.widths[0].http.find(row => row.request?.name === 'Kodak Final'); b.widths[0].http.push({ ...x, index: b.widths[0].http.length }); stage(b, 'save-reopened').httpThrough = b.widths[0].http.length; }],
    ['stale input lost', b => { stage(b, 'conflict-rejected').ui.editor.draft = 'Kodak Company'; }],
    ['uncertain save enabled', b => { stage(b, 'save-uncertain').ui.editor.saveDisabled = false; }],
    ['upstream commit not proved', b => { b.widths[0].faults[0].response.job.saved = false; }],
    ['audio delivered but not consumed', b => { stage(b, 'source-played').playback.sockets[0].sent.at(-1).consumedSamples = 0; }],
    ['played source still old', b => { stage(b, 'source-played').playback.sockets[0].received[0].text = 'Eastman Kodak'; }],
    ['paused seek resumes itself', b => { stage(b, 'paused-seek').ui.speech.paused = false; }],
    ['seek target wrong', b => { stage(b, 'paused-seek').playback.sockets[0].sent[0].startPosition = 1; }],
    ['keyboard seek missing', b => { b.widths[0].actions.find(row => row.target === '#transcript-speech-seek').type = 'click'; }],
    ['narrow overflow', b => { b.widths[1].stages[4].ui.viewport.scrollWidth = 480; }],
    ['editor offscreen', b => { stage(b, 'conflict-rejected').ui.editor.fits = false; }],
    ['wrong served source', b => { b.widths[0].served[0].sha256 = '0'.repeat(64); }],
    ['unbound worklet fixture', b => { b.widths[0].served.find(row => row.source === 'server-response-finish').fixtureId = 'unrelated'; }],
    ['wrong context origin', b => { b.widths[0].served[0].origin = 'https://other.example'; }],
    ['no microphone release', b => { stage(b, 'stopped').ui.microphoneTracks[0].state = 'live'; }],
    ['no keyboard recovery focus', b => { stage(b, 'conflict-rejected').ui.activeElement.id = ''; }],
    ['unbound provider TTS', b => { b.widths[0].ttsLedger[0].text = 'other record'; }],
    ['negative also corrupted unrelated row', b => { b.widths[0].negative.after.database.rows.listenings.find(row => row.id === b.widths[0].unrelatedId).notes = 'unexpected mutation'; }],
    ['negative had no real effect', b => { b.widths[0].negative.after.database = b.widths[0].negative.before.database; }],
    ['negative mutant not served', b => { b.widths[0].served.at(-1).sha256 = b.widths[0].served[0].sha256; }],
    ['cleanup missing', b => { b.widths[0].cleanup = []; }],
    ['cleanup rejected', b => { b.cleanup[0].status = 'rejected'; }]
  ];
  for (const [label, mutate] of mutations) { const changed = structuredClone(f.browser); mutate(changed); assert.equal(validate(f, changed).ok, false, label); }
});

test('journey import contract requires explicit file bytes, stale/expired refusals and full record preservation', async t => {
  const f = await fixture(t);
  for (const [label, mutate] of [
    ['export snapshot omitted', b => { b.widths[0].downloads[0].database.rows.knowledge_facts = []; }],
    ['different upload bytes', b => { b.widths[0].actions.find(row => row.type === 'upload').value.sha256 = '0'.repeat(64); }],
    ['different wire upload', b => { b.widths[0].http.find(row => row.path.endsWith('/validate')).request.uploadBytes = 2; }],
    ['stale auto-accepted', b => { b.widths[0].http.find(row => row.response?.code === 'IMPORT_PREVIEW_STALE').status = 200; }],
    ['expiry faked', b => { b.widths[0].clockEvents[0].timers[0].requestedMilliseconds = 1; }],
    ['expiry ignored', b => { b.widths[0].http.find(row => row.response?.code === 'IMPORT_EXPIRED').status = 200; }],
    ['File passed by app changed', b => { b.widths[0].http.find(row => row.path.endsWith('/validate')).fetch.requestBody.sha256 = '0'.repeat(64); }],
    ['preview token mismatch', b => { b.widths[0].http.find(row => row.path.endsWith('/commit')).request.previewTokenSha256 = 'f'.repeat(64); }],
    ['preview refresh missing', b => { b.widths[0].http.find(row => row.path.endsWith('/preview')).path = '/api/data/other'; }],
    ['append changed to overwrite', b => { b.widths[0].http.find(row => row.path.endsWith('/commit')).request.mode = 'replace'; }],
    ['token in clear', b => { b.widths[0].http.find(row => row.path.endsWith('/commit')).request.tokenSha256 = 'secret'; }],
    ['implicit import confirmation', b => { b.widths[0].actions.find(row => row.target === '#data-import-confirm').target = 'api'; }],
    ['main resurrected before import', b => { stage(b, 'main-deleted').database = stage(b, 'final-exported').database; }],
    ['deleted without UI approval', b => { b.widths[0].actions.find(row => row.type === 'dialog-accept').type = 'click'; }],
    ['restore missing indirect facts', b => { stage(b, 'import-restored').database.rows.knowledge_facts = []; }]
  ]) { const changed = structuredClone(f.browser); mutate(changed); assert.equal(validate(f, changed).ok, false, label); }
});

test('journey release boundary rejects rebound SQLite bytes, missing artifacts, timeout and external quality claims', async t => {
  const f = await fixture(t);
  for (const mutate of [r => { r.complete = false; }, r => { r.propertyRows.pop(); },
    r => { r.executionContext.repositoryRoot = '/forged/checkout'; },
    r => { r.executionContext.nodeExecutable = '/forged/node'; r.checks[0].command[0] = '/forged/node'; },
    r => { r.executionContext.evidenceDirectory = '/forged/' + path.basename(f.directory); r.checks[0].command[2] = r.executionContext.evidenceDirectory; }, r => { r.checks[0].execution.timedOut = true; }, r => { r.checks[0].execution.code = 1; },
    r => { r.checks[0].command[1] = 'test-support/unrelated.mjs'; }, r => { r.executionContext.overallTimeoutMs++; }, r => { r.checks[0].timeoutMs++; },
    r => { r.finalizationErrors.push({ phase: 'artifact-hash', message: 'incomplete' }); }, r => { r.externalAcceptance.quality = 'passed'; }, r => { r.sourceEnd.digests['public/app.js'] = '0'.repeat(64); },
    r => { r.artifacts = r.artifacts.filter(row => row.path !== journeyScreenshots[0]); }, r => { r.artifacts[0].sha256 = '0'.repeat(64); }]) {
    const changed = structuredClone(f.report); mutate(changed); await assert.rejects(validateUserJourneyReleaseContract(changed, f.directory));
  }
  // Hashing the changed native file again must not bless a changed backup body.
  const download = f.browser.widths[0].downloads[0], file = path.join(f.directory, download.path), original = await readFile(file);
  const db = new DatabaseSync(file); try { db.prepare('UPDATE listenings SET notes=?').run('changed after browser download'); } finally { db.close(); }
  const changed = structuredClone(f.report), bytes = await readFile(file); changed.artifacts.find(row => row.path === download.path).sha256 = digest(bytes);
  await assert.rejects(validateUserJourneyReleaseContract(changed, f.directory));
  const reboundBrowser = JSON.parse(JSON.stringify(f.browser).replaceAll(download.sha256, digest(bytes)));
  const rebound = reboundBrowser.widths[0].downloads[0]; rebound.bytes = bytes.length;
  await writeJson(path.join(f.directory, 'browser.json'), reboundBrowser); changed.artifacts = await hashEvidenceFiles(f.directory, (await evidenceFiles(f.directory)).filter(file => file !== 'report.json'));
  await assert.rejects(validateUserJourneyReleaseContract(changed, f.directory), /journey_download_native_snapshot/);
  await writeFile(file, original);
  assert.equal((await validateUserJourneyBrowserReleaseEvidence(path.join(f.directory, 'missing'), { release: false })).status, 'not_run');
});


test('nested journey origin is bound to the separately recorded aggregate log and executable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'journey-outer-contract-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'user-journey-contract'), f = await userJourneyEvidenceFixture(directory, { outerRun: 'run-contract' });
  const outerOrigin = { repositoryRoot: process.cwd(), nodeExecutable: process.execPath };
  const options = { release: false, outerRun: 'run-contract', outerLog: f.outerLog, outerOrigin };
  const good = await validateUserJourneyBrowserReleaseEvidence(directory, options); assert.equal(good.ok, true, good.reasons.join('\n'));
  for (const change of [ { outerLog: '' }, { outerLog: f.outerLog + f.outerLog }, { outerLog: 'prefix\n' + f.outerLog },
    { outerRun: 'run-other' }, { outerOrigin: { ...outerOrigin, repositoryRoot: '/forged/checkout' } },
    { outerOrigin: { ...outerOrigin, nodeExecutable: '/forged/node' } } ]) {
    assert.equal((await validateUserJourneyBrowserReleaseEvidence(directory, { ...options, ...change })).ok, false);
  }
});

test('independent audit counterexamples cannot sever DOM, fetch, identity, receipt, provider or time correlations', async t => {
  const f = await fixture(t); assert.equal(validate(f).ok, true);
  // Preserve the original audit mutations, including changes applied to every
  // stage/width rather than merely contradicting one duplicate observation.
  const probes = [
    ['all visible graph relations erased', /journey_dom_relation_identity/, b => { for (const w of b.widths) for (const s of w.stages) s.ui.graph.relations = []; }],
    ['File observation points at unrelated URL', /journey_fetch_url/, b => { for (const w of b.widths) for (const h of w.http) if (h.fetch) h.fetch.url = 'http://127.0.0.1:43210/api/unrelated'; }],
    ['File observation claims GET', /journey_fetch_method/, b => { for (const w of b.widths) for (const h of w.http) if (h.fetch) h.fetch.method = 'GET'; }],
    ['normal stage selected wrong listening', /journey_selected_identity/, b => { b.widths[0].stages.find(s => s.name === 'history-reopened').selectedId = b.widths[0].unrelatedId; }],
    ['upstream committed receipt mismatches identity/name', /journey_upstream_exact_receipt/, b => { for (const w of b.widths) for (const x of w.faults) { x.response.job.id = w.unrelatedId; x.response.job.name = 'WRONG'; } }],
    ['negative checkpoint outside collection', /journey_negative_time_containment/, b => { b.widths[0].negative.after.at = '2099-01-01T00:00:00.000Z'; }],
    ['entire width observations outside browser window', /journey_width_time_containment/, b => {
      function shift(v) {
        if (!v || typeof v !== 'object') return;
        for (const [key, value] of Object.entries(v)) {
          if (['at', 'startedAt', 'finishedAt', 'completedAt', 'cleanupStartedAt'].includes(key) && typeof value === 'string' && !Number.isNaN(Date.parse(value))) v[key] = new Date(Date.parse(value) + 31536000000).toISOString();
          else shift(value);
        }
      }
      for (const width of b.widths) shift(width);
    }],
    ['knowledge output name differs from stored item', /journey_knowledge_authored_names/, b => { for (const w of b.widths) for (const p of w.providerLedger) if (p.kind === 'knowledge') p.output.items[0].canonical_name = 'FORGED'; }],
    ['graph relation identity changed', /journey_dom_relation_identity/, b => { stage(b, 'name-corrected').ui.graph.relations[0].id = 'other-relation'; }],
    ['graph relation text changed', /journey_dom_relation_text/, b => { stage(b, 'name-corrected').ui.graph.relations[0].text = 'Eastman Kodak → 推出 → Brownie camera'; }],
    ['graph relation accessible label changed', /journey_dom_relation_label/, b => { stage(b, 'name-corrected').ui.graph.relations[0].label = 'unrelated'; }],
    ['fetch document index duplicated', /journey_fetch_document_index/, b => { b.widths[0].http.filter(h => h.fetch)[1].fetch.index = 0; }],
    ['fetch URL occurrence duplicated', /journey_fetch_url_index/, b => { b.widths[0].http.filter(h => h.path.endsWith('/validate'))[1].responseIndex = 0; }],
    ['authored provider fact changed', /journey_knowledge_authored_proposal/, b => { b.widths[0].providerLedger.find(p => p.kind === 'knowledge').output.items[0].new_information = 'Forged information'; }],
    ['provider create changed into unbound repeat', /journey_knowledge_authored_proposal/, b => { b.widths[0].providerLedger.find(p => p.kind === 'knowledge').output.items[0].action = 'repeat'; }]
  ];
  for (const [label, reason, mutate] of probes) {
    const changed = structuredClone(f.browser); mutate(changed); const result = validate(f, changed);
    assert.equal(result.ok, false, label); assert.match(result.reasons.join('\n'), reason, label);
  }
  // CDP may omit a File request body. The independent fetch File digest remains
  // mandatory; an unavailable corroborating channel is represented honestly.
  const omittedCdp = structuredClone(f.browser);
  for (const row of omittedCdp.widths) for (const request of row.http.filter(h => h.path.endsWith('/validate')))
    Object.assign(request.request, { uploadBytes: null, uploadSha256: null });
  const positive = validate(f, omittedCdp); assert.equal(positive.ok, true, positive.reasons.join('\n'));
  omittedCdp.widths[0].http.find(h => h.path.endsWith('/validate')).fetch.requestBody.sha256 = 'f'.repeat(64);
  assert.equal(validate(f, omittedCdp).ok, false);
});
