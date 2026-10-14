import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, writeJson, checkArtifacts } from '../scripts/lib/verification-evidence.mjs';
import { tapSummary, summarizeChecks } from '../scripts/lib/verification-checks.mjs';
import { speechIntervalLedger } from './playback-text-contract.mjs';
import { playbackGolden } from './playback-speech-fixture.mjs';

export { runChecks as runPlaybackChecks } from '../scripts/lib/verification-checks.mjs';
export const playbackCounts = { identity: 15, text: 4, transports: 10 };
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
export function checkPlaybackBrowser(browser) {
  try {
    if (browser?.complete !== true || typeof browser.chromium !== 'string' || !browser.chromium.length || browser.widths?.length !== 2) return false;
    for (const width of [1280, 390]) {
      const rows = browser.widths.filter(row => row.width === width); if (rows.length !== 1 || rows[0].cases?.length !== 3) return false;
      const cases = rows[0].cases;
      if (new Set(cases.map(row => row.scenario)).size !== 3 || !cases.every(row => cleanErrors(row.errors))) return false;
      const text = cases.find(row => row.scenario === 'text'), seek = cases.find(row => row.scenario === 'paused-seek'), unlock = cases.find(row => row.scenario === 'unlock-race');
      if (!text || !seek || !unlock || text.normalized !== playbackGolden || text.requests?.length < 3) return false;
      if (!isDeepStrictEqual(text.ledger, speechIntervalLedger(playbackGolden, text.requests, { graphemeSafe: true }))) return false;
      if (text.state?.enabled !== false || !text.state.contexts?.length || text.state.contexts.some(state => state !== 'closed') || text.state.sockets?.length !== 1) return false;
      const socket = text.state.sockets[0], units = socket.received.filter(event => event.type === 'speech.unit'), pcm = socket.received.filter(event => event.type === 'pcm');
      if (!isDeepStrictEqual(units.map(unit => unit.text), text.requests) || !pcm.length || pcm.reduce((n, frame) => n + frame.samples, 0) !== units.length * 6000) return false;
      const start = socket.sent.find(event => event.type === 'speech.transcript'); let unit = 0, frame = 0;
      for (const packet of pcm) {
        if (packet.unit !== unit) { if (packet.unit !== unit + 1) return false; unit = packet.unit; frame = 0; }
        if (packet.epoch !== start.epoch || packet.frame !== frame++ || !Number.isSafeInteger(packet.samples) || packet.samples <= 0 || packet.bytes !== 16 + packet.samples * 2) return false;
      }
      if (unit !== units.length || socket.received.filter(event => event.type === 'speech.unit-end').length !== units.length || !socket.received.some(event => event.type === 'speech.finished')) return false;
      const progress = socket.sent.filter(event => event.type === 'speech.progress').at(-1);
      if (progress?.playedUnit !== units.length || progress.consumedSamples !== units.length * 6000) return false;
      if (seek.paused?.enabled !== true || seek.paused.paused !== true || seek.paused.sockets?.length !== 2 ||
        seek.paused.sockets[1].sent[0]?.paused !== true || seek.paused.sockets[1].sent[0]?.startPosition !== 2 ||
        seek.afterLate?.enabled !== true || seek.afterLate.paused !== true || seek.afterLate.status !== seek.paused.status ||
        seek.finished?.enabled !== false || !isDeepStrictEqual(seek.commits, ['甲。', '乙。'])) return false;
      if (unlock.before?.sockets?.length !== 1 || unlock.after?.sockets?.length !== 1 || unlock.after.enabled !== true || unlock.after.paused !== false ||
        unlock.stopped?.enabled !== false || unlock.stopped.contexts?.some(state => state !== 'closed') || unlock.stopped.sockets?.some(socket => socket.readyState !== 3) ||
        !isDeepStrictEqual(unlock.commits, ['丙。'])) return false;
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
      if (!checkPlaybackBrowser(observations.browser) || refs.length !== playbackAssets.length || playbackAssets.some(name => refs.filter(ref => ref?.path === name).length !== 1)) return false;
      if (!isDeepStrictEqual(observations.browser, JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8')))) return false;
    }
    return refs.length === 0 || await checkArtifacts(directory, { artifacts: refs });
  } catch { return false; }
}
