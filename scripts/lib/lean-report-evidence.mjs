import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as revision from '../../verification/revision/profile.mjs';
import * as nameInterval from '../../verification/name-interval/profile.mjs';
import * as revisionCorpus from '../../verification/revision/corpus.mjs';
import * as nameCorpus from '../../verification/name-interval/corpus.mjs';
import { knowledgeRevision } from '../../knowledge-revision.mjs';
import { knowledgeTermMatches, replaceKnowledgeTerm } from '../../knowledge-edit.mjs';
import { revisionSources, nameIntervalSources } from './lean-source-files.mjs';
import { sourceVersion, digest, checkArtifacts } from './verification-evidence.mjs';
import { tapMetrics, parseTapFooter } from './tap-summary.mjs';

const contracts = {
  revision: { ...revision, sources: revisionSources, regression: 'legacy-regression', metrics: 'legacy',
    audit: 'AxiomAudit.lean', namespace: 'Revision', proofs: ['Revision.lean', 'Main.lean', 'AxiomAudit.lean'],
    assumptions: ['Plain data records and dense arrays; nullish values, booleans, UTF-16 strings and safe integers.',
      'Normalization and serialization are proved; SHA-256 collision freedom and frozen v11/v12 behavior are not theorems.'] },
  'name-interval': { ...nameInterval, sources: nameIntervalSources, regression: 'implementation-regression', metrics: 'implementation',
    audit: 'NameIntervalAxiomAudit.lean', namespace: 'NameInterval', proofs: ['NameInterval.lean', 'NameIntervalMain.lean', 'NameIntervalAxiomAudit.lean'],
    assumptions: ['Ordered, positive, nonoverlapping UTF-16 replacement spans; nonempty target and valid old anchors.',
      'Intersecting anchors expand to replacement endpoints; matching/case folding and SQLite are implementation evidence.'] }
};
const json = text => JSON.parse(text);
const ndjson = text => text.trimEnd().split('\n').map(json);
const succeeded = execution => execution?.code === 0 && execution?.signal === null && execution?.timedOut === false &&
  execution?.interrupted === false && execution?.ok === true && !execution?.error;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const sameDigests = (actual, expected) => isObject(actual) && Object.keys(actual).length === Object.keys(expected).length &&
  Object.keys(expected).every(file => actual[file] === expected[file]);
const units = values => Array.isArray(values) && values.every(value => Number.isInteger(value) && value >= 0 && value <= 65535);

