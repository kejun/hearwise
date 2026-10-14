import { isDeepStrictEqual } from 'node:util';

const primaryCases = ['append', 'replace'].flatMap(mode => ['stale-review', 'expired-upload'].map(name => ({ mode, name })));
export const importBrowserCases = [...primaryCases, { mode: 'append', name: 'stale-refresh-expiry' }];
const requiredSources = ['server.mjs', 'storage.mjs', 'data-transfer.mjs', 'public/app.js', 'package-lock.json',
  'scripts/verify-import-protocol-browser.mjs', 'test-support/import-protocol-browser-evidence.mjs',
  'test-support/import-protocol-fixture.mjs', 'test-support/import-protocol-control.mjs'];
const validStamp = stamp => /^[a-f0-9]{40}$/.test(stamp?.sha) && typeof stamp?.dirty === 'boolean' &&
  requiredSources.every(file => /^[a-f0-9]{64}$/.test(stamp?.digests?.[file])) &&
  Object.values(stamp.digests).every(value => /^[a-f0-9]{64}$/.test(value));
const closed = (rows, required) => Array.isArray(rows) && rows.every(row => row.ok === true) &&
  required.every(target => rows.filter(row => row.target === target).length === 1);
const observedWork = value => value && ['translations', 'extraction', 'relations', 'rounds', 'edits']
  .every(key => Array.isArray(value[key]) && value[key].length);
const stoppedWork = value => observedWork(value) && value.providerCalls === 0 &&
  value.translations.some(row => row.translation_state === 'failed') &&
  value.translations.every(row => row.translation_state !== 'pending') &&
  value.extraction.some(row => row.state === 'failed' && row.last_error === 'IMPORT_REQUIRES_RESUME') &&
  value.extraction.every(row => !['pending', 'running'].includes(row.state)) &&
  value.relations.some(row => row.state === 'cancelled' && row.last_error === 'IMPORT_REQUIRES_RESUME') &&
  value.relations.every(row => !['pending', 'running'].includes(row.state)) &&
  value.rounds.some(row => row.state === 'paused' && row.stop_reason === 'IMPORT_REQUIRES_RESUME') &&
  value.rounds.every(row => row.state !== 'active') && value.edits.every(row => row.state === 'failed');

// Scope results to the checks that actually establish each property. A later
// UI-only failure cannot rewrite completed stopped-work/restart observations.
export function summarizeImportBrowserEvidence(observations) {
  const scenarios = observations.scenarios || [], reasons = [];
  if (!validStamp(observations.sourceStart) || !validStamp(observations.sourceEnd) ||
    !isDeepStrictEqual(observations.sourceStart, observations.sourceEnd)) reasons.push('source_missing_or_changed');
  if (!closed(observations.cleanup, ['Chromium']) ||
    !scenarios.every(scenario => closed(scenario.cleanup, ['browser context', 'fixture']))) reasons.push('cleanup_incomplete');
  if (scenarios.length && !observations.tools?.chromium) reasons.push('browser_not_observed');
  const results = [['HW-09-04', primaryCases, 'importedWorkStopped'],
    ['HW-09-05', importBrowserCases, 'browserProtocol']].map(([id, cases, check]) => {
    const result = { property: { id, version: 1 }, complete: false, ok: false,
      status: 'not_run', reasons: [...reasons], checks: cases.map(({ mode, name }) => `${mode}/${name}/${check}`) };
    if (reasons.length) { result.status = 'incomplete'; return result; }
    const matches = cases.map(expected => scenarios.filter(scenario => scenario.mode === expected.mode && scenario.name === expected.name));
    if (matches.every(rows => rows.length === 0)) return result;
    if (matches.some(rows => rows.length > 1)) { result.status = 'incomplete'; result.reasons.push('duplicate_scenario'); return result; }
    const applicable = matches.flat();
    const failed = applicable.some(scenario => scenario.checks?.[check]?.ok === false ||
      (!scenario.checks?.[check] && scenario.error));
    if (failed) { result.status = 'failed'; result.reasons.push('required_check_failed'); return result; }
    if (matches.some(rows => rows.length !== 1) || applicable.some(scenario =>
      scenario.checks?.[check]?.complete !== true || scenario.checks?.[check]?.ok !== true)) {
      result.status = 'incomplete'; result.reasons.push('required_check_missing'); return result;
    }
    if (check === 'importedWorkStopped') {
      if (applicable.some(scenario => !observedWork(scenario.unfinishedAfterCommit) || !observedWork(scenario.unfinishedAfterRestart) ||
        !Array.isArray(scenario.providerCalls) || !Array.isArray(scenario.lifecycle))) {
        result.status = 'incomplete'; result.reasons.push('stopped_work_observations_missing'); return result;
      }
      if (applicable.some(scenario => !stoppedWork(scenario.unfinishedAfterCommit) ||
        !isDeepStrictEqual(scenario.unfinishedAfterCommit, scenario.unfinishedAfterRestart) || scenario.providerCalls.length !== 0 ||
        !isDeepStrictEqual(scenario.lifecycle.map(row => row.action), ['start', 'crash', 'start']) ||
        scenario.lifecycle[1].signal !== 'SIGKILL')) {
        result.status = 'failed'; result.reasons.push('stopped_work_or_restart_mismatch'); return result;
      }
    } else {
      if (applicable.some(scenario => !Array.isArray(scenario.pageErrors) || !Array.isArray(scenario.providerCalls))) {
        result.status = 'incomplete'; result.reasons.push('browser_observations_missing'); return result;
      }
      if (applicable.some(scenario => scenario.pageErrors.length || scenario.providerCalls.length)) {
        result.status = 'failed'; result.reasons.push('browser_error_or_provider_call'); return result;
      }
    }
    result.complete = result.ok = true; result.status = 'passed'; return result;
  });
  const complete = results.every(result => result.complete) && !(observations.errors || []).length;
  return { results, complete, ok: complete && results.every(result => result.ok) };
}
