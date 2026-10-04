import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskRuntime, parseTraceInput, buildTraceReport, compareTraceReports } from '../dist/server/index.js';
import { renderTraceReport, createTraceReport } from '../scripts/trace-report.mjs';
import { traceReportFixture } from '../test-support/trace-report-fixture.mjs';

const fixture = await traceReportFixture();
const report = input => buildTraceReport(parseTraceInput(JSON.stringify(input)));

test('real knowledge workflow and HTTP traces drill down to checkpoints, recovered failures and cancellation', () => {
  const result = report(fixture), roots = result.roots.map(id => result.spans.find(s => s.id === id));
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(roots.map(s => s.state), ['succeeded', 'recovered', 'cancelled']);
  assert.ok(result.spans.some(s => s.path === 'knowledge.execute → knowledge.extract → knowledge.http'));
  assert.ok(result.spans.some(s => s.events.some(e => e.error_code === 'HTTP_429')));
  assert.ok(result.spans.some(s => s.events.some(e => e.event === 'checkpoint_committed')));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('mixed stdout strips unrelated logs and JSONL never claims a complete capture', () => {
  const input = 'PRIVATE_KEY_LOG\n' + fixture.events.map(e => `execution_trace ${JSON.stringify(e)}`).join('\n');
  const result = buildTraceReport(parseTraceInput(input));
  assert.equal(result.completeness, 'unknown');
  assert.equal(result.eventCount, fixture.events.length);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEY_LOG/);
  const truncated = buildTraceReport(parseTraceInput(input + '\nexecution_trace {"broken":'));
  assert.equal(truncated.completeness, 'incomplete');
  assert.ok(truncated.issues.includes('malformed_trace_line'));
});

test('lost boundaries, sequence gaps, orphan spans and snapshot ownership are explicit', () => {
  const input = structuredClone(fixture); input.events = input.events.slice(1, -1);
  input.events[0].parent_span_id = 'missing';
  const result = report(input);
  assert.equal(result.completeness, 'incomplete');
  assert.ok(result.issues.includes('sequence_gap'));
  assert.ok(result.issues.includes('missing_parent'));
  assert.ok(result.spans.some(s => s.state === 'unknown'));
  input.process_id = 'wrong-process';
  assert.ok(report(input).issues.includes('snapshot_process_mismatch'));
});

test('duplicate delivery is idempotent, conflicts are incomplete and parent cycles cannot recurse', () => {
  const input = structuredClone(fixture); input.events.push(structuredClone(input.events[0]));
  assert.equal(report(input).eventCount, fixture.events.length);
  input.events.at(-1).state = 'failed';
  assert.ok(report(input).issues.includes('conflicting_duplicate'));
  const cyclic = structuredClone(fixture);
  for (const event of cyclic.events) event.parent_span_id = event.span_id;
  assert.ok(report(cyclic).issues.includes('invalid_parent_chain'));
});

test('state and step differences align on logical paths and retain both versions of the evidence', () => {
  const before = report(fixture), input = structuredClone(fixture);
  for (const event of input.events) {
    event.event_id += '-new'; event.trace_id += '-new'; event.span_id += '-new';
    if (event.parent_span_id) event.parent_span_id += '-new';
    event.attributes.job_id += '-new';
  }
  const same = compareTraceReports(report(input), before);
  assert.ok(same.rows.every(r => !r.changed));
  const http = input.events.find(e => e.step_key === 'knowledge.http');
  input.events = input.events.filter(e => e.span_id !== http.span_id);
  const diff = compareTraceReports(report(input), before);
  const changed = diff.rows.find(r => r.path.endsWith('knowledge.http'));
  assert.equal(changed.changed, true);
  assert.equal(changed.baseline.count, changed.current.count + 1);
  assert.match(diff.warning, /未观测不等于未执行/);
  for (const event of input.events) event.build.instrumentation_version++;
  assert.equal(compareTraceReports(report(input), before).instrumentationCompatible, false);
});

test('unknown fields, unsafe errors and unsupported schemas do not enter the standalone report', () => {
  const input = structuredClone(fixture);
  for (const event of input.events) {
    event.message = '</script><script>globalThis.PWNED=true</script>';
    event.attributes.Authorization = 'PRIVATE_KEY'; event.error_code = 'PRIVATE_ERROR';
  }
  const html = renderTraceReport(report(input));
  assert.doesNotMatch(html, /PWNED|PRIVATE_KEY|PRIVATE_ERROR/);
  assert.match(html, /connect-src 'none'/);
  input.events[0].schema_version = 99;
  assert.ok(report(input).issues.includes('invalid_event'));
});

test('report JSON export round trips and preserves incomplete and unknown evidence', () => {
  for (const state of ['complete', 'incomplete', 'unknown']) {
    const current = report(fixture); current.completeness = state;
    const roundtrip = report({ format: 'hearwise-trace-report/v1', current });
    assert.equal(roundtrip.completeness, state);
    assert.equal(roundtrip.eventCount, current.eventCount);
  }
});

test('ring-buffer overflow and pending tasks cannot be presented as fully completed', async () => {
  const runtime = createTaskRuntime({ enabled: true, capacity: 2 });
  try {
    await runtime.start('one', { job_id: 'one', listening_id: 'a' }, async () => 1).promise;
    const pending = runtime.start('two', { job_id: 'two', listening_id: 'a' }, () => new Promise(() => {}));
    const result = report(runtime.diagnostics());
    assert.equal(result.completeness, 'incomplete');
    assert.ok(result.issues.includes('buffer_truncated'));
    assert.equal(result.spans.find(s => s.job === 'two').state, 'unknown');
    pending.cancel('application_shutdown'); await pending.promise.catch(() => {});
  } finally { await runtime.dispose(); }
});

test('CLI renderer writes a self-contained report and refuses to overwrite sources or baselines', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trace-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.json'), output = path.join(directory, 'report.html');
  const original = JSON.stringify(fixture); await writeFile(input, original);
  const result = await createTraceReport(input, output, input);
  assert.equal(result.completeness, 'complete');
  const html = await readFile(output, 'utf8');
  assert.match(html, /调用层级图/); assert.match(html, /HTTP_429/);
  await assert.rejects(createTraceReport(input, input), { code: 'EEXIST' });
  assert.equal(await readFile(input, 'utf8'), original);
});

test('successful Effect completion does not hide partial, invalid or continuing business outcomes', async () => {
  const runtime = createTaskRuntime({ enabled: true });
  try {
    for (const outcome of ['partial', 'invalid', 'continue']) {
      await runtime.start(outcome, { job_id: outcome, listening_id: 'outcomes' }, async () =>
        outcome === 'continue' ? { kind: 'continue' } : { outcome }).promise;
    }
    assert.deepEqual(report(runtime.diagnostics()).spans.map(s => s.state), ['partial', 'failed', 'waiting']);
  } finally { await runtime.dispose(); }
});

test('input capacity is bounded and an event overflow marks lost evidence', () => {
  assert.throws(() => parseTraceInput('x'.repeat(20 * 1024 * 1024 + 1)), /20 MiB/);
  const input = structuredClone(fixture); input.events = Array(10001).fill(input.events[0]);
  assert.ok(report(input).issues.includes('event_limit'));
});
