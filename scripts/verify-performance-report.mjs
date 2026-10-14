import path from 'node:path';
import { validatePerformanceEvidence } from './lib/performance-evidence.mjs';
const args = process.argv.slice(2), directory = args[0];
if (!directory || args.slice(1).some(value => !['--release-collection', '--clean', '--inspect-incomplete'].includes(value)))
  throw new Error('Usage: node scripts/verify-performance-report.mjs DIRECTORY [--release-collection] [--clean] [--inspect-incomplete]');
const result = await validatePerformanceEvidence(path.resolve(directory), { release: args.includes('--release-collection'), cleanSource: args.includes('--clean'), requireComplete: !args.includes('--inspect-incomplete') });
console.log(JSON.stringify(result, null, 2));
if (!result.valid) process.exitCode = 1;
