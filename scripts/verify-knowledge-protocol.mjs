import { runFormalProtocol } from './lib/formal-protocol-runner.mjs';
import { knowledgeEvidenceDefinition, knowledgeModelRoot, validateKnowledgeEvidence } from './lib/knowledge-protocol-evidence.mjs';
import { replayKnowledgeTrace } from './lib/knowledge-protocol-replay.mjs';
import { createKnowledgeProtocolAdapter } from '../test-support/knowledge-protocol-adapter.mjs';

await runFormalProtocol({ ...knowledgeEvidenceDefinition, modelRoot: knowledgeModelRoot, label: 'Knowledge protocol', script: 'verify:knowledge-protocol',
  environmentVariable: 'KNOWLEDGE_PROTOCOL_EVIDENCE_DIR', defaultDirectory: 'verification-evidence/knowledge-protocol',
  replayTrace: replayKnowledgeTrace, createAdapter: createKnowledgeProtocolAdapter, validateEvidence: validateKnowledgeEvidence,
  regressionFiles: ['test/knowledge-protocol-replay.test.mjs', 'test/knowledge-model-guards.test.mjs', 'test/model-trace-driver.test.mjs'] });
