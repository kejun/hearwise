// Serialized by Playwright into the page. Observe the genuine fetch Response
// through a clone; never wait for the clone or replace the original response.
export function observeImportFetch() {
  const original = window.fetch;
  window.__importProtocolResponses = [];
  window.fetch = async function (...args) {
    const input = args[0], url = new URL(input instanceof Request ? input.url : input, location.href).href;
    if (!new URL(url).pathname.startsWith('/api/data/import/')) return original.apply(this, args);
    const entry = { url, done: false }; window.__importProtocolResponses.push(entry);
    const response = await original.apply(this, args);
    entry.status = response.status;
    void response.clone().json().then(body => { entry.body = body; })
      .catch(error => { entry.error = error.message; }).finally(() => { entry.done = true; });
    return response;
  };
}
