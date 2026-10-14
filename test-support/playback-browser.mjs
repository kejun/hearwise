// Actual Chromium UI/media/worklet and server/provider transports. The native
// resume Promise and queued DOM callbacks are delayed explicitly at their boundaries.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { playbackFixture, playbackWait, playbackGolden } from './playback-speech-fixture.mjs';
import { speechIntervalLedger } from './playback-text-contract.mjs';
import { playbackControllerVariant } from './playback-controller-variant.mjs';
import { playbackSourceSnapshot, playbackProvenance, playbackServedFiles } from './playback-provenance.mjs';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { deadline } from './lifecycle.mjs';

const directory = process.argv[2];
const sourceStart = await playbackSourceSnapshot(), provenance = await playbackProvenance(sourceStart);
const observations = { complete: false, widths: [], negative: null, sourceStart, sourceEnd: null, mutation: { mutation: provenance.mutation,
  normalControllerSha256: provenance.normalControllerSha256, mutantControllerSha256: provenance.mutantControllerSha256 } };
function monitorServed(page) {
  const responses = [], errors = [], pending = [];
  page.on('response', response => {
    const file = 'public' + new URL(response.url()).pathname; if (!playbackServedFiles.includes(file)) return;
    pending.push(response.body().then(body => responses.push({ file, status: response.status(), sha256: digest(body) })).catch(error => errors.push(error.message)));
  });
  return async () => { await deadline(() => Promise.all(pending), 3000, 'served playback module hashes'); return { responses, errors }; };
}
let browser;
async function prepare(page, { delayedUnlock = false, mutation = false } = {}) {
  page.setDefaultTimeout(10000);
  if (mutation) await page.route('**/speech-controller.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: playbackControllerVariant(await response.text(), { mutation: 'late-unlock' }) });
  });
  await page.addInitScript(({ delayedUnlock }) => {
    localStorage.setItem('tongsheng:qianwen-key', 'local-fixture-only');
    const probe = window.playbackProbe = { sockets: [], contexts: [], pendingUnlock: null, unlockNativeReady: false, unlockSettled: false };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        if (!String(args[0]).endsWith('/ws/tts')) return;
        this.received = []; this.sent = []; this.fixtureId = probe.sockets.length + 1; probe.sockets.push(this);
        this.addEventListener('message', ({ data }) => {
          if (typeof data === 'string') this.received.push(JSON.parse(data));
          else if (data instanceof ArrayBuffer) {
            const header = new DataView(data);
            this.received.push({ type: 'pcm', epoch: header.getUint32(0, true), unit: header.getUint32(4, true),
              frame: header.getUint32(8, true), samples: header.getUint32(12, true), bytes: data.byteLength });
          }
        });
      }
      send(data) {
        if (this.sent && typeof data === 'string') {
          const { config: _config, ...message } = JSON.parse(data); this.sent.push(message);
        }
        return super.send(data);
      }
    };
    const NativeContext = window.AudioContext;
    let first = delayedUnlock;
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); probe.contexts.push(this); }
      resume() {
        const actual = super.resume();
        if (!first) return actual;
        first = false; const gate = Promise.withResolvers(); probe.pendingUnlock = gate;
        return actual.then(() => { probe.unlockNativeReady = true; return gate.promise; }).finally(() => { probe.unlockSettled = true; });
      }
    };
  }, { delayedUnlock });
}
const snapshot = page => page.evaluate(() => ({
  sockets: window.playbackProbe.sockets.map(socket => ({ id: socket.fixtureId, readyState: socket.readyState, sent: socket.sent, received: socket.received })),
  contexts: window.playbackProbe.contexts.map(context => context.state), contextIds: window.playbackProbe.contexts.map((_context, index) => index + 1),
  status: document.querySelector('#transcript-speech-status').textContent,
  paused: document.querySelector('#transcript-speech-pause').textContent === '继续播报',
  enabled: !document.querySelector('#transcript-speech-stop').hidden
}));
async function open(page, fixture, record) {
  if (page.url() === 'about:blank') await page.goto(fixture.base);
  await page.locator('#history-listening').click();
  await page.getByRole('button', { name: `查看“播放验证 ${record}”`, exact: true }).click();
  await page.locator('#record-title').filter({ hasText: `播放验证 ${record}` }).waitFor();
}
async function start(page) { await page.locator('#transcript-speech-translation').focus(); await page.keyboard.press('Enter'); }
async function screenshot(page, width, scenario) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#transcript-speech-controls').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(directory, `playback-${width}-${scenario}.png`) });
}
async function unlockScenario(width, mutation = false) {
  const fixture = await playbackFixture({ hold: true, audioSamples: 12000 });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const served = monitorServed(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await prepare(page, { delayedUnlock: true, mutation }); await open(page, fixture, 'A'); await start(page);
    await page.waitForFunction(() => Boolean(window.playbackProbe.pendingUnlock) && window.playbackProbe.unlockNativeReady);
    await page.locator('#transcript-speech-stop').click();
    await open(page, fixture, 'B'); await start(page);
    await playbackWait(() => fixture.held.length === 1, 'current record B held response');
    await page.waitForFunction(() => window.playbackProbe.contexts.length === 2 && window.playbackProbe.contexts[0].state === 'closed' &&
      window.playbackProbe.contexts[1].state === 'running' && window.playbackProbe.sockets.length === 1 && window.playbackProbe.sockets[0].readyState === 1);
    const before = await snapshot(page); assert.equal(before.sockets.length, 1); assert.equal(before.enabled, true);
    assert.deepEqual(fixture.stats.commits, ['丙。']);
    await page.evaluate(async () => {
      window.playbackProbe.pendingUnlock.resolve();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForFunction(() => window.playbackProbe.unlockSettled);
    const after = await snapshot(page);
    if (mutation) {
      assert.equal(after.sockets.length, 2, 'the actual controller mutant incorrectly opens an old transport');
      await screenshot(page, width, 'negative-unlock');
      return { caught: true, mutation: 'late-unlock', expectedSockets: 1, actualSockets: after.sockets.length, before, after, served: await served(), errors };
    }
    assert.equal(after.sockets.length, 1); assert.equal(after.enabled, true); assert.equal(after.paused, false);
    assert.deepEqual(fixture.stats.commits, ['丙。']);
    await screenshot(page, width, 'unlock-race');
    await page.locator('#transcript-speech-stop').click();
    await page.waitForFunction(() => window.playbackProbe.contexts.every(context => context.state === 'closed') &&
      window.playbackProbe.sockets.every(socket => socket.readyState === 3));
    assert.deepEqual(errors, []);
    return { scenario: 'unlock-race', before, after, stopped: await snapshot(page), commits: fixture.stats.commits, served: await served(), errors };
  } finally { await page.close(); await fixture.close(); }
}
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  observations.chromium = browser.version();
  for (const width of [1280, 390]) {
    const cases = [];
    const textFixture = await playbackFixture({ audioSamples: 6000 });
    const textPage = await browser.newPage({ viewport: { width, height: 900 } });
    const textServed = monitorServed(textPage);
    const textErrors = []; textPage.on('pageerror', error => textErrors.push(error.message));
    try {
      await prepare(textPage); await open(textPage, textFixture, 'Text'); await start(textPage);
      await textPage.locator('#transcript-speech-status').filter({ hasText: '译文全文播报完成' }).waitFor();
      await textPage.waitForFunction(() => window.playbackProbe.contexts.every(context => context.state === 'closed') && window.playbackProbe.sockets.every(socket => socket.readyState === 3));
      const ledger = speechIntervalLedger(playbackGolden, textFixture.stats.commits, { graphemeSafe: true });
      const state = await snapshot(textPage), socket = state.sockets[0];
      const units = socket.received.filter(event => event.type === 'speech.unit');
      assert.ok(units.length > 2); assert.deepEqual(units.map(unit => unit.text), textFixture.stats.commits);
      const pcm = socket.received.filter(event => event.type === 'pcm');
      assert.equal(pcm.reduce((n, event) => n + event.samples, 0), units.length * 6000);
      assert.ok(pcm.every(frame => frame.bytes === 16 + frame.samples * 2));
      const progress = socket.sent.filter(event => event.type === 'speech.progress').at(-1);
      assert.equal(progress.playedUnit, units.length); assert.equal(progress.consumedSamples, units.length * 6000);
      assert.equal(state.enabled, false); assert.ok(state.contexts.every(value => value === 'closed'));
      await screenshot(textPage, width, 'text'); assert.deepEqual(textErrors, []);
      cases.push({ scenario: 'text', normalized: playbackGolden, requests: textFixture.stats.commits, ledger, state, served: await textServed(), errors: textErrors });
    } finally { await textPage.close(); await textFixture.close(); }

    const fixture = await playbackFixture({ hold: true, audioSamples: 12000 });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const served = monitorServed(page);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await prepare(page); await open(page, fixture, 'A'); await start(page);
      await playbackWait(() => fixture.held.length === 1, 'first held browser synthesis');
      await page.locator('#transcript-speech-pause').click();
      await page.waitForFunction(() => document.querySelector('#transcript-speech-pause').textContent === '继续播报');
      await page.locator('#transcript-speech-seek').focus(); await page.keyboard.press('End');
      await page.waitForFunction(() => window.playbackProbe.sockets.length === 2 &&
        window.playbackProbe.sockets[1].received.some(event => event.type === 'speech.ready') &&
        window.playbackProbe.sockets[0].readyState === 3 && window.playbackProbe.contexts.at(-1).state === 'suspended');
      const paused = await snapshot(page), commitsWhilePaused = fixture.stats.commits.slice();
      assert.equal(paused.paused, true); assert.equal(paused.sockets[1].sent[0].startPosition, 2);
      assert.equal(paused.sockets[1].sent[0].paused, true); assert.deepEqual(fixture.stats.commits, ['甲。']);
      assert.equal(await page.locator('#transcript-speech-seek').evaluate(element => element === document.activeElement), true);
      await screenshot(page, width, 'paused-seek');
      // Deliver callbacks on the retired browser transport after a current socket
      // exists. Even a forged current wire epoch must not cross object ownership.
      await page.evaluate(() => {
        const [old, current] = window.playbackProbe.sockets;
        const epoch = current.sent[0].epoch, packet = new ArrayBuffer(20), header = new DataView(packet);
        for (const [offset, value] of [[0, epoch], [4, 1], [8, 0], [12, 2]]) header.setUint32(offset, value, true);
        old.dispatchEvent(new MessageEvent('message', { data: packet }));
        for (const type of ['speech.error', 'speech.finished']) old.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, epoch, message: 'INVALID OLD CALLBACK' }) }));
        old.dispatchEvent(new Event('close')); old.dispatchEvent(new Event('error'));
      });
      const afterLate = await snapshot(page), commitsAfterLate = fixture.stats.commits.slice();
      assert.equal(afterLate.enabled, true); assert.equal(afterLate.paused, true); assert.equal(afterLate.status, paused.status);
      assert.deepEqual(fixture.stats.commits, ['甲。']);
      await screenshot(page, width, 'stale-events');
      await page.locator('#transcript-speech-pause').click();
      await playbackWait(() => fixture.held.length === 2, 'explicit resume at selected sentence');
      assert.deepEqual(fixture.stats.commits, ['甲。', '乙。']);
      await playbackWait(() => fixture.held[0].ws.readyState === 3, 'retired provider transport closes');
      assert.equal(fixture.held[0].sendDefault(), false);
      fixture.held[1].sendDefault();
      await page.locator('#transcript-speech-status').filter({ hasText: '译文全文播报完成' }).waitFor();
      await page.waitForFunction(() => window.playbackProbe.contexts.every(context => context.state === 'closed') && window.playbackProbe.sockets.every(socket => socket.readyState === 3));
      const finished = await snapshot(page); assert.equal(finished.enabled, false); assert.deepEqual(errors, []);
      cases.push({ scenario: 'paused-seek', paused, afterLate, finished, commitsWhilePaused, commitsAfterLate, commits: fixture.stats.commits, served: await served(), errors });
    } finally { await page.close(); await fixture.close(); }
    cases.push(await unlockScenario(width)); observations.widths.push({ width, cases });
  }
  observations.negative = await unlockScenario(1280, true);
  assert.deepEqual(observations.negative.errors, []);
  observations.complete = true;
  console.log(JSON.stringify({ complete: true, widths: observations.widths.map(row => row.width), negativeCaught: observations.negative.caught }));
} finally {
  observations.sourceEnd = await playbackSourceSnapshot();
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify(observations, null, 2) + '\n');
  await browser?.close();
}
