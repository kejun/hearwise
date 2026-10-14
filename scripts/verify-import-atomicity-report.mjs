import { readAtomicityReport } from './lib/import-atomicity-report.mjs';
const args = process.argv.slice(2), directory = args.find(arg => !arg.startsWith('--'));
if (!directory || args.some(arg => arg !== directory && !['--release', '--node-only'].includes(arg))) throw new Error('Usage: verify:import-atomicity:report DIRECTORY [--release] [--node-only]');
const summary = await readAtomicityReport(directory, { release: args.includes('--release'), nodeOnly: args.includes('--node-only') });
console.log(JSON.stringify(summary, null, 2)); process.exitCode = summary.ok ? 0 : 1;
