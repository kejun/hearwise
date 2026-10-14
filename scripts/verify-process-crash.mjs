import { runFormalProtocol } from './lib/formal-protocol-runner.mjs';
import { processEvidenceDefinition, processModelRoot, validateProcessEvidence } from './lib/process-crash-evidence.mjs';
import { replayProcessTrace } from './lib/process-crash-replay.mjs';
import { createProcessProtocolAdapter } from '../test-support/process-crash-adapter.mjs';

await runFormalProtocol({ ...processEvidenceDefinition, modelRoot: processModelRoot, label: 'Process crash recovery', script: 'verify:process-crash',
  environmentVariable: 'PROCESS_CRASH_EVIDENCE_DIR', defaultDirectory: 'verification-evidence/process-crash',
  replayTrace: replayProcessTrace,
  createAdapter: options => createProcessProtocolAdapter({ ...options, mutation: options.mutation === 'skip_reservation' ? 'reset_on_recovery' : options.mutation }),
  validateEvidence: validateProcessEvidence,
  regressionFiles: ['test/process-crash-replay.test.mjs', 'test/process-crash-lock.test.mjs', 'test/process-crash-trace.test.mjs'] });
