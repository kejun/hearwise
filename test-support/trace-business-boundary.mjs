import assert from 'node:assert/strict';
import { fullTraceFixture } from './full-trace-fixture.mjs';
import { traceReport } from './trace-business-fixture.mjs';
import { buildBusinessOverview } from '../dist/server/index.js';

export async function runFullTraceComparison() {
  const actual = await fullTraceFixture({ observations: true });
  const report = traceReport(actual.logs), business = buildBusinessOverview(report, actual.listeningId);
  assert.equal(report.completeness, 'unknown', 'A stdout capture has no end manifest, even if all queried work settled');
  assert.deepEqual(report.issues, []); assert.equal(actual.cleanup, true);
  assert.doesNotMatch(JSON.stringify(report), /TRACE_SECRET_KEY|PRIVATE_TRACE_TRANSCRIPT|PRIVATE_PREVIEW_TEXT/);
  const byDomain = name => business.tasks.filter(task => task.domain === name);
  const translated = actual.durable.segments.filter(row => row.run_id === actual.runId);
  assert.equal(translated.length, 1); assert.equal(translated[0].translation_state, 'complete');
  const translation = byDomain('translation');
  assert.equal(translation.length, 1); assert.equal(translation[0].job, translated[0].id);
  assert.equal(translation[0].state, 'succeeded'); assert.equal(translation[0].calls, 1);
  assert.deepEqual(translation[0].segments, [translated[0].id]);
  assert.ok(actual.asrEvents.some(event => event.type === 'translation-updated' && event.segment.id === translated[0].id &&
    event.segment.translation_text === translated[0].translation_text));
  const knowledge = byDomain('knowledge'), jobs = actual.durable.extraction_jobs.filter(job => job.id !== actual.seededJobId);
  assert.equal(jobs.length, 1); assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].job, jobs[0].id); assert.equal(jobs[0].state, 'complete'); assert.equal(jobs[0].outcome, 'empty');
  assert.equal(knowledge[0].state, 'succeeded'); assert.match(knowledge[0].activity, /结果为空/);
  const relations = byDomain('relation');
  assert.ok(relations.length >= 1); assert.equal(relations.length, actual.durable.relation_jobs.length);
  for (const task of relations) {
    const job = actual.durable.relation_jobs.find(row => row.id === task.job);
    assert.equal(job.state, 'complete'); assert.equal(task.state, 'succeeded'); assert.equal(task.calls, job.request_count);
  }
  assert.equal(actual.graph.status.state, 'empty'); assert.equal(actual.graph.relations.length, 0);
  const speech = byDomain('speech'), sessions = speech.filter(task => task.session), units = speech.filter(task => !task.session);
  assert.equal(sessions.length, 2); assert.ok(units.length >= 2);
  for (const task of speech) assert.equal(task.state, 'succeeded');
  const ends = [...actual.speechEvents, ...actual.fishEvents].filter(event => event.type === 'speech.unit-end');
  assert.equal(units.length, ends.length); assert.equal(actual.provider.qwen + actual.provider.fish, units.length);
  assert.ok(ends.every(end => actual.frames.some(frame => frame.unit === end.unit && frame.epoch === end.epoch)));
  const events = report.spans.flatMap(span => span.events), played = events.filter(event => event.event === 'playback_completed');
  assert.equal(played.length, units.length); assert.ok(played.every(event => event.attributes.evidence_source === 'client_report'));
  assert.equal(new Set(played.map(event => event.span_id)).size, units.length);
  assert.equal(business.domains.find(row => row.key === 'speech').played, units.length);
  assert.equal(business.domains.find(row => row.key === 'speech').objectCount, units.length);
  assert.equal(report.spans.filter(span => ['translation.http', 'knowledge.http', 'relation.http'].includes(span.step)).length,
    actual.provider.mt + actual.provider.knowledge);
  const unowned = buildBusinessOverview(report, 'unknown');
  assert.equal(unowned.tasks.length, 1); assert.equal(unowned.tasks[0].domain, 'translation');
  assert.equal(unowned.tasks[0].purpose, '预览 / 试听');
  return { name: 'full-public-boundary', complete: true, ok: true, cleanup: true, actual, report, business, unowned };
}
