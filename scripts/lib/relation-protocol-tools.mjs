import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, access } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from './process.mjs';

export const protocolRoot = path.resolve('verification/relation-protocol');
export const quintCli = path.resolve('node_modules/@informalsystems/quint/dist/src/cli.js');
export const toolchain = JSON.parse(await readFile(path.join(protocolRoot, 'toolchain.json'), 'utf8'));
export const quintHome = path.resolve(process.env.QUINT_HOME || path.join(os.tmpdir(), 'hearwise-quint'));
const distribution = path.join(quintHome, toolchain.apalache.cacheRelativePath);
const archive = path.join(quintHome, `apalache-${toolchain.apalache.version}.tgz`);
const jar = path.join(distribution, 'lib/apalache.jar');

export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const exists = async file => { try { await access(file); return true; } catch { return false; } };

export async function setupProtocolTools() {
  await mkdir(quintHome, { recursive: true });
  if (!await exists(archive)) {
    const temporary = `${archive}.${process.pid}.download`;
    try {
      const response = await fetch(toolchain.apalache.url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw new Error(`Apalache download failed: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
      if (await fileDigest(temporary) !== toolchain.apalache.archiveSha256) throw new Error('Downloaded Apalache archive checksum mismatch');
      await rename(temporary, archive);
    } finally { await rm(temporary, { force: true }); }
  }
  if (await fileDigest(archive) !== toolchain.apalache.archiveSha256) throw new Error('Cached Apalache archive checksum mismatch; select a fresh QUINT_HOME');
  if (!await exists(jar)) {
    const staging = await mkdtemp(path.join(quintHome, 'unpack-'));
    try {
      const extraction = await runProcess('tar', ['-xzf', archive, '-C', staging], { timeoutMs: 60000 });
      if (!extraction.ok) throw new Error(`Apalache extraction failed: ${extraction.tail}`);
      if (await fileDigest(path.join(staging, 'apalache/lib/apalache.jar')) !== toolchain.apalache.jarSha256) throw new Error('Extracted Apalache JAR checksum mismatch');
      await mkdir(path.dirname(distribution), { recursive: true });
      await rename(path.join(staging, 'apalache'), distribution);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  return checkProtocolTools();
}

// Infrastructure startup is separate from each model's exploration budget.
// There is one attempt, with process-group cleanup and explicit timeout status.
export const JAVA_STARTUP_TIMEOUT_MS = 30000;
export async function probeJavaVersion({ command = 'java', args = ['-version'], timeoutMs = JAVA_STARTUP_TIMEOUT_MS, run = runProcess } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > JAVA_STARTUP_TIMEOUT_MS) throw new Error('Invalid Java startup deadline');
  const startedAt = new Date().toISOString();
  const result = await run(command, args, { timeoutMs });
  const execution = { command, args, timeoutMs, startedAt, finishedAt: new Date().toISOString(), ...result };
  const version = result.tail.match(/version\s+"(\d+)[^"]*"/);
  const code = result.timedOut ? 'JAVA_STARTUP_TIMEOUT' : !result.ok ? 'JAVA_STARTUP_FAILED' :
    !version || Number(version[1]) < toolchain.java.minimumMajor ? 'JAVA_VERSION_UNSUPPORTED' : null;
  if (code) {
    const reason = code === 'JAVA_STARTUP_TIMEOUT' ? 'Java startup probe timed out' : code === 'JAVA_STARTUP_FAILED' ?
      'Java startup probe failed' : `Java >=${toolchain.java.minimumMajor} is required`;
    throw Object.assign(new Error(`${reason}: ${JSON.stringify(execution)}`), { code, execution });
  }
  return { major: Number(version[1]), output: result.tail.trim(), execution };
}

export async function checkProtocolTools() {
  const installed = JSON.parse(await readFile('node_modules/@informalsystems/quint/package.json', 'utf8'));
  if (installed.version !== toolchain.quint.version) throw new Error(`Quint must be exactly ${toolchain.quint.version}; run npm ci --ignore-scripts`);
  if (await fileDigest(archive) !== toolchain.apalache.archiveSha256 || await fileDigest(jar) !== toolchain.apalache.jarSha256) throw new Error('Apalache archive/JAR does not match the pinned toolchain');
  const java = await probeJavaVersion();
  return { quint: installed.version, apalache: toolchain.apalache.version, tlc: toolchain.apalache.bundledTlcVersion,
    apalacheJarSha256: toolchain.apalache.jarSha256, apalacheArchiveSha256: toolchain.apalache.archiveSha256,
    java: java.output, javaProbe: java.execution, node: process.version, sqlite: process.versions.sqlite, quintHome };
}
