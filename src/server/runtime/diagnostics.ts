import { randomUUID } from "node:crypto";
import { Cause, Exit, Option, Tracer } from "effect";
import type { BuildMetadata, TraceEvent, TraceState } from "../../shared/diagnostics.js";
import { TRACE_STEPS, TRACE_EVENTS, TRACE_ERRORS } from "../../shared/diagnostics.js";

declare const __BUILD_META__: BuildMetadata;
const allowed = new Set(["listening_id", "job_id", "attempt", "part_no", "request_count", "accepted_count",
  "rejected_count", "http_status", "phase", "outcome", "cancel_reason", "duration_ms", "run_id", "segment_id",
  "consumer_id", "unit_id", "provider", "kind", "queue_ms", "samples", "consumed_samples", "retry_at", "evidence_source"]);
const safeWords = new Set(["extract", "repair", "headers", "body", "ok", "empty", "partial", "invalid",
  "continue", "terminal", "failed", "discarded", "listening_deleted", "application_shutdown", "superseded",
  "consumer_closed", "user_cancelled", "qwen", "fish", "preview", "realtime", "background", "phrase", "remainder",
  "original", "translation", "replay", "live", "check", "client_report"]);
const identifiers = new Set(["job_id", "listening_id", "run_id", "segment_id", "consumer_id"]);
const names = new Set<string>(TRACE_EVENTS), errorCodes = new Set<string>(TRACE_ERRORS);
export function safeAttributes(values: ReadonlyMap<string, unknown> | Record<string, unknown>) {
  const result: Record<string, string | number | boolean> = {};
  const entries = values instanceof Map ? values.entries() : Object.entries(values);
  for (const [key, value] of entries) {
    if (!allowed.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (identifiers.has(key) && typeof value === "string" && /^[\w:/.-]{1,128}$/.test(value)) result[key] = value;
    else if (typeof value === "string" && safeWords.has(value)) result[key] = value;
  }
  return result;
}

export function createDiagnostics({ enabled = true, capacity = 2000, onEvent }: {
  enabled?: boolean; capacity?: number; onEvent?: (event: TraceEvent) => void;
} = {}) {
  const size = Math.min(10000, Math.max(1, Math.floor(Number.isFinite(capacity) ? capacity : 2000)));
  const processId = randomUUID(), events: TraceEvent[] = [], activeSpans = new Set<string>();
  let sequence = 0, dropped = 0, sinkErrors = 0, cursor = 0;
  function record(span: Tracer.Span, state: TraceState, extra: Partial<TraceEvent> = {}) {
    if (!enabled) return;
    const event: TraceEvent = { build: __BUILD_META__, schema_version: 1, event_id: randomUUID(), sequence: ++sequence,
      process_id: processId, timestamp_ms: Date.now(), trace_id: span.traceId, span_id: span.spanId,
      ...(Option.isSome(span.parent) ? { parent_span_id: span.parent.value.spanId } : {}),
      step_key: span.name, state, attributes: safeAttributes(span.attributes), ...extra };
    if (events.length < size) events.push(event);
    else { events[cursor] = event; cursor = (cursor + 1) % size; dropped++; }
    try { onEvent?.(structuredClone(event)); } catch { sinkErrors++; }
  }
  const tracer = Tracer.make({ span(options) {
    const span = new Tracer.NativeSpan(options);
    const end = span.end.bind(span);
    span.end = (at, exit) => {
      if (span.status._tag === "Ended") return;
      end(at, exit);
      activeSpans.delete(span.spanId);
      const state = Exit.isSuccess(exit) ? "succeeded" : Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "failed";
      let errorCode: string | undefined;
      if (Exit.isFailure(exit) && state === "failed") {
        const error = Cause.squash(exit.cause);
        if (error && typeof error === "object" && "status" in error && typeof error.status === "number" &&
          Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) errorCode = `HTTP_${error.status}`;
        else if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && errorCodes.has(error.code)) errorCode = error.code;
        else if (error && typeof error === "object" && "diagnostics" in error && error.diagnostics && typeof error.diagnostics === "object" &&
          "code" in error.diagnostics && typeof error.diagnostics.code === "string" && errorCodes.has(error.diagnostics.code)) errorCode = error.diagnostics.code;
        else if (error instanceof Error && error.name === "TimeoutError") errorCode = "REQUEST_TIMEOUT";
        else errorCode = "UNCLASSIFIED_FAILURE";
      }
      record(span, state, { duration_ms: Math.max(0, Number(at - options.startTime) / 1e6),
        ...(errorCode ? { error_code: errorCode } : {}) });
    };
    return span;
  } });
  return {
    tracer,
    started: (span: Tracer.Span) => { if (enabled) activeSpans.add(span.spanId); record(span, "running"); },
    event(span: Tracer.Span, name: string, attributes: Record<string, unknown> = {}) {
      if (names.has(name)) record(span, "event", { event: name,
        attributes: { ...safeAttributes(span.attributes), ...safeAttributes(attributes) } });
    },
    snapshot() {
      return { schema_version: 1 as const, build: __BUILD_META__, enabled, process_id: processId,
        complete: enabled && dropped === 0 && activeSpans.size === 0, active_spans: activeSpans.size,
        dropped_events: dropped, sink_errors: sinkErrors, sink_complete: enabled && sinkErrors === 0,
        coverage: [...TRACE_STEPS],
        capture: "bounded_process_buffer" as const,
        events: structuredClone(events.length < size || cursor === 0 ? events : [...events.slice(cursor), ...events.slice(0, cursor)]) };
    }
  };
}
