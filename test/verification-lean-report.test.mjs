import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as nameProfile from '../verification/name-interval/profile.mjs';
import * as nameCorpus from '../verification/name-interval/corpus.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { profile, requiredSteps, requiredArtifacts } from '../verification/revision/profile.mjs';
import { corpus, baseline, transport, referenceJSON, units } from '../verification/revision/corpus.mjs';
import { revisionSources, nameIntervalSources } from '../scripts/lib/lean-source-files.mjs';
import { validateLeanEvidence } from '../scripts/lib/lean-report-evidence.mjs';
import { digest, sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { runProcess } from '../scripts/lib/process.mjs';
import { tapMetrics } from '../scripts/lib/tap-summary.mjs';

// Deliberately synthetic report fixtures exercise the offline validator only.
// They are never release evidence and do not pretend to execute a Lean proof.
async function fixture(directory) {
  const success = { code: 0, signal: null, timedOut: false, interrupted: false, ok: true, durationMs: 1, tail: '' };
  const { cases, pairs } = corpus();
  for (const name of ['initial', 'full', 'new-columns', 'reopened', 'business-change']) cases.push({ id: `sqlite-${name}`, group: 'sqlite', snapshot: baseline() });
  const inputs = cases.map(({ snapshot }) => JSON.stringify(transport(snapshot))).join('\n') + '\n';
  const projections = cases.map(({ snapshot }) => JSON.stringify(units(referenceJSON(snapshot)))).join('\n') + '\n';
  const differential = { complete: true, ok: true, seed: profile.seed, generatedBaseSamples: 256, samples: cases.length, pairs: pairs.length,
    groups: Object.fromEntries([...new Set(cases.map(row => row.group))].map(group => [group, cases.filter(row => row.group === group).length])),
    corpusDigest: digest(inputs), observations: cases.map(({ id, group, snapshot }) => ({ id, group, utf16Length: referenceJSON(snapshot).length, digest: digest(referenceJSON(snapshot)) })),
    mutations: [{ detected: true }, { detected: true }, { detected: true }] };
  const audit = await readFile('verification/lean/AxiomAudit.lean', 'utf8');
  const auditEvidence = { complete: true, method: 'Lean #guard_msgs over transitive #print axioms',
    audits: audit.split('\n').filter(line => line.startsWith('/-- info: ')).map(line => line.slice(10, -3).trim()) };
  const files = new Map(requiredArtifacts.map(file => [file, '']));
  files.set('corpus.ndjson', inputs); files.set('lean-projections.ndjson', projections);
  files.set('case-index.json', JSON.stringify(cases.map(({ id, group }) => ({ id, group }))));
  files.set('differential.json', JSON.stringify(differential)); files.set('differential.log', JSON.stringify({ ...differential, observations: undefined, mutations: differential.mutations.map(({ id, detected }) => ({ id, detected })) })); files.set('axioms.json', JSON.stringify(auditEvidence));
  files.set('oracle-execution.json', JSON.stringify(success));
  const tools = { lean: `Lean (version ${profile.lean}, commit ${profile.leanCommit})`, lake: `Lake (Lean version ${profile.lean})`, node: process.version, sqlite: process.versions.sqlite };
  files.set('lean-version.log', tools.lean + '\n'); files.set('lake-version.log', tools.lake + '\n');
  const body = "import test from 'node:test';\n" + Array.from({ length: 8 }, (_, i) => `test('synthetic validator fixture ${i}', () => {});`).join('\n');
  const testFile = path.join(directory, 'fixture.test.mjs'), logFile = path.join(directory, 'legacy-regression.log');
  await writeFile(testFile, body);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const execution = await runProcess(process.execPath, ['--test', '--test-reporter=tap', testFile], { env, logFile, timeoutMs: 5000 });
  assert.equal(execution.ok, true);
  files.set('legacy-regression.log', await readFile(logFile, 'utf8'));
  const sourceDigests = Object.fromEntries(await Promise.all(revisionSources.map(async file => [file, digest(await readFile(file))])));
  const report = { schemaVersion: 1, profileVersion: 1, profileDigest: digest(JSON.stringify(profile)), profile, source: sourceVersion(), sourceDigests,
    startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z', complete: true, interrupted: false, ok: true,
    tools, environment: { platform: process.platform, arch: process.arch, release: 'synthetic-validator-fixture' },
    legacy: tapMetrics(files.get('legacy-regression.log')), differential,
    steps: requiredSteps.map(name => ({ name, status: 'passed', execution: { ...success, tail: files.get(`${name}.log`).slice(-12000) } })), artifacts: [] };
  return { report, files };
}
async function save(directory, { report, files }) {
  for (const [file, content] of files) await writeFile(path.join(directory, file), content);
  report.artifacts = [...files].map(([file, content]) => ({ path: file, sha256: digest(content) }));
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report));
}

