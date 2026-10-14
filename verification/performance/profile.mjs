// Provisional, synthetic collection domains, not supported product limits.
// Release targets are frozen separately only after a reproducible baseline exists.
export const performanceRecipes = Object.freeze([
  { version: 1, tier: 'small', listenings: 20, segmentsPerBackground: 20, graphRecords: 2, nodesPerGraph: 20, isolatedPerGraph: 2, textCharacters: 240, seed: 20261014 },
  { version: 1, tier: 'medium', listenings: 100, segmentsPerBackground: 100, graphRecords: 2, nodesPerGraph: 100, isolatedPerGraph: 10, textCharacters: 240, seed: 20261014 },
  { version: 1, tier: 'large', listenings: 500, segmentsPerBackground: 200, graphRecords: 2, nodesPerGraph: 500, isolatedPerGraph: 50, textCharacters: 240, seed: 20261014 }
]);
export const performanceNetworks = Object.freeze([
  { id: 'loopback', latencyMs: 0, downloadBytesPerSecond: -1, uploadBytesPerSecond: -1 },
  { id: 'constrained', latencyMs: 100, downloadBytesPerSecond: 1250000, uploadBytesPerSecond: 625000 }
]);
export const performanceBrowser = Object.freeze({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1,
  locale: 'zh-CN', timezoneId: 'UTC', reducedMotion: 'reduce', headless: true });
export const performanceProfiles = Object.freeze({
  baseline: { sampling: { warmups: 2, repetitions: 20 }, tiers: ['small', 'medium', 'large'], networks: ['loopback', 'constrained'], releaseCollection: true },
  smoke: { sampling: { warmups: 0, repetitions: 2 }, tiers: ['small'], networks: ['loopback'], releaseCollection: false }
});
export const backendPhases = Object.freeze(['history-first-page', 'history-second-page', 'record-primary', 'record-secondary', 'graph-primary', 'post-import-history', 'post-import-graph']);
export const backendMetrics = Object.freeze(['wallMs', 'serverCpuMs', 'serverRssAfterBytes', 'serverHeapUsedAfterBytes', 'serverLifetimeMaxRssAfterKiB']);
export const performanceTimeouts = Object.freeze({ preparationMs: 600000, preparationRunMs: 1800000, backendMs: 180000, browserMs: 600000, actionMs: 15000, runMs: 2400000 });
