import { deadline } from './lifecycle.mjs';

// Failure-only reads: keep the original browser exchange separate from diagnostics.
// These reads never retry the save or substitute for the browser's receipt response.
export async function nameBrowserFailure({ row, client, fixture, error, inspectEditor, timeoutMs = 3000 }) {
  const failure = { name: error.name, message: error.message };
  Object.assign(row, { complete: false, failure, requests: client?.requests ?? [], responses: client?.responses ?? [],
    requestFailures: client?.requestFailures ?? [], sources: client?.sources ?? [], errors: client?.errors ?? [],
    explicitSaves: client?.explicitSaves ?? 0, providerCalls: fixture.stats.providerRequests, mutation: client?.mutation ?? null });
  const diagnostics = row.diagnostics = { tables: fixture.tables(), snapshot: fixture.snapshot(), serverLog: fixture.logs(), editor: null, reads: [] };
  if (!client) return row;
  const expires = Date.now() + timeoutMs;
  const jobs = row.requests.filter(request => request.method === 'POST' && request.url === fixture.url + '/name-replacements')
    .map(request => request.headers['idempotency-key']).filter(id => typeof id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id));
  const urls = [...new Set([fixture.url, ...jobs.slice(-4).map(id => fixture.url + '/edits/' + id)])];
  const reads = urls.map(async url => {
    const value = { url }; diagnostics.reads.push(value);
    try {
      const response = await client.page.request.get(url, { timeout: Math.max(1, expires - Date.now()) });
      value.status = response.status(); value.text = await response.text();
    } catch (readError) { value.error = readError.message; }
  });
  const editor = Promise.resolve().then(() => inspectEditor(client)).then(value => { diagnostics.editor = value; }, cause => { diagnostics.editorError = cause.message; });
  try { await deadline(() => Promise.all([...reads, editor]), Math.max(1, expires - Date.now()), 'Name browser failure diagnostics'); }
  catch (cause) { diagnostics.observationError = cause.message; }
  return row;
}
