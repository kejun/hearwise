import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../scripts/lib/process.mjs';
import { normalizePlaybackTrace, replayPlaybackTrace, createAuditedPlaybackAdapter } from '../scripts/lib/playback-protocol-replay.mjs';
import { formalPlan, checkerConclusion } from '../scripts/lib/formal-protocol-evidence.mjs';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { playbackCommandShape, loadPlaybackConfig, playbackTraceConfig, playbackMetadata, playbackCoverage, playbackModelRoot, validatePlaybackEvidence } from '../scripts/lib/playback-protocol-evidence.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
export async function realPlaybackTraces() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearwise-playback-traces-'));
  const config = await loadPlaybackConfig();
  const traces = [];
  try {
    for (const main of config.witnesses.mains) {
      const result = await runProcess(process.execPath, [path.resolve('node_modules/@informalsystems/quint/dist/src/cli.js'), 'test', path.join(playbackModelRoot, 'witnesses.qnt'),
        '--main', main, '--backend', 'typescript', '--seed', '42', '--max-samples', '1', '--out-itf', path.join(root, `${main}-{test}-{seq}.itf.json`)], { timeoutMs: 20000 });
      if (!result.ok) throw new Error(`Model witness generation failed: ${result.tail}`);
    }
    for (const file of (await readdir(root)).filter(file => file.endsWith('.itf.json')).sort()) {
      const raw = await readFile(path.join(root, file), 'utf8');
      traces.push({ file, raw, itf: JSON.parse(raw), trace: normalizePlaybackTrace(JSON.parse(raw), playbackTraceConfig(file)) });
    }
    return traces;
  } finally { await rm(root, { recursive: true, force: true }); }
}

const stamp = '2026-01-01T00:00:00.000Z';
const execution = { code: 0, signal: null, timedOut: false, interrupted: false };
const testOnly = 'TEST ONLY: synthetic checker logs for gate regression, NOT formal verification evidence';
const encode = value => typeof value === 'number' ? { '#bigint': String(value) } : value && typeof value === 'object' ?
  { '#map': Object.entries(value).map(([key, entry]) => [encode(Number(key)), encode(entry)]) } : value;
