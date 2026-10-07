import { execFileSync } from 'node:child_process';
import { runProcess } from './lib/process.mjs';
async function run(command, args) {
  const result = await runProcess(command, args, { timeoutMs: 240000, onOutput: text => process.stdout.write(text) });
  if (!result.ok) throw new Error(`Environment setup failed: ${command} (timeout=${result.timedOut}, code=${result.code})`);
}
try {
  if (process.platform === 'linux') {
    let fonts = '';
    try { fonts = execFileSync('fc-list', [':lang=zh-cn', 'family'], { encoding: 'utf8' }).trim(); } catch { /* Install below. */ }
    if (!fonts) {
      const command = process.getuid?.() === 0 ? 'apt-get' : 'sudo';
      const prefix = command === 'sudo' ? ['-n', 'apt-get'] : [];
      await run(command, [...prefix, 'update']);
      await run(command, [...prefix, 'install', '-y', 'fontconfig', 'fonts-noto-cjk']);
    }
  }
  if (!process.env.CHROMIUM_EXECUTABLE) await run('npm', ['exec', '--no', '--', 'playwright', 'install', '--with-deps', 'chromium']);
  await run(process.execPath, ['scripts/preflight.mjs', '--browser']);
} catch (error) { console.error(error.message); process.exitCode = 1; }
