import { validateProtocolEvidence } from './lib/relation-protocol-evidence.mjs';

const [directory, ...options] = process.argv.slice(2);
if (!directory || options.some(option => !['--release', '--deep'].includes(option))) throw new Error('Usage: npm run verify:relation-protocol:report -- RUN_DIRECTORY [--release] [--deep]');
const summary = await validateProtocolEvidence(directory, { release: options.includes('--release'), requireProfile: options.includes('--deep') ? 'deep' : undefined });
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.ok ? 0 : 1;
