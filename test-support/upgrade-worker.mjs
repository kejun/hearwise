import { writeJson, sourceVersion } from '../scripts/lib/verification-evidence.mjs';
import { historicalUpgrade, migrationFault, faultCases, historicalRestore, faultId } from './upgrade-scenarios.mjs';
const output = process.argv[2], report = { source: sourceVersion(), cases: [], complete: false, ok: false };
await writeJson(output, report);
const cases = [
  ...Array.from({ length: 12 }, (_, index) => ({ id: `upgrade/v${index + 1}`, run: row => historicalUpgrade(index + 1, row) })),
  ...faultCases.map(config => ({ id: faultId(config), run: row => migrationFault(config, row) })),
  ...[1, 6, 10, 11, 12].map(version => ({ id: `restore/v${version}`, run: row => historicalRestore(version, null, row) }))
];
for (const entry of cases) {
  const row = { id: entry.id, complete: false, ok: false }; report.cases.push(row);
  try { await entry.run(row); }
  catch (error) { row.failure ||= { name: error.name, message: error.message, stack: error.stack }; console.error(`${row.id}: ${error.message}`); }
  finally { await writeJson(output, report); }
  if (row.cleanupOk !== true) break;
}
report.complete = report.cases.length === cases.length && report.cases.every(row => row.complete);
report.ok = report.complete && report.cases.every(row => row.ok);
await writeJson(output, report); console.log(JSON.stringify({ cases: report.cases.length, complete: report.complete, ok: report.ok }));
process.exitCode = report.ok ? 0 : 1;
