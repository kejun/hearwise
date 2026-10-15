const terminal = new Set(['succeeded', 'failed', 'cancelled']);

// SQLite completion and a successful child span can precede the task's return.
// Match every observed root attempt of every actual job, never an unrelated job.
export async function waitForTraceTasks(readEvents, readJobs, step, timeout = 12000) {
  const expires = Date.now() + timeout;
  while (true) {
    const jobs = readJobs(), events = readEvents();
    if (jobs.length && jobs.every(job => {
      const roots = events.filter(event => event.step_key === step && !event.parent_span_id &&
        event.attributes?.job_id === job.id && event.attributes?.listening_id === job.listening_id);
      const started = roots.filter(event => event.state === 'running');
      return started.length > 0 && started.every(start => roots.some(end => terminal.has(end.state) &&
        end.process_id === start.process_id && end.trace_id === start.trace_id && end.span_id === start.span_id));
    })) return;
    if (Date.now() >= expires) throw new Error(`Trace ${step} completion timed out`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
