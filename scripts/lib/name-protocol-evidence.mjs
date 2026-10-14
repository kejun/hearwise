import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { checkerConclusion } from './formal-protocol-evidence.mjs';
import { parseTapFooter } from './tap-summary.mjs';
import { quintCli, quintHome, toolchain, checkProtocolTools } from './relation-protocol-tools.mjs';
import { normalizeNameTrace, expectedNameMutationViolation, validateNameProjection } from './name-protocol-replay.mjs';
import { inspectMatchedNameDurable, inspectNameNegativeDurable } from './name-protocol-durable.mjs';
import { properties } from '../../verification/name-protocol/properties.mjs';

export const nameModelRoot = path.resolve('verification/name-protocol');
export const nameConfig = () => readFile(path.join(nameModelRoot, 'config.json'), 'utf8').then(JSON.parse);
export const nameWitnesses = {
  independent_witnesses: ['successTest', 'noOpTest', 'noOpSkipsAssociatedFaultTest', 'concurrentConflictTest', 'revisionRecheckTest',
    'anchorRecheckTest', 'associatedRollbackTest', 'receiptRollbackTest', 'lostReceiptRecoveryTest', 'unknownReopenTest', 'rollbackUnknownTest', 'cancelledTest', 'lateResponseTest'],
  reuse_witnesses: ['exactReplayTest', 'receiptPrecedesRevisionTest', 'receiptPrecedesAnchorTest', 'rawFingerprintConflictTest', 'revisionFingerprintConflictTest',
    'explicitReplayAfterLostResponseTest', 'explicitReplayAfterRollbackTest', 'duplicateInFlightTest', 'mismatchedReceiptLookupTest']
};
export const nameNegatives = [
  { mutation: 'bypass_fingerprint', witness: 'reuse_witnesses-rawFingerprintConflictTest-3.itf.json', property: 'exactReplay' },
  { mutation: 'non_atomic_receipt', witness: 'independent_witnesses-receiptRollbackTest-7.itf.json', property: 'atomicRollback' },
  { mutation: 'bypass_revision', witness: 'independent_witnesses-revisionRecheckTest-4.itf.json', property: 'revisionRechecked' },
  { mutation: 'bypass_anchor', witness: 'independent_witnesses-anchorRecheckTest-5.itf.json', property: 'anchorsRechecked' }
];
export const nameGateTests = [
  'name stage plan preserves the frozen 23 stages and budgets',
  'name commands reject altered arguments cwd limits and input identity',
  'strict name TAP requires every named body and nested plan',
  'strict name checker logs reject summaries and incomplete executions',
  'name witnesses require the complete fixed genuine test roster',
  'name abstract negatives require the precise first violated property',
  'name replay gate binds every ITF action mode path and expected projection',
  'name production negatives reject false prefixes and corrupted final raw tables',
  'name report gate rejects missing results artifacts and stale inputs',
  'name stage shares its parent deadline with the real child and removes temporary resources'
];
const replayTests = [
  'real source-copy negatives break fingerprint, atomic receipt, revision and active-anchor contracts',
  'independent gate rejects raw-table/HTTP corruption despite unchanged projections and empty cached violations',
  'raw business gate is usable by browser consumers and independently detects protected-row changes',
  'real successful projection cannot pass replay with fabricated or missing durable observations',
  'name ITF normalization rejects missing variables, unsafe map keys, extra fields and unsupported actions',
  'driver separates unavailable, timeout and cleanup failure from implementation mismatch',
  'raw client evidence rejects contradicted delivery, preparation and event chronology'
];
const httpTests = ['three simultaneous exact HTTP attempts share one durable name transaction and receipt',
  'same-ID conflicting concurrent HTTP bodies choose one actual winner without relying on arrival order',
  'actual HTTP receipt-boundary failure reports unsaved and allows the identical request after rollback',
  'browser-facing raw business gate supports a long Unicode replacement using actual HTTP and full table observations'];
export const nameLifecycleTests = ['name slow startup keeps its own limit before the action timeout',
  'name startup timeout still closes a resource delivered inside its cleanup window',
  'name overdue startup remains unverified and closes its eventual HTTP resource',
  'name replay shares one absolute deadline instead of resetting it per action',
  'name acquired resource is closed even when synchronous startup exhausts the deadline'];
export const nameDriverRoster = [...nameGateTests, ...httpTests, ...replayTests, ...nameLifecycleTests,
  ...Object.values(nameWitnesses).flat().map(name => `actual Quint witness: ${name}`),
  ...nameNegatives.map(row => `${replayTests[0]} > ${row.mutation}`)].sort();
