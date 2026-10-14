import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { normalizeITFStates } from './protocol-replay.mjs';
import { normalizeKnowledgeTrace } from './knowledge-protocol-replay.mjs';
import { formalPlan, validateFormalEvidence } from './formal-protocol-evidence.mjs';
import { properties } from '../../verification/knowledge-protocol/properties.mjs';

export const knowledgeModelRoot = path.resolve('verification/knowledge-protocol');
export const knowledgeModelFiles = ['protocol.qnt', 'actor-guards.qnt', 'configurations.qnt', 'witnesses.qnt', 'config.json', 'tlc.json', 'toolchain.json', 'properties.mjs'];
export async function knowledgeMetadata() {
  const contents = await Promise.all(knowledgeModelFiles.map(async file => [file, await readFile(path.join(knowledgeModelRoot, file), 'utf8')]));
  return { schemaVersion: 1, source: sourceVersion(), specificationVersion: '1.0', modelVersion: 1,
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release() },
    modelDigest: digest(JSON.stringify(contents)), lockDigest: digest(await readFile('package-lock.json')) };
}
export function knowledgeCoverage(config) {
  const common = formalPlan(config).filter(row => !['model-negative', 'implementation-negative'].includes(row.kind)).map(row => row.id);
  const controls = { 'HW-04-06': ['negative-mutant_send_without_reserve', 'negative-mutant_third_extra', 'negative-replay'],
    'HW-04-07': ['negative-mutant_accepted_loss', 'negative-mutant_wrong_terminal_outcome'], 'HW-04-08': ['negative-mutant_wrong_terminal_outcome'], 'HW-04-09': ['negative-mutant_third_extra'] };
  return properties.map(property => ({ id: property.id, version: property.version, acceptance: property.acceptance, checks: [...common, ...controls[property.id]] }));
}
export function knowledgeMutationViolation(main, itf) {
  const trace = normalizeKnowledgeTrace(itf, { parts: 1 });
  const states = normalizeITFStates(itf, ['extract_calls', 'initial_requests', 'repair_calls', 'repair_reserved', 'extra_requests', 'accepted', 'accepted_ever']);
  const wrongOutcome = state => {
    const hasAccepted = Object.values(state.accepted).some(slots => slots.length);
    const resolved = Object.keys(state.phase).every(part => state.phase[part] === 'done' && state.initial_complete[part] && !state.unresolved[part].length);
    const expected = state.stage !== 'done' ? 'none' : resolved ? hasAccepted ? 'ok' : 'empty' : hasAccepted ? 'partial' : 'invalid';
    return state.outcome !== expected;
  };
  const matches = state => main === 'mutant_send_without_reserve' ? state.extract_calls[0] > state.initial_requests[0] || state.repair_calls[0] > state.repair_reserved[0] :
    main === 'mutant_third_extra' ? state.extra_requests > 2 : main === 'mutant_accepted_loss' ? !isDeepStrictEqual(state.accepted[0], state.accepted_ever[0]) : main === 'mutant_wrong_terminal_outcome' ? wrongOutcome(state) : false;
  const step = states.findIndex(matches);
  return { ok: step >= 0, classification: 'model_violation', firstViolationState: step, traceLength: trace.steps.length };
}
export const knowledgeEvidenceDefinition = {
  loadConfig: async () => JSON.parse(await readFile(path.join(knowledgeModelRoot, 'config.json'), 'utf8')),
  loadToolchain: async () => JSON.parse(await readFile(path.join(knowledgeModelRoot, 'toolchain.json'), 'utf8')),
  metadata: knowledgeMetadata, coverage: knowledgeCoverage, normalizeTrace: normalizeKnowledgeTrace,
  traceConfig: main => ({ parts: main.includes('two_parts') ? 2 : 1 }), expectedMutationViolation: knowledgeMutationViolation,
  expectedImplementationCounterexample: replay => replay.difference?.step === 0 && replay.difference?.actual?.initial_requests?.[0] === 0 &&
    replay.difference?.expected?.initial_requests?.[0] === 1 && replay.counterexample?.steps?.length === 1
};
export const validateKnowledgeEvidence = (directory, options) => validateFormalEvidence(directory, knowledgeEvidenceDefinition, options);
