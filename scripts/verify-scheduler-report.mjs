import { validateSchedulerEvidence } from './lib/scheduler-protocol-evidence.mjs';
const [directory, ...flags] = process.argv.slice(2);
if (!directory || flags.some(flag => !['--release', '--deep'].includes(flag))) throw new Error('Usage: node scripts/verify-scheduler-report.mjs DIRECTORY [--release] [--deep]');
const result = await validateSchedulerEvidence(directory, { release: flags.includes('--release'), ...(flags.includes('--deep') ? { requireProfile: 'deep' } : {}) });
console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
