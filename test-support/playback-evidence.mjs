import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, writeJson, checkArtifacts } from '../scripts/lib/verification-evidence.mjs';
import { tapSummary, summarizeChecks } from '../scripts/lib/verification-checks.mjs';
import { speechIntervalLedger } from './playback-text-contract.mjs';
import { playbackProvenance, validPlaybackProvenance, stablePlaybackSources } from './playback-provenance.mjs';
import { playbackGolden } from './playback-speech-fixture.mjs';

export { runChecks as runPlaybackChecks } from '../scripts/lib/verification-checks.mjs';
export const playbackCounts = { identity: 16, text: 4, transports: 10 };
export const playbackAssets = ['browser.json', ...[1280, 390].flatMap(width => ['text', 'paused-seek', 'stale-events', 'unlock-race'].map(name => `playback-${width}-${name}.png`)), 'playback-1280-negative-unlock.png'];
const hashFiles = (directory, names) => Promise.all(names.map(async name => ({ path: name, sha256: digest(await readFile(path.join(directory, name))) })));
export function playbackTap(log, name) {
  const result = tapSummary(log);
  return { ...result, ok: result.ok && result.testCount === playbackCounts[name] };
}
export const playbackRequiredChecks = (id, nodeOnly) => [id === 'HW-08-03' ? 'text' : 'identity', 'transports', ...(nodeOnly ? [] : ['browser'])];
export function summarizePlaybackResults(options) {
  return summarizeChecks({ ...options, expectedChecks: ['identity', 'text', 'transports', ...(options.nodeOnly ? [] : ['browser'])],
    checksForProperty: id => playbackRequiredChecks(id, options.nodeOnly) });
}
const cleanErrors = value => Array.isArray(value) && value.length === 0;
const resourceShape = state => Array.isArray(state?.contexts) && state.contexts.length > 0 && Array.isArray(state.contextIds) &&
  state.contextIds.length === state.contexts.length && new Set(state.contextIds).size === state.contextIds.length && state.contextIds.every(id => Number.isSafeInteger(id) && id > 0) &&
  state.contexts.every(value => ['running', 'suspended', 'closed'].includes(value)) && Array.isArray(state.sockets) && state.sockets.length > 0 &&
  new Set(state.sockets.map(socket => socket.id)).size === state.sockets.length && state.sockets.every(socket => Number.isSafeInteger(socket.id) && socket.id > 0 && [0, 1, 2, 3].includes(socket.readyState));
const activeResources = (state, contextState) => resourceShape(state) && state.contexts.at(-1) === contextState && state.contexts.slice(0, -1).every(value => value === 'closed') &&
  state.sockets.at(-1).readyState === 1 && state.sockets.slice(0, -1).every(socket => socket.readyState === 3);
const closedResources = state => resourceShape(state) && state.enabled === false && state.contexts.every(value => value === 'closed') && state.sockets.every(socket => socket.readyState === 3);
const sameResources = (before, after) => resourceShape(before) && resourceShape(after) && isDeepStrictEqual(before.contextIds, after.contextIds) &&
  isDeepStrictEqual(before.contexts, after.contexts) && isDeepStrictEqual(before.sockets.map(socket => [socket.id, socket.readyState]), after.sockets.map(socket => [socket.id, socket.readyState]));
export function checkPlaybackFrames(socket, requests, samplesPerUnit = 6000) {
  try {
    const starts = socket.sent.filter(event => event.type === 'speech.transcript'); if (starts.length !== 1) return false;
    const epoch = starts[0].epoch; if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffffffff) return false;
    let active = 0, count = 0, frame = 0, samples = 0, total = 0, ends = 0, finished = 0;
    for (const event of socket.received) {
      if (event.type === 'speech.error') return false;
      if (event.type === 'speech.unit') {
        if (active || finished || event.epoch !== epoch || event.unit !== count + 1 || event.text !== requests[count]) return false;
        active = ++count; frame = samples = 0;
      } else if (event.type === 'pcm') {
        if (!active || event.epoch !== epoch || event.unit !== active || event.frame !== frame++ || !Number.isSafeInteger(event.samples) || event.samples <= 0 || event.bytes !== 16 + event.samples * 2) return false;
        samples += event.samples; total += event.samples;
      } else if (event.type === 'speech.unit-end') {
        if (!active || event.epoch !== epoch || event.unit !== active || event.samples !== samples || samples !== samplesPerUnit) return false;
        active = 0; ends++;
      } else if (event.type === 'speech.finished') {
        if (active || event.epoch !== epoch || count !== requests.length || ++finished !== 1) return false;
      }
    }
    const progress = socket.sent.filter(event => event.type === 'speech.progress').at(-1);
    return active === 0 && count === requests.length && ends === count && finished === 1 && total === count * samplesPerUnit &&
      progress?.epoch === epoch && progress.playedUnit === count && progress.consumedSamples === total;
  } catch { return false; }
}

