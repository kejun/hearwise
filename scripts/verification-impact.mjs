import { writeFile } from 'node:fs/promises';
import { impactPlan } from './lib/verification-impact.mjs';
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!['--base', '--profile', '--output'].includes(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index])) throw new Error('Usage: node scripts/verification-impact.mjs --base COMMIT [--profile fast|deep] [--output FILE]');
  options[args[index]] = args[index + 1];
}
if (!options['--base']) throw new Error('An explicit comparison base is required');
const plan = await impactPlan(options['--base'], { profile: options['--profile'] || 'fast' });
const text = JSON.stringify(plan, null, 2) + '\n';
if (options['--output']) await writeFile(options['--output'], text);
console.log(text); process.exitCode = plan.complete ? 0 : 1;