export function negativeTestTrace(source, mutant) {
  const itf = structuredClone(source), last = itf.states.at(-1);
  const set = (name, value) => { last[itf.vars.find(variable => variable.split('::').at(-1) === name)] = encode(value); };
  if (mutant === 'mutant_old_callback') set('isolationViolation', true);
  if (mutant === 'mutant_seek_unpaused') set('pauseViolation', true);
  if (mutant === 'mutant_accepted_loss') set('accepted', { 1: 0 });
  if (mutant === 'mutant_wrong_frame') set('received', { 1: 999 });
  return itf;
}
export async function gateFixture(t, traces, profile = 'fast') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hearwise-TEST-ONLY-playback-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadPlaybackConfig(), pinned = JSON.parse(await readFile(path.join(playbackModelRoot, 'toolchain.json'), 'utf8'));
  const report = { ...await playbackMetadata(), fixturePurpose: testOnly, profile, startedAt: stamp, finishedAt: stamp, complete: true, ok: true,
    execution: { ...execution, complete: true }, domain: config, propertyCoverage: playbackCoverage(config), tools: { quint: pinned.quint.version,
      apalache: pinned.apalache.version, tlc: pinned.apalache.bundledTlcVersion, apalacheJarSha256: pinned.apalache.jarSha256,
      apalacheArchiveSha256: pinned.apalache.archiveSha256, java: 'openjdk version "21.0.0" TEST ONLY', node: process.version, sqlite: process.versions.sqlite }, results: [], artifacts: [] };
  const files = new Map(), row = id => report.results.find(result => result.id === id);
  const put = async (file, value) => { const text = typeof value === 'string' ? value : json(value); files.set(file, text);
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await writeFile(path.join(directory, file), text);
    const artifact = report.artifacts.find(entry => entry.path === file); if (artifact) artifact.sha256 = digest(text); else report.artifacts.push({ path: file, sha256: digest(text) }); };
  for (const entry of formalPlan(config)) {
    const result = { ...entry, startedAt: stamp, finishedAt: stamp, complete: true, status: 'passed', log: `${entry.id}.log`, execution: { ...execution, code: entry.kind === 'model-negative' ? 1 : 0 } };
    report.results.push(result);
    if (['implementation-replay', 'implementation-negative'].includes(entry.kind)) continue;
    let log = testOnly + '\n';
    if (entry.kind === 'finite-state-complete') log += 'Model checking completed. No error has been found.\n846 states generated, 536 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 19.\n';
    if (entry.kind === 'bounded-model-check') log += `Step ${config.profiles[profile].apalacheDepth[entry.id.slice('bounded-'.length)]}: transition\nThe outcome is: NoError\n[ok] No violation found\n`;
    if (entry.kind === 'simulation') log += '[ok] No violation found\n';
    if (entry.kind === 'model-negative') log += 'error: found a counterexample\n';
    if (entry.kind === 'implementation-regression') {
      const count = config.regression.expectedTests;
      log += `TAP version 13\n1..${count}\n# tests ${count}\n# suites 0\n# pass ${count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.0\n`;
      result.argv = ['--test', '--test-reporter=tap', '--test-timeout=30000', ...config.regression.files.map(file => path.resolve(file))];
    }
    const shape = playbackCommandShape(result, config, profile);
    if (shape) {
      result.argv = [...shape.prefix, ...Object.entries(shape.flags).flat()];
      if (['finite-state-complete', 'bounded-model-check', 'model-negative'].includes(entry.kind)) result.argv.push('--server-endpoint', '127.0.0.1:12345');
      if (['model-witness', 'simulation', 'model-negative'].includes(entry.kind)) result.argv.push('--out-itf', '/tmp/TEST-ONLY.itf.json');
    }
    if (['finite-state-complete', 'bounded-model-check'].includes(entry.kind)) {
      result.bound = config.profiles[profile].apalacheDepth[entry.id.slice('bounded-'.length)];
      result.metrics = checkerConclusion(entry.kind, result.execution, log, result.bound).metrics;
    }
    await put(result.log, log);
    const main = entry.id.replace(/^(witnesses|simulation|negative)-/, '');
    if (entry.kind === 'model-witness') {
      result.traces = traces.filter(trace => trace.file.startsWith(main)).map(trace => `witnesses/${trace.file}`);
      for (const file of result.traces) await put(file, traces.find(trace => file.endsWith(trace.file)).raw);
    }
    if (entry.kind === 'simulation') {
      const trace = traces.find(trace => trace.file.includes(main === 'single' ? 'wrongEpochIgnoredTest-' : 'normalSuccessTest-'));
      const itf = structuredClone(trace.itf);
      if (main === 'pair') {
        itf.states = itf.states.slice(0, 5);
        for (const state of itf.states) for (const value of Object.values(state)) if (value?.['#map']) value['#map'] = value['#map'].filter(([key]) => Number(key['#bigint']) <= 2);
      }
      result.traces = Array.from({ length: config.simulation.selectedTraces }, (_, i) => `simulation/${main}-${i}.itf.json`);
      for (const file of result.traces) await put(file, itf);
    }
    if (entry.kind === 'model-negative') {
      const source = traces.find(trace => trace.file.includes(main.includes('callback') || main.includes('seek') ? 'normalSuccessTest-' : 'fullTextSuccessTest-'));
      result.traces = [`negative/${main}.itf.json`]; await put(result.traces[0], negativeTestTrace(source.itf, main));
    }
  }
  const replayCache = new Map();
  for (const id of ['replay-witnesses', 'replay-simulation', 'negative-replay']) {
    const result = row(id), negative = id === 'negative-replay', replays = [];
    const sources = report.results.filter(source => source.kind === (id === 'replay-simulation' ? 'simulation' : 'model-witness'));
    for (const source of sources) for (const file of source.traces.filter(file => !negative || file.includes('normalSuccessTest-'))) {
      const raw = files.get(file), trace = normalizePlaybackTrace(JSON.parse(raw), playbackTraceConfig(source.id));
      const key = `${negative}:${JSON.stringify(trace)}`;
      if (!replayCache.has(key)) replayCache.set(key, await replayPlaybackTrace(trace, config => createAuditedPlaybackAdapter({ ...config, ...(negative ? { mutation: 'old-player-callback' } : {}) })));
      replays.push({ ...structuredClone(replayCache.get(key)), sourceTrace: file, sourceTraceSha256: digest(raw), semanticTraceSha256: digest(JSON.stringify(trace)), steps: trace.steps.length });
    }
    result.data = `${id}.json`; result.traces = replays.map(replay => replay.sourceTrace); result.samples = replays.length; result.steps = replays.reduce((n, replay) => n + replay.steps, 0);
    await put(result.data, replays); await put(result.log, { fixturePurpose: testOnly, samples: replays.length });
  }
  const save = () => writeFile(path.join(directory, 'report.json'), json(report));
  const check = async options => { await save(); return validatePlaybackEvidence(directory, options); };
  await save(); return { directory, config, report, row, files, put, save, check };
}
