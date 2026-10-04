export type CancelReason = "listening_deleted" | "application_shutdown" | "superseded";
export type StepKey = "knowledge.execute" | "knowledge.extract" | "knowledge.repair" | "knowledge.http";
export type TraceState = "running" | "event" | "succeeded" | "failed" | "cancelled";
export interface TaskMetadata {
  listening_id: string;
  job_id: string;
  attempt?: number;
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
