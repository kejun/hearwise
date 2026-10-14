import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readUpgradeCIReport } from './upgrade-report.mjs';
import { evidenceFiles } from './runner-evidence-contract.mjs';
export async function validateUpgradeReleaseEvidence(directory, { release = true } = {}) {
  const result = { kind: 'install-upgrade', ok: false, status: 'not_run', stale: false, reasons: [], source: null,
    methods: ['actual-historical-sqlite-upgrade-and-recovery', 'isolated-npm-install-reinstall'], fullProjectAcceptance: false };
  try { await readFile(path.join(directory, 'report.json')); }
  catch { result.reasons.push('missing_upgrade_report'); return result; }
  result.status = 'incomplete';
  try {
    await evidenceFiles(directory);
    const { source, summary } = await readUpgradeCIReport(directory, { release }); result.source = source;
    result.reasons = [...new Set(summary.rows.flatMap(row => row.reasons))];
    result.stale = result.reasons.includes('source_missing_changed_or_dirty');
    return { ...result, ok: summary.ok, status: summary.ok ? 'passed' : summary.rows.some(row => row.status === 'failed') ? 'failed' : 'incomplete',
      complete: summary.complete, propertyRows: summary.rows, support: summary.support };
  } catch (error) { result.reasons.push(error.message); return result; }
}