// Roster extraction must preserve exactly the runners' pre-existing source scope.
test('shared Lean source rosters preserve both original runner contracts', async () => {
  assert.equal(revisionSources.length, 14); assert.equal(nameIntervalSources.length, 26);
  assert.equal(digest(JSON.stringify(revisionSources)), 'bfff1f5aab42647f700fa31b5d94b3f2852ecacc303f58016e4e56792a784fc4');
  assert.equal(digest(JSON.stringify(nameIntervalSources)), 'd09faf80bbdda4ed100973d84d9c219d357e8c51a27bc719adc015f4d4dc6b91');
  assert.equal(new Set(revisionSources).size, revisionSources.length); assert.equal(new Set(nameIntervalSources).size, nameIntervalSources.length);
  assert.ok(Object.isFrozen(revisionSources)); assert.ok(Object.isFrozen(nameIntervalSources));
  for (const [kind, roster] of [['revision', revisionSources], ['name-interval', nameIntervalSources]]) {
    const runner = await readFile(`scripts/verify-${kind}.mjs`, 'utf8');
    assert.match(runner, /Sources as sources.*lean-source-files\.mjs/);
    assert.doesNotMatch(runner, /const sources = \[/);
    for (const file of roster) assert.ok((await readFile(file)).length > 0);
  }
});

test('offline Lean evidence independently revalidates corruption and execution outcomes', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lean-report-validator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await fixture(directory);
  const validate = () => validateLeanEvidence('revision', directory, { release: false });
  await save(directory, structuredClone(original));
  let result = await validate();
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.equal(result.status, 'passed'); assert.equal(result.stale, false); assert.equal(result.fullProjectAcceptance, false);
  assert.deepEqual(result.methods, [...new Set(profile.properties.map(row => row.method))]);
  const cases = [
    ['missing-report', async () => rm(path.join(directory, 'report.json')), 'not_run', 'missing_report'],
    ['missing-artifact', async () => rm(path.join(directory, 'proof-build.log')), 'incomplete', 'missing_artifact:proof-build.log'],
    ['bad-artifact-hash', async () => writeFile(path.join(directory, 'proof-build.log'), 'changed'), 'incomplete', 'missing_or_changed_artifact'],
    ['sha', fixture => { fixture.report.source.sha = '0'.repeat(40); }, 'passed', 'source_changed'],
    ['profile', fixture => { fixture.report.profileDigest = '0'.repeat(64); }, 'passed', 'profile_changed'],
    ['profile-object', fixture => { fixture.report.profile = null; }, 'passed', 'profile_changed'],
    ['source-content', fixture => { fixture.report.sourceDigests[revisionSources[0]] = '0'.repeat(64); }, 'passed', 'source_content_changed'],
    ['tool', fixture => { fixture.report.tools.node = 'v0.0.0'; }, 'passed', 'wrong_toolchain'],
    ['timeout', fixture => { fixture.report.steps[2].execution.timedOut = true; }, 'incomplete', 'step:proof-build'],
    ['failed', fixture => { fixture.report.steps[2].execution.code = 1; fixture.report.steps[2].status = 'failed'; }, 'failed', 'step:proof-build'],
    ['missing-exit-field', fixture => { delete fixture.report.steps[0].execution.signal; }, 'incomplete', 'step:lean-version'],
    ['missing-completion-field', fixture => { delete fixture.report.interrupted; }, 'incomplete', 'invalid_report'],
    ['raw-differential-log', fixture => { fixture.files.set('differential.log', '{}'); }, 'incomplete', 'invalid_differential_evidence'],
    ['missing-step', fixture => { fixture.report.steps.pop(); }, 'incomplete', 'step:legacy-regression'],
    ['skip-raw-tap', fixture => { fixture.files.set('legacy-regression.log', fixture.files.get('legacy-regression.log').replace('# pass 8', '# pass 7').replace('# skipped 0', '# skipped 1')); }, 'incomplete', 'invalid_regression_tap'],
    ['forged-footer', fixture => { const log = fixture.files.get('legacy-regression.log'); fixture.files.set('legacy-regression.log', 'TAP version 13\n' + log.slice(log.indexOf('1..8\n'))); }, 'incomplete', 'invalid_regression_tap'],
    ['forged-console-footer', fixture => { fixture.files.set('legacy-regression.log', '# pass 99\n' + fixture.files.get('legacy-regression.log')); }, 'incomplete', 'invalid_regression_tap'],
    ['differential-cache', fixture => { fixture.report.differential.observations[0].digest = '0'.repeat(64); }, 'incomplete', 'invalid_differential_evidence'],
    ['raw-projection', fixture => { const rows = fixture.files.get('lean-projections.ndjson').trimEnd().split('\n'); rows[0] = '[65]'; fixture.files.set('lean-projections.ndjson', rows.join('\n') + '\n'); }, 'incomplete', 'invalid_differential_evidence'],
    ['oracle-timeout', fixture => { fixture.files.set('oracle-execution.json', JSON.stringify({ ...JSON.parse(fixture.files.get('oracle-execution.json')), timedOut: true })); }, 'incomplete', 'invalid_oracle_evidence'],
    ['axiom-cache', fixture => { const value = JSON.parse(fixture.files.get('axioms.json')); value.audits[0] = 'unchecked'; fixture.files.set('axioms.json', JSON.stringify(value)); }, 'incomplete', 'invalid_axiom_evidence'],
    ['incomplete', fixture => { fixture.report.complete = false; }, 'incomplete', 'incomplete']
  ];
  for (const [name, mutate, status, reason] of cases) await t.test(name, async () => {
    const changed = structuredClone(original);
    if (['missing-report', 'missing-artifact', 'bad-artifact-hash'].includes(name)) {
      await save(directory, changed); await mutate(changed);
    } else { await mutate(changed); await save(directory, changed); }
    result = await validate();
    assert.equal(result.ok, false, name); assert.equal(result.status, status, JSON.stringify(result.reasons));
    assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
    if (['sha', 'profile', 'profile-object', 'source-content', 'tool'].includes(name)) assert.equal(result.stale, true);
  });
  const cached = structuredClone(original); cached.report.ok = false; cached.report.summary = { ok: false, reasons: ['cached'] };
  await save(directory, cached); assert.equal((await validate()).ok, true, 'cached report.ok is not the validator');
  cached.report.source.dirty = true; await save(directory, cached);
  assert.ok((await validateLeanEvidence('revision', directory)).reasons.includes('uncommitted_source'));
  for (const malformed of [null, {}, { steps: {}, artifacts: [] }, { steps: [null], artifacts: [] }]) {
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(malformed));
    assert.equal((await validate()).status, 'incomplete');
  }
  await rm(path.join(directory, 'report.json'));
  assert.equal((await validateLeanEvidence('name-interval', directory)).status, 'not_run');
  await assert.rejects(validateLeanEvidence('unknown', directory), /Unknown Lean evidence kind/);
});

