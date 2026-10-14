// One continuous real-browser journey; this roster is input to collectors and
// independent readers, never a passing summary supplied by an evidence report.
export const journeyWidths = Object.freeze([1280, 390]);
export const journeyStages = Object.freeze([
  'empty', 'listening-started', 'captions', 'stopped', 'graph-held', 'graph-cancelled',
  'graph-retry-complete', 'graph-late-completed', 'unrelated-created', 'name-corrected',
  'conflict-opened', 'conflict-rejected', 'conflict-recovered', 'receipt-recovered',
  'save-uncertain', 'save-reopened', 'source-played', 'translation-played', 'paused-seek',
  'seek-resumed', 'history-reopened', 'context-reopened', 'exported', 'unrelated-deleted',
  'import-reviewed-stale', 'import-stale-rejected', 'import-token-expired', 'import-expiry-rejected',
  'import-reuploaded', 'import-collision-preserved',
  'final-exported', 'main-deleted', 'import-reviewed', 'import-restored', 'restored-reopened'
]);
export const journeyScreenshots = Object.freeze(journeyWidths.flatMap(width => [
  ...journeyStages.map(stage => `journey-${width}-${stage}.png`), `journey-${width}-negative.png`
]));
export const journeyServedFiles = Object.freeze([
  'public/app.js', 'public/knowledge-editor.js', 'public/knowledge-graph.js',
  'public/speech-controller.js', 'public/speech-player.js', 'public/speech-output-processor.js'
]);
export const journeyLimits = Object.freeze({ browserMs: 140000, overallMs: 150000, aggregateMs: 180000, cleanupMs: 10000 });
export const journeyExternalAcceptance = Object.freeze({ quality: 'not_run', device: 'not_run', performance: 'not_run' });
export const journeyTitle = 'Journey main';
export const journeyUnrelatedTitle = 'Journey unrelated';
