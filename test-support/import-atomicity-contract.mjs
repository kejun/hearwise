import path from 'node:path';
import { tapSummary, parseTapFooter } from '../scripts/lib/tap-summary.mjs';
import { atomicityCases, caseId } from './import-atomicity-scenarios.mjs';
import { dataCases } from './import-atomicity-data.mjs';
export const atomicityRegressionFiles = ['test/import-atomicity-crash.test.mjs', 'test/import-atomicity-data.test.mjs',
  'test/import-atomicity-evidence.test.mjs', 'test/import-atomicity-audit.test.mjs'].sort();
export const atomicityRegressionNames = [
  'atomicity audit rejects erased crash boundary events',
  'atomicity audit rejects contradictory SQL and out-of-run boundary timestamps',
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
  const bodies = [...text.matchAll(/^(ok|not ok) (\d+) - (.+)\r?\n  ---\r?\n([\s\S]*?)^  \.\.\.\r?$/gm)];
  const namesOk = JSON.stringify(headers) === JSON.stringify(atomicityRegressionNames) && bodies.length === atomicityRegressionCount &&
    bodies.every((match, index) => Number(match[2]) === index + 1 && match[3] === atomicityRegressionNames[index] &&
      /^  duration_ms: \d+(?:\.\d+)?\r?$/m.test(match[4]) && /^  type: 'test'\r?$/m.test(match[4]));
  const stream = lines.filter(line => /^\s*(?:(?:not )?ok\b|\d+\.\.|Bail out!)/.test(line));
  const expectedStream = [...bodies.map(match => `${match[1]} ${match[2]} - ${match[3]}`), `1..${atomicityRegressionCount}`];
  const footer = parseTapFooter(text), pass = bodies.filter(match => match[1] === 'ok').length;
  const countsOk = footer?.plan === atomicityRegressionCount && footer.tests === atomicityRegressionCount && footer.pass === pass && footer.fail === bodies.length - pass;
  const bodiesComplete = namesOk && countsOk && JSON.stringify(stream) === JSON.stringify(expectedStream);
  return { ...parsed, bodiesComplete, ok: parsed.ok && bodiesComplete };

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

export function validAtomicityLocations(report, directory, cwd) {
  return report.cwd === cwd && report.evidenceDirectory === path.resolve(directory);
}