export function nameConfiguration(main, config) {
  const mode = main.replace(/_witnesses$/, '');
  const row = config.configurations.find(value => value.main === mode) || config.mutants.find(value => value.main === main);
  if (!row) throw new Error(`Unknown name configuration ${main}`);
  return { mode: row.mode };
}
export function nameProtocolPlan(config) {
  return [
    ...['protocol', 'configurations', 'witnesses'].map(name => ({ id: `typecheck-${name}`, kind: 'typecheck', timeoutMs: 60000 })),
    ...config.configurations.flatMap(row => [{ id: `tlc-${row.main}`, kind: 'finite-state-complete', timeoutMs: config.limits.tlcMs },
      { id: `bounded-${row.main}`, kind: 'bounded-model-check', timeoutMs: config.limits.boundedMs, bound: row.apalacheDepth }]),
    ...config.witnesses.mains.map(main => ({ id: `witnesses-${main}`, kind: 'model-witness', timeoutMs: config.limits.witnessMs })),
    ...config.configurations.map(row => ({ id: `simulation-${row.main}`, kind: 'simulation', timeoutMs: config.limits.simulationMs })),
    ...config.mutants.map(row => ({ id: `negative-${row.main}`, kind: 'model-negative', timeoutMs: config.limits.mutationMs, bound: row.maxSteps })),
    { id: 'replay-witnesses', kind: 'implementation-replay', timeoutMs: 60000 },
    { id: 'replay-simulation', kind: 'implementation-replay', timeoutMs: 60000 },
    ...nameNegatives.map(row => ({ id: `negative-replay-${row.mutation}`, kind: 'implementation-negative', timeoutMs: 30000 })),
    { id: 'driver-regressions', kind: 'implementation-regression', timeoutMs: 90000 }
  ];
}
export const nameProtocolCoverage = config => properties.map(property => ({ id: property.id, version: property.version,
  checks: nameProtocolPlan(config).map(row => row.id), scope: 'Frozen formal configurations and actual HTTP/SQLite replay only',
  additionalRequiredEvidence: property.additionalRequiredEvidence || [] }));
const git = args => execFileSync('git', args, { encoding: 'utf8', timeout: 5000 });
async function outputFiles(directory) {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await outputFiles(file));
    else { assert.ok(entry.isFile(), 'Build files must not be symbolic links'); rows.push(file); }
  }
  return rows;
}
export async function nameProtocolMetadata() {
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const sourceFiles = await Promise.all(files.map(async file => ({ path: file, sha256: digest(await readFile(file)) })));
  const outputs = [...await outputFiles('dist/server'), ...await outputFiles('public/vendor')].sort();
  const buildFiles = await Promise.all(outputs.map(async file => ({ path: file, sha256: digest(await readFile(file)) })));
  const source = sourceVersion(), map = JSON.parse(await readFile('dist/server/index.js.map', 'utf8'));
  let buildCurrent = true, buildSource = null;
  for (const [index, file] of map.sources.entries()) {
    if (file === '<define:__BUILD_META__>') buildSource = JSON.parse(map.sourcesContent[index]);
    else if (await readFile(path.resolve('dist/server', file), 'utf8') !== map.sourcesContent[index]) buildCurrent = false;
  }
  const bundle = await import(`${pathToFileURL(path.resolve('dist/server/index.js')).href}?digest=${buildFiles.find(row => row.path === 'dist/server/index.js').sha256}`);
  const runtime = bundle.createTaskRuntime(); let runtimeBuild;
  try { runtimeBuild = runtime.diagnostics().build; } finally { await runtime.dispose(); }
  buildCurrent &&= same(runtimeBuild, buildSource) && buildSource?.git_sha === source.sha && buildSource?.build_dirty === source.dirty;
  return { schemaVersion: 1, domain: 'name-protocol', specificationVersion: '1.0', modelVersion: 1,
    repositoryRoot: process.cwd(), source, sourceFiles, sourceDigest: digest(JSON.stringify(sourceFiles)),
    buildFiles, buildDigest: digest(JSON.stringify(buildFiles)), buildSource, runtimeBuild, buildCurrent,
    modelDigest: digest(JSON.stringify(sourceFiles.filter(row => row.path.startsWith('verification/name-protocol/')))),
    lockDigest: digest(await readFile('package-lock.json')),
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release() } };
}
export const nameInputBinding = (context, config, tools) => ({ source: context.source, sourceDigest: context.sourceDigest,
  buildDigest: context.buildDigest, buildSource: context.buildSource, buildCurrent: context.buildCurrent,
  modelDigest: context.modelDigest, lockDigest: context.lockDigest, configDigest: digest(JSON.stringify(config)), toolsDigest: digest(JSON.stringify(tools ?? null)) });
