import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { normalizeProtocolTrace } from './protocol-replay.mjs';
import { formalPlan, checkerConclusion, validateFormalEvidence } from './formal-protocol-evidence.mjs';
import { properties } from '../../verification/relation-protocol/properties.mjs';

export const modelFiles = ['protocol.qnt', 'configurations.qnt', 'witnesses.qnt', 'config.json', 'tlc.json', 'toolchain.json', 'properties.mjs'];
export const modelRoot = path.resolve('verification/relation-protocol');
export async function protocolMetadata() {
  const contents = await Promise.all(modelFiles.map(async file => [file, await readFile(path.join(modelRoot, file), 'utf8')]));
  return { schemaVersion: 1, source: sourceVersion(), specificationVersion: '1.0', modelVersion: 1,
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release() },
    modelDigest: digest(JSON.stringify(contents)), lockDigest: digest(await readFile('package-lock.json')) };
}
export { checkerConclusion };
export const protocolPlan = formalPlan;

export function protocolCoverage(config) {
  const plan = protocolPlan(config), common = plan.filter(row => !['model-negative', 'implementation-negative'].includes(row.kind)).map(row => row.id);
  const controls = { 'HW-04-02': ['negative-mutant_send_without_reserve', 'negative-replay'], 'HW-04-03': ['negative-mutant_fourth_request'],
    'HW-04-04': ['negative-mutant_retry_commit_failure'], 'HW-04-05': [] };
  return properties.map(property => ({ id: property.id, version: property.version, acceptance: property.acceptance, checks: [...common, ...controls[property.id]] }));
}
export function expectedMutationViolation(main, itf) {
  const trace = normalizeProtocolTrace(itf, { actors: 1, capacity: 1 });
  const states = [trace.initial, ...trace.steps.map(step => step.expected)];
  const matches = state => main === 'mutant_send_without_reserve' ? state.calls[0] > state.counts[0] :
    main === 'mutant_retry_commit_failure' ? ['ok', 'empty', 'filtered'].includes(state.replies[0]) && state.phase[0] === 'retry_wait' :
    main === 'mutant_fourth_request' ? state.counts[0] >= 3 && state.phase[0] === 'retry_wait' : false;
  const step = states.findIndex(matches);
  return { ok: step >= 0, classification: 'model_violation', firstViolationState: step, traceLength: trace.steps.length };
}

export const relationEvidenceDefinition = {
  loadConfig: async () => JSON.parse(await readFile(path.join(modelRoot, 'config.json'), 'utf8')),
  loadToolchain: async () => JSON.parse(await readFile(path.join(modelRoot, 'toolchain.json'), 'utf8')),
  metadata: protocolMetadata, coverage: protocolCoverage, normalizeTrace: normalizeProtocolTrace,
  traceConfig: main => ({ actors: main.includes('multi_') ? 3 : 1, capacity: main.includes('cap2') ? 2 : 1 }),
  expectedMutationViolation,
  expectedImplementationCounterexample: replay => replay.difference?.step === 0 && replay.difference?.actual?.counts?.[0] === 0 &&
    replay.difference?.expected?.counts?.[0] === 1 && replay.counterexample?.steps?.length === 1
};
export const validateProtocolEvidence = (directory, options) => validateFormalEvidence(directory, relationEvidenceDefinition, options);
