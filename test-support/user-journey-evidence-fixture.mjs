// SYNTHETIC READER CONTRACT ONLY. Native SQLite transactions/exports below are
// real, but the DOM, UI action, socket and process envelopes are authored test
// inputs. This helper does not launch Chromium and is never acceptance evidence.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ListeningStore } from '../storage.mjs';
import { exportDatabase, appendDatabase } from '../data-transfer.mjs';
import { databaseSnapshot } from './import-protocol-fixture.mjs';
import { journeyText } from './user-journey-fixture.mjs';
import { journeyWidths, journeyStages, journeyScreenshots, journeyServedFiles, journeyLimits, journeyExternalAcceptance } from './user-journey-contract.mjs';
import { userJourneyProfile } from '../verification/user-journey-properties.mjs';
import { journeyMutation } from '../scripts/lib/user-journey-release-evidence.mjs';
import { sourceSnapshot, evidenceFiles, hashEvidenceFiles } from '../scripts/lib/runner-evidence-contract.mjs';
import { digest, metadata, writeJson } from '../scripts/lib/verification-evidence.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
export async function userJourneyEvidenceFixture(directory, { outerRun } = {}) {
  await mkdir(directory, { recursive: true });
  const working = await mkdtemp(path.join(os.tmpdir(), 'journey-contract-db-'));
  const source = await sourceSnapshot(), mutation = await journeyMutation();
  let clock = Date.UTC(2026, 9, 14, 1), tick = () => new Date(clock += 5).toISOString();
  const browser = { profile: 'user-journey', schemaVersion: 1, source: source.source, chromium: 'SYNTHETIC CONTRACT ONLY',
    playwright: JSON.parse(await readFile('node_modules/playwright/package.json')).version, startedAt: tick(), complete: true, widths: [], cleanup: [] };
  try {
    for (const width of journeyWidths) {
      const filename = path.join(working, `${width}.sqlite`), store = new ListeningStore(filename);
      try {
        const row = { width, fixtureId: randomUUID(), base: 'http://127.0.0.1:43210', startedAt: tick(), complete: true, stages: [], actions: [],
          http: [], websockets: [], providerLedger: [], served: [], downloads: [], errors: [], clockEvents: [], faults: [], ttsLedger: [], cleanup: [] };
        browser.widths.push(row); let actor = `${width}-main`, selectedId = null, documentIndex = 1, main, aux, held;
        const importIndices = new Map(), urlIndices = new Map();
        const action = (type, target, value) => { row.actions.push({ index: row.actions.length, contextId: actor, at: tick(), type, target, ...(value === undefined ? {} : { value }) }); return row.actions.length - 1; };
        const http = (method, endpoint, request = null, response = { ok: true }, status = 200, key = null) => {
          const query = endpoint.endsWith('/validate') ? '?mode=append' : '';
          const value = { index: row.http.length, contextId: actor, documentIndex, at: tick(), method, path: endpoint, query, status, request: clone(request), response: clone(response), idempotencyKey: key };
          if (endpoint.startsWith('/api/data/import/')) {
            const document = `${actor}:${documentIndex}`, url = row.base + endpoint + query, urlKey = `${document}:${url}`;
            value.responseIndex = urlIndices.get(urlKey) || 0; urlIndices.set(urlKey, value.responseIndex + 1);
            value.fetch = { index: importIndices.get(document) || 0, url, method, requestBody: null }; importIndices.set(document, value.fetch.index + 1);
          }
          row.http.push(value); return value;
        };
        const ui = () => {
          const d = row.mainId ? store.detail(row.mainId) : null, graph = d ? store.graph(row.mainId) : null;
          return { recordTitle: d?.listening.title ?? '', notes: d?.listening.notes ?? '',
            caption: { original: journeyText.original[1], translation: journeyText.translation[1] },
            transcript: d?.segments.map(value => ({ id: value.id, original: value.original_text, translation: value.translation_text })) ?? [],
            knowledge: d?.knowledge.map(value => ({ id: value.id, name: value.canonical_name, summary: value.short_description || value.dialogue_summary,
              facts: value.facts.map(fact => `本次提到：${fact.content}`) })) ?? [],
            graph: { nodes: graph?.nodes.map(value => ({ id: value.id, text: `${value.canonical_name} · 术语` })) ?? [], relations: graph?.relations.map(value => {
                const text = `${graph.nodes.find(node => node.id === value.subject_item_id).canonical_name} → 推出 → ${graph.nodes.find(node => node.id === value.object_item_id).canonical_name}`;
                return { id: value.id, text, label: `查看关系依据：${text}` }; }) ?? [],
              detailTitle: d?.knowledge.find(value => value.id === row.itemId)?.canonical_name ?? '', detailText: d?.knowledge.find(value => value.id === row.itemId)?.canonical_name ?? '' },
            editor: { open: false, draft: '', source: '', status: '', saveDisabled: false, closeDisabled: false, fits: true },
            import: { summary: '追加：新增 1 条，跳过 1 条', append: true, confirmDisabled: false, confirmText: '确认追加', status: '' },
            activeElement: { id: 'knowledge-edit-name', role: '', text: '' }, viewport: { width, scrollWidth: width },
            speech: { paused: false, enabled: false, contexts: [{ state: 'closed', sampleRate: 24000 }] }, microphoneTracks: [{ kind: 'audio', state: 'ended' }] };
        };
        const capture = (name, extra = {}) => {
          assert.equal(name, journeyStages[row.stages.length]);
          const stage = { index: row.stages.length, name, at: tick(), contextId: actor, selectedId, dbPathSha256: digest(filename),
            database: databaseSnapshot(filename), detail: row.mainId ? clone(store.detail(row.mainId)) : null, graph: row.mainId ? clone(store.graph(row.mainId)) : null,
            ui: ui(), actionThrough: row.actions.length, httpThrough: row.http.length, providerThrough: row.providerLedger.length, websocketThrough: row.websockets.length,
            screenshot: `journey-${width}-${name}.png`, ...extra };
          row.stages.push(stage); return stage;
        };
        const start = title => {
          action('press', '#toggle', 'Enter');
          const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, title);
          selectedId = run.listeningId;
          const socket = { index: row.websockets.length, contextId: actor, path: '/ws', at: tick(), sent: [{ type: 'start' }, { type: 'binary', bytes: 640 }],
            received: [{ type: 'listening-ready', ...run }] }; row.websockets.push(socket); return { ...run, socket };
        };
        const captions = run => {
          run.segments = journeyText.original.map((text, index) => {
            action('supplier-final', run.listeningId, { text }); const segment = store.addSegment(run.listeningId, run.runId, { id: `sentence-${index}`, text }).segment;
            store.setTranslation(segment.id, journeyText.translation[index], false); run.socket.received.push({ type: 'segment-final', runId: run.runId, segment: clone(segment) });
            row.providerLedger.push({ sequence: row.providerLedger.length + 1, kind: 'translation', input: text, output: journeyText.translation[index], startedAt: tick(), completedAt: tick(), held: false, transport: [] }); return segment;
          });
        };
        const finish = run => {
          action('press', '#toggle', 'Enter'); run.socket.sent.push({ type: 'stop' }); store.finishRun(run.runId);
          run.items = store.applyKnowledge(run.listeningId, ['Eastman Kodak', 'Brownie camera'].map(name => ({ type: 'term', canonical_name: name, aliases: [], dialogue_summary: journeyText.original[0],
            background_note: null, certainty: 'clear', decision: 'create', existing_item_id: null, correction_reason: null,
            evidence: [{ segment_id: run.segments[0].id, quote: name }] })));
          for (const item of run.items) {
            store.db.prepare('INSERT INTO knowledge_facts VALUES (?,?,?,?,?,?,?)').run(randomUUID(), item.id, run.segments[0].id, item.canonical_name, run.segments[0].original_text, 'clear', new Date().toISOString());
            store.db.prepare('UPDATE knowledge_items SET display_label=?, short_description=? WHERE id=?').run(item.canonical_name === 'Eastman Kodak' ? 'organization' : 'product', item.canonical_name === 'Eastman Kodak' ? '推出布朗尼相机的公司。' : '面向日常摄影的相机。', item.id);
          }
          run.items = store.knowledge(run.listeningId);
          const job = store.createExtractionJob(run.listeningId, run.segments); store.markJob(job.id, 'complete');
          row.providerLedger.push({ sequence: row.providerLedger.length + 1, kind: 'knowledge', input: { existing_candidates: [], focus_segments: run.segments.map(value => ({ id: value.id, text: value.original_text })) },
            output: { items: run.items.map(value => ({ action: 'create', display_label: value.display_label, canonical_name: value.canonical_name,
              role: '讨论对象', reason: '原文明确提及', existing_item_id: null, observed_candidate_id: null, correction_reason: null, aliases: [], certainty: 'clear',
              short_description: value.short_description, new_information: journeyText.original[0], evidence: [{ segment_id: run.segments[0].id, quote: value.canonical_name }] })) }, startedAt: tick(), completedAt: tick(), held: false, transport: [] });
        };
        const relation = hold => {
          action('press', '#graph-generate', 'Enter'); http('POST', `/api/listenings/${row.mainId}/graph`); store.enableRelations(row.mainId); const job = store.beginRelationRequest(store.nextRelationJob(row.mainId, { quietMs: 0 }).id);
          const span = job.input.focus_segments[0];
          const proposal = { subject_item_id: row.itemId, object_item_id: main.items[1].id, predicate: 'released', polarity: 'positive', modality: 'asserted', status: 'active', evidence_ids: ['span'] };
          const request = { sequence: row.providerLedger.length + 1, kind: 'relation', input: { candidates: main.items, evidence: [{ id: 'span', quote: journeyText.original[0] }] }, output: { relations: [proposal] },
            startedAt: tick(), completedAt: hold ? null : tick(), held: hold, transport: [] }; row.providerLedger.push(request);
          if (!hold) {
            const result = store.commitRelationJob(job.id, { relations: [{ ...proposal, statement: journeyText.original[0], conditions: null, time_scope: null, attribution: null, correction_of: null,
              supports: [{ segment_id: span.id, source_revision: span.source_revision, start: 0, end: span.text.length, quote: span.text, role: 'relation' }] }] }); assert.equal(result.accepted, 1);
          }
          return request;
        };
        const namePath = () => `/api/listenings/${row.mainId}/knowledge/${row.itemId}/name-replacements`;
        const edit = (name, unknown = null) => {
          action('fill', '#knowledge-edit-name', name); action('press', '#knowledge-edit-name', 'Enter');
          const request = { name, revision: store.knowledgeEditSnapshot(row.mainId, row.itemId).revision }, key = randomUUID();
          const response = clone(store.replaceKnowledgeName(row.mainId, row.itemId, key, request));
          http('POST', namePath(), request, unknown ? null : response, unknown ? 502 : 200, key);
          if (unknown) {
            row.faults.push({ kind: unknown, contextId: actor, at: tick(), request, idempotencyKey: key, status: 200, response });
            http('GET', namePath().replace('/name-replacements', `/edits/${key}`), null, unknown === 'receipt-recovery' ? { job: response.job } : null, unknown === 'receipt-recovery' ? 200 : 502);
          }
        };
        capture('empty'); main = start('Journey main'); row.mainId = main.listeningId; capture('listening-started'); captions(main); capture('captions'); finish(main); row.itemId = main.items[0].id; capture('stopped');
        held = relation(true); capture('graph-held'); action('press', '#graph-cancel', 'Enter'); store.cancelRelations(row.mainId); http('DELETE', `/api/listenings/${row.mainId}/graph`); capture('graph-cancelled');
        relation(false); capture('graph-retry-complete'); held.completedAt = tick(); held.transport.push({ type: 'close', destroyed: true, at: tick() }, { type: 'provider-return', destroyed: true, at: tick() }); capture('graph-late-completed');
        aux = start('Journey unrelated'); row.unrelatedId = aux.listeningId; captions(aux); finish(aux); capture('unrelated-created'); selectedId = row.mainId;
        edit('Kodak'); capture('name-corrected'); actor = `${width}-competitor`; const staleRevision = store.knowledgeEditSnapshot(row.mainId, row.itemId).revision; capture('conflict-opened');
        actor = `${width}-main`; edit('Kodak Company'); actor = `${width}-competitor`; action('press', '#knowledge-edit-name', 'Enter');
        http('POST', namePath(), { name: 'Eastman Kodak Company', revision: staleRevision }, { code: 'KNOWLEDGE_EDIT_STALE', saved: false }, 409, randomUUID());
        const rejected = capture('conflict-rejected'); Object.assign(rejected.ui.editor, { open: true, draft: 'Eastman Kodak Company', source: 'Kodak Company', status: '已读取最新内容，输入已保留' });
        edit('Eastman Kodak Company'); capture('conflict-recovered'); actor = `${width}-main`; edit('Kodak Incorporated', 'receipt-recovery'); capture('receipt-recovered');
        edit('Kodak Final', 'unknown-save'); const uncertain = capture('save-uncertain'); Object.assign(uncertain.ui.editor, { open: true, draft: 'Kodak Final', source: 'Kodak Incorporated', saveDisabled: true, status: '输入已保留，保存结果尚未确认' });
        const reopened = capture('save-reopened'); reopened.ui.editor.draft = 'Kodak Final';
        const playback = (kind, texts, extra = {}) => {
          const socket = { index: row.websockets.length, contextId: actor, path: '/ws/tts', at: tick(), sent: [{ type: 'speech.transcript', kind, listeningId: row.mainId, ...extra },
            { type: 'speech.progress', playedUnit: texts.length, consumedSamples: texts.length * 6000 }], received: texts.flatMap((text, index) => [{ type: 'speech.unit', text, unit: index + 1 }, { type: 'pcm', samples: 6000, bytes: 12016, unit: index + 1 }]) };
          const commitFrom = row.ttsLedger.length;
          for (const text of texts) row.ttsLedger.push({ text, samples: 6000, delivered: true });
          row.websockets.push(socket); return { sockets: [clone(socket)], commits: texts, commitFrom };
        };
        capture('source-played', { playback: playback('original', journeyText.original.map(text => text.replaceAll('Eastman Kodak', 'Kodak Final'))) });
        capture('translation-played', { playback: playback('translation', journeyText.translation) });
        row.ttsLedger.push({ text: journeyText.translation[0], samples: 6000, delivered: false });
        action('press', '#transcript-speech-seek', 'End'); const seek = playback('translation', [journeyText.translation[1]], { paused: true, startPosition: 2 });
        const paused = capture('paused-seek', { playback: clone(seek) }); paused.ui.speech.paused = true; paused.ui.speech.enabled = true;
        seek.sockets[0].sent.push({ type: 'speech.resume' }); capture('seek-resumed', { playback: seek }); capture('history-reopened'); actor = `${width}-reopened`; capture('context-reopened');
        const backup = async (name, stage) => {
          const file = `journey-${width}-${name}.sqlite`, actionIndex = action('download', '#data-export'); exportDatabase(store, path.join(directory, file));
          const bytes = await readFile(path.join(directory, file)); const result = { path: file, name, actionIndex, bytes: bytes.length, sha256: digest(bytes), database: databaseSnapshot(path.join(directory, file)) };
          row.downloads.push(result); http('GET', '/api/data/export'); capture(stage); return result;
        };
        const first = await backup('initial', 'exported');
        const remove = (id, stage) => { action('dialog-accept', 'delete-listening'); store.removeListening(id); if (selectedId === id) selectedId = null; http('DELETE', `/api/listenings/${id}`); capture(stage); };
        remove(row.unrelatedId, 'unrelated-deleted');
        let uploadNumber = 0, lastPreview = null;
        const upload = (backup, stage) => {
          action('upload', '#data-import-file', { path: backup.path, sha256: backup.sha256, bytes: backup.bytes });
          lastPreview = { mode: 'append', currentCount: 1, listeningCount: 2, addedCount: 1, skippedCount: 1, tokenSha256: digest('token-' + ++uploadNumber), previewTokenSha256: digest('preview-' + uploadNumber) };
          const request = http('POST', '/api/data/import/validate', { uploadSha256: backup.sha256, uploadBytes: backup.bytes, mode: 'append' }, lastPreview);
          request.fetch.requestBody = { kind: 'File', name: backup.path, size: backup.bytes, type: 'application/vnd.sqlite3', sha256: backup.sha256 }; capture(stage);
        };
        const commit = (status, response) => { action('press', '#data-import-confirm', 'Enter'); return http('POST', '/api/data/import/commit', { mode: 'append', tokenSha256: lastPreview.tokenSha256, previewTokenSha256: lastPreview.previewTokenSha256 }, response, status); };
        upload(first, 'import-reviewed-stale'); store.updateMetadata(row.mainId, { notes: 'Changed local metadata' }); commit(409, { code: 'IMPORT_PREVIEW_STALE' });
        lastPreview = { ...lastPreview, previewTokenSha256: digest('refreshed-preview') };
        http('POST', '/api/data/import/preview', { mode: 'append', tokenSha256: lastPreview.tokenSha256 }, lastPreview); capture('import-stale-rejected');
        row.clockEvents.push({ command: 'expire', error: null, timers: [{ id: 0, active: false, requestedMilliseconds: 900000 }] }); capture('import-token-expired');
        commit(410, { code: 'IMPORT_EXPIRED' }); capture('import-expiry-rejected'); upload(first, 'import-reuploaded');
        appendDatabase(store, path.join(directory, first.path), path.join(working, `${width}-safety-1.sqlite`)); commit(200, { addedCount: 1, skippedCount: 1 }); capture('import-collision-preserved');
        documentIndex++; const last = await backup('final', 'final-exported'); remove(row.mainId, 'main-deleted'); upload(last, 'import-reviewed');
        appendDatabase(store, path.join(directory, last.path), path.join(working, `${width}-safety-2.sqlite`)); commit(200, { addedCount: 1, skippedCount: 1 }); capture('import-restored'); documentIndex++; selectedId = row.mainId; capture('restored-reopened');
        actor = `${width}-negative`; documentIndex = 1; const before = { at: tick(), contextId: actor, dbPathSha256: digest(filename), selectedId: row.mainId, actionThrough: row.actions.length, httpThrough: row.http.length, database: databaseSnapshot(filename), ui: ui() };
        edit('Kodak Broken Refresh'); const after = { at: tick(), contextId: actor, dbPathSha256: digest(filename), selectedId: row.mainId, actionThrough: row.actions.length, httpThrough: row.http.length, database: databaseSnapshot(filename), ui: clone(before.ui) };
        row.negative = { property: 'HW-11-06', contextId: actor, before, after, mutation, screenshot: `journey-${width}-negative.png` };
        row.served = journeyServedFiles.map(file => ({ file, source: 'page-response', origin: row.base, contextId: `${width}-main`, status: 200, bytes: 1, sha256: source.digests[file] }));
        for (const file of ['public/speech-output-processor.js', 'public/speech-buffer.js']) row.served.push({ file, fixtureId: row.fixtureId, origin: row.base, source: 'server-response-finish', status: 200, bytes: 1, sha256: source.digests[file] });
        row.served.push({ file: mutation.file, source: 'page-response', origin: row.base, contextId: actor, status: 200, bytes: 1, sha256: mutation.mutantSha256 });
        row.cleanupStartedAt = tick(); row.cleanup = [...Array.from({ length: 4 }, (_, i) => ({ resource: `context-${i}`, status: 'fulfilled' })), { resource: 'fixture', status: 'fulfilled' }]; row.finishedAt = tick(); row.serverLog = 'SYNTHETIC CONTRACT: no browser server launched.\n'; await writeFile(path.join(directory, `journey-${width}-server.log`), row.serverLog);
      } finally { store.close(); }
    }
  } finally { await rm(working, { recursive: true, force: true }); }
  browser.cleanupStartedAt = tick(); browser.cleanup = [{ resource: 'chromium', status: 'fulfilled' }]; browser.finishedAt = tick();
  const log = 'SYNTHETIC READER CONTRACT ONLY: Chromium was not launched.\n';
  await writeFile(path.join(directory, 'browser.log'), log); await writeJson(path.join(directory, 'browser.json'), browser);
  for (const file of journeyScreenshots) await writeFile(path.join(directory, file), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const context = await metadata(), origin = { repositoryRoot: process.cwd(), evidenceDirectory: outerRun ? path.join(process.cwd(), 'browser-evidence', outerRun, path.basename(directory)) : path.resolve(directory), nodeExecutable: process.execPath, overallTimeoutMs: journeyLimits.overallMs };
  const report = { ...context, profile: 'user-journey', schemaVersion: 1, sourceStart: source, sourceEnd: source, startedAt: browser.startedAt, finishedAt: tick(), complete: true, ok: true,
    status: 'passed', finalizationErrors: [], fullProjectAcceptance: false, propertyRows: userJourneyProfile.map(id => ({ id, status: 'passed', reasons: [] })),
    browserFile: 'browser.json', externalAcceptance: journeyExternalAcceptance, executionContext: origin,
    checks: [{ name: 'browser', timeoutMs: journeyLimits.browserMs, command: [process.execPath, 'test-support/user-journey-browser.mjs', origin.evidenceDirectory],
      execution: { code: 0, signal: null, timedOut: false, interrupted: false, ok: true, durationMs: 1, tail: log } }], artifacts: await hashEvidenceFiles(directory, await evidenceFiles(directory)) };
  await writeJson(path.join(directory, 'report.json'), report); return { report, browser, source, mutation, outerLog: `User journey browser evidence: ${origin.evidenceDirectory}\n` };
}