async function nameFixture(directory) {
  const base = await fixture(directory), { cases } = nameCorpus.corpus();
  const { report } = base, success = { code: 0, signal: null, timedOut: false, interrupted: false, ok: true, tail: '' };
  const inputs = cases.map(nameCorpus.transport);
  const outputs = cases.map((item, i) => {
    const raw = nameCorpus.referenceText(item.text, item.matches, item.target), text = inputs[i].enabled ? raw : item.text;
    const map = (point, end) => {
      let shift = 0;
      if (!inputs[i].enabled || text === item.text) return point;
      for (const match of item.matches) {
        if (point <= match.start) break;
        if (point < match.end) return match.start + shift + (end ? item.target.length : 0);
        shift += item.target.length - (match.end - match.start);
      }
      return point + shift;
    };
    return { old: nameCorpus.units(item.text), text: nameCorpus.units(text), rawText: nameCorpus.units(raw), matches: item.matches,
      anchors: item.anchors.map(anchor => {
        const start = map(anchor.start, false), end = map(anchor.end, true);
        return { start, end, quote: nameCorpus.units(text.slice(start, end)) };
      }) };
  });
  const invalid = Array.from({ length: 13 }, (_, id) => ({ id }));
  const importedInvalid = Array.from({ length: 12 }, (_, id) => ({ id, imported: true, status: 409, unchanged: true, reopened: true, receiptAbsent: true }));
  const collision = { publicCommitAccepted: true, code: 'ERR_SQLITE_ERROR', constraint: 'UNIQUE', unchanged: true, receiptAbsent: true };
  const sqliteCases = cases.flatMap((item, i) => {
    if (!item.sqlite) return [];
    const output = outputs[i];
    const anchorIndexes = item.anchors.flatMap((anchor, j) => item.text.slice(anchor.start, anchor.end).trim() &&
      item.text.slice(anchor.start, anchor.end).isWellFormed() && nameCorpus.fromUnits(output.anchors[j].quote).isWellFormed() ? [j] : []);
    const stale = { id: 'stale-history', segment_id: item.id, source_revision: 'stale', start: -1, end: 9999, quote: 'stale' };
    const after = [...anchorIndexes.map(j => ({ id: `anchor-${j}`, segment_id: item.id, source_revision: digest(nameCorpus.fromUnits(output.text)),
      start: output.anchors[j].start, end: output.anchors[j].end, quote: nameCorpus.fromUnits(output.anchors[j].quote) })), stale].sort((a, b) => a.id < b.id ? -1 : 1);
    return [{ id: item.id, segmentId: item.id, old: output.old, text: output.text, anchorIndexes,
      observed: anchorIndexes.map(j => output.anchors[j]), before: [stale], after,
      reopened: true, staleUnchanged: true, unlinkedUnchanged: true, otherListeningUnchanged: true }];
  });
  const invalidOracle = Array.from({ length: 12 }, (_, i) => ({ id: `synthetic-${i}`, rejected: true, execution: { ...success, code: 1, ok: false } }));
  const corpusText = inputs.map(row => JSON.stringify(row)).join('\n') + '\n';
  const differential = { complete: true, ok: true, seed: nameProfile.profile.seed, generatedBaseSamples: 256, samples: cases.length,
    groups: Object.fromEntries([...new Set(cases.map(row => row.group))].map(group => [group, cases.filter(row => row.group === group).length])),
    anchors: cases.reduce((sum, row) => sum + row.anchors.length, 0), sqliteCases: sqliteCases.length,
    sqliteAnchors: sqliteCases.reduce((sum, row) => sum + row.observed.length, 0), sqliteReopened: true, staleSupportsUnchanged: true,
    unlinkedSegmentsUnchanged: true, otherListeningsUnchanged: true, corpusDigest: digest(corpusText), invalid, importedInvalid, collision, invalidOracle,
    mutations: [{ detected: true }], observations: cases.map((item, i) => {
      const intersecting = item.anchors.filter(anchor => item.matches.some(match => anchor.start < match.end && match.start < anchor.end)).length;
      return { id: item.id, group: item.group, oldUnits: item.text.length, newUnits: outputs[i].text.length,
        matches: item.matches.length, anchors: item.anchors.length, unchanged: item.anchors.length - intersecting, intersecting };
    }) };
  const sqlite = { synthetic: true, publicEntry: 'ListeningStore.replaceKnowledgeName', database: 'sqlite-witness.sqlite', cases: sqliteCases, invalid, importedInvalid, collision };
  const witness = sqliteCases.find(row => row.id === 'emoji-target');
  const database = new DatabaseSync(path.join(directory, 'sqlite-witness.sqlite'));
  try {
    database.exec('CREATE TABLE relation_supports (id TEXT, segment_id TEXT, source_revision TEXT, start INTEGER, end INTEGER, quote TEXT); CREATE TABLE segments (id TEXT, original_text TEXT);');
    for (const row of witness.after) database.prepare('INSERT INTO relation_supports VALUES (?,?,?,?,?,?)').run(row.id, row.segment_id, row.source_revision, row.start, row.end, row.quote);
    database.prepare('INSERT INTO segments VALUES (?,?)').run(witness.segmentId, nameCorpus.fromUnits(witness.text));
  } finally { database.close(); }
  const files = new Map(nameProfile.requiredArtifacts.map(file => [file, '']));
  files.set('sqlite-witness.sqlite', await readFile(path.join(directory, 'sqlite-witness.sqlite')));
  files.set('sqlite-evidence.json', JSON.stringify(sqlite)); files.set('differential.json', JSON.stringify(differential));
  files.set('differential.log', JSON.stringify({ ...differential, observations: undefined, mutations: differential.mutations.map(({ id, detected }) => ({ id, detected })), invalidOracle: invalidOracle.map(({ id, rejected, execution }) => ({ id, rejected, code: execution.code })) }));
  files.set('corpus.ndjson', corpusText); files.set('lean-projections.ndjson', outputs.map(row => JSON.stringify(row)).join('\n') + '\n');
  files.set('case-index.json', JSON.stringify(cases.map(({ id, group, source, sqlite }) => ({ id, group, source, sqlite }))));
  files.set('invalid-oracle.json', JSON.stringify(invalidOracle)); files.set('invalid-oracle.log', invalidOracle.map(row => `${row.id}: ${JSON.stringify(row.execution)}\n`).join(''));
  files.set('oracle-execution.json', JSON.stringify(success));
  const audit = await readFile('verification/lean/NameIntervalAxiomAudit.lean', 'utf8');
  files.set('axioms.json', JSON.stringify({ complete: true, method: 'Lean #guard_msgs over transitive #print axioms',
    audits: audit.split('\n').filter(line => line.startsWith('/-- info: ')).map(line => line.slice(10, -3).trim()) }));
  for (const name of ['lean-version.log', 'lake-version.log']) files.set(name, base.files.get(name));
  const logFile = path.join(directory, 'implementation-regression.log'), testFile = path.join(directory, 'fixture.test.mjs');
  await writeFile(testFile, "import test from 'node:test';\n" + Array.from({ length: 9 }, (_, i) => `test('synthetic name fixture ${i}', () => {});`).join('\n'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  assert.equal((await runProcess(process.execPath, ['--test', '--test-reporter=tap', testFile], { env, logFile, timeoutMs: 5000 })).ok, true);
  files.set('implementation-regression.log', await readFile(logFile, 'utf8'));
  report.profile = nameProfile.profile; report.profileDigest = digest(JSON.stringify(report.profile)); report.differential = differential;
  report.implementation = tapMetrics(files.get('implementation-regression.log')); delete report.legacy;
  report.sourceDigests = Object.fromEntries(await Promise.all(nameIntervalSources.map(async file => [file, digest(await readFile(file))])));
  report.finalSourceDigests = { ...report.sourceDigests };
  report.steps = nameProfile.requiredSteps.map(name => ({ name, status: 'passed', execution: { ...success, tail: files.get(`${name}.log`).slice(-12000) } }));
  return { report, files };
}

test('name interval validation binds raw anchors, SQLite witness, invalid oracle and final sources', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'name-report-validator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await nameFixture(directory);
  const validate = () => validateLeanEvidence('name-interval', directory, { release: false });
  await save(directory, structuredClone(original));
  const valid = await validate(); assert.equal(valid.ok, true, JSON.stringify(valid.reasons));
  for (const [name, mutate, reason] of [
    ['final-sources', fixture => { fixture.report.finalSourceDigests[nameIntervalSources[0]] = '0'.repeat(64); }, 'source_content_changed'],
    ['persisted-witness', fixture => { fixture.files.set('sqlite-witness.sqlite', 'not a database'); }, 'invalid_differential_evidence'],
    ['sqlite-cache', fixture => { const value = JSON.parse(fixture.files.get('sqlite-evidence.json')); value.cases[0].observed[0].start++; fixture.files.set('sqlite-evidence.json', JSON.stringify(value)); }, 'invalid_differential_evidence'],
    ['invalid-oracle-cache', fixture => { const value = JSON.parse(fixture.files.get('invalid-oracle.json')); value[0].execution.code = 0; fixture.files.set('invalid-oracle.json', JSON.stringify(value)); }, 'invalid_oracle_evidence'],
    ['raw-anchor', fixture => { const rows = fixture.files.get('lean-projections.ndjson').trimEnd().split('\n'); const value = JSON.parse(rows[0]); value.anchors[0].start++; rows[0] = JSON.stringify(value); fixture.files.set('lean-projections.ndjson', rows.join('\n') + '\n'); }, 'invalid_differential_evidence']
  ]) await t.test(name, async () => {
    const changed = structuredClone(original); mutate(changed); await save(directory, changed);
    const result = await validate(); assert.equal(result.ok, false); assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
  });
});
