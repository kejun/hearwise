import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd(), checks = [];
async function check(name, work) {
  try { checks.push({ name, ok: true, detail: await work() }); }
  catch (error) { checks.push({ name, ok: false, detail: error.message }); }
}
await check('Node', () => {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 required');
  return process.versions.node;
});
await check('Locked dependencies', () => {
  const lock = JSON.parse(readFileSync('package-lock.json')), pkg = JSON.parse(readFileSync('package.json'));
  if (realpathSync('node_modules') !== path.join(realpathSync(root), 'node_modules')) throw new Error('Borrowed node_modules detected; run npm ci --ignore-scripts in this checkout');
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const actual = JSON.parse(readFileSync(path.join('node_modules', name, 'package.json'))).version;
    const expected = lock.packages[`node_modules/${name}`]?.version;
    if (actual !== expected) throw new Error(`${name}: installed ${actual}, locked ${expected}; run npm ci --ignore-scripts`);
  }
  execFileSync('npm', ['ls', '--depth=0', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return 'Top-level versions match package-lock.json; npm dependency tree is valid';
});
await check('Git base and publication route', () => {
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  const fetch = execFileSync('git', ['config', '--get-all', 'remote.origin.fetch'], { encoding: 'utf8' }).trim();
  // Do not print credential helpers, URLs, headers, or env. Read access does not prove push permission.
  return { branch, fetchesAllBranches: fetch.includes('refs/heads/*'), publication: process.env.PUBLICATION_CHANNEL || 'undetermined: choose connected GitHub or authenticated git before publication' };
});
if (process.argv.includes('--browser')) {
  await check('Chinese font', () => {
    if (process.platform !== 'linux') return 'Verify platform font in the browser smoke check';
    const fonts = execFileSync('fc-list', [':lang=zh-cn', 'family'], { encoding: 'utf8' }).trim();
    if (!fonts) throw new Error('No Chinese font; install fonts-noto-cjk before screenshots');
    return fonts.split('\n').slice(0, 3);
  });
  await check('Chromium smoke', async () => {
    const { chromium } = await import('playwright');
    const executablePath = process.env.CHROMIUM_EXECUTABLE || chromium.executablePath();
    if (!existsSync(executablePath)) throw new Error('Chromium missing; run npm run setup:browser or set CHROMIUM_EXECUTABLE to a verified installation');
    let browser;
    try {
      browser = await chromium.launch({ headless: true, executablePath, timeout: 15000, args: ['--no-sandbox', '--disable-gpu'] });
      const page = await browser.newPage();
      await page.setContent('<p id="probe" style="font:24px sans-serif">中文播报验证</p>');
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const { root: document } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.nodeId, selector: '#probe' });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      if (!fonts.some(font => font.glyphCount > 0 && /CJK|Han|Hei|Song|PingFang|SimSun|WenQuanYi|Noto Sans SC/i.test(font.familyName))) {
        throw new Error('Chinese probe did not use a known CJK font: ' + fonts.map(font => font.familyName).join(', '));
      }
      return { version: browser.version(), executablePath, fonts: fonts.map(font => font.familyName) };
    } finally { await browser?.close(); }
  });
}
console.log(JSON.stringify({ ok: checks.every(check => check.ok), checks }, null, 2));
process.exitCode = checks.every(check => check.ok) ? 0 : 1;
