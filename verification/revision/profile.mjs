export const profile = Object.freeze({
  version: 1, specification: 'hearwise-enhanced-verification-v1.0', issue: 'KEJ-68',
  lean: '4.35.0', leanCommit: 'eb6cafb7290e8bd5f2937522d8d804f58f02bafc',
  seed: 1262832232, generatedBaseSamples: 256,
  properties: [
    { id: 'HW-06-02', method: 'lean-proof', requirement: 'Current projection preserves equivalent permutations, irrelevant fields, missing/null, and multiplicity',
      implementation: 'knowledge-revision.mjs:knowledgeRevision',
      theorems: ['pick_irrelevant', 'missing_equals_null', 'canonical_permutation', 'canonical_preserves_multiplicity',
        'normalization_equivalent', 'normalization_permutation', 'row_irrelevant', 'rows_irrelevant', 'normalization_irrelevant', 'row_missing_null'] },
    { id: 'HW-06-03', method: 'lean-js-differential', requirement: 'UTF-16 serialized projection agrees with independent JS and public digest over boundary, seeded and real SQLite snapshots' },
    { id: 'HW-06-04', method: 'implementation-regression', requirement: 'Frozen v11/v12 timestamp/query order and v11 override restriction remain separate' },
    { id: 'HW-06-05', method: 'mutation-detection', requirement: 'Omitted field, reversed sorting and nullish regression are detected' }
  ]
});
export const requiredSteps = Object.freeze(['lean-version', 'lake-version', 'proof-build', 'axiom-audit', 'differential', 'legacy-regression']);
export const requiredArtifacts = Object.freeze(['lean-version.log', 'lake-version.log', 'proof-build.log', 'axiom-audit.log',
  'differential.log', 'legacy-regression.log', 'corpus.ndjson', 'case-index.json', 'lean-projections.ndjson',
  'oracle.log', 'oracle-execution.json', 'differential.json', 'axioms.json']);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Dedicated proof/differential report, not an implementation-scenario pilot row.
// Do not promote this profile to full HW-06 or full-project acceptance.
export function gate(report, { target, release = false, artifactsValid = false, profileDigest }) {
  const reasons = [];
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
  if (!(report.legacy?.tapComplete === true && report.legacy?.tests >= 8 && report.legacy?.passed === report.legacy?.tests &&
      ['failed', 'cancelled', 'skipped', 'todo'].every(key => report.legacy?.[key] === 0))) reasons.push('missing_legacy_tests');
  const d = report.differential;
  if (!d?.complete || !d.ok || d.seed !== profile.seed || d.generatedBaseSamples !== profile.generatedBaseSamples ||
      d.samples !== 662 || d.pairs !== 298 || d.groups?.sqlite !== 5 || d.groups?.field !== 40 ||
      d.mutations?.length !== 3 || d.mutations.some(mutation => !mutation.detected)) reasons.push('missing_differential');
  if (!artifactsValid || requiredArtifacts.some(name => report.artifacts?.filter(a => a.path === name).length !== 1)) reasons.push('missing_or_changed_artifact');
  return { ok: reasons.length === 0, reasons, release, fullProjectAcceptance: false, fullHW06Acceptance: false };
}
