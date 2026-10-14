import { tapSummary } from '../scripts/lib/tap-summary.mjs';
import { atomicityCases, caseId } from './import-atomicity-scenarios.mjs';
import { dataCases } from './import-atomicity-data.mjs';
export const atomicityRegressionFiles = ['test/import-atomicity-crash.test.mjs', 'test/import-atomicity-data.test.mjs',
  'test/import-atomicity-evidence.test.mjs', 'test/import-atomicity-audit.test.mjs'];
export const atomicityRegressionNames = [...atomicityCases.map(value => `real SQLite import atomicity: ${caseId(value)}`),
  ...dataCases.map(value => `import full business projection: ${value}`),
  'atomicity source hashes reject dirty-to-dirty changes and release dirtiness',
  'atomicity evidence rejects absent cases despite cached passed flags',
  'atomicity browser cannot be supplied by Node or an empty cached pass',
  'atomicity execution rejects timeouts signals interruption and missing finish',
  'atomicity audit rejects erased crash boundary events',
  'atomicity audit rejects a marker that contradicts real SQL',
  'atomicity audit rejects footer-only passing TAP'];
export const atomicityRegressionCount = atomicityRegressionNames.length;
// Kept at the pre-audit behavior in the red regression commit.
export function atomicityRegressionTap(text) {
  const parsed = tapSummary(text);
  return { ...parsed, ok: parsed.ok && parsed.testCount === atomicityRegressionCount };
}
