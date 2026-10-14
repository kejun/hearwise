import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { normalizeITFStates } from './protocol-replay.mjs';
import { normalizeImportTrace } from './import-protocol-replay.mjs';
import { formalPlan, validateFormalEvidence } from './formal-protocol-evidence.mjs';
import { properties } from '../../verification/import-protocol/properties.mjs';

export const importModelRoot = path.resolve('verification/import-protocol');
export const importModelFiles = ['protocol.qnt', 'configurations.qnt', 'witnesses.qnt', 'config.json', 'tlc.json', 'toolchain.json', 'properties.mjs'];
export const importSources = ['package.json', 'scripts/verify-import-protocol-report.mjs', ...importModelFiles.map(file => `verification/import-protocol/${file}`),
  'server.mjs', 'data-transfer.mjs', 'storage.mjs', 'knowledge-name-replacement.mjs', 'knowledge-revision.mjs', 'relation-storage.mjs',
  'scripts/verify-import-protocol.mjs', 'scripts/lib/import-protocol-evidence.mjs', 'scripts/lib/import-protocol-replay.mjs',
  'scripts/lib/formal-protocol-runner.mjs', 'scripts/lib/formal-protocol-evidence.mjs', 'scripts/lib/protocol-replay.mjs',
  'scripts/lib/relation-protocol-tools.mjs', 'scripts/lib/process.mjs', 'scripts/lib/tap-summary.mjs', 'scripts/lib/verification-evidence.mjs',
  'test-support/import-protocol-adapter.mjs', 'test-support/import-protocol-control.mjs', 'test-support/import-protocol-fixture.mjs',
  'test-support/server-fixture.mjs', 'test-support/lifecycle.mjs', 'test-support/name-replacement-fixture.mjs',
  'test/import-protocol-http.test.mjs', 'test/import-protocol-replay.test.mjs', 'test/import-protocol-evidence.test.mjs'];
export async function importMetadata() {
  const sourceDigests = Object.fromEntries(await Promise.all(importSources.map(async file => [file, digest(await readFile(file))])));
  return { schemaVersion: 1, source: sourceVersion(), specificationVersion: '1.0', modelVersion: 1,
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release() },
    // Covers declared implementation/driver inputs as well as the formal model.
    modelDigest: digest(JSON.stringify(sourceDigests)), sourceDigests, lockDigest: digest(await readFile('package-lock.json')) };
}
export function importCoverage(config) {
  const common = formalPlan(config).filter(row => !['model-negative', 'implementation-negative'].includes(row.kind)).map(row => row.id);
  const checks = {
    'HW-09-02': [...common, 'negative-mutant_skip_expiry', 'negative-mutant_retain_token'],
    'HW-09-03': [...common, 'negative-mutant_skip_version', 'negative-replay'],
    'HW-09-04': ['implementation-regressions']
  };
  return properties.filter(property => checks[property.id]).map(property => ({ id: property.id, version: property.version,
    acceptance: property.acceptance, checks: checks[property.id] }));
}
export function importMutationViolation(main, itf) {
  const states = normalizeITFStates(itf, ['versionAccepted', 'expiryAccepted', 'consumptionCount']);
  const matches = state => main === 'mutant_skip_version' ? state.versionAccepted === false :
    main === 'mutant_skip_expiry' ? state.expiryAccepted === false :
      main === 'mutant_retain_token' ? Object.values(state.consumptionCount).some(count => count === 2) : false;
  const step = states.findIndex(matches);
  return { ok: step >= 0, classification: 'model_violation', firstViolationState: step, traceLength: states.length - 1 };
}
export const importEvidenceDefinition = {
  loadConfig: async () => JSON.parse(await readFile(path.join(importModelRoot, 'config.json'), 'utf8')),
  loadToolchain: async () => JSON.parse(await readFile(path.join(importModelRoot, 'toolchain.json'), 'utf8')),
  metadata: importMetadata, coverage: importCoverage, normalizeTrace: normalizeImportTrace,
  traceConfig: main => ({ tokens: main.includes('two_tokens') ? 2 : 1 }), expectedMutationViolation: importMutationViolation,
  // Two-token complete TLC measured108s; fixed240s cap leaves bounded CI variance.
  // Fast covers both TLC/BMC domains, 40 real-server traces and regressions.
  overallTimeoutMs: { fast: 720000, deep: 1200000 }, tlcTimeoutMs: { single: 60000, two_tokens: 240000 },
  implementationMutation: 'skip_http_revision', implementationNegativeWitness: 'staleOtherConnectionTest',
  expectedImplementationCounterexample: replay => replay.difference?.step === 2 &&
    replay.difference?.expected?.lastHTTPStatus === 409 && replay.difference?.expected?.lastHTTPCode === 'IMPORT_PREVIEW_STALE' &&
    replay.difference?.actual?.lastHTTPStatus === 200 && replay.difference?.actual?.lastHTTPCode === '' &&
    JSON.stringify(replay.difference?.expected?.businessIds) === '[0]' && JSON.stringify(replay.difference?.actual?.businessIds) === '[0,1]' &&
    replay.counterexample?.steps?.length === 3
};
export const validateImportEvidence = (directory, options) => validateFormalEvidence(directory, importEvidenceDefinition, options);
