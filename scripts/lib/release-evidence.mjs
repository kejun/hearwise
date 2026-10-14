import { validateUpgradeReleaseEvidence } from './upgrade-release-evidence.mjs';
import { validateAtomicityReleaseEvidence } from './atomicity-release-evidence.mjs';
import { validateGenerationReleaseEvidence } from './generation-release-evidence.mjs';
import { validateNameReleaseEvidence } from './name-release-evidence.mjs';
import { validateSemanticOfflineReleaseEvidence } from './semantic-release-evidence.mjs';
import { validateSchedulerReleaseEvidence } from './scheduler-release-evidence.mjs';
import { validatePlaybackReleaseEvidence } from './playback-release-evidence.mjs';
import { validateProcessReleaseEvidence } from './process-release-evidence.mjs';
import { validateQualityInfrastructureEvidence } from './quality-release-evidence.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { purposes, technicalSuites, fullRequirements, externalRequirements } from '../../verification/release/policy.mjs';
import { sourceVersion } from './verification-evidence.mjs';
import { historicalCapabilities } from './historical-release-evidence.mjs';
import { impactPlan } from './verification-impact.mjs';
import { validateNodeEvidence, validateBrowserEvidence } from './runner-report-evidence.mjs';
import { validatePilotEvidence } from './pilot-release-evidence.mjs';
import { validateLeanEvidence } from './lean-report-evidence.mjs';
import { validateFormalReleaseEvidence } from './formal-release-evidence.mjs';

