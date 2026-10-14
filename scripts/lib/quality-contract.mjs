import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { metricDefinition, normalizeQualityText } from './quality-metrics.mjs';
export const qualityVersion = 1;
export const qualityCategories = ['daily', 'technical', 'numbers-time-money', 'negation-condition', 'proper-names', 'long-sentences', 'accent-noise', 'multilingual', 'silence-empty', 'ambiguity'];
export const seriousErrorTypes = ['number', 'negation', 'condition', 'attribution', 'omission'];
export const qualityProperties = Object.freeze({ asr: 'HW-01-05', mt: 'HW-02-05' });
export const languageTargets = { en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean' };
export const hashBytes = value => createHash('sha256').update(value).digest('hex');
export const hashJson = value => hashBytes(JSON.stringify(value) ?? 'null');
export const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const contractDigest = value => hashJson(canonical(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => /^[a-f0-9]{64}$/.test(value || '');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => text(value) && Number.isFinite(Date.parse(value));
const https = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; } catch { return false; } };
const providerUrl = (value, protocol) => { try { const u = new URL(value); return u.protocol === protocol && !u.username && !u.password && !u.hash && !u.search; } catch { return false; } };
export function estimateQualityBudget(config, samples) {
  const attempts = { asr: 0, mt: 0 };
  for (const sample of samples.filter(row => row.split === 'acceptance')) for (const task of sample.tasks || []) attempts[task] += (task === 'asr' ? 2 : 1) * config.repetitions * 2;
  const attemptMicros = {};
  for (const kind of ['asr', 'mt']) {
    const b = config.budget?.bounds?.[kind];
    if (!b || !['inputUnitsUpper', 'outputUnitsUpper', 'inputUnitMicros', 'outputUnitMicros', 'fixedMicros'].every(key => integer(b[key]))) return null;
    attemptMicros[kind] = b.inputUnitsUpper * b.inputUnitMicros + b.outputUnitsUpper * b.outputUnitMicros + b.fixedMicros;
    if (!Number.isSafeInteger(attemptMicros[kind]) || attemptMicros[kind] <= 0) return null;
  }
  const worstCaseMicros = attempts.asr * attemptMicros.asr + attempts.mt * attemptMicros.mt;
  return Number.isSafeInteger(worstCaseMicros) && worstCaseMicros > 0 ? { attempts, attemptMicros, worstCaseMicros, currency: config.budget.currency } : null;
}
export async function inspectQualityPlan(configFile, { now = Date.now() } = {}) {
  const configPath = path.resolve(configFile), root = path.dirname(configPath), config = JSON.parse(await readFile(configPath, 'utf8'));
  const corpusPath = path.resolve(root, config.corpusFile || ''), corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const issues = [], assets = {};
  const require = (condition, code) => { if (!condition) issues.push(code); };
  require(config.schemaVersion === qualityVersion && corpus.schemaVersion === qualityVersion, 'schema_version');
  require(text(config.id) && text(corpus.id) && Number.isSafeInteger(corpus.version) && corpus.version > 0, 'corpus_identity');
  require(Number.isSafeInteger(config.repetitions) && config.repetitions >= 2 && config.repetitions <= 10, 'repetitions_not_frozen');
  require(contractDigest(config.metrics) === contractDigest(metricDefinition), 'metric_definition_not_frozen');
  require(config.humanRubric?.version === 'meaning-0-to-4-v1' && contractDigest(config.humanRubric.seriousTypes) === contractDigest(seriousErrorTypes), 'human_rubric_not_frozen');
  const thresholds = config.thresholds;
  require(thresholds && ['asrErrorRateMax', 'asrOmissionRateMax', 'asrRegressionMax', 'mtMeaningRetentionMin', 'mtRegressionMax'].every(key =>
    typeof thresholds[key] === 'number' && Number.isFinite(thresholds[key]) && thresholds[key] >= 0 && thresholds[key] <= 1) && thresholds.seriousErrorMax === 0 && thresholds.asrSilenceHallucinationsMax === 0, 'thresholds_not_frozen');
  require(config.directions && Object.keys(config.directions).length > 0 && Object.entries(config.directions).every(([source, target]) => languageTargets[source] && Object.values(languageTargets).includes(target) && languageTargets[source] !== target), 'directions_not_frozen');
  require(text(config.approval?.reviewer) && text(config.approval?.reference) && time(config.approval?.at) && Date.parse(config.approval.at) <= now &&
    config.approval?.beforeCandidateGeneration === true && Array.isArray(config.reviewers) && config.reviewers.length > 0 && config.reviewers.every(text), 'human_approval_missing');
  for (const role of ['baseline', 'candidate']) {
    const c = config.roles?.[role];
    require(c && /^[a-f0-9]{40}$/.test(c.sourceSha || '') && text(c.asrModel) && text(c.mtModel) &&
      providerUrl(c.asrEndpoint, 'wss:') && providerUrl(c.mtEndpoint, 'https:'), `${role}_configuration_missing`);
    require(c?.requestTemplateVersion === 'hearwise-public-routes-v1' &&
      ['classic', 'realtime'].includes(c?.captionMode) && c?.sentenceSilenceMs === 2500 && Number.isSafeInteger(c?.maxConnectionMs) && c.maxConnectionMs >= 1000 && c.maxConnectionMs <= 120000 && Number.isSafeInteger(c.maxRunMs) && c.maxRunMs >= 1000 && c.maxRunMs <= 86400000, `${role}_unsupported_adapter_configuration`);
    if (/^[a-f0-9]{40}$/.test(c?.sourceSha || '')) {
      try { c.sourceTree = execFileSync('git', ['rev-parse', `${c.sourceSha}^{tree}`], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 5000 }).trim();
        c.requestBuilderSha256 = hashBytes(execFileSync('git', ['show', `${c.sourceSha}:server.mjs`], { stdio: ['ignore','pipe','ignore'], timeout: 5000 }));
      } catch { require(false, `${role}_source_unavailable`); }
    }
  }
  const samples = corpus.samples;
  require(Array.isArray(samples) && samples.length > 0, 'corpus_missing');
  const identities = new Set(), textsBySplit = new Map(), audioBySplit = new Map();
  for (const sample of samples || []) {
    const prefix = `sample:${sample.id || '?'}`;
    require(text(sample.id) && !identities.has(sample.id), `${prefix}:duplicate_id`); identities.add(sample.id);
    require(['development', 'acceptance'].includes(sample.split) && ['normal', 'difficult'].includes(sample.difficulty), `${prefix}:split_difficulty`);
    require(Array.isArray(sample.tasks) && sample.tasks.length > 0 && new Set(sample.tasks).size === sample.tasks.length && sample.tasks.every(task => ['asr', 'mt'].includes(task)), `${prefix}:tasks`);
    require(Array.isArray(sample.categories) && sample.categories.length > 0 && sample.categories.every(category => qualityCategories.includes(category)), `${prefix}:categories`);
    require(languageTargets[sample.language] && config.directions?.[sample.language] === sample.target, `${prefix}:direction`);
    require(sample.kind === 'real-recording-and-human-text' && sample.provenance?.redistributionApproved === true && text(sample.provenance?.source) && text(sample.provenance?.sourceItemId) &&
      text(sample.provenance?.license) && https(sample.provenance?.licenseUrl) && text(sample.provenance?.attribution) && text(sample.provenance?.selectionRule), `${prefix}:provenance_unapproved`);
    require(text(sample.gold?.reviewer) && time(sample.gold?.reviewedAt) && Date.parse(sample.gold.reviewedAt) <= now && sample.gold?.approved === true &&
      Array.isArray(sample.gold?.criticalFacts) && (sample.silence === true || sample.gold.criticalFacts.length > 0) &&
      sample.gold.criticalFacts.every(row => seriousErrorTypes.includes(row.type) && text(row.meaning)), `${prefix}:gold_unreviewed`);
    require((text(sample.text) || sample.silence === true && sample.text === '' && sample.tasks?.length === 1 && sample.tasks[0] === 'asr') && sample.text.length <= 3000, `${prefix}:text_limit`);
    if (text(sample.text)) {
      const fingerprint = hashBytes(normalizeQualityText(sample.text));
      require(!textsBySplit.has(fingerprint) || textsBySplit.get(fingerprint) === sample.split, `${prefix}:development_acceptance_overlap`); textsBySplit.set(fingerprint, sample.split);
    }
    if (sample.tasks?.includes('asr')) {
      require(['cer', 'wer'].includes(sample.asrMetric) && (sample.asrMetric !== 'wer' || sample.language === 'en'), `${prefix}:asr_metric`);
      require(Array.isArray(sample.gold?.transcripts) && sample.gold.transcripts.length > 0 && sample.gold.transcripts.every(value => text(value) || sample.silence === true && value === ''), `${prefix}:transcript_missing`);
      require(sample.silence === true ? sample.gold?.transcripts?.every(value => value === '') : sample.gold?.transcripts?.every(text), `${prefix}:silence_reference_mismatch`);
      const audio = sample.audio;
      require(audio?.format === 'pcm-s16le-mono-16000' && text(audio.path) && sha(audio.sha256) && integer(audio.bytes) && audio.bytes > 0 && audio.bytes % 2 === 0 && audio.bytes <= 32000 * 90 &&
        audio.durationMs === audio.bytes / 32 && text(audio.transform), `${prefix}:real_audio_missing`);
      if (text(audio?.path)) {
        try {
          const filename = path.resolve(path.dirname(corpusPath), audio.path), bytes = await readFile(filename); assets[audio.path] = hashBytes(bytes);
          require(assets[audio.path] === audio.sha256 && bytes.length === audio.bytes, `${prefix}:audio_hash_or_length`);
          require(!audioBySplit.has(assets[audio.path]) || audioBySplit.get(assets[audio.path]) === sample.split, `${prefix}:audio_split_overlap`); audioBySplit.set(assets[audio.path], sample.split);
        } catch { require(false, `${prefix}:audio_unreadable`); }
      }
    }
    if (sample.tasks?.includes('mt')) require(Array.isArray(sample.gold?.translations) && sample.gold.translations.length > 0 && sample.gold.translations.every(text), `${prefix}:translation_references_missing`);
  }
  for (const task of ['asr', 'mt']) for (const category of qualityCategories) for (const difficulty of ['normal', 'difficult'])
    if (!(task === 'mt' && category === 'silence-empty')) require(samples?.some(row => row.split === 'acceptance' && row.tasks?.includes(task) && row.categories?.includes(category) && row.difficulty === difficulty), `coverage:${task}:${category}:${difficulty}`);
  for (const language of Object.keys(config.directions || {})) for (const task of ['asr', 'mt']) require(samples?.some(row => row.split === 'acceptance' && row.language === language && row.tasks?.includes(task)), `coverage:${task}:${language}`);
  require(samples?.some(row => row.split === 'development'), 'development_split_missing');
  for (const type of seriousErrorTypes) require(samples?.some(row => row.split === 'acceptance' && row.gold?.criticalFacts?.some(fact => fact.type === type)), `critical_fact_coverage:${type}`);
  const b = config.budget;
  require(text(b?.id) && ['USD', 'CNY'].includes(b?.currency) && text(b?.approvedBy) && text(b?.approvalReference) && time(b?.approvedAt) && Date.parse(b.approvedAt) <= now && time(b?.expiresAt) && Date.parse(b.expiresAt) > now && integer(b?.ceilingMicros) && b.ceilingMicros > 0, 'budget_approval_missing');
  require(text(b?.ledgerFile), 'persistent_budget_ledger_missing');
  // Bind the one approved ledger location, not a per-checkout relative path.
  // Moving a frozen plan cannot silently start a new baseline/candidate budget.
  if (text(b?.ledgerFile)) b.ledgerFile = path.resolve(root, b.ledgerFile);
  for (const kind of ['asr', 'mt']) {
    const bound = b?.bounds?.[kind];
    require(bound?.reviewed === true && text(bound.reviewedBy) && https(bound.sourceUrl) && sha(bound.sourceDocumentSha256) && time(bound.checkedAt) && Date.parse(bound.checkedAt) <= now &&
      time(bound.validUntil) && Date.parse(bound.validUntil) > now && text(bound.rationale) && bound.coversRetriesAndHiddenCharges === true && bound.usesDiscounts === false &&
      (kind !== 'mt' || bound.outputLimitEnforcedBy === 'documented-provider-hard-limit') && (kind !== 'asr' || bound.includesWallClockCap === true), `billing_upper_bound_unknown:${kind}`);
    const configurations = Object.values(config.roles || {}).map(role => ({ model: role[`${kind}Model`], endpoint: role[`${kind}Endpoint`] }));
    require(Array.isArray(bound?.appliesTo) && configurations.every(configuration => bound.appliesTo.some(row =>
      row?.model === configuration.model && row?.endpoint === configuration.endpoint && row?.currency === b.currency)), `billing_model_or_endpoint_uncovered:${kind}`);
  }
  for (const kind of ['asr', 'mt']) {
    const bound = b?.bounds?.[kind];
    if (!bound) continue;
    if (text(bound.sourceDocumentFile)) {
      try { const bytes = await readFile(path.resolve(root, bound.sourceDocumentFile)); assets[`billing:${kind}:${bound.sourceDocumentFile}`] = hashBytes(bytes);
        require(hashBytes(bytes) === bound.sourceDocumentSha256, `billing_document_changed:${kind}`);
      } catch { require(false, `billing_document_missing:${kind}`); }
    } else require(false, `billing_document_missing:${kind}`);
    if (kind === 'asr') {
      const quantum = bound.billingQuantumMs, tail = bound.billingTailMs, minimum = bound.minimumBillableMs;
      const maxAudioMs = Math.max(...(samples || []).filter(sample => sample.tasks?.includes('asr')).map(sample => sample.audio?.durationMs ?? NaN));
      const basis = bound.durationBasis === 'received-pcm-duration' && bound.providerChargesOnlyReceivedAudio === true ? maxAudioMs :
        bound.durationBasis === 'provider-hard-session-duration' && integer(bound.providerHardSessionMs) && bound.providerHardSessionMs > 0 ? bound.providerHardSessionMs : NaN;
      const upper = integer(quantum) && quantum > 0 && integer(tail) && integer(minimum) ? Math.ceil(Math.max(basis + tail, minimum) / quantum) * quantum : NaN;
      require(bound.inputUnit === 'millisecond' && bound.outputUnitsUpper === 0 && Number.isSafeInteger(upper) && bound.inputUnitsUpper >= upper, 'asr_duration_bound_unproven');
      for (const sample of samples || []) if (sample.tasks?.includes('asr') && sample.audio?.durationMs != null)
        require(Object.values(config.roles || {}).every(role => sample.audio.durationMs + 15000 <= role.maxConnectionMs) &&
          (bound.durationBasis !== 'provider-hard-session-duration' || sample.audio.durationMs + 15000 <= bound.providerHardSessionMs), `sample:${sample.id}:audio_exceeds_connection_cap`);
    } else {
      require(bound.inputUnit === 'token' && bound.outputUnit === 'token' && bound.tokenUpperBoundMethod === 'provider-hard-input-and-output-limits' &&
        integer(bound.providerInputTokenLimit) && bound.providerInputTokenLimit > 0 && integer(bound.providerOutputTokenLimit) && bound.providerOutputTokenLimit > 0 &&
        bound.inputUnitsUpper >= bound.providerInputTokenLimit && bound.outputUnitsUpper >= bound.providerOutputTokenLimit &&
        integer(bound.providerRequestByteLimit) && bound.providerRequestByteLimit > 0, 'mt_token_bound_unproven');
      for (const sample of samples || []) if (sample.tasks?.includes('mt') && typeof sample.text === 'string') for (const role of Object.values(config.roles || {})) {
        const wire = JSON.stringify({ model: role.mtModel, messages: [{ role: 'user', content: sample.text.trim() }], translation_options: { source_lang: 'auto', target_lang: sample.target } });
        require(Buffer.byteLength(wire) <= bound.providerRequestByteLimit, `sample:${sample.id}:mt_request_exceeds_billing_bound`);
      }
    }
  }
  const estimate = estimateQualityBudget(config, samples || []);
  require(estimate && estimate.worstCaseMicros <= b?.ceilingMicros, 'worst_case_exceeds_budget_or_unknown');
  const plan = { config, corpus, assets };
  return { schemaVersion: qualityVersion, configPath, corpusPath, config, corpus, assets, digest: contractDigest(plan),
    issues, eligibleForFreeze: issues.length === 0, qualityStatus: 'not_run', estimate };
}
export async function freezeQualityPlan(configFile, destination) {
  const inspected = await inspectQualityPlan(configFile);
  if (!inspected.eligibleForFreeze) throw Object.assign(new Error('QUALITY_PLAN_NOT_READY'), { issues: inspected.issues });
  const frozen = { schemaVersion: qualityVersion, kind: 'frozen-quality-plan', frozenAt: new Date().toISOString(), configFile: path.relative(path.dirname(path.resolve(destination)), inspected.configPath),
    digest: inspected.digest, config: inspected.config, corpus: inspected.corpus, assets: inspected.assets };
  await writeFile(destination, JSON.stringify(frozen, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return frozen;
}
export async function readFrozenQualityPlan(filename, { forCollection = true } = {}) {
  const frozen = JSON.parse(await readFile(filename, 'utf8'));
  if (frozen.schemaVersion !== qualityVersion || frozen.kind !== 'frozen-quality-plan' || !time(frozen.frozenAt) || Date.parse(frozen.frozenAt) > Date.now()) throw new Error('INVALID_FREEZE');
  const configPath = path.resolve(path.dirname(path.resolve(filename)), frozen.configFile);
  // Spending needs current approval; historical assessment checks approval at
  // freeze time and every actual upstream start against its original expiry.
  const current = await inspectQualityPlan(configPath, { now: forCollection ? Date.now() : Date.parse(frozen.frozenAt) });
  if (!current.eligibleForFreeze || current.digest !== frozen.digest || contractDigest({ config: frozen.config, corpus: frozen.corpus, assets: frozen.assets }) !== frozen.digest) throw new Error('FREEZE_CHANGED_OR_EXPIRED');
  const approvals = [frozen.config.approval.at, frozen.config.budget.approvedAt, ...Object.values(frozen.config.budget.bounds).map(row => row.checkedAt), ...frozen.corpus.samples.map(row => row.gold.reviewedAt)];
  if (approvals.some(value => Date.parse(value) > Date.parse(frozen.frozenAt))) throw new Error('FREEZE_PRECEDES_APPROVAL');
  return { ...frozen, freezePath: path.resolve(filename), configPath, freezeFileSha256: hashBytes(await readFile(filename)), corpusPath: current.corpusPath, estimate: current.estimate };
}

export function qualityBudgetConfig(frozen) {
  const b = frozen.config.budget;
  return { id: b.id, currency: b.currency, ceilingMicros: b.ceilingMicros, requireRunClaim: true,
    maxAttempts: frozen.estimate.attempts, attemptMicros: frozen.estimate.attemptMicros,
    expiresAt: new Date(Math.min(Date.parse(b.expiresAt), ...Object.values(b.bounds).map(row => Date.parse(row.validUntil)))).toISOString() };
}
