import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'dist/server');
const staging = path.join(root, 'dist/.server-build');
export async function buildServer() {
  let gitSha = 'unknown', dirty = true;
  try {
    gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* Source distributions may not contain git metadata. */ }
  await rm(staging, { recursive: true, force: true });
  try {
    await build({ absWorkingDir: root, entryPoints: ['src/server/index.ts'], outfile: path.join(staging, 'index.js'),
      bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', sourcemap: 'external',
      define: { __BUILD_META__: JSON.stringify({ git_sha: gitSha, build_dirty: dirty, instrumentation_version: 3 }) },
      plugins: [{ name: 'legacy-resource-boundary', setup(builder) {
        builder.onResolve({ filter: /\.mjs$/ }, args => {
          if (args.importer.includes(`${path.sep}src${path.sep}`)) return { errors: [{ text: 'Inject legacy .mjs ports from the root composition module; do not bundle their resource paths.' }] };
        });
      } }] });
    await mkdir(output, { recursive: true });
    await rename(path.join(staging, 'index.js.map'), path.join(output, 'index.js.map'));
    await rename(path.join(staging, 'index.js'), path.join(output, 'index.js'));
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildServer();
