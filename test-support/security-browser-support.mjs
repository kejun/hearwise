// Browser-security test data and observations only; never imported by production.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SECURITY_KEYS, credentialFindings } from './security-fixture.mjs';
import { seedNameReplacement } from './name-replacement-fixture.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const securityText = field => `${field}:<img data-hw-security-injected src="/hw-security-probe" onerror="globalThis.__hwSecurityExecuted=1">`;
export const securityCorpus = Object.freeze({
  title: securityText('title'), notes: securityText('notes'), name: securityText('name'),
  summary: securityText('model-summary'), fact: securityText('model-fact'),
  alias: securityText('alias'), background: securityText('background'),
  original: `${securityText('live-original')}</script><script>globalThis.__hwSecurityExecuted=99</script>`,
  translation: `${securityText('live-model-translation')}<svg data-hw-security-injected onload="globalThis.__hwSecurityExecuted=2"></svg>`
});

export function seedSecurityBrowser(store) {
  const seeded = seedNameReplacement(store);
  // Background and aliases have no direct public editor. Use the existing
  // business-store model commit API, not fabricated DOM or a test-only endpoint.
  store.applyKnowledge(seeded.listeningId, [{ type: 'term', canonical_name: 'Camera',
    existing_item_id: seeded.camera.id, decision: 'link', correction_reason: null,
    dialogue_summary: 'Persisted camera context.', background_note: securityCorpus.background,
    aliases: [securityCorpus.alias], certainty: 'clear',
    evidence: [{ segment_id: seeded.segment.id, quote: seeded.segment.original_text }] }]);
  return seeded;
}

export function renderingMutant(source) {
  const anchor = 'els.recordTitle.textContent = detail.listening.title;';
  assert.equal(source.split(anchor).length - 1, 1, 'The rendering mutation must match exactly one actual-app anchor');
  const replacement = 'els.recordTitle.innerHTML = detail.listening.title;';
  return { source: source.replace(anchor, replacement), anchor, replacement, replacements: 1 };
}

export class SecurityBoundaryViolation extends Error {
  constructor(scope, findings) {
    super(`Security boundary violation in ${scope}: ${findings.join(', ')}`);
    this.name = 'SecurityBoundaryViolation'; this.findings = findings;
  }
}
export function assertTextIsolation(snapshot, scope) {
  const findings = [];
  if (snapshot.executionCount !== 0) findings.push('script-execution');
  if (snapshot.injectedNodeCount !== 0) findings.push('unexpected-nodes');
  if (snapshot.probeRequests !== 0) findings.push('probe-request');
  if (snapshot.externalRequests !== 0) findings.push('external-request');
  if (snapshot.credentialFindings !== 0) findings.push('credential-exposure');
  if (snapshot.observationErrors !== 0) findings.push('incomplete-observation');
  if (snapshot.pageErrors !== 0) findings.push('page-error');
  if (findings.length) throw new SecurityBoundaryViolation(scope, findings);
}
export function redactSecurityDiagnostic(error) {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const key of SECURITY_KEYS) text = text.replaceAll(key, '[synthetic credential redacted]');
  return text.slice(0, 1600);
}

// Serializable by Playwright addInitScript and independently unit-tested below
// the browser boundary. The original promise, response, this, and arguments are
// untouched. Clone consumption never delays the application caller.
export function installSecurityFetchObserver({ target = globalThis, keys = [], epoch = globalThis.crypto.randomUUID() } = {}) {
  const state = { epoch, sequence: 0, responses: 0, pending: 0, errors: 0, credentialFindings: 0 };
  target.__hwSecurityFetchObservation = state;
  const publish = () => {
    state.sequence++;
    try { Promise.resolve(target.__hwSecurityFetchUpdated?.({ ...state })).catch(() => {}); } catch { /* Closing page; the parent retains this epoch's pending count. */ }
  };
  const inspect = text => { for (const key of keys) if (text.includes(key)) state.credentialFindings++; };
  const original = target.fetch;
  target.fetch = function (...args) {
    state.pending++; publish();
    let settled = false;
    const finish = () => { if (!settled) { settled = true; state.pending--; publish(); } };
    let originalPromise;
    try { originalPromise = original.apply(this, args); } catch (error) { finish(); throw error; }
    void Promise.resolve(originalPromise).then(response => {
      if (!new URL(response.url, target.location?.href).pathname.startsWith('/api/')) { finish(); return; }
      let clone;
      try { clone = response.clone(); inspect(JSON.stringify([...response.headers])); }
      catch { state.errors++; finish(); return; }
      void Promise.resolve().then(() => clone.arrayBuffer()).then(bytes => {
        inspect(new TextDecoder('utf-8').decode(bytes)); inspect(new TextDecoder('utf-16le').decode(bytes)); state.responses++;
      }).catch(() => { state.errors++; }).finally(finish);
    }, finish).catch(() => { state.errors++; finish(); });
    return originalPromise;
  };
  return state;
}

