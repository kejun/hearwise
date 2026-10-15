import { validateM1Evidence } from './lib/m1-evidence.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
const directories = {}, args = process.argv.slice(2); let release = false, output;
while (args.length) {
  const flag = args.shift();
  if (flag === '--release') release = true;
  else if (['--relation', '--knowledge', '--process', '--generation', '--output'].includes(flag) && args[0] && !args[0].startsWith('--')) {
    const value = args.shift(); if (flag === '--output') output = value; else directories[flag.slice(2)] = value;
  } else throw new Error('Usage: verify:m1:report -- [--relation DIR] [--knowledge DIR] [--process DIR] [--generation DIR] [--release] [--output FILE]');
}
const summary = await validateM1Evidence(directories, { release });
if (output) await writeJson(output, summary);
console.log(JSON.stringify(summary, null, 2)); process.exitCode = summary.ok ? 0 : 1;
