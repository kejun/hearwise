import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { runSemanticDistinctOffline, inspectSemanticDistinctOffline } from '../scripts/lib/semantic-quality-distinct.mjs';
import { semanticDatabase, semanticUnits } from '../scripts/lib/semantic-quality-capture.mjs';
import { hashBytes } from '../scripts/lib/quality-contract.mjs';
import { semanticFixtureResponse } from '../test-support/semantic-quality-fixture.mjs';
import { closeServer } from '../test-support/lifecycle.mjs';

const roles = ['baseline', 'candidate'];
const marker = 'Distinct corpus candidate prompt marker.';
const read = async file => JSON.parse(await readFile(file));
const git = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000
}).trim();
let root, directory, checkouts, plan, options, summary, captures, observed;

function corpusPlan() {
  return {
    schemaVersion: 1, kind: 'offline-semantic-corpus-plan', mode: 'offline',
    sample: {
      id: 'board-approval-notes', kind: 'offline-text-corpus', ingestionBatchSize: 4,
      segments: Array.from({ length: 8 }, (_, index) =>
        `Board note ${index + 1}: Atlas also called AtlasCo, Nova, Orion and Vale are independent organizations. ` +
        'Orion reports that Atlas did not acquire Nova for 15 dollars. If approved, Atlas plans to acquire Nova for 20 dollars.'),
      gold: { approved: false, variants: [{ id: 'unreviewed', units: [] }] }
    },
    reviewers: ['synthetic corpus annotation label (not a human)'],
    budget: {
      id: 'distinct-corpus-synthetic-only', currency: 'USD', ceilingMicros: 100000,
      attemptMicros: { knowledge: 2, relation: 3 }, expiresAt: new Date(Date.now() + 600000).toISOString()
    },
    limits: { maxRequestBytes: 32768, maxResponseBytes: 16384, requestTimeoutMs: 3000, totalTimeoutMs: 10000 }
  };
}

async function provider() {
  const response = semanticFixtureResponse(), requests = [], knowledge = new Map();
  let first = true;
  const server = http.createServer(async (request, reply) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/');
      assert.equal(request.headers.authorization, undefined);
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 32768); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks)), input = JSON.parse(body.messages.at(-1).content);
      const kind = input.candidates ? 'relation' : input.rejected ? 'repair' : 'knowledge';
      const role = body.messages[0].content.includes(marker) ? 'candidate' : 'baseline';
      requests.push({ role, kind, body });
      if (first) {
        first = false; reply.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
        reply.end('{"synthetic":"retry this reserved attempt"}'); return;
      }
      let value;
      if (kind === 'repair') {
        value = { corrections: input.rejected.map(row => ({ rejection_id: row.rejection_id, item: { ...row.item, certainty: 'clear' } })) };
      } else {
        // Reuse only the authored response oracle; all persisted IDs and source
        // evidence come from the actual target request, never fixture capture IDs.
        const sample = { id: 'qualified', names: ['Atlas', 'Nova', 'Orion', 'Vale'] };
        value = response({ input, kind, sample });
        if (kind === 'knowledge') {
          const count = (knowledge.get(role) || 0) + 1; knowledge.set(role, count);
          const atlas = value.items.find(item => item.canonical_name === 'Atlas');
          atlas.aliases = ['AtlasCo'];
          if (count === 1) atlas.certainty = 'invalid';
        }
      }
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
    } catch (error) {
      requests.push({ error: String(error) }); reply.writeHead(400); reply.end('{}');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { requests, url: `http://127.0.0.1:${server.address().port}/`, close: () => closeServer(server, 'distinct corpus provider') };
}

function cli(command, extra = []) {
  return new Promise((resolve, reject) => {
    // Keep this process's loopback provider live while the CLI collects and
    // independently replays both sources. A synchronous child would deadlock it.
    execFile(process.execPath, ['scripts/evaluate-semantic-quality.mjs', command,
      '--baseline', checkouts.baseline, '--candidate', checkouts.candidate,
      '--reviewers', path.join(root, 'reviewers.json'), '--plan', path.join(root, 'plan.json'),
      '--out', directory, ...extra], { encoding: 'utf8', timeout: 65000, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error && !Number.isInteger(error.code)) reject(error);
      else resolve({ status: error?.code || 0, stdout, stderr });
    });
  });
}

