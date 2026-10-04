import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessOverview, buildTraceReport, parseTraceInput, uncoveredDuration } from '../dist/server/index.js';

// Synthetic timing evidence validates arithmetic and damaged-capture handling, not provider latency.
function capture(rows) {
  const events = rows.flatMap(([id, step, start, end, extra = {}]) => {
    const common = { schema_version: 1, process_id: extra.process || 'p', trace_id: extra.trace || 'trace', span_id: id,
      step_key: step, ...(extra.parent ? { parent_span_id: extra.parent } : {}),
      attributes: { listening_id: 'record', job_id: extra.job || 'job', ...extra.attributes },
      build: { git_sha: '1234567', build_dirty: false, instrumentation_version: 3 } };
    return [{ ...common, state: 'running', timestamp_ms: start },
      ...(extra.events || []).map(([name, at, attributes]) => ({ ...common, state: 'event', event: name, timestamp_ms: at, attributes: { ...common.attributes, ...attributes } })),
      ...(end === null ? [] : [{ ...common, state: extra.state || 'succeeded', timestamp_ms: end, duration_ms: end - start }])];
  }).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  events.forEach((event, i) => { event.sequence = i + 1; event.event_id = `e${i}`; });
  return events;
}
const report = events => buildTraceReport(parseTraceInput(events.map(e => `execution_trace ${JSON.stringify(e)}`).join('\n')));
const overview = events => buildBusinessOverview(report(events), 'record');

test('call totals count adapter attempts once and group repeated dispatches into one business object', () => {
  const input = capture([
    ['root1', 'knowledge.execute', 100, 220, { attributes: { outcome: 'continue' } }],
    ['extract1', 'knowledge.extract', 110, 210, { parent: 'root1', state: 'failed' }],
    ['http1', 'knowledge.http', 120, 200, { parent: 'extract1', state: 'failed' }],
    ['root2', 'knowledge.execute', 300, 420],
    ['extract2', 'knowledge.extract', 310, 410, { parent: 'root2' }],
    ['http2', 'knowledge.http', 320, 400, { parent: 'extract2' }]
  ]);
  const result = overview(input), knowledge = result.domains.find(d => d.key === 'knowledge');
  assert.equal(knowledge.objectCount, 1); assert.equal(knowledge.calls, 2); assert.equal(knowledge.callMs, 160);
  assert.equal(knowledge.tasks[0].state, 'recovered'); assert.equal(knowledge.tasks[0].spanIds.length, 2);
  assert.ok(result.insights.some(i => i.code === 'recovered'));
  assert.equal(result.domains.length, 5); assert.equal(result.domains.find(d => d.key === 'speech').observed, false);
  const waiting = overview(input.filter(e => ['root1', 'extract1', 'http1'].includes(e.span_id)));
  assert.equal(waiting.tasks[0].state, 'waiting');
  assert.match(waiting.tasks[0].activity, /等待后续调度/);
  assert.ok(waiting.insights.some(i => i.code === 'followup_needed'));
});

test('parallel child time is a union and uncovered time is not labelled queue or CPU', () => {
  const result = report(capture([
    ['r', 'translation.execute', 1000, 11000],
    ['a', 'translation.http', 2000, 4000, { parent: 'r' }],
    ['b', 'translation.http', 3000, 5000, { parent: 'r' }]
  ]));
  assert.equal(uncoveredDuration(result.spans[0], result.spans.slice(1)), 7000);
  const insight = buildBusinessOverview(result, 'record').insights.find(i => i.code === 'unattributed_time');
  assert.match(insight.detail, /7.00 秒/); assert.match(insight.detail, /不是根因证据/);
  result.spans[1].issues.push('missing_parent');
  assert.equal(uncoveredDuration(result.spans[0], result.spans.slice(1)), undefined);
});

