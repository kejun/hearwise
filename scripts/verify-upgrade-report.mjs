import { readUpgradeReport } from './lib/upgrade-report.mjs';
const args = process.argv.slice(2), directory = args.find(value => !value.startsWith('--'));
if (!directory || args.some(value => value !== directory && value !== '--release')) throw new Error('Usage: verify:upgrade:report DIRECTORY [--release]');
const result = await readUpgradeReport(directory, { release: args.includes('--release') }); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
