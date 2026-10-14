import { runFormalProtocol } from './lib/formal-protocol-runner.mjs';
import { importEvidenceDefinition, importModelRoot, validateImportEvidence } from './lib/import-protocol-evidence.mjs';
import { replayImportTrace } from './lib/import-protocol-replay.mjs';
import { createImportProtocolAdapter } from '../test-support/import-protocol-adapter.mjs';

await runFormalProtocol({ ...importEvidenceDefinition, modelRoot: importModelRoot, label: 'Import protocol', script: 'verify:import-protocol',
  environmentVariable: 'IMPORT_PROTOCOL_EVIDENCE_DIR', defaultDirectory: 'verification-evidence/import-protocol',
  replayTrace: replayImportTrace, createAdapter: createImportProtocolAdapter, validateEvidence: validateImportEvidence,
  regressionCwd: process.cwd(),
  regressionFiles: ['test/import-protocol-http.test.mjs', 'test/import-protocol-replay.test.mjs', 'test/import-protocol-evidence.test.mjs'] });