export function nameStageCommand(stage, config, directory, endpoint = null, origin = { repositoryRoot: process.cwd(), nodeExecutable: process.execPath, quintHome }) {
  const resolve = file => path.join(origin.repositoryRoot, file), modelRoot = resolve('verification/name-protocol');
  const cli = resolve('node_modules/@informalsystems/quint/dist/src/cli.js');
  const main = stage.id.replace(/^(typecheck|tlc|bounded|witnesses|simulation|negative)-/, '');
  let args, cwd = directory;
  if (stage.kind === 'typecheck') args = [cli, 'typecheck', path.join(modelRoot, `${main}.qnt`)];
  else if (['finite-state-complete', 'bounded-model-check', 'model-negative'].includes(stage.kind)) {
    assert.match(endpoint || '', /^127\.0\.0\.1:[1-9]\d{3,4}$/); assert.ok(Number(endpoint.split(':')[1]) <= 65535);
    args = [cli, 'verify', path.join(modelRoot, config.specification), '--main', main, '--init', config.init, '--step', config.step,
      '--invariant', config.invariant, '--apalache-version', toolchain.apalache.version, '--verbosity', '3',
      '--backend', stage.kind === 'finite-state-complete' ? 'tlc' : 'apalache', '--server-endpoint', endpoint];
    if (stage.kind === 'finite-state-complete') args.push('--tlc-config', path.join(modelRoot, 'tlc.json'));
    else args.push('--max-steps', String(stage.bound));
    if (stage.kind === 'model-negative') args.push('--out-itf', path.join(directory, 'negative', `${main}.itf.json`));
  } else if (stage.kind === 'model-witness') args = [cli, 'test', path.join(modelRoot, config.witnesses.specification), '--main', main,
    '--backend', 'typescript', '--seed', config.witnesses.seed, '--max-samples', String(config.witnesses.maxSamples),
    '--out-itf', path.join(directory, 'witnesses', `${main}-{test}-{seq}.itf.json`)];
  else if (stage.kind === 'simulation') args = [cli, 'run', path.join(modelRoot, config.specification), '--main', main,
    '--init', config.init, '--step', config.step, '--invariant', config.invariant, '--backend', 'typescript', '--seed', config.simulation.seed,
    '--max-samples', String(config.simulation.samples), '--max-steps', String(config.simulation.maximumSteps), '--n-traces', String(config.simulation.selectedTraces),
    '--out-itf', path.join(directory, 'simulation', `${main}-{seq}.itf.json`)];
  else {
    cwd = origin.repositoryRoot;
    args = stage.kind === 'implementation-regression' ? ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=30000',
      ...['evidence', 'http', 'replay'].map(name => resolve(`test/name-protocol-${name}.test.mjs`))] :
      [resolve('scripts/lib/name-protocol-command.mjs'), directory, stage.id];
  }
  return { command: origin.nodeExecutable, argv: args, cwd, timeoutMs: stage.timeoutMs, graceMs: 1500,
    environment: { QUINT_HOME: origin.quintHome, JVM_ARGS: '-Xmx2G', NODE_NO_WARNINGS: '1', NODE_TEST_CONTEXT: null,
      TMPDIR: path.join(directory, '.temporary', stage.id) }, endpoint };
}
export const validNameInterval = row => typeof row?.startedAt === 'string' && typeof row?.finishedAt === 'string' &&
  Number.isFinite(Date.parse(row.startedAt)) && Number.isFinite(Date.parse(row.finishedAt)) && Date.parse(row.startedAt) <= Date.parse(row.finishedAt);
