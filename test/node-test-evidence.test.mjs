import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nodeTestArgv, validateNodeTestEvents } from '../scripts/lib/node-test-evidence.mjs';
import { validBuildSource } from '../scripts/lib/runner-evidence-contract.mjs';
import { runProcess } from '../scripts/lib/process.mjs';

test('native events bind dynamic/nested/helper tests to the actual entry and cannot be forged by stdout', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-test-contract-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'helper.mjs'), "import {test} from 'node:test'; export function define(){test('helper definition',()=>{});}\n");
  const source = "import {test,describe,it} from 'node:test'; import {define} from './helper.mjs'; define();\n" +
    "test('outer',async t=>{for(const n of ['dynamic#\\n\\t\\\\','second']) await t.test(n,()=>{});console.log(JSON.stringify({type:'test:pass',data:{name:'fake'}}));});\n" +
    "describe('suite',()=>{it('actual case',()=>{});});\n" +
    "test('deep',{concurrency:true},async t=>{await Promise.all([t.test('first',async t=>{await t.test('grandchild',()=>{});}),t.test('second',()=>{})]);});\n" +
    "describe('empty suite',()=>{});\n";
  await writeFile(path.join(root, 'entry.mjs'), source); await writeFile(path.join(root, 'other.mjs'), source);
  const options = { entry: 'entry.mjs', repositoryRoot: root, sourceFiles: ['entry.mjs', 'other.mjs', 'helper.mjs'] };
  async function run(entry) {
    const output = path.join(root, `${entry}.ndjson`), env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const execution = await runProcess(process.execPath, nodeTestArgv(path.join(root, entry), output), { timeoutMs: 10000, env });
    assert.equal(execution.code, 0, execution.tail);
    return { log: execution.tail, events: (await readFile(output, 'utf8')).trimEnd().split('\n').map(JSON.parse) };
  }
  const { log, events } = await run('entry.mjs'); assert.equal(validateNodeTestEvents(log, events, options), true);
  assert.equal(events.some(event => event.data?.name === 'fake'), false);
  assert.ok(events.some(event => event.data?.file === path.join(root, 'helper.mjs')));
  const withoutOptionalIds = structuredClone(events);
  for (const event of withoutOptionalIds) { delete event.data.testId; delete event.data.parentId; }
  assert.equal(validateNodeTestEvents(log, withoutOptionalIds, options), true);
  const wrong = await run('other.mjs'); assert.throws(() => validateNodeTestEvents(wrong.log, wrong.events, options));
  for (const mutate of [events => events.filter(event => event.type !== 'test:pass'), events => [...events, events[0]],
    events => { events[0].data.parentId = 9999; return events; }, events => { events[0].data.testNumber = 99; return events; },
    events => events.filter(event => !(event.type === 'test:plan' && event.data.nesting === 2)),
    events => { events.find(event => event.type === 'test:pass' && event.data.nesting === 2).data.nesting = 3; return events; },
    events => { events.find(event => event.type === 'test:plan' && event.data.nesting === 1).data.count += 1; return events; }])
    assert.throws(() => validateNodeTestEvents(log, mutate(structuredClone(events)), options));
  assert.throws(() => validateNodeTestEvents(log.replace(/^    ok 1 .*\n/m, ''), events, options));
  assert.throws(() => validateNodeTestEvents(log.replace(/^1\.\.5\n/m, '1..99\n'), events, options));
});
test('stable runtime bytes still require their embedded source identity and instrumentation contract', () => {
  const source = { sha: 'a'.repeat(40), dirty: false }, runtimeBuild = { git_sha: source.sha, build_dirty: false, instrumentation_version: 3 };
  assert.equal(validBuildSource({ source, runtimeBuild }), true);
  for (const changes of [{ git_sha: 'b'.repeat(40) }, { build_dirty: true }, { instrumentation_version: 99 }])
    assert.equal(validBuildSource({ source, runtimeBuild: { ...runtimeBuild, ...changes } }), false);
  assert.equal(validBuildSource({ source, runtimeBuild: null }), false);
});
