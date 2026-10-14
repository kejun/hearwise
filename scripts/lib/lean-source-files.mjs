// Exact source rosters shared by the existing runners and offline report validation.
export const revisionSources = Object.freeze(['knowledge-revision.mjs', 'verification/lean/Revision.lean', 'verification/lean/Main.lean',
  'verification/lean/AxiomAudit.lean', 'verification/lean/lean-toolchain', 'verification/lean/lakefile.toml',
  'verification/lean/lake-manifest.json', 'verification/revision/corpus.mjs', 'verification/revision/differential.mjs',
  'verification/revision/profile.mjs', 'test-support/knowledge-revision-fixture.mjs', 'test/knowledge-revision.test.mjs', 'scripts/lib/tap-summary.mjs', 'package-lock.json']);

export const nameIntervalSources = Object.freeze(['knowledge-edit.mjs', 'knowledge-name-replacement.mjs', 'relation-storage.mjs', 'storage.mjs', 'data-transfer.mjs',
  'verification/lean/Revision.lean', 'verification/lean/NameInterval.lean', 'verification/lean/NameIntervalMain.lean',
  'verification/lean/NameIntervalAxiomAudit.lean', 'verification/lean/lean-toolchain', 'verification/lean/lakefile.toml',
  'verification/lean/lake-manifest.json', 'verification/name-interval/corpus.mjs',
  'verification/name-interval/differential.mjs', 'verification/name-interval/profile.mjs',
  'test-support/name-replacement-fixture.mjs', 'test/knowledge-name-replacement.test.mjs',
  'test-support/name-replacement-import-fixture.mjs', 'test/knowledge-name-replacement-import.test.mjs',
  'scripts/lib/process.mjs', 'scripts/lib/tap-summary.mjs', 'scripts/lib/verification-evidence.mjs', 'scripts/verify-name-interval.mjs', 'package.json', 'package-lock.json', '.github/workflows/ci.yml']);
