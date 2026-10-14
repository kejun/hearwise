// Test-only Node preload, never imported by production. Playwright page response
// events omit Chromium AudioWorklet requests, so observe the actual HTTP body at
// its server boundary. No request bodies, headers, credentials or module copies.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { ServerResponse } from 'node:http';
import { playbackWorkletFiles } from './playback-worklet-responses.mjs';

const filename = process.env.HEARWISE_TEST_WORKLET_RESPONSES;
const fixtureId = process.env.HEARWISE_TEST_WORKLET_FIXTURE;
if (!filename || !/^[a-f0-9-]{36}$/.test(fixtureId || '')) throw new Error('Worklet response observer requires an isolated fixture log');
const captures = new WeakMap();
function capture(response) {
  const request = response.req;
  if (request?.method !== 'GET' || !playbackWorkletFiles.includes('public' + request.url)) return null;
  if (!captures.has(response)) {
    const origin = `http://${request.socket.localAddress}:${request.socket.localPort}`;
    const state = { hash: createHash('sha256'), bytes: 0, failed: false, recorded: false };
    captures.set(response, state);
    const record = outcome => {
      if (state.recorded) return;
      state.recorded = true;
      appendFileSync(filename, JSON.stringify({ fixtureId, origin, source: `server-response-${outcome}`, method: request.method,
        path: request.url, file: 'public' + request.url, status: response.statusCode,
        bytes: state.bytes, sha256: state.hash.digest('hex') }) + '\n');
    };
    response.once('error', () => { state.failed = true; record('error'); });
    response.once('close', () => { if (!state.recorded) record('close'); });
    response.once('finish', () => record(state.failed ? 'error' : 'finish'));
  }
  return captures.get(response);
}
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
