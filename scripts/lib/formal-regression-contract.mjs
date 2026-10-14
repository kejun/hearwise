import { validateFlatTap, validateTapTree } from './release-tap-evidence.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tapSummary, parseTapFooter } from './tap-summary.mjs';
import processNames from '../../verification/release/process-regressions.json' with { type: 'json' };

export const regressions = { 'import-protocol': { files: ['test/import-protocol-http.test.mjs', 'test/import-protocol-replay.test.mjs', 'test/import-protocol-evidence.test.mjs'], count: 42 }, 'relation-protocol': { files: ['test/relation-protocol-replay.test.mjs'], count: 14 },
  'knowledge-protocol': { files: ['test/knowledge-protocol-replay.test.mjs', 'test/knowledge-model-guards.test.mjs', 'test/model-trace-driver.test.mjs'], count: 25 } };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export async function regressionNames(file) {
  const source = await readFile(file, 'utf8');
  const literal = [...source.matchAll(/^test\('([^']+)'/gm)].map(match => match[1]);
  if (file !== 'test/import-protocol-http.test.mjs') return literal;
  const templates = [...source.matchAll(/test\(`([^`]+)`/g)].map(match => match[1]);
  assert.equal(templates.length, 7);
  return [...['append', 'replace'].flatMap(mode => templates.slice(0, 6).flatMap(name =>
    (name.includes('${origin}') ? ['same', 'other'] : ['']).map(origin => name.replaceAll('${mode}', mode).replaceAll('${origin}', origin)))),
    ...['append', 'replace'].map(mode => templates[6].replaceAll('${mode}', mode)), ...literal];
}
export async function importRegressionTree() {
  const source = await readFile('test/import-protocol-evidence.test.mjs', 'utf8'), children = new Map();
  for (const match of source.matchAll(/^test\('([^']+)'[\s\S]*?(?=^test\('|$(?![\s\S]))/gm)) {
    if (!match[0].includes('await t.test(')) continue;
    const names = [...match[0].matchAll(/\['([^']+)', (?:f =>|'(?:replay-witnesses|replay-simulation|negative-replay)')/g)].map(row => row[1]);
    assert.ok(names.length); children.set(match[1], names);
  }
  const names = (await Promise.all([...regressions['import-protocol'].files].sort().map(regressionNames))).flat();
  return names.map(name => ({ name, children: children.get(name) || [] }));
}
export async function formalRegressionTree(kind) {
  if (kind === 'process-crash') return processNames;
  assert.ok(regressions[kind], 'Unknown formal regression suite');
  if (kind === 'import-protocol') return importRegressionTree();
  const names = (await Promise.all([...regressions[kind].files].sort().map(regressionNames))).flat();
  if (kind === 'relation-protocol') {
    const parent = 'valid empty and fully filtered responses settle without extra calls; insufficient candidates make zero calls';
    assert.equal(names.filter(name => name === parent).length, 1);
    const source = await readFile(regressions[kind].files[0], 'utf8');
    assert.ok(source.includes("for (const response of ['empty', 'filtered']) await t.test(response,"));
    assert.ok(source.includes("await t.test('no candidates',"));
    return names.map(name => ({ name, children: name === parent ? ['empty', 'filtered', 'no candidates'] : [] }));
  }
  if (kind === 'knowledge-protocol') {
    const children = new Map([
      ['empty and unrepairable outputs never request a correction or destroy existing knowledge', ['empty', 'unrepairable']],
      ['failed extract and repair reservations roll back durable occupancy with zero new provider calls', ['extract', 'repair']],
      ['response then SQLite commit failure uses the actual scheduler failure path without replaying the request', ['extract', 'repair']],
      ['the actual scheduler blocks early repair and cross-part cooldown admission at exact persisted deadlines', ['part interval', 'repair rate limit', 'long repair rate limit']]
    ]);
    for (const name of children.keys()) assert.equal(names.filter(value => value === name).length, 1);
    return names.map(name => ({ name, children: children.get(name) || [] }));
  }
  return names;
}
export async function validateFormalRegression(kind, log) {
  const footer = parseTapFooter(log);
  assert.equal(tapSummary(log).ok, true);
  assert.equal(footer.tests, kind === 'process-crash' ? processNames.length : regressions[kind].count);
  return validateTapTree(log, await formalRegressionTree(kind));
}
