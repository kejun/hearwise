import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameBrowserContractFixture } from '../test-support/name-browser-contract-fixture.mjs';
import { validNameBrowser } from '../test-support/name-protocol-browser-evidence.mjs';
test('name browser evidence rechecks genuine full-table commits inside an explicitly synthetic UI envelope', { timeout: 25000 }, async () => {
  const { browser, source, mutation } = await nameBrowserContractFixture();
  assert.equal(validNameBrowser(browser, source, mutation), true);
  const cases = [
    value => { value.widths[0].results[0].checkpoints.at(-1).tables.knowledge_edit_jobs = []; },
    value => { value.widths[0].results[0].checkpoints.at(-1).tables.knowledge_items[0].content_version++; },
    value => { value.widths[0].results[0].checkpoints.at(-1).tables.relation_supports.find(row => row.state === 'stale').quote = 'changed'; },
    value => { value.widths[0].results[0].requests.find(row => row.method === 'POST').body.revision = '0'.repeat(64); },
    value => { value.widths[0].results[0].explicitSaves++; },
    value => { value.widths[0].results[0].sources[0].sha256 = '0'.repeat(64); },
    value => { value.widths[0].results[1].responses.find(row => row.url.includes('/edits/')).status = 404; },
    value => { value.widths[0].results[2].checkpoints[1].editor.saveDisabled = false; },
    value => { value.widths[0].results[4].checkpoints[1].tables = value.widths[0].results[4].checkpoints.at(-1).tables; },
    value => { value.widths[0].results[5].checkpoints[1].tables = value.widths[0].results[5].checkpoints.at(-1).tables; },
    value => { value.widths[1].results[0].checkpoints.at(-1).editor.fits = false; },
    value => { value.negative.requests = value.negative.requests.slice(0, 1); },
    value => { value.negative.mutation.mutantSha256 = mutation.originalSha256; }
  ];
  for (const mutate of cases) { const changed = structuredClone(browser); mutate(changed); assert.equal(validNameBrowser(changed, source, mutation), false, mutate.toString()); }
});

test('name profile packages two generic artifacts and verifies every actual referenced asset and full TAP body', { timeout: 30000 }, async t => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os'), path = await import('node:path');
  const { runProcess } = await import('../scripts/lib/process.mjs');
  const { metadata, digest, writeJson, validateResult } = await import('../scripts/lib/verification-evidence.mjs');
  const { nameBrowserAssets, checkNameEvidence } = await import('../test-support/name-protocol-browser-evidence.mjs');
  const { browser, source, mutation } = await nameBrowserContractFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'name-browser-contract-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const argv = ['--test', '--test-reporter=tap', '--test-timeout=20000', 'test/name-protocol-http.test.mjs'];
  const execution = await runProcess(process.execPath, argv, { env, timeoutMs: 30000, logFile: path.join(directory, 'http.log') }); assert.equal(execution.ok, true);
  Object.assign(execution, { configuredTimeoutMs: 30000, timeoutMs: 30000, cwd: process.cwd(), command: [process.execPath, ...argv] });
  const marker = 'SYNTHETIC BROWSER CONTRACT ONLY\n'; await writeFile(path.join(directory, 'browser.log'), marker);
  const checks = [{ name: 'http', execution }, { name: 'browser', execution: { code: 0, ok: true, signal: null, timedOut: false, interrupted: false, tail: marker,
    configuredTimeoutMs: 110000, timeoutMs: 110000, cwd: process.cwd(), command: [process.execPath, 'test-support/name-protocol-browser.mjs', directory] } }];
  await writeJson(path.join(directory, 'browser.json'), browser);
  for (const name of nameBrowserAssets.filter(name => name.endsWith('.png'))) await writeFile(path.join(directory, name), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const hashFiles = names => Promise.all(names.map(async name => ({ path: name, sha256: digest(await readFile(path.join(directory, name))) })));
  const observations = { checks, sourceStart: source, sourceEnd: source, browser, mutation, attachments: await hashFiles(nameBrowserAssets),
    executionContext: { cwd: process.cwd(), executable: process.execPath, evidenceDirectory: directory, outputArgument: directory } };
  const packageEvidence = async value => {
    await writeJson(path.join(directory, 'browser.json'), value.browser); value.attachments = await hashFiles(nameBrowserAssets);
    await writeJson(path.join(directory, 'observations.json'), value);
    await writeFile(path.join(directory, 'worker.log'), `CHECK http\n${await readFile(path.join(directory, 'http.log'), 'utf8')}\nCHECK browser\n${marker}`);
    return { ...await metadata(), property: { id: 'HW-07-07', version: 1 }, startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z', complete: true, status: 'passed',
      scope: { description: 'Synthetic packaging contract, real HTTP below', scenario: 'contract-only', samples: 1, seed: null }, artifacts: await hashFiles(['observations.json', 'worker.log']) };
  };
  let result = await packageEvidence(structuredClone(observations)); assert.equal(validateResult(result), true); assert.equal(await checkNameEvidence(directory, result), true);
  for (const mutate of [o => { o.checks[0].execution.command[0] = '/tmp/not-node'; }, o => { o.checks[1].execution.command[2] = '/wrong/' + path.basename(directory); },
    o => { o.browser.widths[0].results[0].checkpoints.at(-1).tables.knowledge_corrections = []; }, o => { o.sourceEnd.build.git_sha = '0'.repeat(40); }]) {
    const changed = structuredClone(observations); mutate(changed); result = await packageEvidence(changed); assert.equal(await checkNameEvidence(directory, result), false, mutate.toString());
  }
  result = await packageEvidence(structuredClone(observations)); await writeFile(path.join(directory, nameBrowserAssets[1]), 'tampered'); assert.equal(await checkNameEvidence(directory, result), false);
});