export function checkPlaybackBrowser(browser, provenance) {
  try {
    if (browser?.complete !== true || typeof browser.chromium !== 'string' || !browser.chromium.length || browser.widths?.length !== 2) return false;
    if (!validPlaybackProvenance(browser, provenance)) return false;
    for (const width of [1280, 390]) {
      const rows = browser.widths.filter(row => row.width === width); if (rows.length !== 1 || rows[0].cases?.length !== 3) return false;
      const cases = rows[0].cases;
      if (new Set(cases.map(row => row.scenario)).size !== 3 || !cases.every(row => cleanErrors(row.errors))) return false;
      const text = cases.find(row => row.scenario === 'text'), seek = cases.find(row => row.scenario === 'paused-seek'), unlock = cases.find(row => row.scenario === 'unlock-race');
      if (!text || !seek || !unlock || text.normalized !== playbackGolden || text.requests?.length < 3) return false;
      if (!isDeepStrictEqual(text.ledger, speechIntervalLedger(playbackGolden, text.requests, { graphemeSafe: true }))) return false;
      if (!closedResources(text.state) || text.state.sockets?.length !== 1) return false;
      const socket = text.state.sockets[0];
      if (socket.readyState !== 3 || !checkPlaybackFrames(socket, text.requests)) return false;
      if (seek.paused?.enabled !== true || seek.paused.paused !== true || seek.paused.sockets?.length !== 2 ||
        seek.paused.sockets[1].sent[0]?.paused !== true || seek.paused.sockets[1].sent[0]?.startPosition !== 2 ||
        seek.afterLate?.enabled !== true || seek.afterLate.paused !== true || seek.afterLate.status !== seek.paused.status ||
        !activeResources(seek.paused, 'suspended') || !activeResources(seek.afterLate, 'suspended') || !sameResources(seek.paused, seek.afterLate) || !isDeepStrictEqual(seek.commitsWhilePaused, ['甲。']) || !isDeepStrictEqual(seek.commitsAfterLate, ['甲。']) ||
        !closedResources(seek.finished) || !isDeepStrictEqual(seek.commits, ['甲。', '乙。'])) return false;
      if (unlock.before?.enabled !== true || unlock.before.paused !== false || unlock.before?.sockets?.length !== 1 || unlock.after?.sockets?.length !== 1 || unlock.after.enabled !== true || unlock.after.paused !== false ||
        !activeResources(unlock.before, 'running') || !activeResources(unlock.after, 'running') || !sameResources(unlock.before, unlock.after) || !closedResources(unlock.stopped) || !isDeepStrictEqual(unlock.commits, ['丙。'])) return false;
    }
    const negative = browser.negative;
    return negative?.caught === true && negative.mutation === 'late-unlock' && negative.expectedSockets === 1 && negative.actualSockets === 2 &&
      negative.before?.sockets?.length === 1 && negative.after?.sockets?.length === 2 && cleanErrors(negative.errors);
  } catch { return false; }
}
export async function writePlaybackEvidence(directory, observations) {
  const names = observations.browser?.complete ? playbackAssets : (await readdir(directory)).filter(name => name.endsWith('.png') || name === 'browser.json');
  const attachments = await hashFiles(directory, names);
  await writeJson(path.join(directory, 'observations.json'), { ...observations, attachments });
  await writeFile(path.join(directory, 'worker.log'), (await Promise.all(observations.checks.map(async ({ name }) =>
    `CHECK ${name}\n${await readFile(path.join(directory, `${name}.log`), 'utf8')}`))).join('\n'));
  return hashFiles(directory, ['observations.json', 'worker.log']);
}
export async function checkPlaybackEvidence(directory, result) {
  if (!await checkArtifacts(directory, result)) return false;
  try {
    const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8')), refs = observations.attachments;
    const provenance = await playbackProvenance();
    if (!stablePlaybackSources(observations.sourceStart, observations.sourceEnd) || !isDeepStrictEqual(observations.sourceStart, provenance.snapshot)) return false;
    if (!Array.isArray(refs) || new Set(refs.map(item => item?.path)).size !== refs.length) return false;
    if (result.status === 'passed' && !observations.browser?.complete) return false;
    if (!Array.isArray(observations.checks) || new Set(observations.checks.map(check => check.name)).size !== observations.checks.length) return false;
    const boundLog = (await Promise.all(observations.checks.map(async ({ name }) => `CHECK ${name}\n${await readFile(path.join(directory, `${name}.log`), 'utf8')}`))).join('\n');
    if (boundLog !== await readFile(path.join(directory, 'worker.log'), 'utf8')) return false;
    for (const check of observations.checks) {
      if (!['identity', 'text', 'transports', 'browser'].includes(check.name)) return false;
      if (check.name !== 'browser') {
        const tap = playbackTap(await readFile(path.join(directory, `${check.name}.log`), 'utf8'), check.name);
        if (tap.testCount !== check.execution?.testCount || tap.testComplete !== check.execution?.testComplete) return false;
        const ok = tap.ok && check.execution.code === 0 && check.execution.signal == null && check.execution.timedOut === false && check.execution.interrupted === false;
        if (ok !== check.execution.ok) return false;
      }
    }
    if (result.status === 'passed' && playbackRequiredChecks(result.property.id, false).some(name => !observations.checks.some(check =>
      check.name === name && check.execution?.ok === true && check.execution.code === 0 && check.execution.signal == null &&
      check.execution.timedOut === false && check.execution.interrupted === false))) return false;
    if (observations.browser?.complete) {
      if (!checkPlaybackBrowser(observations.browser, provenance) || refs.length !== playbackAssets.length || playbackAssets.some(name => refs.filter(ref => ref?.path === name).length !== 1)) return false;
      if (!isDeepStrictEqual(observations.browser, JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8')))) return false;
    }
    return refs.length === 0 || await checkArtifacts(directory, { artifacts: refs });
  } catch { return false; }
}