function ledger(directory) {
  const db = new DatabaseSync(path.join(directory, 'budget.sqlite'), { readOnly: true });
  try {
    return {
      attempts: db.prepare('SELECT * FROM attempts ORDER BY id').all().map(row => ({ ...row })),
      runs: db.prepare('SELECT * FROM runs ORDER BY role').all().map(row => ({ ...row }))
    };
  } finally { db.close(); }
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'semantic-distinct-corpus-')); directory = path.join(root, 'run');
  checkouts = Object.fromEntries(roles.map(role => [role, path.join(root, role)]));
  const files = git(process.cwd(), ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const role of roles) {
    const target = checkouts[role]; await mkdir(target);
    for (const file of files) {
      await mkdir(path.dirname(path.join(target, file)), { recursive: true }); await cp(file, path.join(target, file));
    }
    // Independent physical module trees, including locally contained bin links.
    await cp('node_modules', path.join(target, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    assert.equal((await lstat(path.join(target, 'node_modules'))).isSymbolicLink(), false);
    git(target, ['init', '-q']); git(target, ['config', 'user.name', 'Synthetic fixture']);
    git(target, ['config', 'user.email', 'fixture@example.invalid']);
    if (role === 'candidate') {
      const file = path.join(target, 'docs/knowledge-extraction-prompt-v2.md');
      await writeFile(file, (await readFile(file, 'utf8')).replace('```text\n', `\`\`\`text\n${marker}\n`));
    }
    git(target, ['add', '.']); git(target, ['commit', '-qm', `Synthetic corpus ${role}`]);
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: target, timeout: 20000, stdio: 'pipe' });
  }
  assert.notEqual(await realpath(path.join(checkouts.baseline, 'node_modules')), await realpath(path.join(checkouts.candidate, 'node_modules')));
  plan = corpusPlan(); options = { checkouts, reviewers: plan.reviewers, corpusPlan: plan };
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(plan));
  await writeFile(path.join(root, 'reviewers.json'), JSON.stringify(plan.reviewers));
  const upstream = await provider();
  try {
    const result = await cli('distinct-offline', ['--provider', upstream.url]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    summary = JSON.parse(result.stdout); observed = upstream.requests;
  } finally { await upstream.close(); }
  captures = Object.fromEntries(await Promise.all(roles.map(async role => [role, await read(path.join(directory, role, 'capture/capture.json'))])));
}, { timeout: 80000 });
after(() => root && rm(root, { recursive: true, force: true }));

test('arbitrary corpus executes distinct actual prompts, retry, repair and multiple relation windows under one cumulative ledger', async () => {
  assert.equal(summary.infrastructurePassed, true, JSON.stringify(summary));
  assert.equal(summary.reviewComplete, false); assert.equal(summary.offlineReviewPassed, false);
  assert.equal(summary.qualityStatus, 'not_run'); assert.equal(summary.qualityEvaluated, false);
  assert.equal(summary.fullQualityAcceptance, false); assert.equal(summary.releaseEligible, false); assert.equal(summary.liveCalls, 0);
  assert.equal(summary.pairs.length, 1); assert.equal(summary.pairs[0].sample, plan.sample.id);
  assert.equal(summary.pairs[0].metricDeltas, null); assert.ok(observed.every(row => !row.error));
  assert.notEqual(captures.baseline.sourceStart.sha, captures.candidate.sourceStart.sha);
  assert.notEqual(captures.baseline.sourceStart.tree, captures.candidate.sourceStart.tree);
  const prompts = roles.map(role => captures[role].calls.find(call => call.kind === 'knowledge').request.messages[0].content);
  assert.notEqual(prompts[0], prompts[1]); assert.ok(!prompts[0].includes(marker)); assert.ok(prompts[1].includes(marker));
  for (const role of roles) {
    const capture = captures[role]; assert.deepEqual(capture.sample, plan.sample);
    // Each four-segment ingestion batch is drained through the production
    // three-segment extraction range, yielding two jobs per batch.
    assert.deepEqual(capture.after.tables.extraction_jobs.map(row => [row.from_sequence, row.to_sequence]).sort((a,b)=>a[0]-b[0]),
      [[1,3],[4,4],[5,7],[8,8]]);
    assert.ok(capture.after.tables.relation_windows.length >= 2);
    assert.ok(capture.calls.some(call => call.kind === 'repair'));
    assert.ok(capture.after.tables.knowledge_aliases.some(row => row.alias === 'AtlasCo'));
    assert.ok(capture.after.tables.relation_assertions.some(row => row.conditions === 'If approved' && row.modality === 'planned'));
    assert.equal(capture.qualityStatus, 'not_run');
  }
  assert.equal(captures.baseline.calls.filter(call => call.http.status === 503).length, 1);
  const rows = ledger(directory), paired = await read(path.join(directory, 'paired.json'));
  assert.deepEqual(rows.runs.map(row => [row.role, row.source_sha, row.state]),
    roles.map(role => [role, captures[role].sourceStart.sha, 'complete']));
  assert.equal(rows.attempts.length, roles.reduce((sum, role) => sum + captures[role].calls.length, 0));
  assert.deepEqual(rows.attempts.map(row => row.id), rows.attempts.map((_, index) => index + 1));
  const spent = rows.attempts.reduce((sum, row) => sum + row.reserved_micros, 0);
  assert.ok(rows.attempts.every(row => row.reserved_micros === plan.budget.attemptMicros[row.kind]));
  assert.equal(paired.roleSnapshots[1].snapshot.reservedMicros, spent);
  assert.ok(spent > paired.roleSnapshots[0].snapshot.reservedMicros);
  assert.deepEqual(paired.roleSnapshots[1].snapshot.attempts, rows.attempts);
  for (const role of roles) assert.deepEqual(captures[role].transport.budgetBindings.map(row => Number(row.attemptId)),
    rows.attempts.filter(row => row.trial_id === `${role}:${plan.sample.id}:0`).map(row => row.id));
});

