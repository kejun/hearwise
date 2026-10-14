// Test-only Node preload, never imported by production. Playwright page response
// events omit Chromium AudioWorklet requests, so observe the actual HTTP body at
// its server boundary. No request bodies, request headers, credentials or module
// copies. Only opt-in export responses include three download metadata headers.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { ServerResponse } from 'node:http';
import { playbackWorkletFiles } from './playback-worklet-responses.mjs';

const filename = process.env.HEARWISE_TEST_WORKLET_RESPONSES;
const fixtureId = process.env.HEARWISE_TEST_WORKLET_FIXTURE;
if (!filename || !/^[a-f0-9-]{36}$/.test(fixtureId || '')) throw new Error('Worklet response observer requires an isolated fixture log');
const captures = new WeakMap();
const isExport = request => process.env.HEARWISE_TEST_CAPTURE_EXPORTS === '1' && request?.method === 'GET' && /^\/api\/data\/export\?download=\d+$/.test(request.url);
function capture(response) {
  const request = response.req;
  const exportResponse = isExport(request);
  if (request?.method !== 'GET' || !exportResponse && !playbackWorkletFiles.includes('public' + request.url)) return null;
  if (!captures.has(response)) {
    const origin = `http://${request.socket.localAddress}:${request.socket.localPort}`;
    const state = { hash: createHash('sha256'), bytes: 0, failed: false, recorded: false, startedAt: new Date().toISOString(), headers: {} };
    captures.set(response, state);
    const record = outcome => {
      if (state.recorded) return;
      state.recorded = true;
      appendFileSync(filename, JSON.stringify({ fixtureId, origin, source: `server-response-${outcome}`, method: request.method,
        path: request.url, ...(exportResponse ? { kind: 'data-export', startedAt: state.startedAt, finishedAt: new Date().toISOString(), headers: state.headers } : { file: 'public' + request.url }), status: response.statusCode,
        bytes: state.bytes, sha256: state.hash.digest('hex') }) + '\n');
    };
    response.once('error', () => { state.failed = true; record('error'); });
    response.once('close', () => { if (!state.recorded) record('close'); });
    response.once('finish', () => record(state.failed ? 'error' : 'finish'));
  }
  return captures.get(response);
}
// Chromium download navigation is not consistently emitted as a Playwright
// page request. Opt-in export observation uses this same actual server boundary;
// only response metadata is recorded, never request headers or credentials.
const originalWriteHead = ServerResponse.prototype.writeHead;
ServerResponse.prototype.writeHead = function (...args) {
  if (isExport(this.req)) {
    const state = capture(this), supplied = args.at(-1);
    const headers = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied : {};
    const lookup = name => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? this.getHeader(name);
    state.headers = { contentType: lookup('content-type') ?? null, contentLength: Number(lookup('content-length')),
      contentDisposition: lookup('content-disposition') ?? null };
  }
  return Reflect.apply(originalWriteHead, this, args);
};
for (const method of ['write', 'end']) {
  const original = ServerResponse.prototype[method];
  ServerResponse.prototype[method] = function (...args) {
    const state = capture(this);
    if (state) {
      if (this.writableEnded || this.destroyed) state.failed = true;
      const [chunk, encoding] = args;
      // Node suppresses bodies for 1xx, 204 and 304 responses.
      if (!state.failed && !state.recorded && this.statusCode >= 200 && this.statusCode !== 204 && this.statusCode !== 304 &&
        (typeof chunk === 'string' || ArrayBuffer.isView(chunk))) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined) :
          Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        state.hash.update(bytes); state.bytes += bytes.length;
      }
    }
    try { return Reflect.apply(original, this, args); }
    catch (error) { if (state) state.failed = true; throw error; }
  };
}
