export type CancelReason = "listening_deleted" | "application_shutdown" | "superseded" | "consumer_closed" | "user_cancelled";
export const TRACE_STEPS = ["knowledge.execute", "knowledge.extract", "knowledge.repair", "knowledge.http",
  "translation.execute", "translation.preview", "translation.phrase", "translation.check", "translation.http",
  "relation.execute", "relation.extract", "relation.http", "relation.validate", "relation.commit",
  "speech.session", "speech.unit", "speech.synthesize", "speech.attempt", "speech.connect", "speech.stream", "speech.http",
  "recognition.session"] as const;
export type StepKey = typeof TRACE_STEPS[number];
export const TRACE_EVENTS = ["checkpoint_reserved", "checkpoint_committed", "response_headers", "response_received",
  "cancel_requested", "validation_completed", "continuation", "slot_released", "admitted", "provider_started",
  "translation_committed", "notification_sent", "passthrough", "discarded", "retry_scheduled",
  "first_pcm", "pcm_sent", "browser_consumed", "playback_completed", "paused", "resumed", "draining",
  "waiting_translation", "connection_reused", "request_started", "source_committed"] as const;
export const TRACE_ERRORS = ["KNOWLEDGE_INVALID_RESPONSE", "RELATION_INVALID_RESPONSE", "RELATION_OUTPUT_LIMIT",
  "TRANSLATION_EMPTY", "TRANSLATION_BUSY", "REQUEST_TIMEOUT", "UNCLASSIFIED_FAILURE", "ASR_FAILED", "SPEECH_FAILED",
  "FISH_HTTP_ERROR", "FISH_AUDIO_FORMAT", "FISH_AUDIO_INCOMPLETE", "FISH_RESPONSE_TIMEOUT", "FISH_GENERATION_TIMEOUT", "FISH_NETWORK_ERROR"] as const;
export type TraceState = "running" | "event" | "succeeded" | "failed" | "cancelled";
export interface TaskMetadata {
  listening_id?: string;
  job_id: string;
  attempt?: number;
  run_id?: string;
  segment_id?: string;
  consumer_id?: string;
  unit_id?: number;
  provider?: string;
  kind?: string;
}
export interface BuildMetadata { git_sha: string; build_dirty: boolean; instrumentation_version: number }
export interface TraceEvent {
  build: BuildMetadata;
  schema_version: 1;
  event_id: string;
  sequence: number;
  process_id: string;
  timestamp_ms: number;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  step_key: string;
  state: TraceState;
  event?: string;
  duration_ms?: number;
  error_code?: string;
  attributes: Record<string, string | number | boolean>;
}
export class TaskCancelled extends Error {
  readonly name = "TaskCancelled";
  readonly code = "TASK_CANCELLED";
  constructor(readonly reason: CancelReason) { super(reason); }
}
