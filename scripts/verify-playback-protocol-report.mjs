import { validatePlaybackEvidence } from './lib/playback-protocol-evidence.mjs';
const args = process.argv.slice(2), directory = args.find(arg => !arg.startsWith('--'));
if (!directory || args.some(arg => arg.startsWith('--') && !['--release', '--deep'].includes(arg))) throw new Error('Usage: node scripts/verify-playback-protocol-report.mjs DIRECTORY [--release] [--deep]');
const summary = await validatePlaybackEvidence(directory, { release: args.includes('--release'), ...(args.includes('--deep') ? { requireProfile: 'deep' } : {}) });
console.log(JSON.stringify(summary, null, 2)); process.exitCode = summary.ok ? 0 : 1;
