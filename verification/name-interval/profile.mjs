export const profile = Object.freeze({
  version: 1, specification: 'hearwise-enhanced-verification-v1.0', issue: 'KEJ-70',
  lean: '4.35.0', leanCommit: 'eb6cafb7290e8bd5f2937522d8d804f58f02bafc',
  seed: 1262832240, generatedBaseSamples: 256,
  properties: [
    { id: 'HW-07-02', method: 'lean-proof', requirement: 'Ordered positive disjoint matches preserve valid UTF-16 anchors and unchanged text; interior anchors expand explicitly',
      implementation: 'knowledge-name-replacement.mjs:replaceKnowledgeName / knowledge-edit.mjs:replaceKnowledgeTerm',
      theorems: ['mapPoint_zero', 'mapped_bound', 'mapped_end_positive', 'mapped_strict_interval',
        'mapped_anchor_valid', 'mapPoint_append', 'slice_inside', 'unchanged_quote', 'intersecting_quote',
        'ordered_matches', 'bounded_matches', 'effective_valid', 'effective_noop', 'effective_before'] },
    { id: 'HW-07-03', method: 'lean-js-sqlite-differential', requirement: 'Public replacement text and persisted support coordinates agree with Lean on fixed/seeded cases' },
    { id: 'HW-07-04', method: 'implementation-regression', requirement: 'Whole-term case/boundary behavior is separately checked against an independent finite-alphabet matcher' },
    { id: 'HW-07-05', method: 'implementation-regression', requirement: 'Imported malformed active intervals and source-revision/quote mismatches roll back; stale evidence never revives' },
    { id: 'HW-07-06', method: 'mutation-detection', requirement: 'A real production-copy code-point/UTF-16 length confusion is detected' }
  ]
});
export const requiredSteps = Object.freeze(['lean-version', 'lake-version', 'proof-build', 'axiom-audit', 'differential', 'implementation-regression']);
export const requiredArtifacts = Object.freeze(['lean-version.log', 'lake-version.log', 'proof-build.log', 'axiom-audit.log',
  'differential.log', 'implementation-regression.log', 'corpus.ndjson', 'case-index.json', 'lean-projections.ndjson',
  'oracle.log', 'oracle-execution.json', 'differential.json', 'axioms.json', 'sqlite-evidence.json',
  'sqlite-witness.sqlite', 'invalid-oracle.json', 'invalid-oracle.log']);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Dedicated proof/differential report, not an implementation-scenario pilot row.
// Do not promote this profile to full HW-07 or full-project acceptance.
export function sameSourceDigests(before, after) {
  const names = Object.keys(before || {});
  return names.length > 0 && names.length === Object.keys(after || {}).length &&
    names.every(name => /^[a-f0-9]{64}$/.test(before[name]) && before[name] === after?.[name]);
}

export function gate(report, { target, release = false, artifactsValid = false, profileDigest }) {
  const reasons = [];
  if (!sameSourceDigests(report.sourceDigests, report.finalSourceDigests)) reasons.push('source_content_changed');
  if (!sha(report.source?.sha) || report.source?.sha !== target?.sha || report.source?.dirty !== target?.dirty) reasons.push('source_changed');
  if (release && (report.source?.dirty !== false || target?.dirty !== false)) reasons.push('uncommitted_source');
  if (report.schemaVersion !== 1 || report.profileVersion !== profile.version || report.profileDigest !== profileDigest) reasons.push('profile_changed');
  if (!validTime(report.startedAt) || !validTime(report.finishedAt) || Date.parse(report.finishedAt) < Date.parse(report.startedAt)) reasons.push('invalid_time');
  if (!report.complete || report.interrupted) reasons.push('incomplete');
  if (!report.tools?.lean?.includes(`version ${profile.lean},`) || !report.tools.lean.includes(profile.leanCommit) ||
      !report.tools?.lake?.includes(`Lean version ${profile.lean}`) || !report.tools?.node || !report.tools?.sqlite) reasons.push('wrong_toolchain');
  if (!report.environment?.platform || !report.environment?.arch || !report.environment?.release) reasons.push('missing_environment');
  for (const name of requiredSteps) {
    const rows = report.steps?.filter(step => step.name === name) || [];
    const step = rows[0];
    if (rows.length !== 1 || step.status !== 'passed' || step.execution?.code !== 0 || step.execution?.signal != null ||
        step.execution?.timedOut !== false || step.execution?.interrupted !== false || step.execution?.ok !== true) reasons.push(`step:${name}`);
  }
  if (!(report.implementation?.tapComplete === true && report.implementation?.tests >= 9 && report.implementation?.passed === report.implementation?.tests &&
      ['failed', 'cancelled', 'skipped', 'todo'].every(key => report.implementation?.[key] === 0))) reasons.push('missing_implementation_tests');
  const d = report.differential;
  if (!d?.complete || !d.ok || d.seed !== profile.seed || d.generatedBaseSamples !== profile.generatedBaseSamples ||
      d.samples !== 296 || d.anchors !== 10333 || d.sqliteCases !== 81 || d.sqliteAnchors !== 3675 ||
      d.sqliteReopened !== true || d.staleSupportsUnchanged !== true || d.unlinkedSegmentsUnchanged !== true ||
      d.otherListeningsUnchanged !== true || d.invalid?.length !== 13 ||
      d.mutations?.length !== 1 || d.mutations.some(mutation => !mutation.detected)) reasons.push('missing_differential');
  if (!d?.collision?.publicCommitAccepted || d.collision.code !== 'ERR_SQLITE_ERROR' || d.collision.constraint !== 'UNIQUE' ||
      !d.collision.unchanged || !d.collision.receiptAbsent) reasons.push('missing_collision_regression');
  if (d?.importedInvalid?.length !== 12 || d.importedInvalid.some(row => !row.imported || row.status !== 409 ||
      !row.unchanged || !row.reopened || !row.receiptAbsent)) reasons.push('missing_import_regressions');
  if (!Array.isArray(d?.invalidOracle) || d.invalidOracle.length !== 12 || d.invalidOracle.some(row =>
      !row.rejected || row.execution?.code !== 1 || row.execution?.timedOut !== false ||
      row.execution?.interrupted !== false || row.execution?.signal != null)) reasons.push('missing_invalid_input_checks');
  if (!artifactsValid || requiredArtifacts.some(name => report.artifacts?.filter(a => a.path === name).length !== 1)) reasons.push('missing_or_changed_artifact');
  return { ok: reasons.length === 0, reasons, release, fullProjectAcceptance: false, fullHW07Acceptance: false };
}
