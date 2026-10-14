import { validateNameProtocolEvidence } from './lib/name-protocol-evidence.mjs';
const [directory, ...options] = process.argv.slice(2);
if (!directory || options.some(option => option !== '--release')) throw new Error('Usage: node scripts/verify-name-protocol-report.mjs RUN_DIRECTORY [--release]');
const summary = await validateNameProtocolEvidence(directory, { release: options.includes('--release') });
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.ok ? 0 : 1;
