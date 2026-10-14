import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, '../..');
const cli = path.join(repository, 'node_modules/@informalsystems/quint/dist/src/cli.js');
const config = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
function quint(args) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hearwise-generation-model-test-'));
  try {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: directory, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, QUINT_HOME: process.env.QUINT_HOME || '/tmp/hearwise-quint' }
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, `Quint was interrupted: ${result.signal}`);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const file of config.modelSpecifications) {
  test(`generation model typechecks: ${file}`, { timeout: 25000 }, () => {
    quint(['typecheck', path.join(root, file)]);
  });
}
for (const suite of [config.witnesses, config.guards, config.directedMutants]) {
  for (const [main, expected] of Object.entries(suite.counts)) {
    test(`generation model regression: ${main}`, { timeout: 25000 }, () => {
      const output = quint(['test', path.join(root, suite.specification), '--main', main,
        '--backend', 'typescript', '--seed', '42', '--max-samples', '1']);
      assert.match(output, new RegExp(`\\b${expected} passing\\b`));
      assert.doesNotMatch(output, /\b[1-9]\d* failing\b/);
    });
  }
}

test('finite quotient erases only action labels, never guards or semantic state', () => {
  const model = readFileSync(path.join(root, 'protocol.qnt'), 'utf8');
  const references = model.split('\n').filter(line => /\bTRACE\b/.test(line));
  assert.ok(references.length > 1);
  for (const line of references) {
    assert.match(line, /^  const TRACE: bool$|^    (?:lastAction|actor|response)' = if \(TRACE\) .+ else .+,$/);
  }
  const invariantSection = model.slice(model.indexOf('  val finiteDomain ='));
  assert.doesNotMatch(invariantSection, /\b(?:TRACE|lastAction|actor|response)\b/);
  const configurations = readFileSync(path.join(root, 'configurations.qnt'), 'utf8');
  for (const domain of config.domains.filter(row => row.kind === 'generation-envelope')) {
    const finiteConfigurations = readFileSync(path.join(root, domain.finiteSpecification), 'utf8');
    const get = (main, source = configurations) => source.match(new RegExp(String.raw`module ${main} \{([\s\S]*?)\n\}`))?.[1];
    assert.ok(get(domain.main));
    assert.equal(get(domain.main).replace('TRACE = true', 'TRACE = false'), get(domain.finiteMain, finiteConfigurations));
  }
});

test('full product budgets are imported unchanged and are not advertised as the concurrency Cartesian product', () => {
  for (const protocol of ['relation', 'knowledge']) {
    const wrapper = readFileSync(path.join(root, `${protocol}-budget.qnt`), 'utf8');
    assert.match(wrapper, new RegExp(`from "\\.\\./${protocol}-protocol/protocol"`));
    assert.doesNotMatch(wrapper, /MAX_REQUESTS|MAX_EXTRA|MAX_REPAIR|MAX_PROTOCOL/);
  }
  assert.match(config.budgetScope, /not the Cartesian product/);
  assert.equal(config.domains.filter(row => row.kind === 'generation-envelope').length, 6);
  assert.equal(config.witnesses.expectedTestCount, Object.values(config.witnesses.counts).reduce((a, b) => a + b, 0));
});
