import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { devicePlanTemplate, prepareDeviceEvidence, readDeviceEvidence, requireEvidenceLocation } from './lib/device-evidence.mjs';
import { writeJson } from './lib/verification-evidence.mjs';

const help = `Hearwise physical-device check preparation (no automatic provider calls).
  plan [--out FILE]                 Write a fresh plan; fill actual client and services.
  prepare --plan FILE [--out DIR]   Create isolated SQLite, checklist and blank observations.
  report --run DIR                 Check operator observations against source and the 10-minute window.
Default output: verification-evidence/device/. One run per device/browser/provider configuration.
Use the generated device.sqlite as LISTENING_DB when starting Hearwise.
Report exit: 0 = complete operator-reported pass; 1 = failed; 3 = incomplete/not run.
No exit code certifies physical hardware, TTS quality or final release acceptance.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, out: { type: 'string' }, plan: { type: 'string' }, run: { type: 'string' }
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  if (positionals.length !== 1) throw new Error('Use one command');
  const command = positionals[0];
  if (command === 'plan') {
    if (values.plan || values.run) throw new Error('plan accepts only --out');
    const file = path.resolve(values.out || 'verification-evidence/device/plan.json'); requireEvidenceLocation(file);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(devicePlanTemplate(), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ plan: file, manualStatus: 'not_run', releaseEligible: false })); return;
  }
  if (command === 'prepare') {
    if (!values.plan || values.run) throw new Error('prepare requires --plan FILE and optional --out DIR');
    const plan = JSON.parse(await readFile(values.plan, 'utf8'));
    console.log(JSON.stringify(await prepareDeviceEvidence(plan, values.out || 'verification-evidence/device'), null, 2)); return;
  }
  if (command === 'report') {
    if (!values.run || values.out || values.plan) throw new Error('report requires only --run DIR');
    requireEvidenceLocation(values.run);
    const report = await readDeviceEvidence(values.run);
    await writeJson(path.join(values.run, 'summary.json'), report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.reportedPassed ? 0 : report.manualStatus === 'failed' ? 1 : 3; return;
  }
  throw new Error('Unknown command');
}
main().catch(error => { console.error(error.message); process.exitCode = 3; });
