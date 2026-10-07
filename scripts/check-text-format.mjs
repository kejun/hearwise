import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const extensions = /\.(?:mjs|cjs|js|ts|css|html|md|json|yml|yaml|txt|py|sh)$/;
const failures = [];
for (const file of files) {
  if (!extensions.test(file) && !['.gitattributes', '.editorconfig', '.gitignore'].includes(file)) continue;
  let bytes; try { bytes = readFileSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (bytes.includes(0)) continue;
  const content = bytes.toString('utf8');
  if (content.includes('\r')) failures.push(`${file}: use LF line endings`);
  if (content.startsWith('\ufeff')) failures.push(`${file}: remove UTF-8 BOM`);
  if (content && !content.endsWith('\n')) failures.push(`${file}: missing final newline`);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log('Tracked text files: LF, no BOM, final newline');
