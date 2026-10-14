import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { qualitySources } from '../scripts/lib/quality-collector.mjs';
import { createTaskRuntime } from '../dist/server/index.js';
import { knowledgeRevision } from '../knowledge-revision.mjs';
import { inspectNameBusinessTables, checkNameCommittedTables } from '../scripts/lib/name-protocol-durable.mjs';
export const nameBrowserScenarios = ['held-double-submit', 'receipt-recovery', 'unknown-502', 'unknown-lost', 'rollback-retry', 'cancel-noop'];
export const nameBrowserModules = ['app.js', 'knowledge-editor.js', 'knowledge-graph.js'];
export const nameBrowserAssets = ['browser.json', ...[1280, 390].flatMap(width => nameBrowserScenarios.map(name => `name-${width}-${name}.png`)), 'name-390-double-submit-negative.png'];
export async function nameSourceSnapshot() {
  const result = await qualitySources(), runtime = createTaskRuntime({ enabled: false });
  try { result.build = structuredClone(runtime.diagnostics().build); } finally { await runtime.dispose(); }
  result.files['public/vendor/cytoscape.js'] = digest(await readFile('public/vendor/cytoscape.js'));
  return result;
}
export const validNameBuild = snapshot => snapshot?.build?.git_sha === snapshot?.sha && snapshot?.build?.build_dirty === snapshot?.dirty && snapshot?.build?.instrumentation_version === 3;
export async function nameBrowserMutation() {
  const text = await readFile('public/knowledge-editor.js', 'utf8'), anchor = 'async function save(method) {\n    if (busy || !selected || outcomeUnknown) return;';
  assert.equal(text.split(anchor).length, 2);
  return { file: 'public/knowledge-editor.js', originalSha256: digest(text), mutantSha256: digest(text.replace(anchor, 'async function save(method) {\n    if (!selected || outcomeUnknown) return;')), anchor };
}
function inspectRow(row, { width, scenario, negative, source, mutation }) {
  assert.equal(row.width, width); assert.equal(row.scenario, scenario); assert.equal(row.complete, true);
  assert.deepEqual(row.errors, []); assert.deepEqual(row.providerCalls, []);
  assert.equal(row.screenshot, `name-${width}-${negative ? 'double-submit-negative' : scenario}.png`);
  const ids = row.identities, final = row.checkpoints.at(-1), opened = row.checkpoints[0];
  const labels = ['opened', ...(scenario === 'held-double-submit' ? ['committed-held'] : scenario.startsWith('unknown-') ? ['unknown', 'reopened-unknown'] :
    scenario === 'rollback-retry' ? ['rolled-back'] : scenario === 'cancel-noop' ? ['cancelled-reopened'] : []), 'final'];
  assert.deepEqual(row.checkpoints.map(value => value.label), labels); assert.deepEqual(opened.tables, row.baseline);
  const name = scenario === 'cancel-noop' ? 'Deebo' : scenario === 'rollback-retry' ? 'Ｔｉｂｏ  Longer' : 'Tibo';
  for (const checkpoint of row.checkpoints) {
    const check = inspectNameBusinessTables({ baseline: row.baseline, tables: checkpoint.tables, identities: ids });
    assert.equal(check.ok, true, JSON.stringify(check));
    const item = checkpoint.tables.knowledge_items.find(value => value.id === ids.itemId); assert.ok(item);
    for (const [key, value] of Object.entries(item)) assert.deepEqual(checkpoint.snapshot.item[key], value);
    const ordered = rows => rows.map(value => JSON.stringify(value, Object.keys(value).sort())).sort();
    for (const [field, table] of [['mentions', 'knowledge_mentions'], ['facts', 'knowledge_facts'], ['revisions', 'knowledge_revisions']])
      assert.deepEqual(ordered(checkpoint.snapshot.item[field]), ordered(checkpoint.tables[table].filter(value => value.item_id === ids.itemId)));
    assert.deepEqual([...checkpoint.snapshot.item.aliases].sort(), checkpoint.tables.knowledge_aliases.filter(value => value.item_id === ids.itemId).map(value => value.alias).sort());
    assert.equal(checkpoint.snapshot.item.id, ids.itemId); assert.equal(checkpoint.snapshot.item.canonical_name, check.projection.name);
    assert.equal(knowledgeRevision(checkpoint.snapshot), checkpoint.snapshot.revision);
    assert.equal(checkpoint.snapshot.segments.find(value => value.id === ids.segmentId)?.original_text, check.projection.sourceText);
    const displayedSource = ['opened', 'rolled-back', 'unknown', 'cancelled-reopened'].includes(checkpoint.label) || checkpoint.label === 'committed-held' && !negative ? opened.snapshot.item.canonical_name : checkpoint.snapshot.item.canonical_name;
    assert.equal(checkpoint.editor.source, displayedSource);
    assert.equal(checkpoint.editor.open, true); assert.equal(checkpoint.editor.fits, true);
  }
  assert.equal(final.snapshot.item.canonical_name, name); assert.equal(final.editor.draft, name); assert.equal(final.editor.saveDisabled, false);
  const posts = row.requests.filter(request => request.method === 'POST'), gets = row.requests.filter(request => request.method === 'GET' && /\/edits\//.test(request.url));
  const expectedSaves = scenario === 'rollback-retry' ? 2 : 1;
  assert.equal(row.explicitSaves, expectedSaves); assert.equal(posts.length, expectedSaves + (negative ? 1 : 0));
  assert.equal(gets.length, ['receipt-recovery', 'unknown-502', 'unknown-lost'].includes(scenario) ? 1 : 0);
  const origin = new URL(posts[0].url).origin, url = `${origin}/api/listenings/${ids.listeningId}/knowledge/${ids.itemId}`;
  assert.ok(['127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
  const seen = new Set();
  for (const post of posts) {
    assert.equal(post.url, url + '/name-replacements'); const id = post.headers['idempotency-key'];
    assert.match(id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/); assert.equal(seen.has(id), false); seen.add(id);
    assert.deepEqual(post.body, { name, revision: opened.snapshot.revision });
  }
  const added = final.tables.knowledge_edit_jobs.filter(job => !row.baseline.knowledge_edit_jobs.some(old => old.id === job.id));
  assert.equal(added.length, 1); const receipt = added[0], request = posts.find(post => post.headers['idempotency-key'] === receipt.id); assert.ok(request);
  assert.equal(receipt.listening_id, ids.listeningId); assert.equal(receipt.item_id, ids.itemId); assert.equal(receipt.state, 'succeeded');
  assert.equal(receipt.name, name); assert.equal(receipt.revision, request.body.revision);
  for (const get of gets) { assert.equal(get.url, url + '/edits/' + receipt.id); assert.equal(get.body, null); }
  const publicJob = { id: receipt.id, state: receipt.state, name: receipt.name, source: receipt.source, saved: true, error: receipt.error };
  assert.equal(receipt.fingerprint, digest(JSON.stringify(['name_replace', request.body.name, request.body.revision])));
  const transaction = checkNameCommittedTables({ before: row.baseline, after: final.tables, identities: ids, id: receipt.id, input: request.body });
  assert.equal(transaction.ok, true, transaction.reason);
  const upstreamRequired = ['held-double-submit', 'receipt-recovery', 'unknown-502', 'unknown-lost'].includes(scenario);
  assert.equal(row.upstream.length, upstreamRequired ? (negative ? 2 : 1) : 0);
  for (const value of row.upstream) {
    const post = posts.find(post => post.headers['idempotency-key'] === value.id); assert.ok(post); assert.deepEqual(value.request, post.body);
    const body = JSON.parse(value.text);
    if (value.status === 200) { assert.deepEqual(body.job, publicJob); }
    else { assert.equal(negative, true); assert.equal(value.status, 409); assert.equal(body.saved, false); assert.equal(body.code, 'KNOWLEDGE_EDIT_STALE'); }
  }
  if (scenario === 'held-double-submit') {
    assert.equal(row.checkpoints[1].snapshot.revision, final.snapshot.revision); assert.deepEqual(row.checkpoints[1].tables, final.tables);
    if (!negative) assert.equal(row.checkpoints[1].editor.closeDisabled, true);
  } else if (scenario.startsWith('unknown-')) {
    const unknown = row.checkpoints[1], reopened = row.checkpoints[2];
    assert.equal(unknown.editor.draft, name); assert.equal(unknown.editor.saveDisabled, true); assert.equal(unknown.editor.closeDisabled, false);
    assert.match(unknown.editor.status, /输入已保留.*保存结果尚未确认|保存结果尚未确认.*输入已保留/);
    assert.deepEqual(unknown.tables, reopened.tables); assert.deepEqual(reopened.tables, final.tables);
    assert.notEqual(unknown.snapshot.revision, opened.snapshot.revision);
    assert.equal(row.responses.filter(response => response.url === gets[0].url && response.status === 502).length, 1);
  } else if (scenario === 'receipt-recovery') {
    const response = row.responses.filter(response => response.url === url + '/edits/' + receipt.id); assert.equal(response.length, 1);
    assert.equal(response[0].status, 200); assert.deepEqual(JSON.parse(response[0].text).job, publicJob);
  } else if (scenario === 'rollback-retry') {
    assert.deepEqual(row.checkpoints[1].tables, row.baseline); assert.equal(row.checkpoints[1].editor.draft, name); assert.equal(row.checkpoints[1].editor.saveDisabled, false);
    const failed = row.responses.filter(response => response.url === url + '/name-replacements' && response.status === 502); assert.equal(failed.length, 1);
    assert.equal(JSON.parse(failed[0].text).saved, false); assert.notEqual(posts[0].headers['idempotency-key'], receipt.id);
  } else { assert.deepEqual(row.checkpoints[1].tables, row.baseline); assert.equal(final.snapshot.revision, opened.snapshot.revision); }
  assert.equal(row.views.list.id, ids.itemId); assert.equal(row.views.list.name, name); assert.ok(row.views.list.transcript.includes(final.snapshot.segments[0].original_text));
  assert.ok(row.views.list.summary.includes(name)); assert.ok(row.views.list.fact.includes(name));
  assert.deepEqual(row.views.graph.entries.map(value => value.id).sort(), [ids.itemId, ids.cameraId].sort());
  assert.ok(row.views.graph.entries.find(value => value.id === ids.itemId).text.includes(name));
  assert.ok(row.views.graph.name.includes(name)); assert.ok(row.views.graph.details.includes(name));
  assert.equal(row.views.reopened.draft, name); assert.equal(row.views.reopened.saveDisabled, false);
  assert.equal(row.sources.length, 3);
  for (const module of nameBrowserModules) {
    const values = row.sources.filter(value => value.url === origin + '/' + module); assert.equal(values.length, 1);
    const value = values[0]; assert.equal(value.status, 200); assert.ok(value.bytes > 0);
    assert.equal(value.sha256, negative && module === 'knowledge-editor.js' ? mutation.mutantSha256 : source.files['public/' + module]);
  }
  assert.deepEqual(row.mutation, negative ? mutation : null);
}
export function validNameBrowser(value, source, mutation) {
  try {
    assert.equal(value.complete, true); assert.deepEqual(value.source, { sha: source.sha, dirty: source.dirty }); assert.ok(value.chromium);
    assert.deepEqual(value.widths.map(row => row.width), [1280, 390]);
    for (const row of value.widths) {
      assert.deepEqual(row.results.map(result => result.scenario), nameBrowserScenarios);
      for (const result of row.results) inspectRow(result, { width: row.width, scenario: result.scenario, negative: false, source, mutation });
    }
    inspectRow(value.negative, { width: 390, scenario: 'held-double-submit', negative: true, source, mutation }); return true;
  } catch { return false; }
}

export const nameBrowserChecks = [{ name: 'http', file: 'test/name-protocol-http.test.mjs', timeoutMs: 30000 }, { name: 'browser', timeoutMs: 110000 }];
export async function nameHttpRoster() {
  return [...(await readFile('test/name-protocol-http.test.mjs', 'utf8')).matchAll(/^test\('([^']+)'/gm)].map(match => match[1]);
}
export async function checkNameEvidence(directory, result) {
  try {
    const { checkArtifacts } = await import('../scripts/lib/verification-evidence.mjs');
    const { strictNameTap } = await import('../scripts/lib/name-protocol-evidence.mjs');
    const path = await import('node:path');
    if (!await checkArtifacts(directory, result)) return false;
    const observations = JSON.parse(await readFile(path.join(directory, 'observations.json'), 'utf8'));
    assert.ok(validNameBuild(observations.sourceStart) && validNameBuild(observations.sourceEnd));
    assert.deepEqual(observations.sourceStart, observations.sourceEnd); assert.deepEqual(observations.sourceEnd, await nameSourceSnapshot());
    assert.deepEqual(observations.checks.map(row => row.name), nameBrowserChecks.map(row => row.name));
    const origin = observations.executionContext; assert.ok(path.isAbsolute(origin.cwd) && path.isAbsolute(origin.executable));
    assert.equal(path.resolve(origin.cwd, origin.outputArgument), origin.evidenceDirectory);
    assert.equal(path.basename(origin.evidenceDirectory), path.basename(path.resolve(directory)));
    const logs = [];
    for (const [index, row] of observations.checks.entries()) {
      const spec = nameBrowserChecks[index], e = row.execution, log = await readFile(path.join(directory, row.name + '.log'), 'utf8');
      logs.push(`CHECK ${row.name}\n${log}`);
      assert.equal(e.tail, log.slice(-12000)); assert.equal(e.code, 0); assert.equal(e.ok, true); assert.equal(e.signal, null);
      assert.equal(e.timedOut, false); assert.equal(e.interrupted, false); assert.equal(e.configuredTimeoutMs, spec.timeoutMs);
      assert.ok(e.timeoutMs > 0 && e.timeoutMs <= spec.timeoutMs); assert.equal(e.cwd, origin.cwd);
      const args = spec.file ? ['--test', '--test-reporter=tap', '--test-timeout=20000', spec.file] : ['test-support/name-protocol-browser.mjs', origin.outputArgument];
      assert.deepEqual(e.command, [origin.executable, ...args]);
      if (spec.file) assert.equal(strictNameTap(log, await nameHttpRoster()).ok, true);
    }
    assert.equal(await readFile(path.join(directory, 'worker.log'), 'utf8'), logs.join('\n'));
    assert.deepEqual(observations.attachments.map(row => row.path).sort(), [...nameBrowserAssets].sort());
    assert.ok(await checkArtifacts(directory, { artifacts: observations.attachments }));
    for (const file of nameBrowserAssets.filter(file => file.endsWith('.png'))) assert.ok((await readFile(path.join(directory, file))).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    const browser = JSON.parse(await readFile(path.join(directory, 'browser.json'), 'utf8'));
    assert.deepEqual(browser, observations.browser); assert.deepEqual(observations.mutation, await nameBrowserMutation());
    assert.ok(validNameBrowser(browser, observations.sourceEnd, observations.mutation)); return true;
  } catch { return false; }
}
