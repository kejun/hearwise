import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { performanceRecipes, performanceProfiles, performanceTimeouts } from '../verification/performance/profile.mjs';
import { runProcess } from './lib/process.mjs';
import { performanceRoot, performanceSourceSnapshot, fileSha256 } from './lib/performance-files.mjs';
import { writeJson } from './lib/verification-evidence.mjs';
const [destination, profile = 'baseline'] = process.argv.slice(2);
if (!destination || !performanceProfiles[profile]) throw new Error('Usage: node scripts/prepare-performance.mjs DIRECTORY [baseline|smoke]');
await mkdir(destination, { recursive: true }); const directory = await mkdtemp(path.join(path.resolve(destination), 'fixtures-'));
const report = { schemaVersion: 1, profile, startedAt: new Date().toISOString(), finishedAt: null, complete: false, ...await performanceSourceSnapshot(), datasets: [], executions: [] };
console.log(`Performance fixtures: ${directory}`);
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
let interrupted = false, timedOut = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const overall = setTimeout(() => { timedOut = true; process.kill(process.pid, 'SIGTERM'); }, performanceTimeouts.preparationRunMs);
try {
  for (const recipe of performanceRecipes.filter(recipe => performanceProfiles[profile].tiers.includes(recipe.tier))) {
    const row = { tier: recipe.tier, recipe: `${recipe.tier}-recipe.json`, database: `${recipe.tier}.sqlite`, manifest: `${recipe.tier}-manifest.json`,
      importRecipe: `${recipe.tier}-import-recipe.json`, importDatabase: `${recipe.tier}-import.sqlite`, importManifest: `${recipe.tier}-import-manifest.json` };
    report.datasets.push(row);
    for (const imported of [false, true]) {
      if (interrupted || timedOut) throw new Error('Performance fixture preparation interrupted');
      const name = imported ? `${recipe.tier}-import` : recipe.tier, actualRecipe = imported ? { ...recipe, tier: `${recipe.tier}-import`, listenings: 1, graphRecords: 1, seed: recipe.seed + 1 } : recipe;
      const recipeFile = path.join(directory, imported ? row.importRecipe : row.recipe), databaseFile = path.join(directory, imported ? row.importDatabase : row.database), manifestFile = path.join(directory, imported ? row.importManifest : row.manifest);
      await writeJson(recipeFile, actualRecipe);
      const argv = ['scripts/prepare-performance-dataset.mjs', recipeFile, databaseFile, manifestFile], log = `${name}.log`;
      const { tail: _tail, ...execution } = await runProcess(process.execPath, argv, { cwd: performanceRoot, env, timeoutMs: performanceTimeouts.preparationMs, logFile: path.join(directory, log) });
      report.executions.push({ id: name, argv, cwd: performanceRoot, log, timeoutMs: performanceTimeouts.preparationMs, execution });
      await writeJson(path.join(directory, 'prepared.json'), report);
      if (!execution.ok || execution.signal) throw new Error(`Preparation ${name} incomplete; original files and log retained`);
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      if (manifest.databaseSha256 !== await fileSha256(databaseFile)) throw new Error(`Preparation ${name} database digest differs`);
    }
  }
  report.complete = true;
} catch (error) { report.error = error.message; }
finally {
  clearTimeout(overall); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  if (interrupted || timedOut) report.complete = false;
  report.finalSource = await performanceSourceSnapshot();
  if (JSON.stringify(report.sourceDigests) !== JSON.stringify(report.finalSource.sourceDigests)) { report.complete = false; report.error = 'Source changed during fixture preparation'; }
  report.execution = { complete: !interrupted && !timedOut, interrupted: interrupted && !timedOut, timedOut, code: report.complete ? 0 : 1, signal: null, timeoutMs: performanceTimeouts.preparationRunMs };
  report.finishedAt = new Date().toISOString(); await writeJson(path.join(directory, 'prepared.json'), report);
  console.log(JSON.stringify({ complete: report.complete, path: path.join(directory, 'prepared.json'), error: report.error }));
  if (!report.complete) process.exitCode = 1;
}
