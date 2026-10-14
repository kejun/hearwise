export const baselinePhases = ['warmup', 'continuous', 'stop-start', 'switching', 'background', 'post-import'];
export function summarizeLatencies(samples) {
  return Object.fromEntries(['audioToCaptionMs', 'finalToTranslationMs', 'audioToTranslationMs', 'finalToKnowledgeMs', 'audioToKnowledgeMs', 'finalToTranslationHttpObservedMs', 'finalToKnowledgeHttpObservedMs'].map(key => {
    const values = samples.filter(row => row.phase !== 'warmup').map(row => row[key]).filter(Number.isFinite).sort((a, b) => a - b);
    const rank = q => values[Math.ceil(values.length * q) - 1] ?? null;
    return [key, { count: values.length, p50: rank(.5), p95: rank(.95), p99: rank(.99), min: values[0] ?? null, max: values.at(-1) ?? null }];
  }));
}
export function validateBaselineRun(run) {
  const reasons = [];
  if (!run?.complete || !run.cleanup?.confirmed) reasons.push('incomplete_or_unclean');
  for (const phase of baselinePhases) if (!run?.phases?.some(row => row.name === phase && row.complete)) reasons.push(`missing_phase:${phase}`);
  if (!run?.samples?.length || run.samples.some(row => !Number.isFinite(row.audioToCaptionMs) || (!Number.isFinite(row.finalToTranslationMs) && !Number.isFinite(row.finalToTranslationHttpObservedMs)))) reasons.push('missing_latency_samples');
  if (!run?.samples?.some(row => Number.isFinite(row.finalToKnowledgeMs))) reasons.push('missing_knowledge_latency');
  if (!run?.runs?.length || run.runs.some(row => !Number.isFinite(row.startToFirstPcmMs))) reasons.push('missing_pcm_latency');
  if (!run?.resourceSamples || !run?.quiescent?.length) reasons.push('missing_resource_samples');
  if (run?.error) reasons.push(run.error);
  return { ok: !reasons.length, reasons, acceptanceStatus: 'not_run', fullProjectAcceptance: false };
}
