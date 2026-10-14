import { validateGenerationEvidence } from './lib/generation-protocol-report.mjs';
const [directory, ...args] = process.argv.slice(2);
if (!directory || args.some(arg => !['--release', '--deep'].includes(arg))) throw new Error('Usage: npm run verify:generation-protocol:report -- RUN_DIRECTORY [--release] [--deep]');
const summary = await validateGenerationEvidence(directory, { release: args.includes('--release'), requireProfile: args.includes('--deep') ? 'deep' : undefined });
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.ok ? 0 : 1;
