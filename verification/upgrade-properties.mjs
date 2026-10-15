export const upgradeProperties = [
  ['HW-14-02', 'Historical schema preservation', 'Actual v1–12 data retain exact business rows, declared defaults and recovery transforms, constraints/indexes/triggers; query, manual edit and reopen remain usable.'],
  ['HW-14-03', 'Interrupted migration and usable backup', 'Real first-stage SQLite transactions survive SIGKILL boundaries and roll back constraint/READONLY failures; the actual failed-upgrade backup is restored through HTTP and edited.'],
  ['HW-14-04', 'Isolated install and reinstall', 'Locked dependencies install in an isolated source checkout; npm build/start, version alignment, no-key diagnosis and external-database retention after reinstall pass on the recorded runtime.']
].map(([id, title, requirement]) => ({ id, group: 'HW-14', version: 1, title, requirement,
  consequence: 'Installation or migration failure can make historical user data inaccessible.',
  preconditions: 'Synthetic actual historical databases; documented pre-upgrade manual backup; Node 24+; supported local SQLite filesystem.',
  state: 'Historical business rows, schema/version, transaction stage, backup, application build and runtime.',
  domain: 'Frozen v1–12 histories; completed/manual/unfinished work; first pending migration transaction; clean/reinstalled dependency tree.',
  assumptions: 'Process SIGKILL is not power failure; Linux x64 execution does not prove other OS, CPU, runtime or audio devices.',
  owners: ['Module maintainer: migrations', 'Verification maintainer: upgrade evidence', 'Release owner: platform matrix'],
  methods: ['real-sqlite-migration', 'real-process-sigkill', 'http-backup-restore', 'isolated-install'],
  implementation: ['storage.mjs', 'relation-storage.mjs', 'knowledge-edit.mjs', 'knowledge-name.mjs', 'server.mjs', 'data-transfer.mjs'],
  assets: ['scripts/verify-upgrade.mjs', 'test/upgrade-historical.test.mjs', 'test/upgrade-recovery.test.mjs', 'test/upgrade-evidence.test.mjs'],
  issues: ['KEJ-83'], invalidatedBy: ['migration, recovery, packaging, runtime, dependency or evidence contract changes'],
  acceptance: [requirement], gaps: ['macOS/Windows/ARM, alternate Node runtime, audio devices, disk-full and power-loss require separate actual evidence.'], evidenceStatus: 'not_run'
}));
