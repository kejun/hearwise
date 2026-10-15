// Observe public transports and rendered DOM. No application state or methods
// are changed; import responses use the existing non-blocking Response.clone seam.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { observeImportFetch } from './import-protocol-browser-observer.mjs';
import { deadline } from './lifecycle.mjs';
import { digest } from '../scripts/lib/verification-evidence.mjs';

// Serialized into the page. Observe the application's real abort signal and a
// response clone without replacing the response or delaying its delivery. A
// network ERR_ABORTED alone cannot establish intentional loader supersession.
export function observeJourneyGraphReads() {
  const original = window.fetch;
  window.__journeyGraphReads = [];
  window.fetch = function (...args) {
    const input = args[0], options = args[1], url = new URL(input instanceof Request ? input.url : input, location.href).href;
    const method = String(options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' || !/^\/api\/listenings\/[0-9a-f-]{36}\/graph$/.test(new URL(url).pathname)) return original.apply(this, args);
    const signal = options?.signal || (input instanceof Request ? input.signal : null), now = () => new Date().toISOString();
    const entry = { index: window.__journeyGraphReads.length, url, method, startedAt: now(), hasSignal: Boolean(signal),
      initiallyAborted: signal?.aborted ?? false, abortedAt: null, abortStack: null, status: null, done: false };
    window.__journeyGraphReads.push(entry);
    signal?.addEventListener('abort', () => { entry.abortedAt = now(); entry.abortStack = new Error('Observed graph signal abort').stack; }, { once: true });
    return original.apply(this, args).then(response => {
      entry.status = response.status; entry.headersAt = now();
      void response.clone().json().then(body => { entry.body = body; })
        .catch(error => { entry.bodyError = { name: error.name, message: error.message }; })
        .finally(() => { entry.done = true; entry.finishedAt = now(); });
      return response;
    }, error => {
      entry.fetchError = { name: error.name, message: error.message }; entry.done = true; entry.finishedAt = now(); throw error;
    });
  };
}

export function safeJourneyValue(value) {
  if (Array.isArray(value)) return value.map(safeJourneyValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    ['key', 'authorization', 'apiKey'].includes(key) ? [key, '[synthetic credential omitted]'] :
      ['token', 'previewToken'].includes(key) ? [`${key}Sha256`, digest(String(item))] : [key, safeJourneyValue(item)]));
}
export async function observeJourneyPage(page, row, contextId) {
  const pending = new Set(), requests = new Map(), responseIndices = new Map();
  let documentIndex = 0, graphReadIndex = 0;
  const task = promise => { pending.add(promise); void promise.finally(() => pending.delete(promise)); };
  const now = () => new Date().toISOString();
  await page.addInitScript(observeImportFetch, { uploadDigest: true });
  await page.addInitScript(observeJourneyGraphReads);
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    window.__journeyAudioContexts = [];
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) { super(...args); window.__journeyAudioContexts.push(this); }
    };
    const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__journeyTracks = [];
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await nativeGetUserMedia(...args); window.__journeyTracks.push(...stream.getTracks()); return stream;
    };
  });
  // The fetch clone ledger belongs to the current document. Successful import
  // reloads on closing settings, so its ordinals restart for that new document.
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) { documentIndex++; graphReadIndex = 0; responseIndices.clear(); }
  });
  page.on('pageerror', error => row.errors.push({ contextId, message: error.message }));
  page.on('request', request => {
    const url = new URL(request.url()); if (url.origin !== row.base || !url.pathname.startsWith('/api/')) return;
    let body = null; const bytes = request.postDataBuffer();
    if (url.pathname.endsWith('/validate') && !bytes) body = { uploadBytes: null, uploadSha256: null, mode: url.searchParams.get('mode') };
    if (bytes) {
      if (url.pathname.endsWith('/validate')) body = { uploadBytes: bytes.length, uploadSha256: digest(bytes), mode: url.searchParams.get('mode') };
      else { try { body = safeJourneyValue(request.postDataJSON()); } catch { body = { bytes: bytes.length, sha256: digest(bytes) }; } }
    }
    const entry = { index: row.http.length, contextId, documentIndex, at: now(), method: request.method(), path: url.pathname, query: url.search,
      request: body, response: null, status: null, idempotencyKey: request.headers()['idempotency-key'] ?? null };
    if (url.pathname.startsWith('/api/data/import/')) {
      entry.responseIndex = responseIndices.get(request.url()) || 0; responseIndices.set(request.url(), entry.responseIndex + 1);
    }
    if (entry.method === 'GET' && /^\/api\/listenings\/[0-9a-f-]{36}\/graph$/.test(entry.path)) entry.graphReadIndex = graphReadIndex++;
    row.http.push(entry); requests.set(request, entry);
  });
  page.on('response', response => {
    const url = new URL(response.url()); if (url.origin !== row.base) return;
    const entry = requests.get(response.request());
    if (entry) {
      entry.status = response.status();
      if (!entry.path.endsWith('/export')) task((async () => {
        try {
          if (entry.path.startsWith('/api/data/import/')) {
            assert.equal(entry.documentIndex, documentIndex, 'Import observation must remain in its request document');
            const selection = { url: response.url(), index: entry.responseIndex };
            await page.waitForFunction(({ url, index }) => { const value = window.__importProtocolResponses?.filter(value => value.url === url)[index]; return value?.done && (!value.requestBody || value.uploadDigestComplete === true); },
              selection, { timeout: 7000 });
            const observed = await page.evaluate(({ url, index }) => window.__importProtocolResponses.filter(value => value.url === url)[index], selection);
            assert.equal(entry.documentIndex, documentIndex, 'Import document changed during response observation');
            assert.equal(observed.status, entry.status); assert.equal(observed.method, entry.method); assert.equal(observed.error, undefined); assert.equal(observed.uploadDigestError, undefined);
            entry.fetch = { index: observed.index, url: observed.url, method: observed.method, requestBody: observed.requestBody };
            entry.response = safeJourneyValue(observed.body);
          } else {
            const text = await response.text();
            try { entry.response = safeJourneyValue(JSON.parse(text)); } catch { entry.responseText = text; }
          }
        } catch (error) { entry.bodyError = error.message; }
      })());
    } else if (url.pathname === '/' || /\.(?:js|css)$/.test(url.pathname)) task((async () => {
      try {
        const bytes = await response.body(); row.served.push({ contextId, source: 'page-response', origin: url.origin,
          file: url.pathname === '/' ? 'public/index.html' : 'public' + url.pathname, status: response.status(), bytes: bytes.length, sha256: digest(bytes) });
      } catch (error) { row.errors.push({ contextId, message: 'served response: ' + error.message }); }
    })());
  });
  page.on('requestfailed', request => { const entry = requests.get(request); if (entry) { entry.failure = request.failure()?.errorText ?? 'unknown request failure'; entry.failureAt = now(); } });
  page.on('websocket', socket => {
    const url = new URL(socket.url()); if (url.host !== new URL(row.base).host) return;
    const entry = { index: row.websockets.length, contextId, path: url.pathname, at: now(), sent: [], received: [], closedAt: null };
    row.websockets.push(entry);
    const frame = (direction, payload) => {
      if (typeof payload === 'string') { try { entry[direction].push({ at: now(), ...safeJourneyValue(JSON.parse(payload)) }); } catch { entry[direction].push({ at: now(), invalidText: payload }); } }
      else if (direction === 'received' && url.pathname === '/ws/tts' && payload.length >= 16) entry[direction].push({ at: now(), type: 'pcm',
        epoch: payload.readUInt32LE(0), unit: payload.readUInt32LE(4), frame: payload.readUInt32LE(8), samples: payload.readUInt32LE(12), bytes: payload.length });
      else entry[direction].push({ at: now(), type: 'binary', bytes: payload.length });
    };
    socket.on('framesent', ({ payload }) => frame('sent', payload)); socket.on('framereceived', ({ payload }) => frame('received', payload));
    socket.on('close', () => { entry.closedAt = now(); });
  });
  return { drain: () => deadline(async () => {
    await Promise.all([...pending]);
    const entries = row.http.filter(entry => entry.contextId === contextId && entry.documentIndex === documentIndex && entry.graphReadIndex !== undefined);
    if (!entries.length || page.isClosed()) return;
    await page.waitForFunction(count => window.__journeyGraphReads?.length >= count && window.__journeyGraphReads.every(entry => entry.done), entries.length, { timeout: 7000 });
    const observed = await page.evaluate(() => window.__journeyGraphReads);
    for (const entry of entries) {
      const value = observed[entry.graphReadIndex]; assert.ok(value); assert.equal(value.index, entry.graphReadIndex);
      assert.equal(value.url, row.base + entry.path + entry.query); assert.equal(value.method, entry.method);
      entry.graphRead = safeJourneyValue(value);
    }
  }, 7000, 'Journey browser observations') };
}
export async function journeyUi(page) {
  return page.evaluate(() => {
    const $ = id => document.getElementById(id), text = id => $(id)?.textContent ?? '', visible = node => Boolean(node && node.getClientRects().length);
    const editor = $('knowledge-editor'), box = editor?.getBoundingClientRect();
    const field = id => $(id)?.value ?? '';
    return {
      recordTitle: text('record-title'), notes: text('record-notes'),
      caption: { original: text('original'), translation: text('translation') },
      transcript: [...document.querySelectorAll('.transcript-item')].map(node => ({ id: node.id.replace(/^segment-/, ''),
        original: node.querySelector('.transcript-original')?.textContent, translation: node.querySelector('.transcript-translation')?.textContent })),
      knowledge: [...document.querySelectorAll('.knowledge-item[data-id]')].map(node => ({ id: node.dataset.id,
        name: node.querySelector('.knowledge-title-line strong')?.textContent, summary: node.querySelector('.knowledge-brief')?.textContent ?? '', facts: [...node.querySelectorAll('.knowledge-dialogue')].map(value => value.textContent) })),
      graph: { visible: visible($('graph-viewport')), nodes: [...document.querySelectorAll('[data-result-node-id]')].map(node => ({ id: node.dataset.resultNodeId, text: node.textContent })),
        relations: [...document.querySelectorAll('.graph-relations [data-relation-id]')].map(node => ({ id: node.dataset.relationId, text: node.textContent, label: node.getAttribute('aria-label') })), detailTitle: text('graph-detail-title'), detailText: text('graph-details'),
        status: text('graph-status'), count: text('graph-count'), generateDisabled: $('graph-generate')?.disabled, cancelHidden: $('graph-cancel')?.hidden },
      editor: { open: editor?.open ?? false, draft: field('knowledge-edit-name'), source: field('knowledge-edit-source'), status: text('knowledge-edit-status'),
        saveDisabled: $('knowledge-edit-save')?.disabled ?? false, closeDisabled: $('knowledge-edit-close')?.disabled ?? false,
        fits: Boolean(box && box.left >= 0 && box.right <= innerWidth && editor.scrollWidth <= editor.clientWidth), currentName: text('knowledge-edit-current-name') },
      import: { summary: text('data-import-summary'), status: text('data-transfer-status'), append: $('data-import-append')?.checked,
        confirmDisabled: $('data-import-confirm')?.disabled, confirmText: text('data-import-confirm') },
      history: [...document.querySelectorAll('.history-open')].map(node => ({ name: node.getAttribute('aria-label'), text: node.textContent })),
      activeElement: { id: document.activeElement?.id || '', role: document.activeElement?.getAttribute('role') || '', text: document.activeElement?.textContent ?? '' },
      viewport: { width: innerWidth, scrollWidth: document.documentElement.scrollWidth },
      speech: { status: text('transcript-speech-status'), paused: text('transcript-speech-pause') === '继续播报', enabled: !$('transcript-speech-stop')?.hidden,
        contexts: window.__journeyAudioContexts?.map(context => ({ state: context.state, sampleRate: context.sampleRate })) ?? [] },
      microphoneTracks: window.__journeyTracks?.map(track => ({ kind: track.kind, state: track.readyState })) ?? []
    };
  });
}
export async function staleJourneyEditorVariant() {
  const file = 'public/knowledge-editor.js', source = await readFile(file, 'utf8');
  const anchor = '      await onSaved(current.listeningId);'; assert.equal(source.split(anchor).length, 2);
  const replacement = '      // Deliberately broken: leave the committed name out of every current view.';
  const changed = source.replace(anchor, replacement);
  return { file, source, changed, anchor, replacement, sourceSha256: digest(source), mutantSha256: digest(changed) };
}
