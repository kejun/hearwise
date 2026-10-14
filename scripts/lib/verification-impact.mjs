import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { digest, sourceVersion } from './verification-evidence.mjs';
import { groups, technicalSuites, domainSuites, impactRules, safeDocumentation, styleFile, policyVersion,
  externalRequirements, budgets, specificationVersion } from '../../verification/release/policy.mjs';

const sorted = values => [...new Set(values)].sort();
const validPath = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..');
export function parseNameStatus(buffer) {
  const tokens = buffer.toString('utf8').split('\0');
  if (tokens.pop() !== '') throw new Error('Git diff is not NUL terminated');
  const changes = [];
  while (tokens.length) {
    const status = tokens.shift();
    if (!/^(?:[AMDTUXB]|[RC]\d{1,3})$/.test(status)) throw new Error('Unrecognized Git change kind');
    const paths = tokens.splice(0, /^[RC]/.test(status) ? 2 : 1);
    if (paths.length !== (/^[RC]/.test(status) ? 2 : 1) || paths.some(value => !validPath(value))) throw new Error('Unsafe or incomplete Git path');
    changes.push({ status, paths });
  }
  return changes;
}
export function selectImpact(changes, { uncertain = false } = {}) {
  if (!Array.isArray(changes)) throw new Error('Expected actual Git changes');
  const files = [];
  for (const change of changes) {
    if (!Array.isArray(change.paths) || !change.paths.length || change.paths.some(file => !validPath(file))) throw new Error('Invalid change path');
    for (const file of change.paths) {
      // CSS is UI coverage, not a request to repeat every paid service/device run.
      const matches = styleFile.test(file) ? [{ id: 'style', category: 'interaction-style', domains: ['HW-11', 'HW-12', 'HW-13'] }] : impactRules.filter(rule => rule.match.test(file));
      const knownDomain = matches.some(rule => rule.id !== 'runtime-security-performance');
      if (!knownDomain && safeDocumentation.test(file)) matches.push({ id: 'documentation', category: 'documentation', domains: [] });
      else if (!knownDomain) matches.push({ id: 'unknown-conservative', category: 'unknown', domains: groups });
      files.push({ path: file, change: change.status, rules: matches.map(rule => rule.id), categories: sorted(matches.map(rule => rule.category)), domains: sorted(matches.flatMap(rule => rule.domains)) });
    }
  }
  const affectedDomains = uncertain ? groups : sorted(files.flatMap(file => file.domains));
  return { files, affectedDomains, affectedSuites: sorted(affectedDomains.flatMap(group => domainSuites[group])),
    // Existing checks stay mandatory even for documentation-only PRs.
    requiredTechnicalSuites: [...technicalSuites],
    externalRequirements: externalRequirements.filter(requirement => requirement.domains.some(group => affectedDomains.includes(group)))
      .map(requirement => ({ id: requirement.id, method: requirement.method, automaticPrExecution: false, status: 'requires_separate_evidence' })),
    automaticPaidCalls: false, uncertain };
}
const git = (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }).trim();
export function inspectChangeRange(base, target = 'HEAD', { cwd = process.cwd() } = {}) {
  let baseSha = null, targetSha = null;
  try {
    if (![base, target].every(value => typeof value === 'string' && /^(?:[a-f0-9]{40}|HEAD|origin\/main)$/.test(value))) throw new Error('Use a full commit SHA, HEAD, or origin/main');
    baseSha = git(['rev-parse', '--verify', `${base}^{commit}`], cwd); targetSha = git(['rev-parse', '--verify', `${target}^{commit}`], cwd);
    if (!/^[a-f0-9]{40}$/.test(baseSha) || !/^[a-f0-9]{40}$/.test(targetSha)) throw new Error('Commit identity is invalid');
    execFileSync('git', ['merge-base', '--is-ancestor', baseSha, targetSha], { cwd, timeout: 10000, stdio: 'pipe' });
    const commits = git(['rev-list', '--reverse', '--topo-order', `${baseSha}..${targetSha}`], cwd).split('\n').filter(Boolean);
    // Inspect every commit and every merge parent, not only the net tree diff.
    // A dependency/protocol A→B→A sequence must remain visible to history reuse.
    const bytes = commits.length ? execFileSync('git', ['diff-tree', '--stdin', '--root', '-r', '-m', '--no-commit-id', '--name-status', '-z', '--find-renames', '--find-copies'],
      { cwd, input: commits.join('\n') + '\n', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }) : Buffer.from('\0');
    const changes = commits.length ? parseNameStatus(bytes) : [];
    return { complete: true, base: baseSha, target: targetSha, ancestor: true, commits, changes, ...selectImpact(changes), reasons: [] };
  } catch (error) {
    return { complete: false, base: baseSha, target: targetSha, ancestor: false, changes: [], ...selectImpact([], { uncertain: true }), reasons: ['unknown_or_nonancestor_change_range'], diagnostic: error.message.split('\n')[0] };
  }
}
export async function policyBinding() {
  const paths = ['verification/release/policy.mjs', 'scripts/lib/verification-impact.mjs'];
  return digest(JSON.stringify(await Promise.all(paths.map(async file => [file, digest(await readFile(file))]))));
}
export async function impactPlan(base, { profile = 'fast' } = {}) {
  if (!['fast', 'deep'].includes(profile)) throw new Error('Profile must be fast or deep');
  const range = inspectChangeRange(base), policyDigest = await policyBinding();
  const lockDigest = digest(await readFile('package-lock.json'));
  const toolchain = JSON.parse(await readFile('verification/relation-protocol/toolchain.json', 'utf8'));
  const lean = (await readFile('verification/lean/lean-toolchain', 'utf8')).trim();
  const environment = { platform: process.platform, arch: process.arch, nodeMajor: process.versions.node.split('.')[0] };
  return { schemaVersion: 1, policyVersion, specificationVersion, policyDigest, profile, source: sourceVersion(), ...range,
    environment, toolchain: { ...toolchain, lean }, budgets,
    cache: { kind: 'compiled-tools-only; never a passing-report cache',
      toolsKey: digest(JSON.stringify({ policyVersion, lockDigest, toolchain, lean, environment })),
      evidenceKey: digest(JSON.stringify({ target: range.target, policyDigest, lockDigest, profile, toolchain, lean, budgets, environment })) },
    fullProjectAcceptance: false };
}
// This establishes eligibility only. The original source's registered domain
// validator and immutable artifacts must also have passed; eligibility cannot
// turn an unimplemented quality/device validator into a release pass.
export function historicalEligibility({ range, source, target, domains, actualBindings, expectedBindings, originalVerdict }) {
  const reasons = [];
  if (!range?.complete || !range.ancestor || range.base !== source?.sha || range.target !== target?.sha || source?.dirty !== false || target?.dirty !== false) reasons.push('incomplete_history_chain');
  if (!Array.isArray(domains) || !domains.length || domains.some(domain => !groups.includes(domain))) reasons.push('unknown_domain');
  if (range?.affectedDomains?.some(domain => domains?.includes(domain))) reasons.push('affected_since_evidence');
  const keys = ['policy', 'model', 'tools', 'configuration', 'thresholds', 'corpus', 'environment'];
  if (keys.some(key => !/^[a-f0-9]{64}$/.test(expectedBindings?.[key] || '') || !/^[a-f0-9]{64}$/.test(actualBindings?.[key] || '')) || !isDeepStrictEqual(actualBindings, expectedBindings)) reasons.push('changed_or_unfrozen_context');
  if (originalVerdict?.ok !== true || originalVerdict?.source?.sha !== source?.sha || originalVerdict?.source?.dirty !== false || originalVerdict?.artifactsVerified !== true) reasons.push('original_evidence_not_validated');
  return { eligible: !reasons.length, reasons, sourceMode: 'historical', originalSource: source, target,
    reason: 'Only a complete ancestor diff with unaffected declared domains and identical frozen context permits continued applicability; this is not a rerun.' };
}
