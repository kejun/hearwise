import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.mjs';
import { digest, writeJson } from './verification-evidence.mjs';
import { nameConfig, nameProtocolPlan, nameTracePaths, nameTraceMain, nameConfiguration, nameNegatives, validateNameReplay } from './name-protocol-evidence.mjs';
import { normalizeNameTrace, replayNameTrace } from './name-protocol-replay.mjs';

export const runNameProtocolCommand = async (invocation, logFile) => {
  const env = { ...process.env, ...invocation.environment }; delete env.NODE_TEST_CONTEXT;
  await mkdir(env.TMPDIR, { recursive: true });
  const result = await runProcess(invocation.command, invocation.argv, { cwd: invocation.cwd, env, timeoutMs: invocation.timeoutMs, graceMs: invocation.graceMs, logFile });
  try { await rm(env.TMPDIR, { recursive: true, force: true }); result.cleanupComplete = true; }
  catch (error) { result.cleanupComplete = false; result.error = `Temporary resource cleanup failed: ${error.message}`; }
  return result;
};
// Each actual replay runs inside the existing process-group runner. The outer
// deadline can terminate adapters and HTTP/SQLite grandchildren, not just await
// an unbounded Promise in the report process.
async function replayCommand(directory, id) {
  const config = await nameConfig(), stage = nameProtocolPlan(config).find(row => row.id === id);
  if (!stage || !['implementation-replay', 'implementation-negative'].includes(stage.kind)) throw new Error('Unknown name replay stage');
  const { createNameProtocolAdapter } = await import('../../test-support/name-protocol-adapter.mjs');
  const traces = nameTracePaths(stage, config), values = [];
  const negative = stage.kind === 'implementation-negative' ? nameNegatives.find(row => id.endsWith(row.mutation)) : null;
  for (const file of traces) {
    const bytes = await readFile(path.join(directory, file), 'utf8');
    const trace = normalizeNameTrace(JSON.parse(bytes), nameConfiguration(nameTraceMain(file), config));
    const replay = await replayNameTrace(trace, options => createNameProtocolAdapter({ ...options, mutation: negative?.mutation || 'none' }));
    const value = { ...replay, sourceTrace: file, sourceTraceSha256: digest(bytes), semanticTraceSha256: digest(JSON.stringify(trace)), config: trace.config, steps: trace.steps.length };
    values.push(value);
    await writeJson(path.join(directory, `${id}.json`), values);
    if (!validateNameReplay(value, trace, file, bytes, { negative })) throw new Error(`Name replay failed: ${file}: ${JSON.stringify(replay.error || replay.difference || replay)}`);
  }
  const data = await readFile(path.join(directory, `${id}.json`), 'utf8');
  console.log(`NAME_REPLAY_COMPLETE ${JSON.stringify({ id, traces, samples: values.length, steps: values.reduce((sum, value) => sum + value.steps, 0), dataSha256: digest(data) })}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, id, ...extra] = process.argv.slice(2);
  if (!directory || !id || extra.length) throw new Error('Usage: name-protocol-command.mjs EVIDENCE_DIRECTORY REPLAY_STAGE');
  await replayCommand(path.resolve(directory), id);
}
