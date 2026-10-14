import { validateEditProtocolEvidence } from './lib/edit-protocol-evidence.mjs';
const [directory, ...options] = process.argv.slice(2);
if (!directory || options.some(option => option !== '--release')) throw new Error('Usage: node scripts/verify-edit-protocol-report.mjs RUN_DIRECTORY [--release]');
const summary = await validateEditProtocolEvidence(directory, { release: options.includes('--release') });
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.ok ? 0 : 1;
