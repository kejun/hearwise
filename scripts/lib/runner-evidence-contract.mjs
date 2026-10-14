import { nameBrowserAssets } from '../../test-support/name-protocol-browser-evidence.mjs';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { digest, sourceVersion } from './verification-evidence.mjs';

export const browserChecks = ['speech', 'speech-seek', 'graph', 'relation-progress', 'trace', 'transcript', 'knowledge-edit', 'data-transfer', 'knowledge-name', 'knowledge-revision', 'session', 'relation-result', 'security', 'import-protocol', 'edit-consistency', 'trace-business', 'playback', 'import-atomicity', 'name-protocol'];
export async function findNodeTests(directory = 'test') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory() ? findNodeTests(path.join(directory, entry.name)) :
    /\.test\.[cm]?js$/.test(entry.name) ? [path.join(directory, entry.name).split(path.sep).join('/')] : []));
  return files.flat().sort();
}
export const rootScreenshots = {
  SPEECH_SCREENSHOT: 'speech.png', PINNED_SCREENSHOT: 'pinned-caption.png', SPEECH_TRANSCRIPT_SCREENSHOT: 'transcript.png',
  CAPTION_PANEL_SCREENSHOT: 'caption-panel.png', SPEECH_PANEL_SCREENSHOT: 'speech-panel.png', SPEECH_SETTINGS_SCREENSHOT: 'speech-settings.png',
  FISH_SETTINGS_SCREENSHOT: 'fish-settings.png', INCREMENTAL_SETTINGS_SCREENSHOT: 'incremental-settings.png',
  INCREMENTAL_SETTINGS_MOBILE_SCREENSHOT: 'incremental-settings-mobile.png', INCREMENTAL_SCREENSHOT: 'incremental-caption.png',
  INCREMENTAL_CORRECTION_SCREENSHOT: 'incremental-correction.png',
  ...Object.fromEntries(['desktop', 'mobile', 'pinned-desktop', 'pinned-mobile'].flatMap(size => ['min', 'max'].map(bound =>
    [`CAPTION_SIZE_${size.replaceAll('-', '_').toUpperCase()}_${bound.toUpperCase()}_SCREENSHOT`, `caption-size-${size}-${bound}.png`])))
};
export const browserScreenshots = {
  'import-atomicity': ['append', 'replace'].flatMap(mode => [`atomicity-${mode}-failure.png`, `atomicity-${mode}-restored.png`]),
  'name-protocol': nameBrowserAssets.filter(file => file.endsWith('.png')),
  playback: [...[1280, 390].flatMap(width => ['text', 'paused-seek', 'stale-events', 'unlock-race'].map(name => `playback-${width}-${name}.png`)), 'playback-1280-negative-unlock.png'],
  'trace-business': ['trace-business-desktop.png', 'trace-business-mobile.png', 'trace-business-incomplete.png'],
  speech: Object.values(rootScreenshots),
  'speech-seek': [1280, 390].map(width => `speech-seek-${width}.png`),
  graph: ['history-loading-desktop', 'history-loading-mobile', 'graph-desktop-node', 'graph-desktop-fullscreen', 'graph-desktop-overview',
    'graph-desktop-evidence', 'graph-mobile-overview', 'graph-mobile-fullscreen', 'graph-mobile-landscape-fullscreen', 'graph-mobile-node',
    'graph-mobile-evidence', 'graph-live-arrival-inline', 'graph-mobile-long-name', 'graph-mobile-unbroken-latin-name',
    'graph-desktop-dense-fixture', 'graph-desktop-dense-relation', 'graph-desktop-dense-fullscreen', 'graph-wide-fullscreen', 'graph-empty-fullscreen'].map(name => `${name}.png`),
  'relation-progress': ['relation-progress-desktop-waiting', 'relation-progress-desktop-cancelled', 'relation-progress-desktop-paused',
    'relation-progress-mobile-paused', 'relation-progress-mobile-running', 'relation-progress-mobile-cancelled', 'relation-progress-mobile-complete',
    'relation-progress-desktop-complete', 'relation-progress-desktop-partial', 'relation-diagnostics-mobile-retry-confirmation', 'relation-diagnostics-mobile-unknown'].map(name => `${name}.png`),
  trace: ['trace-desktop.png', 'trace-mobile.png', 'business-overview.png', 'trace-full-pipeline.png'],
  ...Object.fromEntries(['transcript', 'knowledge-edit', 'data-transfer', 'knowledge-name', 'knowledge-revision'].map(name => [name, [1280, 390].map(width => `${name}-${width}.png`)])),
  security: ['security-stored-text.png', 'security-reopened-graph.png', 'security-live-provider-text.png'],
  'import-protocol': [...['append', 'replace'].flatMap(mode => [
    ...[1280, 390, 320].map(width => `${mode}-stale-review-requires-second-confirmation-${width}.png`),
    `${mode}-expired-upload-expired-1280.png`]), 'append-stale-refresh-expiry-expired-preview-error-1280.png'],
  'edit-consistency': [...[1280, 390].flatMap(width => ['conflict', 'unknown-502', 'unknown-lost', 'rollback', 'late-success'].map(name => `edits-${width}-${name}.png`)), 'edits-390-auto-resend-negative.png'],
  session: [...[1280, 390].flatMap(width => ['permission', 'disconnect', 'recovered'].map(scenario => `session-${width}-${scenario}.png`)), 'session-source-version.png'],
  'relation-result': [1280, 390].flatMap(width => ['shortage', 'empty', 'filtered', 'qualified', 'partial', 'error'].map(scenario => `relations-${width}-${scenario}.png`))
};
export async function sourceSnapshot() {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeout: 10000 }).toString('utf8').split('\0').filter(Boolean);
  paths.push('dist/server/index.js', 'public/vendor/cytoscape.js');
  const files = [...new Set(paths)].sort();
  const digests = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(file))])));
  const { createTaskRuntime } = await import(pathToFileURL(path.resolve('dist/server/index.js')).href + `?evidence=${digests['dist/server/index.js']}`);
  const runtime = createTaskRuntime({ enabled: false }); let runtimeBuild;
  try { runtimeBuild = structuredClone(runtime.diagnostics().build); } finally { await runtime.dispose(); }
  return { source: sourceVersion(), digests, runtimeBuild, lockDigest: digests['package-lock.json'] };
}
export const validBuildSource = snapshot => Boolean(snapshot?.runtimeBuild && /^[a-f0-9]{40}$/.test(snapshot.runtimeBuild.git_sha) &&
  snapshot.runtimeBuild.instrumentation_version === 3 && snapshot.runtimeBuild.git_sha === snapshot.source?.sha && snapshot.runtimeBuild.build_dirty === snapshot.source?.dirty);
export const sameSourceSnapshot = (before, after) => Boolean(before?.digests && Object.keys(before.digests).length && isDeepStrictEqual(before, after));
export const executionEnvironment = () => ({ executionRepositoryRoot: process.cwd(), tools: { node: process.version, sqlite: process.versions.sqlite }, environment: { platform: process.platform, arch: process.arch, release: os.release() } });
export const safeRelative = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..');
export async function evidenceFiles(directory, prefix = '') {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!safeRelative(relative) || entry.isSymbolicLink()) throw new Error('Evidence contains an unsafe path or symlink');
    if (entry.isDirectory()) paths.push(...await evidenceFiles(directory, relative));
    else if (entry.isFile()) paths.push(relative);
  }
  return paths.sort();
}
export async function hashEvidenceFiles(directory, files) {
  return Promise.all(files.map(async file => {
    if (!safeRelative(file) || !(await lstat(path.join(directory, file))).isFile()) throw new Error('Evidence must be a regular relative file');
    return { path: file, sha256: digest(await readFile(path.join(directory, file))) };
  }));
}
