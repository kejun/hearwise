import { safeAttributes } from "../runtime/diagnostics.js";
import type { BuildMetadata, TraceEvent } from "../../shared/diagnostics.js";

const steps = new Set(["knowledge.execute", "knowledge.extract", "knowledge.repair", "knowledge.http"]);
const states = new Set(["running", "event", "succeeded", "failed", "cancelled"]);
const eventNames = new Set(["checkpoint_reserved", "checkpoint_committed", "response_headers", "response_received",
  "cancel_requested", "validation_completed", "continuation", "slot_released"]);
const id = (value: unknown): value is string => typeof value === "string" && /^[\w:/.\-]{1,128}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
type Json = Record<string, any>;
export interface TraceCapture {
  events: TraceEvent[];
  issues: string[];
  ignoredLines: number;
  declaredComplete: boolean;
  source: "snapshot" | "jsonl" | "report";
}

function cleanEvent(raw: Json): TraceEvent | undefined {
  if (!raw || raw.schema_version !== 1 || !id(raw.event_id) || !id(raw.process_id) || !id(raw.trace_id) || !id(raw.span_id) ||
    !steps.has(raw.step_key) || !states.has(raw.state) || !count(raw.sequence) || raw.sequence < 1 ||
    typeof raw.timestamp_ms !== "number" || !Number.isFinite(raw.timestamp_ms) || raw.timestamp_ms < 0 ||
    (raw.parent_span_id !== undefined && !id(raw.parent_span_id)) || !raw.build ||
    !/^(?:[a-f0-9]{7,40}|unknown)$/.test(raw.build.git_sha) || typeof raw.build.build_dirty !== "boolean" ||
    !count(raw.build.instrumentation_version)) return;
  if (raw.state === "event" && !eventNames.has(raw.event)) return;
  if (raw.duration_ms !== undefined && (typeof raw.duration_ms !== "number" || !Number.isFinite(raw.duration_ms) || raw.duration_ms < 0)) return;
  const errorCode = typeof raw.error_code === "string" && /^(HTTP_[1-5][0-9]{2}|KNOWLEDGE_INVALID_RESPONSE|REQUEST_TIMEOUT|UNCLASSIFIED_FAILURE)$/.test(raw.error_code)
    ? raw.error_code : undefined;
  return { schema_version: 1, event_id: raw.event_id, sequence: raw.sequence, process_id: raw.process_id,
    trace_id: raw.trace_id, span_id: raw.span_id, step_key: raw.step_key, timestamp_ms: raw.timestamp_ms,
    state: raw.state, build: { git_sha: raw.build.git_sha, build_dirty: raw.build.build_dirty,
      instrumentation_version: raw.build.instrumentation_version },
    ...(raw.parent_span_id ? { parent_span_id: raw.parent_span_id } : {}),
    ...(raw.state === "event" ? { event: raw.event } : {}),
    ...(raw.duration_ms !== undefined ? { duration_ms: raw.duration_ms } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    attributes: safeAttributes(raw.attributes && typeof raw.attributes === "object" ? raw.attributes : {}) };
}

// Import only explicit trace records. Ordinary server logs and arbitrary error text never enter the report.
export function parseTraceInput(text: string): TraceCapture {
  if (Buffer.byteLength(text) > 20 * 1024 * 1024) throw new Error("Trace input exceeds 20 MiB");
  const capture: TraceCapture = { events: [], issues: [], ignoredLines: 0, declaredComplete: false, source: "jsonl" };
  const issues = new Set<string>();
  const add = (raw: Json) => {
    if (capture.events.length >= 10000) { issues.add("event_limit"); return; }
    const event = cleanEvent(raw);
    if (event) capture.events.push(event); else issues.add("invalid_event");
  };
  let document: Json | undefined;
  try { document = JSON.parse(text); } catch { /* Mixed stdout / JSONL is supported. */ }
  if (document?.format === "hearwise-trace-report/v1" && Array.isArray(document.current?.spans)) {
    capture.source = "report";
    capture.declaredComplete = document.current.completeness === "complete";
    if (document.current.completeness === "incomplete") issues.add("source_incomplete");
    for (const span of document.current.spans) {
      if (!Array.isArray(span?.events)) { issues.add("invalid_event"); continue; }
      for (const raw of span.events) add(raw);
    }
  } else if (document && Array.isArray(document.events)) {
    capture.source = "snapshot";
    capture.declaredComplete = document.schema_version === 1 && document.enabled === true && document.complete === true &&
      document.capture === "bounded_process_buffer" && document.dropped_events === 0 && document.active_spans === 0;
    if (document.dropped_events > 0) issues.add("buffer_truncated");
    if (document.enabled !== true) issues.add("capture_disabled");
    if (document.active_spans > 0) issues.add("unfinished_spans");
    for (const raw of document.events) {
      if (raw?.process_id !== document.process_id) issues.add("snapshot_process_mismatch");
      add(raw);
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (!value) continue;
      const marked = value.startsWith("execution_trace ");
      try {
        const raw = JSON.parse(marked ? value.slice(16) : value);
        if (marked || (raw && raw.schema_version !== undefined && raw.span_id !== undefined)) add(raw);
        else capture.ignoredLines++;
      } catch { if (marked) issues.add("malformed_trace_line"); else capture.ignoredLines++; }
    }
  }
  if (!capture.events.length) issues.add("no_events");
  capture.issues = [...issues];
  return capture;
}

export interface ReportSpan {
  id: string; parent?: string; children: string[]; step: string; path: string;
  listening: string; job: string; process: string; trace: string; attempt?: number;
  state: string; ownState: string; start?: number; duration?: number;
  events: TraceEvent[]; issues: string[];
}
export interface TraceReport {
  schema_version: 1; coverage: string[]; builds: BuildMetadata[];
  completeness: "complete" | "incomplete" | "unknown"; issues: string[];
  ignoredLines: number; eventCount: number; spans: ReportSpan[]; roots: string[];
}
const spanId = (e: TraceEvent, span = e.span_id) => JSON.stringify([e.process_id, e.trace_id, span]);

export function buildTraceReport(capture: TraceCapture): TraceReport {
  const issues = new Set(capture.issues), spans = new Map<string, ReportSpan>(), sequences = new Map<string, Map<number, TraceEvent>>();
  const eventIds = new Map<string, string>(), builds = new Map<string, BuildMetadata>();
  for (const event of capture.events) {
    const signature = JSON.stringify(event), previous = eventIds.get(event.event_id);
    if (previous) { if (previous !== signature) issues.add("conflicting_duplicate"); continue; }
    eventIds.set(event.event_id, signature);
    const process = sequences.get(event.process_id) ?? new Map<number, TraceEvent>();
    if (process.has(event.sequence)) { issues.add("conflicting_sequence"); continue; }
    process.set(event.sequence, event); sequences.set(event.process_id, process);
    builds.set(JSON.stringify(event.build), event.build);
    const key = spanId(event), parent = event.parent_span_id ? spanId(event, event.parent_span_id) : undefined;
    let span = spans.get(key);
    if (!span) {
      span = { id: key, parent, children: [], step: event.step_key, path: event.step_key,
        listening: String(event.attributes.listening_id ?? "unknown"), job: String(event.attributes.job_id ?? "unknown"),
        process: event.process_id, trace: event.trace_id, attempt: Number(event.attributes.attempt) || undefined,
        state: "unknown", ownState: "unknown", events: [], issues: [] };
      spans.set(key, span);
    }
    if (span.parent !== parent || span.step !== event.step_key || span.listening !== String(event.attributes.listening_id ?? "unknown") ||
      span.job !== String(event.attributes.job_id ?? "unknown")) span.issues.push("conflicting_span");
    span.events.push(event);
  }
  for (const process of sequences.values()) {
    const ordered = [...process.keys()].sort((a, b) => a - b);
    if (ordered[0] !== 1 || ordered.some((seq, i) => i > 0 && seq !== ordered[i - 1]! + 1)) issues.add("sequence_gap");
  }
  if (builds.size > 1) issues.add("mixed_builds");
  for (const span of spans.values()) {
    span.events.sort((a, b) => a.sequence - b.sequence);
    const starts = span.events.filter(e => e.state === "running");
    const ends = span.events.filter(e => ["succeeded", "failed", "cancelled"].includes(e.state));
    const end = ends.at(-1);
    span.start = starts[0]?.timestamp_ms;
    span.duration = end?.duration_ms;
    span.ownState = end?.state ?? "unknown";
    if (end?.attributes.outcome === "partial" && span.ownState === "succeeded") span.ownState = "partial";
    if (end?.attributes.outcome === "invalid" && span.ownState === "succeeded") span.ownState = "failed";
    if (end?.attributes.outcome === "continue" && span.ownState === "succeeded") span.ownState = "waiting";
    if (starts.length !== 1 || ends.length !== 1 || (end && starts[0] && end.sequence < starts[0].sequence)) span.issues.push("span_boundary_missing_or_invalid");
    if (end && span.events.at(-1) !== end) span.issues.push("event_after_span_end");
    // Build hierarchy from explicit parent IDs only. Never infer dependencies from timestamps.
    const ancestors = new Set([span.id]); let parent = span.parent;
    const path = [span.step];
    while (parent) {
      const item = spans.get(parent);
      if (!item) { span.issues.push("missing_parent"); span.parent = undefined; break; }
      if (ancestors.has(parent) || ancestors.size >= 64) { span.issues.push("invalid_parent_chain"); span.parent = undefined; break; }
      if (item.listening !== span.listening || item.job !== span.job) { span.issues.push("parent_owner_mismatch"); span.parent = undefined; break; }
      ancestors.add(parent); path.unshift(item.step); parent = item.parent;
    }
    span.path = path.join(" → ");
    for (const issue of span.issues) issues.add(issue);
  }
  for (const span of spans.values()) if (span.parent) spans.get(span.parent)!.children.push(span.id);
  const roots = [...spans.values()].filter(s => !s.parent);
  const summarize = (span: ReportSpan): string => {
    const children = span.children.map(key => summarize(spans.get(key)!));
    span.state = span.ownState;
    if (span.ownState === "succeeded") {
      if (children.some(s => s === "unknown")) span.state = "unknown";
      else if (children.some(s => s === "waiting")) span.state = "waiting";
      else if (children.some(s => s === "partial")) span.state = "partial";
      else if (children.some(s => ["failed", "recovered", "cancelled"].includes(s))) span.state = "recovered";
    }
    if (span.issues.length && span.state === "succeeded") span.state = "unknown";
    return span.state;
  };
  for (const root of roots) summarize(root);
  return { schema_version: 1, coverage: [...steps], builds: [...builds.values()],
    completeness: issues.size ? "incomplete" : capture.declaredComplete ? "complete" : "unknown",
    issues: [...issues], ignoredLines: capture.ignoredLines, eventCount: [...spans.values()].reduce((sum, s) => sum + s.events.length, 0),
    spans: [...spans.values()], roots: roots.map(s => s.id) };
}

// Aggregate comparison deliberately does not claim same-input equivalence or causal regressions.
// Random job/trace/span IDs do not participate in the matching key.
export function compareTraceReports(current: TraceReport, baseline: TraceReport) {
  const aggregate = (report: TraceReport) => {
    const result = new Map<string, { count: number; states: Record<string, number>; ids: string[] }>();
    for (const span of report.spans) {
      const row = result.get(span.path) ?? { count: 0, states: {}, ids: [] };
      row.count++; row.states[span.state] = (row.states[span.state] ?? 0) + 1; row.ids.push(span.id); result.set(span.path, row);
    }
    return result;
  };
  const now = aggregate(current), before = aggregate(baseline);
  const instrumentationCompatible = current.builds.length === 1 && baseline.builds.length === 1 &&
    current.builds[0]!.instrumentation_version === baseline.builds[0]!.instrumentation_version;
  return { mode: "observed_aggregate" as const, instrumentationCompatible,
    warning: "仅比较已观测的步骤与状态；输入、模型、提示词和配置未证明相同，不判定代码回归。未观测不等于未执行。",
    rows: [...new Set([...now.keys(), ...before.keys()])].sort().map(path => {
      const current = now.get(path) ?? { count: 0, states: {}, ids: [] };
      const baseline = before.get(path) ?? { count: 0, states: {}, ids: [] };
      const changed = current.count !== baseline.count || [...new Set([...Object.keys(current.states), ...Object.keys(baseline.states)])]
        .some(state => current.states[state] !== baseline.states[state]);
      return { path, current, baseline, changed };
    }) };
}