function revisionSnapshot(input) {
  const scalar = value => {
    if (value.tag === 'null') return null;
    if (value.tag === 'text' && units(value.units)) return revisionCorpus.fromUnits(value.units);
    if (value.tag === 'boolean' && typeof value.value === 'boolean') return value.value;
    if (value.tag === 'integer' && Number.isSafeInteger(value.value)) return value.value;
    throw new Error('Invalid tagged revision scalar');
  };
  const row = pairs => Object.fromEntries(pairs.map(([key, value]) => [key, scalar(value)]));
  return { item: { ...row(input.item), aliases: input.aliases.map(scalar),
    ...Object.fromEntries(['mentions', 'revisions', 'facts'].map(key => [key, input[key].map(row)])) }, segments: input.segments.map(row) };
}
function validateRevision(differential, inputs, outputs, index) {
  const { cases, pairs } = revisionCorpus.corpus();
  assert.equal(inputs.length, cases.length + 5);
  assert.deepEqual(inputs.slice(0, cases.length), cases.map(({ snapshot }) => revisionCorpus.transport(snapshot)));
  assert.deepEqual(index.slice(0, cases.length), cases.map(({ id, group }) => ({ id, group })));
  assert.deepEqual(index.slice(cases.length), ['initial', 'full', 'new-columns', 'reopened', 'business-change']
    .map(name => ({ id: `sqlite-${name}`, group: 'sqlite' })));
  const observations = inputs.map((input, i) => {
    assert.ok(units(outputs[i]));
    const snapshot = revisionSnapshot(input), actual = revisionCorpus.fromUnits(outputs[i]);
    assert.equal(actual, revisionCorpus.referenceJSON(snapshot));
    const hash = digest(actual);
    assert.equal(knowledgeRevision(snapshot), hash);
    if (index[i].group === 'field') assert.notEqual(hash, differential.observations[0].digest);
    return { ...index[i], utf16Length: actual.length, digest: hash };
  });
  assert.deepEqual(differential.observations, observations);
  assert.equal(differential.pairs, pairs.length);
  for (const [left, right] of pairs) assert.equal(observations[left].digest, observations[right].digest);
}
function validateName(differential, inputs, outputs, index) {
  const { cases } = nameCorpus.corpus();
  assert.deepEqual(inputs, cases.map(nameCorpus.transport));
  assert.deepEqual(index, cases.map(({ id, group, source, sqlite }) => ({ id, group, source, sqlite })));
  const observations = cases.map((item, i) => {
    const result = outputs[i];
    assert.deepEqual(knowledgeTermMatches(item.text, item.source), item.matches);
    const raw = replaceKnowledgeTerm(item.text, item.source, item.target);
    assert.equal(raw, nameCorpus.referenceText(item.text, item.matches, item.target));
    assert.deepEqual(result.old, nameCorpus.units(item.text));
    assert.deepEqual(result.matches, item.matches);
    assert.deepEqual(result.rawText, nameCorpus.units(raw));
    assert.deepEqual(result.text, nameCorpus.units(inputs[i].enabled ? raw : item.text));
    assert.equal(result.anchors.length, item.anchors.length);
    let unchanged = 0, intersecting = 0;
    item.anchors.forEach((anchor, j) => {
      const mapped = result.anchors[j];
      const map = (point, end) => {
        if (!inputs[i].enabled || raw === item.text) return point;
        let shift = 0;
        for (const match of item.matches) {
          if (point <= match.start) break;
          if (point < match.end) return match.start + shift + (end ? item.target.length : 0);
          shift += item.target.length - (match.end - match.start);
        }
        return point + shift;
      };
      assert.equal(mapped.start, map(anchor.start, false)); assert.equal(mapped.end, map(anchor.end, true));
      assert.ok(Number.isSafeInteger(mapped.start) && Number.isSafeInteger(mapped.end) && mapped.start >= 0 &&
        mapped.start < mapped.end && mapped.end <= result.text.length);
      assert.deepEqual(mapped.quote, result.text.slice(mapped.start, mapped.end));
      const touches = item.matches.some(match => anchor.start < match.end && match.start < anchor.end);
      if (!touches) { assert.deepEqual(mapped.quote, nameCorpus.units(item.text.slice(anchor.start, anchor.end))); unchanged++; }
      else intersecting++;
      if (!inputs[i].enabled || raw === item.text) assert.deepEqual(mapped,
        { ...anchor, quote: nameCorpus.units(item.text.slice(anchor.start, anchor.end)) });
    });
    return { id: item.id, group: item.group, oldUnits: item.text.length, newUnits: result.text.length,
      matches: item.matches.length, anchors: item.anchors.length, unchanged, intersecting };
  });
  assert.deepEqual(differential.observations, observations);
  assert.equal(differential.anchors, observations.reduce((sum, row) => sum + row.anchors, 0));
}
function validateSQLite(evidence, differential, outputs, index, directory) {
  assert.equal(evidence.synthetic, true);
  assert.equal(evidence.database, 'sqlite-witness.sqlite');
  assert.equal(evidence.publicEntry, 'ListeningStore.replaceKnowledgeName');
  assert.deepEqual(evidence.invalid, differential.invalid);
  assert.deepEqual(evidence.importedInvalid, differential.importedInvalid);
  assert.deepEqual(evidence.collision, differential.collision);
  assert.equal(evidence.cases.length, differential.sqliteCases);
  assert.equal(evidence.cases.reduce((sum, row) => sum + row.observed.length, 0), differential.sqliteAnchors);
  assert.deepEqual(evidence.cases.map(row => row.id), index.filter(row => row.sqlite).map(row => row.id));
  for (const row of evidence.cases) {
    const output = outputs[index.findIndex(item => item.id === row.id)];
    assert.deepEqual(row.old, output.old); assert.deepEqual(row.text, output.text);
    assert.deepEqual(row.observed, row.anchorIndexes.map(i => output.anchors[i]));
    assert.equal(new Set(row.anchorIndexes).size, row.anchorIndexes.length);
    for (const key of ['reopened', 'staleUnchanged', 'unlinkedUnchanged', 'otherListeningUnchanged']) assert.equal(row[key], true);
    assert.deepEqual(row.before.find(support => support.id === 'stale-history'), row.after.find(support => support.id === 'stale-history'));
    row.anchorIndexes.forEach((anchor, i) => {
      const support = row.after.find(support => support.id === `anchor-${anchor}`);
      assert.deepEqual({ start: support.start, end: support.end, quote: nameCorpus.units(support.quote) }, row.observed[i]);
      assert.equal(support.source_revision, digest(nameCorpus.fromUnits(row.text)));
    });
  }
  // Open the bound persisted witness read-only; cached witnessVerification is not evidence.
  const witness = evidence.cases.find(row => row.id === 'emoji-target');
  const database = new DatabaseSync(path.join(directory, 'sqlite-witness.sqlite'), { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(JSON.parse(JSON.stringify(database.prepare('SELECT * FROM relation_supports WHERE segment_id=? ORDER BY id').all(witness.segmentId))), witness.after);
    assert.deepEqual(nameCorpus.units(database.prepare('SELECT original_text FROM segments WHERE id=?').get(witness.segmentId).original_text), witness.text);
  } finally { database.close(); }
}

// Offline validation never executes a proof tool and never trusts report.ok/summary.
// Historical eligibility belongs to the caller; this API always checks the current checkout.
export async function validateLeanEvidence(kind, directory, { release = true } = {}) {
  const contract = contracts[kind];
  if (!contract) throw new TypeError(`Unknown Lean evidence kind: ${kind}`);
  const target = sourceVersion(), profileDigest = digest(JSON.stringify(contract.profile));
  const summary = { ok: false, status: 'not_run', stale: false, reasons: [], kind, release, target,
    source: null, profileDigest, properties: contract.profile.properties,
    methods: [...new Set(contract.profile.properties.map(property => property.method))],
    scope: { description: `${kind} proof and finite implementation bridge`, assumptions: contract.assumptions,
      seed: contract.profile.seed, generatedBaseSamples: contract.profile.generatedBaseSamples,
      samples: kind === 'revision' ? 662 : 296, depth: null, states: null,
      fullProjectAcceptance: false, fullDomainAcceptance: false },
    reportPath: path.resolve(directory, 'report.json'), report: null, fullProjectAcceptance: false };
  const add = reason => { if (!summary.reasons.includes(reason)) summary.reasons.push(reason); };
  let report;
  try { report = json(await readFile(summary.reportPath, 'utf8')); }
  catch (error) { add(error.code === 'ENOENT' ? 'missing_report' : 'invalid_report'); summary.status = error.code === 'ENOENT' ? 'not_run' : 'incomplete'; return summary; }
  summary.report = report; summary.source = report?.source ?? null; summary.status = 'incomplete';
  if (!isObject(report) || !Array.isArray(report.steps) || report.steps.some(row => !isObject(row)) ||
      !Array.isArray(report.artifacts) || report.artifacts.some(row => !isObject(row))) { add('invalid_report'); return summary; }
  if (typeof report.complete !== 'boolean' || typeof report.interrupted !== 'boolean' || report.error) add('invalid_report');
  const files = new Map();
  for (const file of contract.requiredArtifacts) {
    try { files.set(file, await readFile(path.join(directory, file))); }
    catch { add(`missing_artifact:${file}`); }
  }
  const text = file => { if (!files.has(file)) throw new Error(`Missing ${file}`); return files.get(file).toString('utf8'); };
  const evidenceCheck = async (reason, work) => { try { await work(); } catch { add(reason); } };
  const actualSourceDigests = {};
  for (const file of contract.sources) {
    try { actualSourceDigests[file] = digest(await readFile(file)); }
    catch { add(`missing_source:${file}`); }
  }
  if (!sameDigests(report.sourceDigests, actualSourceDigests) ||
      (kind === 'name-interval' && !sameDigests(report.finalSourceDigests, actualSourceDigests))) add('source_content_changed');
  if (!isObject(report.profile) || digest(JSON.stringify(report.profile)) !== profileDigest) add('profile_changed');
  if (report.tools?.node !== process.version || report.tools?.sqlite !== process.versions.sqlite) add('wrong_toolchain');
  await evidenceCheck('tool_log_mismatch', () => {
    assert.equal(text('lean-version.log').trim(), report.tools?.lean);
    assert.equal(text('lake-version.log').trim(), report.tools?.lake);
  });
  for (const step of report.steps) {
    if (!succeeded(step.execution)) add(`step:${step.name}`);
    if (step.execution && files.has(`${step.name}.log`) && step.execution.tail !== text(`${step.name}.log`).slice(-12000)) add(`step_log_mismatch:${step.name}`);
  }
  let metrics;
  await evidenceCheck('invalid_regression_tap', () => {
    const log = text(`${contract.regression}.log`), footer = parseTapFooter(log);
    metrics = tapMetrics(log);
    assert.ok(log.startsWith('TAP version 13\n') || log.startsWith('TAP version 13\r\n'));
    // A fabricated footer alone is not raw Node test evidence. These existing
    // regression suites are flat; require their actual numbered reporter rows.
    const rows = [...log.matchAll(/^(?:not )?ok (\d+) - .+$/gm)];
    assert.equal(rows.length, footer?.plan);
    assert.ok(rows.every((row, i) => Number(row[1]) === i + 1));
    assert.deepEqual(metrics, report[contract.metrics]);
    assert.equal(metrics.tapComplete, true);
  });
  let differential;
  await evidenceCheck('invalid_differential_evidence', () => {
    differential = json(text('differential.json'));
    assert.deepEqual(differential, report.differential);
    assert.equal(differential.complete, true); assert.equal(differential.ok, true);
    const logged = { ...differential, observations: undefined,
      mutations: differential.mutations.map(({ id, detected }) => ({ id, detected })) };
    if (kind === 'name-interval') logged.invalidOracle = differential.invalidOracle.map(({ id, rejected, execution }) => ({ id, rejected, code: execution.code }));
    assert.deepEqual(json(text('differential.log')), json(JSON.stringify(logged)));
    const inputs = ndjson(text('corpus.ndjson')), outputs = ndjson(text('lean-projections.ndjson')), index = json(text('case-index.json'));
    assert.equal(differential.corpusDigest, digest(files.get('corpus.ndjson')));
    assert.equal(inputs.length, differential.samples); assert.equal(outputs.length, inputs.length); assert.equal(index.length, inputs.length);
    assert.equal(new Set(index.map(row => row.id)).size, index.length);
    assert.deepEqual(differential.groups, Object.fromEntries([...new Set(index.map(row => row.group))].map(group => [group, index.filter(row => row.group === group).length])));
    if (kind === 'revision') validateRevision(differential, inputs, outputs, index);
    else { validateName(differential, inputs, outputs, index); validateSQLite(json(text('sqlite-evidence.json')), differential, outputs, index, directory); }
  });
  await evidenceCheck('invalid_oracle_evidence', () => {
    const execution = json(text('oracle-execution.json'));
    assert.ok(succeeded(execution)); assert.equal(execution.tail, text('oracle.log').slice(-12000));
    if (kind === 'name-interval') {
      const invalid = json(text('invalid-oracle.json'));
      assert.deepEqual(invalid, differential.invalidOracle);
      assert.equal(text('invalid-oracle.log'), invalid.map(row => `${row.id}: ${JSON.stringify(row.execution)}\n`).join(''));
      assert.equal(new Set(invalid.map(row => row.id)).size, 12);
      for (const row of invalid) {
        assert.equal(row.rejected, true); assert.equal(row.execution.code, 1); assert.equal(row.execution.ok, false);
        assert.equal(row.execution.signal, null); assert.equal(row.execution.timedOut, false); assert.equal(row.execution.interrupted, false); assert.ok(!row.execution.error);
      }
    }
  });
  await evidenceCheck('invalid_axiom_evidence', async () => {
    const audit = await readFile(`verification/lean/${contract.audit}`, 'utf8');
    const audits = audit.split('\n').filter(line => line.startsWith('/-- info: ')).map(line => line.slice(10, -3).trim());
    assert.equal(audits.length, contract.profile.properties[0].theorems.length);
    contract.profile.properties[0].theorems.forEach((theorem, i) => assert.ok(audits[i].startsWith(`'Hearwise.${contract.namespace}.${theorem}' `)));
    assert.deepEqual(json(text('axioms.json')), { complete: true, method: 'Lean #guard_msgs over transitive #print axioms', audits });
    for (const file of contract.proofs) {
      const source = await readFile(`verification/lean/${file}`, 'utf8');
      assert.ok(!/\b(sorry|admit|sorryAx|native_decide|axiom)\b/.test(source.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')));
    }
  });
  // Pass independently read data into the existing, unchanged profile gate.
  const checked = { ...report, differential, [contract.metrics]: metrics };
  await evidenceCheck('invalid_report', async () => {
    const result = contract.gate(checked, { target, release, profileDigest, artifactsValid: await checkArtifacts(directory, report) });
    result.reasons.forEach(add);
  });
  summary.stale = summary.reasons.some(reason => ['source_changed', 'source_content_changed', 'profile_changed', 'wrong_toolchain'].includes(reason));
  const interrupted = report.interrupted || report.steps.some(step => step.execution?.timedOut || step.execution?.interrupted || step.execution?.signal);
  const failed = report.steps.some(step => step.status === 'failed' || (Number.isInteger(step.execution?.code) && step.execution.code !== 0)) || metrics?.failed > 0 || differential?.ok === false;
  summary.status = interrupted ? 'incomplete' : failed ? 'failed' : report.complete === true ? 'passed' : 'incomplete';
  const integrityFailure = summary.reasons.some(reason => !['source_changed', 'source_content_changed', 'profile_changed', 'wrong_toolchain', 'uncommitted_source'].includes(reason));
  if (integrityFailure && summary.status === 'passed') summary.status = 'incomplete';
  summary.ok = summary.status === 'passed' && summary.reasons.length === 0;
  return summary;
}
