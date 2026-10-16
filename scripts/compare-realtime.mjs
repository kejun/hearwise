import { readFile } from 'node:fs/promises';
import { freezeRealtimePolicy, compareRealtime, auditRealtimeComparison } from './lib/realtime-comparison.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
const [mode, baseline, next, policyFile, output, ...extra] = process.argv.slice(2);
if (mode === 'freeze' && baseline && next && policyFile && !output) {
  console.log(JSON.stringify(await freezeRealtimePolicy(baseline, JSON.parse(await readFile(next, 'utf8')), policyFile)));
} else if (mode === 'audit' && baseline && next && policyFile && output && !extra.length) {
  console.log(JSON.stringify(await auditRealtimeComparison(baseline, next, JSON.parse(await readFile(policyFile, 'utf8')), JSON.parse(await readFile(output, 'utf8')))));
} else if (mode === 'compare' && baseline && next && policyFile && output && !extra.length) {
  const report = await compareRealtime(baseline, next, JSON.parse(await readFile(policyFile, 'utf8')));
  await writeJson(output, report); console.log(JSON.stringify(report)); process.exitCode = report.passed ? 0 : report.status === 'failed' ? 1 : 3;
} else throw new Error('freeze BASELINE LIMITS.json NEW_POLICY.json | compare BASELINE CANDIDATE POLICY.json OUTPUT.json');