test('missing candidate and a different caller corpus cannot reuse the evidence', async () => {
  assert.equal((await inspectSemanticDistinctOffline(directory, { ...options, checkouts: { baseline: checkouts.baseline } })).infrastructurePassed, false);
  const changed = structuredClone(plan); changed.sample.segments[0] += ' Different caller text.';
  assert.equal((await inspectSemanticDistinctOffline(directory, { ...options, corpusPlan: changed })).infrastructurePassed, false);
});

test('coordinated persistence forgery fails; restored read-only assessment preserves evidence and computes only declared deltas', async () => {
  for (const role of roles) {
    const file = path.join(directory, role, 'review.json'), review = await read(file);
    review.reviewer = plan.reviewers[0]; review.reviewedAt = new Date().toISOString(); review.selectedVariantId = 'unreviewed';
    review.missingGoldIds = [];
    for (const row of review.rows) {
      row.reviewer = review.reviewer; row.reviewedAt = review.reviewedAt;
      row.severe = Object.fromEntries(Object.keys(row.severe).map(key => [key, false]));
      row.notes = 'Predetermined unmatched synthetic annotation; no human or quality approval.';
    }
    await writeFile(file, JSON.stringify(review));
  }
  const files = ['freeze.json', 'paired.json', 'budget.sqlite', ...roles.flatMap(role =>
    ['freeze.json', 'run.json', 'runtime.json', 'worker.json', 'review.json', 'capture/capture.json', 'capture/store.sqlite'].map(file => `${role}/${file}`))];
  const hashes = () => Promise.all(files.map(async file => hashBytes(await readFile(path.join(directory, file)))));
  const originalHashes = await hashes();
  const file = path.join(directory, 'baseline/capture/capture.json'), dbfile = path.join(directory, 'baseline/capture/store.sqlite');
  const bytes = await readFile(file), dbbytes = await readFile(dbfile), forged = JSON.parse(bytes);
  const db = new DatabaseSync(dbfile);
  try {
    assert.ok(db.prepare("UPDATE relation_assertions SET conditions='FORGED unconditional purchase'").run().changes > 0);
    assert.ok(db.prepare("UPDATE knowledge_aliases SET alias='ForgedAlias'").run().changes > 0);
  } finally { db.close(); }
  forged.after = semanticDatabase(dbfile);
  for (const table of ['relation_assertions', 'knowledge_aliases']) forged.before.tables[table] = structuredClone(forged.after.tables[table]);
  forged.units = semanticUnits(forged.after); forged.artifacts[0].sha256 = hashBytes(await readFile(dbfile));
  await writeFile(file, JSON.stringify(forged));
  try { assert.equal((await inspectSemanticDistinctOffline(directory, options)).infrastructurePassed, false); }
  finally { await writeFile(dbfile, dbbytes); await writeFile(file, bytes); }
  assert.deepEqual(await hashes(), originalHashes);
  const checked = await cli('assess-distinct-offline'); assert.equal(checked.status, 1, checked.stderr);
  const result = JSON.parse(checked.stdout); assert.equal(result.infrastructurePassed, true, checked.stdout);
  assert.equal(result.reviewComplete, true); assert.equal(result.offlineReviewPassed, false);
  assert.equal(result.qualityStatus, 'not_run'); assert.equal(result.fullQualityAcceptance, false); assert.equal(result.liveCalls, 0);
  assert.ok(result.pairs[0].metricDeltas);
  for (const kind of ['entity', 'fact', 'relation']) assert.equal(result.pairs[0].metricDeltas[kind].falseNegatives, 0);
  assert.deepEqual(await hashes(), originalHashes);
});

test('baseline reservations consume the shared ceiling before candidate forwarding and are never refunded', async () => {
  const baselineAttempts = ledger(directory).attempts.filter(row => row.trial_id.startsWith('baseline:'));
  const low = structuredClone(plan); low.budget.ceilingMicros = baselineAttempts.reduce((sum, row) => sum + row.reserved_micros, 0);
  const exhausted = path.join(root, 'exhausted'), upstream = await provider();
  try {
    const result = await runSemanticDistinctOffline(exhausted, { ...options, corpusPlan: low, providerEndpoint: upstream.url });
    assert.equal(result.complete, false); assert.equal(result.errorCode, 'SEMANTIC_PAIR_INCOMPLETE');
    assert.equal(result.qualityStatus, 'not_run'); assert.equal(result.liveCalls, 0);
  } finally { await upstream.close(); }
  assert.equal(upstream.requests.filter(row => row.kind).length, baselineAttempts.length);
  assert.ok(upstream.requests.every(row => row.role === 'baseline'));
  const first = ledger(exhausted);
  assert.deepEqual(first.runs.map(row => [row.role, row.state]), [['baseline', 'complete'], ['candidate', 'incomplete']]);
  assert.equal(first.attempts.length, baselineAttempts.length);
  assert.ok(first.attempts.every(row => row.trial_id.startsWith('baseline:')));
  assert.equal(first.attempts.reduce((sum, row) => sum + row.reserved_micros, 0), low.budget.ceilingMicros);
  assert.deepEqual(ledger(exhausted), first);
});
