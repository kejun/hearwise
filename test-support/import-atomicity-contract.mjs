import path from 'node:path';
import { tapSummary } from '../scripts/lib/tap-summary.mjs';
import { atomicityCases, caseId } from './import-atomicity-scenarios.mjs';
import { dataCases } from './import-atomicity-data.mjs';
export const atomicityRegressionFiles = ['test/import-atomicity-crash.test.mjs', 'test/import-atomicity-data.test.mjs',
  'test/import-atomicity-evidence.test.mjs', 'test/import-atomicity-audit.test.mjs'].sort();
export const atomicityRegressionNames = [
  'atomicity audit rejects erased crash boundary events',
  'atomicity audit rejects a marker that contradicts real SQL',
  'atomicity audit rejects footer-only passing TAP',
  ...atomicityCases.map(value => `real SQLite import atomicity: ${caseId(value)}`),
  ...dataCases.map(value => `import full business projection: ${value}`),
  'atomicity source hashes reject dirty-to-dirty changes and release dirtiness',
  'atomicity evidence rejects absent cases despite cached passed flags',
  'atomicity browser cannot be supplied by Node or an empty cached pass',
  'atomicity execution rejects timeouts signals interruption and missing finish',
  'atomicity commands bind the actual regression files cwd and budgets',
  'atomicity TAP binds every expected test name number and body'];
export const atomicityRegressionCount = atomicityRegressionNames.length;
export function atomicityRegressionTap(text) {
  const parsed = tapSummary(text);
  const lines = text.split(/\r?\n/);
  const headers = lines.filter(line => line.startsWith('# Subtest: ')).map(line => line.slice('# Subtest: '.length));
  const bodies = [...text.matchAll(/^ok (\d+) - (.+)\r?\n  ---\r?\n  duration_ms: (\d+(?:\.\d+)?)\r?\n  type: 'test'\r?\n  \.\.\.\r?$/gm)];
  const namesOk = JSON.stringify(headers) === JSON.stringify(atomicityRegressionNames) && bodies.length === atomicityRegressionCount &&
    bodies.every((match, index) => Number(match[1]) === index + 1 && match[2] === atomicityRegressionNames[index] && Number.isFinite(Number(match[3])));
  const noExtraResults = lines.filter(line => /^(?:not )?ok \d+/.test(line)).length === atomicityRegressionCount;
  return { ...parsed, bodiesComplete: namesOk && noExtraResults, ok: parsed.ok && parsed.testCount === atomicityRegressionCount && namesOk && noExtraResults };
}
export function atomicityChecks(directory, nodeOnly) {
  directory = path.resolve(directory);
  return [
    { name: 'node', command: ['test-support/import-atomicity-worker.mjs', `${directory}/observations.json`], timeout: 55000 },
    { name: 'regressions', command: ['--test', '--test-reporter=tap', '--test-timeout=20000', ...atomicityRegressionFiles], timeout: 55000 },
    ...(!nodeOnly ? [{ name: 'browser', command: ['test-support/import-atomicity-browser.mjs', directory], timeout: 55000 }] : [])
  ];
}
export function validAtomicityCommand(check, expected, cwd) {
  return check && Array.isArray(check.command) && /(?:^|[\\/])node(?:\.exe)?$/.test(check.command[0]) &&
    JSON.stringify(check.command.slice(1)) === JSON.stringify(expected.command) && check.cwd === cwd &&
    check.configuredTimeoutMs === expected.timeout && check.log === `${expected.name}.log` &&
    Number.isSafeInteger(check.effectiveTimeoutMs) && check.effectiveTimeoutMs > 0 && check.effectiveTimeoutMs <= expected.timeout;
}
