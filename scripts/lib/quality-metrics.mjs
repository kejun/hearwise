// Metric v1: NFC, Unicode default lowercase, trimmed/collapsed whitespace.
// Punctuation and numbers remain. CER units are Unicode code points, not UTF-16.
export const metricDefinition = Object.freeze({ version: 1, normalization: 'NFC-lowercase-whitespace-v1',
  cer: 'Unicode-code-points-excluding-whitespace', wer: 'whitespace-delimited-tokens',
  references: 'minimum-error-rate; ties choose first reference', aggregate: 'sum-selected-edit-counts / sum-selected-reference-units' });
export function normalizeQualityText(text) {
  if (typeof text !== 'string') throw new Error('QUALITY_TEXT_REQUIRED');
  return text.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ');
}
function units(text, metric) {
  const normalized = normalizeQualityText(text);
  if (metric === 'cer') return [...normalized.replace(/\s/gu, '')];
  if (metric === 'wer') return normalized ? normalized.split(' ') : [];
  throw new Error('UNKNOWN_QUALITY_METRIC');
}
export function editCounts(reference, hypothesis, metric) {
  const a = units(reference, metric), b = units(hypothesis, metric);
  if (!a.length) throw new Error('EMPTY_REFERENCE');
  if (a.length > 12000 || b.length > 12000 || a.length * b.length > 4000000) throw new Error('METRIC_INPUT_LIMIT');
  let previous = Array.from({ length: b.length + 1 }, (_, insertions) => ({ errors: insertions, insertions, deletions: 0, substitutions: 0 }));
  for (let i = 1; i <= a.length; i++) {
    const current = [{ errors: i, insertions: 0, deletions: i, substitutions: 0 }];
    for (let j = 1; j <= b.length; j++) {
      const substitution = a[i - 1] !== b[j - 1];
      const options = [
        { ...previous[j - 1], errors: previous[j - 1].errors + Number(substitution), substitutions: previous[j - 1].substitutions + Number(substitution) },
        { ...previous[j], errors: previous[j].errors + 1, deletions: previous[j].deletions + 1 },
        { ...current[j - 1], errors: current[j - 1].errors + 1, insertions: current[j - 1].insertions + 1 }
      ];
      // Deterministic alignment ties: diagonal, deletion, insertion. Error rate
      // does not depend on this tie rule; deletion attribution can.
      current[j] = options.reduce((best, row) => row.errors < best.errors ? row : best);
    }
    previous = current;
  }
  const result = previous.at(-1);
  return { ...result, referenceUnits: a.length, hypothesisUnits: b.length, errorRate: result.errors / a.length, omissionRate: result.deletions / a.length };
}
export function scoreReferences(references, hypothesis, metric) {
  if (!Array.isArray(references) || !references.length) throw new Error('REFERENCE_REQUIRED');
  const candidates = references.map((reference, referenceIndex) => ({ referenceIndex, ...editCounts(reference, hypothesis, metric) }));
  return candidates.reduce((best, row) => row.errorRate < best.errorRate ? row : best);
}
export function aggregateErrors(rows) {
  if (!rows.length) throw new Error('NO_METRIC_SAMPLES');
  const total = Object.fromEntries(['errors', 'insertions', 'deletions', 'substitutions', 'referenceUnits', 'hypothesisUnits'].map(key =>
    [key, rows.reduce((sum, row) => sum + row[key], 0)]));
  return { ...total, errorRate: total.errors / total.referenceUnits, omissionRate: total.deletions / total.referenceUnits,
    sampleCount: rows.length, perSampleMin: Math.min(...rows.map(row => row.errorRate)), perSampleMax: Math.max(...rows.map(row => row.errorRate)) };
}

export function scoreAsr(references, hypothesis, metric) {
  if (Array.isArray(references) && references.length > 0 && references.every(row => typeof row === 'string' && !normalizeQualityText(row))) {
    return { metric: 'empty-reference-hallucination', referenceUnits: 0, errorRate: null, omissionRate: null,
      hallucination: Boolean(normalizeQualityText(hypothesis)) };
  }
  return { metric, ...scoreReferences(references, hypothesis, metric) };
}
