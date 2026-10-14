import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialImplementationNegative } from '../test-support/security-negative.mjs';
import { credentialFindings, SECURITY_KEY } from '../test-support/security-fixture.mjs';
import { securityCorpus, assertTextIsolation, renderingMutant, SecurityBoundaryViolation, redactSecurityDiagnostic } from '../test-support/security-browser-support.mjs';
import { readFile } from 'node:fs/promises';

test('credential scanner finds UTF-8 and SQLite UTF-16 sentinels without publishing their values', () => {
  assert.deepEqual(credentialFindings('safe'), []);
  for (const encoding of ['utf8', 'utf16le']) assert.deepEqual(credentialFindings(Buffer.from(SECURITY_KEY, encoding)), [{ sentinel: 0, encoding }]);
  assert.deepEqual(credentialFindings(redactSecurityDiagnostic(new Error(SECURITY_KEY))), []);
});

test('copied real production error-body mutation is rejected by the same credential oracle', { timeout: 15000 }, async () => {
  const result = await credentialImplementationNegative(); assert.equal(result.ok, true); assert.equal(result.replacements, 1);
  assert.ok(result.findings.length > 0); assert.notEqual(result.sourceSha256, result.mutantSha256);
  assert.deepEqual(credentialFindings(result), []);
});

test('browser oracle rejects each execution, DOM, network, credential or observation failure independently', () => {
  const good = { executionCount: 0, injectedNodeCount: 0, probeRequests: 0, externalRequests: 0, credentialFindings: 0, observationErrors: 0, pageErrors: 0 };
  assert.doesNotThrow(() => assertTextIsolation(good, 'normal'));
  for (const key of Object.keys(good)) assert.throws(() => assertTextIsolation({ ...good, [key]: 1 }, key), SecurityBoundaryViolation);
  assert.ok(Object.keys(securityCorpus).length >= 8);
});

test('rendering mutation changes exactly one actual app sink and rejects missing or ambiguous anchors', async () => {
  const source = await readFile('public/app.js', 'utf8'), mutant = renderingMutant(source);
  assert.equal(mutant.replacements, 1); assert.notEqual(source, mutant.source);
  assert.throws(() => renderingMutant('no matching sink'));
  assert.throws(() => renderingMutant(source + '\n' + mutant.anchor));
});
