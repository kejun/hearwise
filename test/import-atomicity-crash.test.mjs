import test from 'node:test';
import { atomicityCases, atomicityScenario, caseId } from '../test-support/import-atomicity-scenarios.mjs';
for (const config of atomicityCases) test(`real SQLite import atomicity: ${caseId(config)}`, { timeout: 20000 }, async () => {
  await atomicityScenario(config);
});
