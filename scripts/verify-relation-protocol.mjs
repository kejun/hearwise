import { runFormalProtocol } from './lib/formal-protocol-runner.mjs';
import { relationEvidenceDefinition, modelRoot, validateProtocolEvidence } from './lib/relation-protocol-evidence.mjs';
import { replayProtocolTrace } from './lib/protocol-replay.mjs';
import { createRelationProtocolAdapter } from '../test-support/relation-protocol-adapter.mjs';

await runFormalProtocol({ ...relationEvidenceDefinition, modelRoot, label: 'Relation protocol', script: 'verify:relation-protocol',
  environmentVariable: 'RELATION_PROTOCOL_EVIDENCE_DIR', defaultDirectory: 'verification-evidence/relation-protocol',
  replayTrace: replayProtocolTrace, createAdapter: createRelationProtocolAdapter, validateEvidence: validateProtocolEvidence,
  regressionFiles: ['test/relation-protocol-replay.test.mjs'] });
