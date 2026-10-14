import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { inspectChangeRange, selectImpact, historicalEligibility, policyBinding } from './verification-impact.mjs';
import { budgets } from '../../verification/release/policy.mjs';
import { runProcess } from './process.mjs';

const supported = {
  'relation-protocol': ['HW-03', 'HW-04', 'HW-05', 'HW-10'], 'knowledge-protocol': ['HW-03', 'HW-04', 'HW-05', 'HW-10'],
  revision: ['HW-06', 'HW-07'], 'name-interval': ['HW-06', 'HW-07']
};
export async function historicalBindings(suite, profile) {
  if (!Object.hasOwn(supported, suite)) throw new Error('Historical suite is not supported');
  const files = execFileSync('git', ['ls-files', '-z'], { timeout: 10000 }).toString('utf8').split('\0').filter(Boolean);
  // Conservative full source dependency closure: only ordinary documentation
  // with no semantic impact is omitted. This can reject harmless changes; it
  // never guesses that a production dependency is unrelated.
  const source = files.filter(file => selectImpact([{ status: 'M', paths: [file] }]).affectedDomains.length);
  const entries = await Promise.all(source.map(async file => [file, digest(await readFile(file))]));
  const toolFiles = ['package-lock.json', 'verification/lean/lean-toolchain', 'verification/relation-protocol/toolchain.json', 'verification/knowledge-protocol/toolchain.json'];
  return { policy: await policyBinding(), model: digest(JSON.stringify(entries)),
    tools: digest(JSON.stringify({ node: process.version, sqlite: process.versions.sqlite, files: entries.filter(([file]) => toolFiles.includes(file)) })),
    configuration: digest(JSON.stringify({ suite, profile, budgets, files: entries.filter(([file]) => /(?:config\.json|profile\.mjs|toolchain|tlc\.json)$/.test(file)) })),
    corpus: digest(JSON.stringify(entries.filter(([file]) => /^(verification|test-support)\//.test(file)))),
    thresholds: digest('No semantic-quality or external measurement threshold applies to this finite technical report; none is accepted by this adapter.'),
    environment: digest(JSON.stringify({ platform: process.platform, arch: process.arch, release: os.release() })) };
}
export async function validateHistoricalEvidence(suite, directory, { profile = 'fast' } = {}) {
  const target = sourceVersion(), result = { suite, ok: false, eligible: false, sourceMode: 'historical', target, reasons: [], fullProjectAcceptance: false };
  if (!Object.hasOwn(supported, suite)) return { ...result, reasons: ['historical_validator_not_registered'] };
  let source;
  try { source = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')).source; }
  catch { return { ...result, reasons: ['missing_original_report'] }; }
  result.originalSource = source;
  if (!/^[a-f0-9]{40}$/.test(source?.sha || '') || source.dirty !== false || target.dirty !== false) return { ...result, reasons: ['unclean_or_invalid_source'] };
  const range = inspectChangeRange(source.sha, target.sha); result.impact = range;
  if (!range.complete || range.affectedDomains.some(domain => supported[suite].includes(domain))) return { ...result, reasons: ['incomplete_or_affected_history'] };
  const expectedBindings = await historicalBindings(suite, profile);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hearwise-original-evidence-')), checkout = path.join(temporary, 'source');
  let added = false;
  try {
    execFileSync('git', ['worktree', 'add', '--detach', checkout, source.sha], { timeout: 15000, stdio: 'pipe' }); added = true;
    const output = path.join(temporary, 'validation.json');
    const reader = fileURLToPath(new URL('../read-technical-evidence.mjs', import.meta.url));
    const execution = await runProcess(process.execPath, [reader, suite, path.resolve(directory), output, profile], { cwd: checkout, timeoutMs: 30000 });
    if (!execution.ok) return { ...result, reasons: ['original_validation_failed'], execution };
    const original = JSON.parse(await readFile(output, 'utf8'));
    if (JSON.stringify(sourceVersion()) !== JSON.stringify(target) || JSON.stringify(await historicalBindings(suite, profile)) !== JSON.stringify(expectedBindings)) return { ...result, reasons: ['target_changed_during_validation'] };
    const eligibility = historicalEligibility({ range, source, target, domains: supported[suite], actualBindings: original.bindings, expectedBindings,
      originalVerdict: { ok: original.verdict.ok, source: original.verdict.source, artifactsVerified: original.verdict.ok } });
    return { ...result, ...eligibility, ok: eligibility.eligible, originalValidation: original.verdict, bindings: original.bindings,
      scope: 'Original source revalidated offline with the same complete non-document source closure. Historical applicability never replaces mandatory current-source PR checks.' };
  } catch (error) { return { ...result, reasons: ['historical_validation_unavailable'], diagnostic: error.message }; }
  finally {
    if (added) execFileSync('git', ['worktree', 'remove', '--force', checkout], { timeout: 15000, stdio: 'pipe' });
    await rm(temporary, { recursive: true, force: true });
  }
}
