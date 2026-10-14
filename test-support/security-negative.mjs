import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '../scripts/lib/verification-evidence.mjs';
import { securityFixture, SECURITY_KEY, credentialFindings } from './security-fixture.mjs';

export async function credentialImplementationNegative() {
  const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-security-mutant-'));
  let fixture;
  const anchor = 'if (!response.ok) throw Object.assign(new Error(`翻译服务 HTTP ${response.status}`), { status: response.status });';
  const replacement = 'if (!response.ok) throw Object.assign(new Error(result.error?.message || `翻译服务 HTTP ${response.status}`), { status: response.status });';
  try {
    // An isolated runtime copy, not a second checkout. Only public source and
    // generated build assets are copied; no .git, env, user data, or credentials.
    for (const entry of await readdir('.', { withFileTypes: true })) if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name === 'package.json')) await cp(entry.name, path.join(directory, entry.name));
    for (const name of ['public', 'dist', 'docs']) await cp(name, path.join(directory, name), { recursive: true });
    // Use this checkout's already verified lockfile install without modifying it.
    await symlink(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'dir');
    const source = await readFile('server.mjs', 'utf8');
    assert.equal(source.split(anchor).length - 1, 1, 'The actual production mutation must have one exact anchor');
    const mutated = source.replace(anchor, replacement); await writeFile(path.join(directory, 'server.mjs'), mutated);
    fixture = await securityFixture({ serverFile: path.join(directory, 'server.mjs') }); fixture.control.modelStatus = 401;
    const response = await fetch(fixture.base + '/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: SECURITY_KEY, text: 'Synthetic negative control.', source: 'en', target: 'Chinese' }), signal: AbortSignal.timeout(5000) });
    const body = await response.json(); assert.equal(response.status, 502); assert.equal(fixture.stats.requests.length, 1);
    const findings = credentialFindings(body);
    assert.throws(() => assert.deepEqual(findings, []), assert.AssertionError, 'The unchanged credential oracle must reject the real response');
    return { complete: true, ok: true, expectedFailure: true, mutation: 'forward-provider-error-body', replacements: 1,
      sourceSha256: digest(source), mutantSha256: digest(mutated), status: response.status, findings,
      requests: fixture.stats.requests.length, anchor, replacement, scope: 'Copied actual server.mjs and unchanged dependencies/HTTP boundary; synthetic local provider only.' };
  } finally { if (fixture) await fixture.close(); await rm(directory, { recursive: true, force: true }); }
}
