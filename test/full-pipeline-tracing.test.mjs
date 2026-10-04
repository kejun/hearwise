import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRuntime, parseTraceInput, buildTraceReport, buildBusinessOverview } from '../dist/server/index.js';
import { fullTraceFixture, traceEvents } from '../test-support/full-trace-fixture.mjs';
import { FishTts } from '../fish-tts.mjs';

test('default application tracing covers recognition, all text workflows, Qwen/Fish synthesis and client playback', { timeout: 25000 }, async () => {
  const logs = await fullTraceFixture(), events = traceEvents(logs);
  const report = buildTraceReport(parseTraceInput(logs));
  for (const step of ['recognition.session', 'translation.execute', 'translation.preview', 'translation.http',
    'knowledge.execute', 'knowledge.http', 'relation.execute', 'relation.extract', 'relation.http', 'relation.validate', 'relation.commit',
    'speech.session', 'speech.unit', 'speech.synthesize', 'speech.attempt', 'speech.connect', 'speech.stream', 'speech.http']) {
    assert.ok(events.some(e => e.step_key === step && e.state === 'succeeded'), step);
  }
  assert.equal(report.completeness, 'unknown'); // stdout has no capture-end manifest
  assert.deepEqual(report.issues, []);
  assert.doesNotMatch(JSON.stringify(report), /TRACE_SECRET_KEY|PRIVATE_TRACE_TRANSCRIPT|PRIVATE_PREVIEW_TEXT|本轮真实适配器/);
  const unit = report.spans.find(s => s.step === 'speech.unit' && s.events[0].attributes.provider === 'qwen');
  const attrs = unit.events[0].attributes;
  const translation = report.spans.find(s => s.step === 'translation.execute' && s.events[0].attributes.segment_id === attrs.segment_id);
  assert.equal(translation.listening, unit.listening);
  assert.equal(translation.events[0].attributes.run_id, attrs.run_id);
  const milestones = unit.events.filter(e => e.state === 'event').map(e => e.event);
  assert.deepEqual(milestones, ['pcm_sent', 'browser_consumed', 'playback_completed']);
  const generated = report.spans.find(s => s.parent === unit.id && s.step === 'speech.synthesize');
  assert.equal(generated.events.filter(e => e.event === 'first_pcm').length, 1);
  assert.ok(generated.events.at(-1).sequence < unit.events.find(e => e.event === 'playback_completed').sequence);
  const relation = report.spans.find(s => s.step === 'relation.execute');
  assert.ok(relation.events.some(e => e.event === 'checkpoint_reserved'));
  assert.ok(relation.events.some(e => e.event === 'checkpoint_committed'));
  const business = buildBusinessOverview(report, unit.listening);
  assert.ok(business.domains.every(d => d.observed));
  assert.equal(business.domains.find(d => d.key === 'translation').calls, 1);
  assert.equal(business.domains.find(d => d.key === 'relation').calls, 1);
  assert.equal(business.domains.find(d => d.key === 'speech').calls, 3);
  assert.ok(business.tasks.find(t => t.domain === 'translation').sequence > 0);
  assert.ok(business.tasks.some(t => t.domain === 'knowledge' && t.segments.includes(attrs.segment_id)));
  assert.ok(business.domains.find(d => d.key === 'speech').generatedMs > 0);
  assert.doesNotMatch(JSON.stringify(business), /TRACE_SECRET_KEY|PRIVATE_/);
});

test('default runtime traces, preserves external AbortError, and closes lifecycle scopes exactly once', async () => {
  const runtime = createTaskRuntime();
  const controller = new AbortController(), reason = new DOMException('superseded phrase', 'AbortError');
  const pending = runtime.run('translation.phrase', { listening_id: 'a', job_id: 'b' }, () => new Promise(() => {}), controller.signal);
  controller.abort(reason); await assert.rejects(pending, error => error === reason);
  const open = runtime.open('speech.session', { listening_id: 'a', job_id: 'session' });
  open.succeed(); open.fail(new Error('late failure')); open.cancel('consumer_closed'); await open.promise;
  assert.equal(runtime.diagnostics().enabled, true);
  assert.equal(runtime.diagnostics().events.filter(e => e.step_key === 'speech.session' && e.state === 'succeeded').length, 1);
  const other = runtime.open('speech.unit', { listening_id: 'other', job_id: 'other' });
  const deleted = runtime.open('translation.execute', { listening_id: 'a', job_id: 'deleted' });
  runtime.cancelListening('a'); await assert.rejects(deleted.promise, error => error.reason === 'listening_deleted');
  assert.equal(runtime.activeCount, 1); other.cancel('user_cancelled'); await other.promise.catch(() => {});
  await runtime.dispose();
});

test('Fish retries retain failed attempt and never retry after PCM escapes with tracing enabled', async () => {
  for (const failAfterAudio of [false, true]) {
    const runtime = createTaskRuntime(); let requests = 0, pcm = 0;
    const tts = new FishTts({ key: 'PRIVATE_KEY', model: 's2.1-pro-free', referenceId: 'voice', rate: 1 }, {
      fetchImpl: async () => {
        requests++;
        if (!failAfterAudio && requests === 1) throw new TypeError('PRIVATE_PROVIDER_ERROR');
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/pcm' }), body: (async function*() {
          yield Buffer.alloc(20); if (failAfterAudio) throw new TypeError('PRIVATE_PROVIDER_ERROR');
        })() };
      }
    });
    try {
      const call = runtime.run('speech.synthesize', { job_id: 'unit' }, context => tts.synthesize('PRIVATE_TEXT', () => { pcm++; }, context));
      if (failAfterAudio) await assert.rejects(call); else await call;
      assert.equal(requests, failAfterAudio ? 1 : 2); assert.equal(pcm, 1);
      const result = buildTraceReport(parseTraceInput(JSON.stringify(runtime.diagnostics())));
      const attempts = result.spans.filter(s => s.step === 'speech.http');
      assert.equal(attempts.length, requests);
      assert.equal(attempts[0].ownState, 'failed');
      assert.equal(result.spans.find(s => s.step === 'speech.synthesize').state, failAfterAudio ? 'failed' : 'recovered');
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
    } finally { tts.close(); await runtime.dispose(); }
  }
});