export async function readTechnicalEvidence(suite, directory, { release = true, profile = 'fast' } = {}) {
  if (!technicalSuites.includes(suite)) throw new Error('Unregistered technical evidence suite');
  if (suite === 'generation-protocol') return validateGenerationReleaseEvidence(directory, { release, requireProfile: profile });
  if (suite === 'install-upgrade') return validateUpgradeReleaseEvidence(directory, { release });
  if (suite === 'import-atomicity') return validateAtomicityReleaseEvidence(directory, { release });
  if (suite === 'name-protocol') return validateNameReleaseEvidence(directory, { release, requireProfile: profile });
  if (suite === 'semantic-offline') return validateSemanticOfflineReleaseEvidence(directory, { release });
  if (suite === 'scheduler') return validateSchedulerReleaseEvidence(directory, { release, requireProfile: profile });
  if (suite === 'node') return validateNodeEvidence(directory, { release });
  if (suite === 'browser') return validateBrowserEvidence(directory, { release });
  if (suite === 'playback-protocol') return validatePlaybackReleaseEvidence(directory, { release, requireProfile: profile });
  if (suite === 'process-crash') return validateProcessReleaseEvidence(directory, { release, requireProfile: profile });
  if (suite === 'quality-offline') return validateQualityInfrastructureEvidence(directory, { release });
  if (suite === 'pilot') return validatePilotEvidence(directory, { release });
  if (suite.endsWith('-protocol')) return validateFormalReleaseEvidence(suite, directory, { release, requireProfile: profile });
  return validateLeanEvidence(suite, directory, { release });
}
export const isCurrentTechnicalPass = (row, target) => row?.ok === true && row.status === 'passed' && row.stale === false && row.source?.sha === target.sha && row.source?.dirty === target.dirty;
const missing = suite => ({ suite, ok: false, status: 'not_run', reasons: ['missing_report'], sourceMode: 'current', fullProjectAcceptance: false });
// Purposes are fixed checked-in contracts. "foundation-demo" is deliberately
// not a release mode and cannot clear any full-business requirement.
export async function releaseEvidence(manifest, { purpose = 'pr', profile = 'fast', base = 'origin/main', release = true, directory = process.cwd() } = {}) {
  if (!Object.hasOwn(purposes, purpose) || !['fast', 'deep'].includes(profile)) throw new Error('Unknown purpose or fixed verification profile');
  const target = sourceVersion(), impact = await impactPlan(base, { profile }), reasons = [];
  const required = purposes[purpose], entries = manifest?.evidence;
  if (manifest?.schemaVersion !== 1 || !Array.isArray(entries)) reasons.push('invalid_manifest');
  if (!impact.complete) reasons.push('incomplete_impact_chain');
  if (release && target.dirty) reasons.push('uncommitted_source');
  const rows = [];
  for (const suite of required) {
    const candidates = Array.isArray(entries) ? entries.filter(entry => entry?.suite === suite) : [];
    if (!candidates.length) { rows.push(missing(suite)); continue; }
    // Every submitted attempt is checked. A failed deep attempt cannot be hidden
    // behind a same-source fast pass, nor can arbitrary "latest" ordering win.
    const seen = new Set();
    for (const entry of candidates) {
      if (entry.discoveryError) { rows.push({ ...missing(suite), status: 'incomplete', reasons: [entry.discoveryError] }); continue; }
      if (typeof entry.directory !== 'string' || !entry.directory || seen.has(path.resolve(directory, entry.directory))) {
        rows.push({ ...missing(suite), status: 'incomplete', reasons: ['invalid_or_duplicate_evidence_directory'] }); continue;
      }
      const location = path.resolve(directory, entry.directory); seen.add(location);
      let verdict;
      try { verdict = await readTechnicalEvidence(suite, location, { release, profile }); }
      catch (error) { verdict = { ok: false, status: 'incomplete', reasons: ['reader_error'], diagnostic: error.message }; }
      rows.push({ ...verdict, suite, directory: location, sourceMode: 'current', originalSource: verdict.source });
    }
  }
  if (Array.isArray(entries) && entries.some(entry => !required.includes(entry?.suite))) reasons.push('unexpected_suite_for_purpose');
  const historical = [];
  if (manifest?.historical != null) {
    if (!Array.isArray(manifest.historical)) reasons.push('invalid_historical_manifest');
    else {
      const { validateHistoricalEvidence } = await import('./historical-release-evidence.mjs');
      for (const entry of manifest.historical) {
        if (typeof entry?.directory !== 'string' || !entry.directory) { reasons.push('invalid_historical_entry'); continue; }
        const row = await validateHistoricalEvidence(entry.suite, path.resolve(directory, entry.directory), { profile }); historical.push(row);
        if (!row.eligible) reasons.push('unvalidated_historical_evidence');
      }
    }
  }
  const technicalPassed = reasons.length === 0 && required.every(suite => rows.some(row => row.suite === suite)) && rows.every(row => isCurrentTechnicalPass(row, target));
  const requirements = fullRequirements.map(row => ({ ...row, status: 'not_run' }));
  const external = externalRequirements.map(row => ({ ...row, status: 'not_run', reasons: ['validator_not_registered', 'configuration_or_threshold_not_frozen'] }));
  const fullAcceptance = technicalPassed && requirements.every(row => row.status === 'passed') && external.every(row => row.status === 'passed');
  const ok = purpose === 'release' ? fullAcceptance : technicalPassed;
  return { schemaVersion: 1, purpose, profile, target, impact, reasons, required, rows, historical, historicalCapabilities, technicalPassed, fullAcceptance, fullProjectAcceptance: fullAcceptance,
    releaseEligible: purpose === 'release' && fullAcceptance, ok,
    status: ok ? 'passed' : rows.some(row => row.status === 'failed') ? 'failed' : 'incomplete',
    requirements, external, automaticPaidCalls: false,
    claim: purpose === 'foundation-demo' ? 'Fixed integration demonstration of real Quint/replay and Lean/bridge only; not PR or release acceptance.' :
      purpose === 'pr' ? 'Current mandatory technical reports only; missing business and real-world acceptance remains explicit.' : 'All technical, all fifteen business domains and external acceptance required.' };
}
export async function readManifest(file) { return JSON.parse(await readFile(file, 'utf8')); }
