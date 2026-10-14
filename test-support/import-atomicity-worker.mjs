import { atomicityCases, atomicityScenario } from './import-atomicity-scenarios.mjs';
import { dataCases, dataScenario } from './import-atomicity-data.mjs';
import { atomicityVersion } from './import-atomicity-evidence.mjs';
import { writeJson } from '../scripts/lib/verification-evidence.mjs';
const output = process.argv[2];
const observations = { version: atomicityVersion, scenarios: [] };
await writeJson(output, observations);
for (const config of [...dataCases, ...atomicityCases]) {
  const row = {}; observations.scenarios.push(row);
  try { await (typeof config === 'string' ? dataScenario(config, row) : atomicityScenario(config, row)); }
  catch (error) { console.error(error); process.exitCode = 1; }
  finally { await writeJson(output, observations); }
  console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.id}`);
  if (row.cleanup?.ok !== true) break;
}