test('business completion stays distinct from missing boundaries and unknown never becomes running', () => {
  const events = capture([['r', 'translation.execute', 100, 400], ['h', 'translation.http', 110, null, { parent: 'r' }]]);
  const result = overview(events), task = result.tasks[0];
  assert.equal(task.state, 'succeeded'); assert.equal(task.quality, 'incomplete');
  assert.equal(result.quality, 'incomplete'); assert.ok(result.insights.some(i => i.code === 'missing_evidence'));
  assert.equal(result.domains.find(d => d.key === 'translation').timedCalls, 0);
  assert.equal(overview(capture([['r', 'translation.execute', 100, null]])).tasks[0].state, 'unknown');
});

test('speech session duration is not added to generation calls and cancelled playback does not raise a missing-feedback insight', () => {
  const result = overview(capture([
    ['s', 'speech.session', 100, 100000, { job: 'session' }],
    ['u', 'speech.unit', 1000, 7000, { job: 'unit', state: 'cancelled', attributes: { segment_id: 'sentence', segment_sequence: 3, unit_id: 1 },
      events: [['pcm_sent', 6100, { audio_ms: 1000 }]] }],
    ['g', 'speech.synthesize', 1100, 6000, { job: 'unit', parent: 'u' }],
    ['a', 'speech.attempt', 1200, 5900, { job: 'unit', parent: 'g' }],
    ['h', 'speech.stream', 1500, 5800, { job: 'unit', parent: 'a' }]
  ]));
  const speech = result.domains.find(d => d.key === 'speech');
  assert.equal(speech.objectCount, 1); assert.equal(speech.sessions, 1); assert.equal(speech.calls, 1); assert.equal(speech.callMs, 4300);
  assert.equal(speech.generatedMs, 1000); assert.equal(speech.played, 0);
  assert.ok(result.tasks.some(t => t.label.startsWith('第 3 句')));
  assert.equal(result.insights.some(i => i.code === 'playback_unobserved'), false);
});

test('source references connect a sentence with batches without fabricating a single-sentence batch label', () => {
  const result = overview(capture([
    ['t', 'translation.execute', 100, 200, { attributes: { segment_id: 'sentence', segment_sequence: 8 } }],
    ['k', 'relation.execute', 300, 500, { events: [['source_linked', 310, { segment_id: 'sentence', segment_sequence: 8 }],
      ['source_linked', 320, { segment_id: 'other', segment_sequence: 9 }], ['checkpoint_committed', 490, { accepted_count: 0, rejected_count: 2 }]] }]
  ]));
  const related = result.tasks.filter(task => task.segments.includes('sentence'));
  assert.equal(related.length, 2); assert.equal(related.find(t => t.domain === 'relation').sequence, undefined);
  assert.ok(result.insights.some(i => i.code === 'results_rejected'));
  assert.equal(result.domains.find(d => d.key === 'relation').rejected, 2);
});

test('corrupt capture never gains invented live state or zero-result success', () => {
  const events = capture([['r', 'relation.execute', 100, null]]);
  const input = events.map(e => `execution_trace ${JSON.stringify(e)}`).join('\n') + '\nexecution_trace {broken';
  const result = buildBusinessOverview(buildTraceReport(parseTraceInput(input)), 'record');
  assert.equal(result.quality, 'incomplete'); assert.equal(result.tasks[0].state, 'unknown');
  assert.equal(result.domains.find(d => d.key === 'relation').accepted, undefined);
  assert.equal(result.domains.find(d => d.key === 'translation').observed, false);
});

test('legacy reports are re-aggregated from safe events and supplied analysis is never trusted', () => {
  const source = report(capture([['r', 'translation.execute', 100, 200]]));
  const json = JSON.stringify({ format: 'hearwise-trace-report/v1', current: source, overviews: { malicious: 'PRIVATE_PAYLOAD' } });
  const result = buildBusinessOverview(buildTraceReport(parseTraceInput(json)), 'record');
  assert.equal(result.tasks.length, 1); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PAYLOAD/);
});
