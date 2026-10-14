import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const performanceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function fileSha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
export async function performanceSourceSnapshot() {
  const git = args => execFileSync('git', ['-C', performanceRoot, ...args], { encoding: 'utf8', timeout: 10000 }).trim();
  const files = [...new Set([...git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean),
    'dist/server/index.js', 'public/vendor/cytoscape.js'])].sort(), sourceDigests = {};
  for (const file of files) {
    const info = await lstat(path.join(performanceRoot, file));
    if (info.isFile()) sourceDigests[file] = await fileSha256(path.join(performanceRoot, file));
  }
  const { createTaskRuntime } = await import(pathToFileURL(path.join(performanceRoot, 'dist/server/index.js')).href);
  const runtime = createTaskRuntime({ enabled: false }); let runtimeBuild;
  try { runtimeBuild = structuredClone(runtime.diagnostics().build); } finally { await runtime.dispose(); }
  return { source: { sha: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain', '--untracked-files=normal'])) }, sourceDigests, runtimeBuild };
}
async function optionalText(file) { try { return (await readFile(file, 'utf8')).trim(); } catch { return null; } }
export async function performanceEnvironment() {
  const cpuModels = {};
  for (const cpu of os.cpus()) cpuModels[cpu.model] = (cpuModels[cpu.model] || 0) + 1;
  return { label: process.env.PERFORMANCE_ENVIRONMENT_LABEL || (process.env.GITHUB_ACTIONS === 'true' ? 'github-actions-runner' : 'unclassified-cloud-runner'),
    userDeviceMeasurement: false, platform: process.platform, arch: process.arch, osRelease: os.release(), host: os.hostname(),
    node: process.version, sqlite: process.versions.sqlite, availableParallelism: os.availableParallelism(), cpuModels, totalMemoryBytes: os.totalmem(),
    cgroup: { cpuMax: await optionalText('/sys/fs/cgroup/cpu.max'), memoryMax: await optionalText('/sys/fs/cgroup/memory.max'), cpuset: await optionalText('/sys/fs/cgroup/cpuset.cpus.effective') } };
}
export const performanceConditions = () => ({ recordedAt: new Date().toISOString(), loadAverage: os.loadavg(), freeMemoryBytes: os.freemem() });