const completeExecution = row => row?.timedOut === false && row?.interrupted === false && row?.signal === null && Number.isInteger(row?.code) && !row.error;
export function validateNameCommand(result, stage, config, directory, binding, origin) {
  try {
    assert.deepEqual(result.invocation, nameStageCommand(stage, config, directory, result.invocation?.endpoint, origin));
    assert.deepEqual(result.inputStart, binding); assert.deepEqual(result.inputEnd, binding);
    assert.equal(binding.buildCurrent, true); assert.ok(validNameInterval(result));
    assert.ok(completeExecution(result.execution)); assert.equal(result.execution.cleanupComplete, true);
    const budget = result.execution.budget, started = Date.parse(result.startedAt);
    assert.equal(result.execution.startedAt, result.startedAt);
    assert.ok(budget && Number.isSafeInteger(budget.timeoutMs) && budget.timeoutMs > 1500 && budget.timeoutMs <= stage.timeoutMs);
    assert.equal(budget.deadlineAt, started + budget.timeoutMs); assert.equal(budget.childDeadlineAt, budget.deadlineAt - 1500);
    assert.ok(Date.parse(result.finishedAt) <= budget.deadlineAt + 1500);
    assert.ok(Number.isSafeInteger(result.execution.durationMs) && result.execution.durationMs >= 0 && result.execution.durationMs <= stage.timeoutMs + 1500);
    return true;
  } catch { return false; }
}
// Validate the complete nested TAP body, each named test, local numbering and
// plans. A plausible footer or a test diagnostic containing it is insufficient.
export function strictNameTap(log, roster = nameDriverRoster) {
  try {
    assert.match(log, /^TAP version 13\r?\n/); assert.equal((log.match(/^TAP version 13$/gm) || []).length, 1);
    const footer = parseTapFooter(log); assert.ok(footer && footer.suites === 0 && footer.fail === 0 && footer.cancelled === 0 && footer.skipped === 0 && footer.todo === 0);
    const roots = [], stack = [], found = [], counts = new Map([['', 0]]), plans = new Map();
    for (const line of log.split(/\r?\n/)) {
      let match = line.match(/^( *)# Subtest: (.+)$/);
      if (match) {
        assert.equal(match[1].length % 4, 0); const depth = match[1].length / 4;
        assert.equal(depth, stack.length); const node = { name: match[2], path: [...stack.map(row => row.name), match[2]].join(' > '), children: 0 };
        if (!depth) roots.push(node); else stack.at(-1).children++; stack.push(node); counts.set(node.path, 0); continue;
      }
      match = line.match(/^( *)(not ok|ok) (\d+) - (.+)$/);
      if (match) {
        assert.equal(match[2], 'ok'); assert.ok(!/ # (?:SKIP|TODO)\b/i.test(match[4]));
        const depth = match[1].length / 4; assert.equal(stack.length, depth + 1); const node = stack.pop(); assert.equal(match[4], node.name);
        const parent = stack.map(row => row.name).join(' > '), number = counts.get(parent) + 1;
        assert.equal(Number(match[3]), number); counts.set(parent, number); found.push(node.path);
        if (node.children) assert.equal(plans.get(node.path), node.children); continue;
      }
      match = line.match(/^( *)1\.\.(\d+)$/);
      if (match) {
        const depth = match[1].length / 4; assert.equal(stack.length, depth); const parent = stack.map(row => row.name).join(' > ');
        assert.ok(!plans.has(parent)); plans.set(parent, Number(match[2])); assert.equal(Number(match[2]), counts.get(parent)); continue;
      }
      assert.ok(!/^\s*(?:Bail out!|(?:not )?ok(?:\s|$)|\d+\.\.)/.test(line), 'Unparsed TAP result/plan token');
    }
    assert.equal(stack.length, 0); assert.equal(footer.plan, roots.length); assert.equal(footer.tests, found.length); assert.equal(footer.pass, found.length);
    assert.deepEqual(found.sort(), [...roster].sort()); return { ok: true, tests: found.length };
  } catch { return { ok: false, tests: 0 }; }
}
export function nameStageConclusion(stage, execution, log, config) {
  const base = checkerConclusion(stage.kind, execution, log, stage.bound);
  if (!completeExecution(execution)) return { ok: false, complete: false };
  if (stage.kind === 'implementation-regression') return { complete: strictNameTap(log).ok, ok: execution.code === 0 && strictNameTap(log).ok, metrics: strictNameTap(log) };
  if (stage.kind === 'model-witness') {
    const main = stage.id.slice('witnesses-'.length), names = [...log.matchAll(/^\s*ok\s+([A-Za-z][A-Za-z0-9]*Test)(?:\s|$)/gm)].map(match => match[1]);
    const ok = execution.code === 0 && same(names.sort(), [...nameWitnesses[main]].sort()) &&
      new RegExp(`\\b${nameWitnesses[main].length} passing\\b`).test(log) && !/\b(?:failing|failed)\b/i.test(log);
    return { complete: ok, ok, metrics: { witnesses: names.length } };
  }
  if (['implementation-replay', 'implementation-negative'].includes(stage.kind)) return { complete: execution.code === 0, ok: execution.code === 0 && log.includes('NAME_REPLAY_COMPLETE ') };
  if (stage.kind === 'simulation') return { ...base, ok: base.ok && /An example execution:/.test(log) && /\[State 0\]/.test(log) && /Trace length statistics: max=\d+, min=\d+, average=/.test(log) };
  if (stage.kind === 'finite-state-complete') return { ...base, ok: base.ok && /TLC2 Version/.test(log) && /Running breadth-first search Model-Checking/.test(log) && /Computing initial states/.test(log) && /Semantic processing of module/.test(log) };
  if (stage.kind === 'bounded-model-check') return { ...base, ok: base.ok && /PASS #0: SanyParser/.test(log) && /PASS #1: TypeCheckerSnowcat/.test(log) && Array.from({ length: stage.bound + 1 }, (_, n) => n).every(n => new RegExp(`Step ${n}:`).test(log)) };
  if (stage.kind === 'model-negative') return { ...base, ok: base.ok && /PASS #0: SanyParser/.test(log) && /The outcome is: Error/.test(log) };
  return base;
}
export function nameTracePaths(stage, config) {
  const main = stage.id.replace(/^(witnesses|simulation|negative)-/, '');
  if (stage.kind === 'model-witness') return nameWitnesses[main].map((name, i) => `witnesses/${main}-${name}-${i}.itf.json`).sort();
  if (stage.kind === 'simulation') return Array.from({ length: config.simulation.selectedTraces }, (_, i) => `simulation/${main}-${i}.itf.json`);
  if (stage.kind === 'model-negative') return [`negative/${main}.itf.json`];
  if (stage.kind === 'implementation-negative') return [`witnesses/${nameNegatives.find(row => stage.id.endsWith(row.mutation)).witness}`];
  if (stage.kind === 'implementation-replay') return nameProtocolPlan(config).filter(row => row.kind === (stage.id === 'replay-witnesses' ? 'model-witness' : 'simulation')).flatMap(row => nameTracePaths(row, config));
  return [];
}
export function nameTraceMain(file) {
  const match = file.match(/^(?:witnesses|simulation)\/(independent_witnesses|reuse_witnesses|independent|reuse)-/);
  if (!match) throw new Error('Invalid fixed name trace path'); return match[1];
}
export function nameSafetyViolations(state, step) {
  const actors = [0, 1], exact = actor => state.rawName[actor] === state.receiptRawName[state.operationId[actor]] && state.submittedRevision[actor] === state.receiptInputRevision[state.operationId[actor]];
  const checks = {
    exactReplay: actors.every(a => state.txResult[a] !== 'duplicate' || exact(a)),
    revisionRechecked: actors.every(a => state.txResult[a] !== 'committed' || state.submittedRevision[a] === state.commitBaseRevision[a]),
    anchorsRechecked: actors.every(a => state.txResult[a] !== 'committed' || state.commitBaseAnchorValid[a]),
    associatedAtomic: ['sourceName', 'associatedName', 'evidenceName'].every(field => state[field] === state.name) &&
      ['sourceVersion', 'associatedVersion', 'evidenceVersion'].every(field => state[field] === state.changes) && state.revision === state.changes + Number(state.background === 'revision'),
    receiptAtomic: actors.every(a => (state.receipt[a] === 'succeeded') === (state.commits[a] === 1)),
    atMostOnce: actors.every(a => state.commits[a] >= 0 && state.commits[a] <= 1),
    receiptImmutable: actors.every(a => state.receipt[a] === 'none' || state.receiptRawName[a] === state.rawName[state.receiptOwner[a]] && state.receiptInputRevision[a] === state.submittedRevision[state.receiptOwner[a]]),
    protectedRecords: state.stalePreserved && state.scopePreserved && state.identitiesPreserved,
    honestResponse: actors.every(a => state.reply[a] !== 'ok' || state.receipt[state.operationId[a]] === 'succeeded' && exact(a)),
    readCurrent: step?.action !== 'refresh' || state.loadedRevision[step.actor] === state.revision && state.loadedName[step.actor] === state.name,
    cancelledUnsent: actors.every(a => state.phase[a] !== 'cancelled' || state.requests[a] === 0)
  };
  return Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
}
export function validateNameModelNegative(main, itf, config) {
  try {
    const definition = config.mutants.find(row => row.main === main); assert.ok(definition);
    const trace = normalizeNameTrace(itf, nameConfiguration(main, config)), states = [trace.initial, ...trace.steps.map(step => step.expected)];
    const result = expectedNameMutationViolation(main, itf, trace.config);
    assert.ok(result.ok); assert.ok(trace.steps.length > 0 && trace.steps.length <= definition.maxSteps);
    assert.equal(result.firstViolationState, states.length - 1); assert.equal(trace.steps.at(-1).action, 'transaction');
    for (const [index, state] of states.entries()) assert.deepEqual(nameSafetyViolations(state, trace.steps[index - 1]), index === states.length - 1 ? [definition.expectedViolation] : []);
    return { ...result, violatedProperty: definition.expectedViolation };
  } catch { return { ok: false }; }
}
export function validateNameReplay(value, trace, sourceTrace, sourceBytes, { negative = null, interval = value } = {}) {
  try {
    assert.equal(value.sourceTrace, sourceTrace); assert.equal(value.sourceTraceSha256, digest(sourceBytes));
    assert.equal(value.semanticTraceSha256, digest(JSON.stringify(trace))); assert.equal(value.steps, trace.steps.length);
    assert.deepEqual(value.config, trace.config); assert.ok(validNameInterval(value)); assert.ok(validNameInterval(interval));
    assert.ok(Date.parse(value.startedAt) >= Date.parse(interval.startedAt) && Date.parse(value.finishedAt) <= Date.parse(interval.finishedAt));
    assert.equal(value.complete, true); assert.equal(value.cleanupComplete, true);
    const b = value.budget; assert.ok(b && Number.isSafeInteger(b.deadlineAt));
    assert.equal(b.startupTimeoutMs, 15000); assert.equal(b.stepTimeoutMs, 15000); assert.equal(b.cleanupTimeoutMs, 5000); assert.equal(b.timeoutMs, 60000);
    assert.ok(b.deadlineAt <= Date.parse(value.startedAt) + b.timeoutMs && Date.parse(value.finishedAt) <= b.deadlineAt);
    if (interval.execution?.budget) assert.ok(b.deadlineAt <= interval.execution.budget.childDeadlineAt);
    assert.equal(value.ok, !negative); assert.equal(value.classification, negative ? 'implementation_mismatch' : 'matched');
    assert.ok(!value.error && !value.cleanupError);
    const states = [trace.initial, ...trace.steps.map(step => step.expected)], index = negative ? value.difference?.step : trace.steps.length - 1;
    assert.ok(Number.isSafeInteger(index) && index >= 0 && index < trace.steps.length); assert.equal(value.observations?.length, index + 2);
    for (const [n, observation] of value.observations.entries()) {
      assert.equal(observation.step, n - 1); assert.ok(validateNameProjection(observation.actual, trace.config));
      assert.equal(observation.durable.events.length, n); assert.ok(Array.isArray(observation.durableViolations));
      for (const [j, event] of observation.durable.events.entries()) {
        const step = trace.steps[j]; assert.deepEqual({ action: event.action, actor: event.actor, argument: event.argument }, { action: step.action, actor: step.actor, argument: step.argument });
        assert.ok(event.startedAtMs >= Date.parse(value.startedAt) && event.finishedAtMs <= Date.parse(value.finishedAt));
      }
      const previous = value.observations[n - 1], finalNegative = negative && n === index + 1;
      if (!finalNegative) {
        assert.deepEqual(observation.actual, states[n]); assert.deepEqual(observation.durableViolations, []);
        assert.equal(inspectMatchedNameDurable(observation, trace.config, previous).ok, true);
      } else {
        const checked = inspectNameNegativeDurable(observation, trace.config, previous, negative.mutation);
        assert.equal(checked.ok, true, checked.reason); assert.equal(checked.violatedProperty, negative.property);
        assert.equal(value.difference.durableValid, false); assert.deepEqual(value.difference.actual, observation.actual);
        assert.deepEqual(value.difference.expected, states[n]); assert.deepEqual(value.difference.durableViolations, observation.durableViolations);
        assert.deepEqual(value.counterexample, { ...trace, steps: trace.steps.slice(0, index + 1), minimality: 'first-divergence-prefix' });
        assert.equal(trace.steps[index].action, 'transaction');
      }
    }
    return true;
  } catch { return false; }
}

export function expectedNameMutationDigests(original, mutation, repositoryRoot) {
  let changed = original;
  const replace = (before, after) => { assert.equal(changed.split(before).length, 2); changed = changed.replace(before, after); };
  if (mutation === 'bypass_fingerprint') replace('previous.fingerprint !== fingerprint(input)', 'false /* deliberately broken fingerprint check */');
  else if (mutation === 'bypass_revision') replace("assertKnowledgeRevision(snapshot, input.revision, '条目或原文已改变，请核对最新内容后再提交');", '/* deliberately omitted transaction revision recheck */');
  else if (mutation === 'bypass_anchor') replace("fail(409, '关联原文引用已改变，请刷新后核对');", '{ /* deliberately omitted active support guard */ }');
  else { assert.equal(mutation, 'non_atomic_receipt'); replace('return this.tx(() => {', 'return (() => {'); replace('    });\n  }\n};', '    })();\n  }\n};'); }
  const runnable = changed.replace(/from '(\.\/.+?)'/g, (_all, specifier) => `from '${pathToFileURL(path.join(repositoryRoot, specifier.slice(2))).href}'`);
  return { sourceDigest: digest(original), mutatedDigest: digest(changed), runnableDigest: digest(runnable) };
}

export async function validateNameProtocolEvidence(directory, { release = false } = {}) {
  directory = path.resolve(directory);
  const config = await nameConfig(), target = await nameProtocolMetadata(), plan = nameProtocolPlan(config), reasons = [];
  const rows = plan.map(stage => ({ id: stage.id, kind: stage.kind, status: 'not_run', reasons: [] }));
  const fail = reason => ({ ok: false, reasons: [reason], rows, target, fullProjectAcceptance: false });
  let report;
  try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); } catch { return fail('missing_or_invalid_report'); }
  if (!report || !Array.isArray(report.results) || !Array.isArray(report.artifacts) || [...report.results, ...report.artifacts].some(row => !row || typeof row !== 'object' || Array.isArray(row))) return fail('invalid_report_shape');
  const origin = report.origin, binding = nameInputBinding(target, config, report.tools);
  if (!origin || !['repositoryRoot', 'nodeExecutable', 'quintHome', 'evidenceDirectory'].every(key => typeof origin[key] === 'string' && path.isAbsolute(origin[key]) && path.normalize(origin[key]) === origin[key]) || origin.repositoryRoot !== report.repositoryRoot) return fail('invalid_execution_origin');
  for (const field of ['schemaVersion', 'domain', 'specificationVersion', 'modelVersion', 'source', 'sourceFiles', 'sourceDigest', 'buildFiles', 'buildDigest', 'buildSource', 'runtimeBuild', 'modelDigest', 'lockDigest']) if (!same(report[field], target[field])) reasons.push(`stale_${field}`);
  const tools = report.tools, javaMajor = Number(tools?.java?.match?.(/version\s+"(\d+)/)?.[1]);
  if (tools?.quint !== toolchain.quint.version || tools?.apalache !== toolchain.apalache.version || tools?.tlc !== toolchain.apalache.bundledTlcVersion ||
      tools?.apalacheJarSha256 !== toolchain.apalache.jarSha256 || tools?.apalacheArchiveSha256 !== toolchain.apalache.archiveSha256 ||
      !(javaMajor >= toolchain.java.minimumMajor) || !/^v24\./.test(tools?.node || '') || !tools?.sqlite || tools?.quintHome !== origin.quintHome) reasons.push('invalid_toolchain');
  if (!['platform', 'arch', 'osRelease'].every(key => typeof report.environment?.[key] === 'string' && report.environment[key])) reasons.push('invalid_environment');
  if (!target.buildCurrent || report.buildCurrent !== true) reasons.push('stale_build');
  if (release && (report.source?.dirty !== false || target.source.dirty !== false)) reasons.push('uncommitted_source');
  if (!same(report.config, config) || !same(report.propertyCoverage, nameProtocolCoverage(config))) reasons.push('invalid_domain_or_coverage');
  if (report.complete !== true || report.execution?.complete !== true || !completeExecution(report.execution) || report.execution.code !== 0 || report.overallTimeoutMs !== config.limits.overallMs) reasons.push('incomplete_execution');
  if (!validNameInterval(report) || Date.parse(report.finishedAt) - Date.parse(report.startedAt) > config.limits.overallMs + 1500) reasons.push('invalid_run_interval');
  if (!same(report.inputEnd, binding)) reasons.push('changed_inputs_at_end');
  const artifacts = new Map();
  for (const item of report.artifacts) {
    if (typeof item.path !== 'string' || item.path.includes('\\') || path.isAbsolute(item.path) || path.posix.normalize(item.path) !== item.path || item.path.split('/').includes('..') || artifacts.has(item.path)) { reasons.push('invalid_artifact_path'); continue; }
    try { const filename = path.join(directory, item.path); assert.equal(await realpath(filename), path.join(await realpath(directory), item.path), 'Artifact symlink is forbidden'); const bytes = await readFile(filename); if (digest(bytes) !== item.sha256) reasons.push('changed_artifact'); else artifacts.set(item.path, bytes.toString('utf8')); } catch { reasons.push('missing_artifact'); }
  }
  if (!same(report.results.map(row => row.id), plan.map(row => row.id))) reasons.push('wrong_stage_plan');
  const used = new Set(); let lastFinish = Date.parse(report.startedAt);
  for (const [i, stage] of plan.entries()) {
    const row = rows[i], matches = report.results.filter(value => value.id === stage.id); if (matches.length !== 1) { row.reasons.push('missing_or_duplicate_result'); continue; }
    row.status = 'incomplete'; const result = matches[0];
    if (result.kind !== stage.kind || result.status !== 'passed' || result.complete !== true) row.reasons.push('not_passed');
    if (!validateNameCommand(result, stage, config, origin.evidenceDirectory, binding, origin)) row.reasons.push('wrong_command_or_input_binding');
    if (Date.parse(result.startedAt) < lastFinish || Date.parse(result.finishedAt) > Date.parse(report.finishedAt)) row.reasons.push('wrong_stage_interval'); lastFinish = Date.parse(result.finishedAt);
    if (result.log !== `${stage.id}.log`) row.reasons.push('wrong_log_path'); used.add(result.log);
    const log = artifacts.get(result.log), conclusion = log == null ? null : nameStageConclusion(stage, result.execution, log, config);
    if (!conclusion?.ok || !same(result.metrics, conclusion.metrics || null)) row.reasons.push('raw_check_not_passed');
    const traces = nameTracePaths(stage, config); if (!same(result.traces || [], traces)) row.reasons.push('wrong_trace_roster');
    for (const file of traces) used.add(file);
    if (['model-witness', 'simulation', 'model-negative'].includes(stage.kind)) {
      const main = stage.id.replace(/^(witnesses|simulation|negative)-/, '');
      for (const file of traces) try {
        const itf = JSON.parse(artifacts.get(file)), trace = normalizeNameTrace(itf, nameConfiguration(main, config));
        if (stage.kind === 'model-negative') { const violation = validateNameModelNegative(main, itf, config); if (!violation.ok || !same(result.violation, violation)) throw new Error('Wrong negative'); }
        else if ([trace.initial, ...trace.steps.map(step => step.expected)].some((state, n) => nameSafetyViolations(state, trace.steps[n - 1]).length)) throw new Error('Unsafe normal trace');
        if (stage.kind === 'simulation' && trace.steps.length > config.simulation.maximumSteps) throw new Error('Wrong simulation bound');
      } catch { row.reasons.push('invalid_trace'); }
    }
    if (['implementation-replay', 'implementation-negative'].includes(stage.kind)) {
      used.add(result.data);
      try {
        assert.equal(result.data, `${stage.id}.json`); const values = JSON.parse(artifacts.get(result.data));
        assert.deepEqual(values.map(value => value.sourceTrace), traces); assert.equal(result.samples, values.length);
        assert.equal(result.steps, values.reduce((sum, value) => sum + value.steps, 0));
        assert.equal(log, `NAME_REPLAY_COMPLETE ${JSON.stringify({ id: stage.id, traces, samples: result.samples, steps: result.steps, dataSha256: digest(artifacts.get(result.data)) })}\n`);
        for (const value of values) {
          const raw = artifacts.get(value.sourceTrace), trace = normalizeNameTrace(JSON.parse(raw), nameConfiguration(nameTraceMain(value.sourceTrace), config));
          const negative = stage.kind === 'implementation-negative' ? nameNegatives.find(item => stage.id.endsWith(item.mutation)) : null;
          assert.ok(validateNameReplay(value, trace, value.sourceTrace, raw, { negative, interval: result }));
          for (const observation of value.observations) {
            const mutation = observation.durable.mutation;
            if (negative) {
              assert.equal(mutation?.mutation, negative.mutation); assert.equal(mutation.source, 'knowledge-name-replacement.mjs');
              assert.equal(mutation.sourceDigest, target.sourceFiles.find(item => item.path === mutation.source).sha256);
              const expectedMutation = expectedNameMutationDigests(await readFile('knowledge-name-replacement.mjs', 'utf8'), negative.mutation, origin.repositoryRoot);
              assert.equal(mutation.mutatedDigest, expectedMutation.mutatedDigest); assert.equal(mutation.runnableDigest, expectedMutation.runnableDigest); assert.equal(mutation.executionRepositoryRoot, origin.repositoryRoot);
            } else assert.equal(mutation, null);
          }
        }
      } catch { row.reasons.push('invalid_raw_replay'); }
    }
    if (!row.reasons.length) row.status = 'passed';
  }
  if (!same([...artifacts.keys()].sort(), [...used].sort())) reasons.push('wrong_artifact_inventory');
  const ok = !reasons.length && rows.every(row => row.status === 'passed');
  return { ok, release, reasons, rows, target, propertyRows: nameProtocolCoverage(config).map(property => ({ ...property, status: ok ? 'passed_for_declared_scope' : 'incomplete' })),
    fullProjectAcceptance: false, browserAcceptance: 'requires_separate_actual_browser_evidence' };
}