export function createSecurityFetchLedger() {
  const epochs = new Map();
  return {
    update(next) {
      if (!next || typeof next.epoch !== 'string' || !['sequence', 'responses', 'pending', 'errors', 'credentialFindings'].every(key => Number.isSafeInteger(next[key]) && next[key] >= 0)) throw new Error('Invalid fetch observation');
      const prior = epochs.get(next.epoch);
      if (prior && next.sequence <= prior.sequence) return { responses: 0, errors: 0, credentialFindings: 0 };
      if (prior && ['responses', 'errors', 'credentialFindings'].some(key => next[key] < prior[key])) throw new Error('Regressed fetch observation');
      epochs.set(next.epoch, { ...next });
      return Object.fromEntries(['responses', 'errors', 'credentialFindings'].map(key => [key, next[key] - (prior?.[key] || 0)]));
    },
    get pending() { return [...epochs.values()].reduce((total, epoch) => total + epoch.pending, 0); },
    get size() { return epochs.size; }
  };
}

export async function observeSecurityPage(page, getBase, { mutant } = {}) {
  const state = { probes: 0, external: 0, credentialHits: 0, observationErrors: 0, pageErrors: 0,
    consoleMessages: 0, apiResponses: 0, wsResponses: 0, snapshots: 0, servedAppHashes: [],
    listeningIds: [], mutationResponses: 0 };
  const pending = new Set();
  const ledger = createSecurityFetchLedger();
  const fetchCounts = next => {
    try {
      const added = ledger.update(next);
      state.apiResponses += added.responses; state.credentialHits += added.credentialFindings; state.observationErrors += added.errors;
    } catch { state.observationErrors++; }
  };
  const inspect = value => { state.credentialHits += credentialFindings(value).length; };
  const observe = work => {
    const task = Promise.resolve().then(work).catch(() => { state.observationErrors++; });
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  await page.exposeFunction('__hwSecurityFetchUpdated', fetchCounts);
  await page.addInitScript(installSecurityFetchObserver, { keys: SECURITY_KEYS });
  await page.addInitScript(() => {
    globalThis.__hwSecurityExecuted = 0;
    const seen = new WeakSet(); let injectedNodeCount = 0;
    const selector = '[data-hw-security-injected], [onerror], [onload], script:not([src]), iframe, object, embed';
    const check = node => {
      if (node.nodeType !== 1) return;
      const candidates = [...node.querySelectorAll(selector)];
      if (node.matches(selector)) candidates.push(node);
      for (const item of candidates) if (!seen.has(item)) { seen.add(item); injectedNodeCount++; }
    };
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') check(record.target);
        for (const node of record.addedNodes) check(node);
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['onerror', 'onload', 'src', 'data-hw-security-injected'] });
    globalThis.__hwSecuritySnapshot = () => ({ executionCount: Number(globalThis.__hwSecurityExecuted), injectedNodeCount });
  });
  // Only the selected actual app origin is allowed. The local server is itself
  // configured exclusively for local providers; no browser request can escape.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()); inspect(url.href);
    if (url.pathname === '/hw-security-probe') { state.probes++; await route.abort(); return; }
    if (url.origin !== new URL(getBase()).origin) { state.external++; await route.abort(); return; }
    if (mutant && url.pathname === '/app.js') {
      state.mutationResponses++;
      await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: mutant.source });
      return;
    }
    await route.continue();
  });
  page.on('console', message => { state.consoleMessages++; inspect(message.text()); });
  page.on('pageerror', error => { state.pageErrors++; inspect(error.message); });
  page.on('websocket', socket => {
    if (new URL(socket.url()).origin.replace(/^ws/, 'http') !== new URL(getBase()).origin) state.external++;
    socket.on('framereceived', ({ payload }) => {
      state.wsResponses++; inspect(payload);
      try {
        const event = JSON.parse(String(payload));
        if (event.type === 'listening-ready') state.listeningIds.push(event.listeningId);
      } catch { /* Binary media is not a business JSON frame. */ }
    });
  });
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    // Static source provenance is small and stable. API data is observed via
    // Response.clone above, avoiding CDP inspector-cache eviction entirely.
    if (pathname !== '/app.js') return;
    observe(async () => {
      const body = await response.body(); inspect(body); inspect(JSON.stringify(response.headers()));
      state.servedAppHashes.push(sha256(body));
    });
  });
  const drain = async () => {
    const expires = Date.now() + 5000;
    while (Date.now() < expires) {
      const current = await page.evaluate(() => globalThis.__hwSecurityFetchObservation ? { ...globalThis.__hwSecurityFetchObservation } : null);
      if (current) fetchCounts(current);
      if (pending.size === 0 && ledger.pending === 0) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Browser response observation exceeded 5000ms across navigation epochs');
  };
  return { page, state, inspect, drain,
    async snapshot() {
      await drain();
      const dom = await page.evaluate(() => ({ ...globalThis.__hwSecuritySnapshot(), text: document.body.textContent,
        fetchObservation: { ...globalThis.__hwSecurityFetchObservation },
        attributes: [...document.querySelectorAll('*')].flatMap(node => [...node.attributes]
          .filter(attribute => !(attribute.name === 'value' && ['api-key', 'speech-fish-key'].includes(node.id)))
          .map(attribute => attribute.value)).join('\n'),
        inputValues: [...document.querySelectorAll('input, textarea, select')]
          .filter(node => !['api-key', 'speech-fish-key'].includes(node.id)).map(node => node.value).join('\n') }));
      fetchCounts(dom.fetchObservation);
      inspect(dom.text); inspect(dom.attributes); inspect(dom.inputValues); state.snapshots++;
      return { executionCount: dom.executionCount, injectedNodeCount: dom.injectedNodeCount,
        probeRequests: state.probes, externalRequests: state.external, credentialFindings: state.credentialHits,
        observationErrors: state.observationErrors, pageErrors: state.pageErrors };
    }
  };
}
