import { Cause, Effect, Exit, Layer, ManagedRuntime, Tracer } from "effect";
import { TaskCancelled, type CancelReason, type StepKey, type TaskMetadata, type TraceEvent } from "../../shared/diagnostics.js";
import { createDiagnostics } from "./diagnostics.js";
import { randomUUID } from "node:crypto";

export interface ExecutionContext {
  readonly signal: AbortSignal;
  event(name: string, attributes?: Record<string, unknown>): void;
  step<A>(name: StepKey, operation: (context: ExecutionContext) => PromiseLike<A>, attributes?: Partial<TaskMetadata>): Promise<A>;
}
export interface TaskHandle<A> {
  readonly promise: Promise<A>;
  cancel(reason: CancelReason): void;
}
export function createTaskRuntime(options: { enabled?: boolean; capacity?: number; onEvent?: (event: TraceEvent) => void } = {}) {
  const diagnostics = createDiagnostics(options);
  const runtime = ManagedRuntime.make(Layer.succeed(Tracer.Tracer, diagnostics.tracer));
  // Build the resource-free layer synchronously so the legacy scheduler retains immediate admission.
  runtime.runSync(Effect.void);
  const tasks = new Map<string, TaskHandle<unknown>>();
  const owners = new Map<string, TaskMetadata>();
  let closed = false, disposing: Promise<void> | undefined;

  function execute<A>(name: StepKey, metadata: TaskMetadata, operation: (context: ExecutionContext) => PromiseLike<A>,
    signal: AbortSignal, parent?: Tracer.AnySpan): Effect.Effect<A, unknown> {
    const effect = Effect.gen(function*() {
      const span = yield* Effect.currentSpan;
      diagnostics.started(span);
      const children = yield* Effect.acquireRelease(Effect.sync(() => new AbortController()),
        children => Effect.sync(() => children.abort(new TaskCancelled("superseded"))));
      const scopedSignal = AbortSignal.any([signal, children.signal]);
      yield* Effect.acquireRelease(Effect.sync(() => {
        const aborted = () => {
          const reason = signal.reason instanceof TaskCancelled ? signal.reason.reason : "superseded";
          span.attribute("cancel_reason", reason);
          diagnostics.event(span, "cancel_requested", { cancel_reason: reason });
        };
        signal.addEventListener("abort", aborted, { once: true });
        return aborted;
      }), aborted => Effect.sync(() => signal.removeEventListener("abort", aborted)));
      const context: ExecutionContext = {
        signal: scopedSignal,
        event: (event, attributes) => { if (!scopedSignal.aborted) diagnostics.event(span, event, attributes); },
        step: (childName, child, attributes) => {
          scopedSignal.throwIfAborted();
          return runtime.runPromiseExit(execute(childName, { ...metadata, ...attributes }, child, scopedSignal, span), { signal: scopedSignal })
            .then(exit => {
              if (Exit.isSuccess(exit)) return exit.value;
              if (scopedSignal.aborted) throw scopedSignal.reason;
              throw Cause.squash(exit.cause);
            });
        }
      };
      const value = yield* Effect.tryPromise({ try: () => {
        scopedSignal.throwIfAborted();
        return Promise.resolve(operation(context));
      }, catch: (error: unknown) => error });
      if (value && typeof value === "object") {
        if ("outcome" in value && value.outcome !== undefined) span.attribute("outcome", value.outcome);
        else if ("kind" in value) span.attribute("outcome", value.kind);
      }
      return value;
    }).pipe(Effect.scoped, Effect.withSpan(name, { attributes: { ...metadata } }));
    return parent ? effect.pipe(Effect.provideService(Tracer.ParentSpan, parent)) : effect;
  }
  function startNamed<A>(name: StepKey, identity: string, metadata: TaskMetadata, operation: (context: ExecutionContext) => PromiseLike<A>, signal?: AbortSignal): TaskHandle<A> {
    if (closed) throw new Error("Task runtime is closed");
    if (tasks.has(identity)) throw new Error("Task identity already running");
    const controller = new AbortController();
    // Preserve the caller's cancellation identity (legacy phrase logic tests AbortError).
    const aborted = () => controller.abort(signal?.reason ?? new TaskCancelled("superseded"));
    if (signal?.aborted) aborted(); else signal?.addEventListener("abort", aborted, { once: true });
    let resolve!: (result: A) => void, reject!: (error: unknown) => void;
    const promise = new Promise<A>((yes, no) => { resolve = yes; reject = no; });
    // A caller may cancel synchronously before attaching its await/catch.
    void promise.catch(() => {});
    const handle: TaskHandle<A> = {
      promise,
      cancel(reason) { if (!controller.signal.aborted) controller.abort(new TaskCancelled(reason)); }
    };
    tasks.set(identity, handle);
    owners.set(identity, metadata);
    runtime.runCallback(execute(name, metadata, operation, controller.signal), {
      signal: controller.signal,
      onExit: exit => {
        signal?.removeEventListener("abort", aborted);
        if (tasks.get(identity) === handle) { tasks.delete(identity); owners.delete(identity); }
        if (controller.signal.aborted) reject(controller.signal.reason);
        else if (Exit.isSuccess(exit)) resolve(exit.value);
        else reject(Cause.squash(exit.cause));
      }
    });
    return handle;
  }
  return {
    start: <A>(identity: string, metadata: TaskMetadata, operation: (context: ExecutionContext) => PromiseLike<A>) => startNamed("knowledge.execute", identity, metadata, operation),
    run: <A>(name: StepKey, metadata: TaskMetadata, operation: (context: ExecutionContext) => PromiseLike<A>, signal?: AbortSignal) =>
      startNamed(name, randomUUID(), metadata, operation, signal).promise,
    open(name: StepKey, metadata: TaskMetadata) {
      let context!: ExecutionContext, succeed!: (value?: unknown) => void, fail!: (error: unknown) => void;
      const handle = startNamed(name, randomUUID(), metadata, current => {
        context = current;
        return new Promise((resolve, reject) => { succeed = resolve; fail = reject; });
      });
      let settled = false;
      return { context, promise: handle.promise,
        succeed(value?: unknown) { if (!settled) { settled = true; succeed(value); } },
        fail(error: unknown) { if (!settled) { settled = true; fail(error); } },
        cancel(reason: CancelReason) { if (!settled) { settled = true; handle.cancel(reason); } } };
    },
    cancelListening(id: string, reason: CancelReason = "listening_deleted") {
      for (const [identity, metadata] of owners) if (metadata.listening_id === id) tasks.get(identity)?.cancel(reason);
    },
    get activeCount() { return tasks.size; },
    diagnostics: diagnostics.snapshot,
    dispose(): Promise<void> {
      if (disposing) return disposing;
      closed = true;
      const active = [...tasks.values()];
      for (const task of active) task.cancel("application_shutdown");
      disposing = Promise.allSettled(active.map(task => task.promise)).then(() => runtime.dispose());
      return disposing;
    }
  };
}
