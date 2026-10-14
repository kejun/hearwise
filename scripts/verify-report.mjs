import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pilot, properties } from '../verification/properties.mjs';
import { sourceVersion, summarize, checkArtifacts } from './lib/verification-evidence.mjs';

const [directory, ...options] = process.argv.slice(2);
if (!directory || options.some(option => !['--release', '--full'].includes(option))) {
  throw new Error('Usage: npm run verify:report -- RUN_DIRECTORY [--release] [--full]');
}
// Re-read required results and referenced files. Cached report.ok is not a gate.
let report, result;
try { report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); } catch { /* Incomplete run. */ }
try { result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')); } catch { /* Missing result. */ }
const results = result ? [result] : [];
const summary = summarize({ results, target: sourceVersion(), required: options.includes('--full') ? properties.map(p => p.id) : pilot,
  release: options.includes('--release'), execution: report?.complete === true ? report.execution : undefined,
  artifactsValid: await Promise.all(results.map(item => checkArtifacts(directory, item))) });
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.ok ? 0 : 1;
