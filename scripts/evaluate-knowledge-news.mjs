import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_ENDPOINT = 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions';
const HELP = `手动评估新闻样本的真实模型表现（会产生模型调用费用）。

用法：node scripts/evaluate-knowledge-news.mjs --live [--repetitions 1..3]
      node scripts/evaluate-knowledge-news.mjs --help

环境变量：
  HEARWISE_EVAL_API_KEY   必填，仅从环境读取，不写入日志或数据库
  HEARWISE_EVAL_ENDPOINT 可选，与应用相同的默认聊天补全地址

默认每种分组运行 3 次，共 9 次独立试验：全文、三段顺序、模拟最终句。
模拟最终句使用 Intl.Segmenter，最多 3 句一批；它不是原始 ASR 时序。
从各批最终原文入库开始测量，到知识提交回调为止，不包含 ASR、调度器
合批等待、网络推送和浏览器渲染。执行真实存储、校验、定向纠正及重试。
仅输出 JSON 汇总；不输出完整原文、模型回复或 Key。临时 SQLite 自动清理。
费用取决于模型和重试；没有 --live 或没有 Key 时绝不请求模型。
退出码：0=本样本自动检查通过，1=有未通过/执行失败，2=调用方式错误。
自动检查不能代替金额、期限、可能性及 80x 口径的人工语义复核。
`;

function options() {
  let values;
  try {
    ({ values } = parseArgs({ options: { help: { type: 'boolean' }, live: { type: 'boolean' },
      repetitions: { type: 'string', default: '3' } }, allowPositionals: false }));
  } catch { throw new Error('参数无效；请使用 --help。'); }
  if (values.help) return { help: true };
  if (!values.live) throw new Error('必须显式传入 --live 才能运行真实模型评估；使用 --help 查看范围。');
  if (!/^[1-3]$/.test(values.repetitions)) throw new Error('--repetitions 必须是 1、2 或 3。');
  const key = process.env.HEARWISE_EVAL_API_KEY?.trim();
  if (!key) throw new Error('缺少 HEARWISE_EVAL_API_KEY；未发送任何模型请求。');
  const endpoint = process.env.HEARWISE_EVAL_ENDPOINT || DEFAULT_ENDPOINT;
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error('HEARWISE_EVAL_ENDPOINT 不是有效 URL。'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('评估地址必须是无内嵌凭据的 HTTP(S) URL。');
  }
  return { key, endpoint, repetitions: Number(values.repetitions) };
}

const normalized = name => String(name).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const names = item => [item.canonical_name, ...(item.aliases || [])].map(normalized);
const coreNames = ['Anthropic', 'Akamai'];
const sources = new Set(['sethfiegerman', 'seth', 'nora', 'bloombergtech', 'bloomberg']);
const matches = (item, name) => names(item).includes(normalized(name));
const safeError = error => ({
  kind: error?.code === 'KNOWLEDGE_INVALID_RESPONSE' ? 'invalid_response'
    : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout'
      : Number.isInteger(error?.status) ? 'http_error' : 'execution_error',
  ...(Number.isInteger(error?.status) ? { http_status: error.status } : {})
});

function groupings(text) {
  const paragraphs = text.trim().split(/\r?\n+/).filter(Boolean);
  if (paragraphs.length !== 3) throw new Error('FIXTURE_PARAGRAPHS');
  const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .map(entry => entry.segment.trim()).filter(Boolean);
  return [
    { mode: 'whole', groups: [[text.trim()]] },
    { mode: '3paragraph', groups: paragraphs.map(paragraph => [paragraph]) },
    { mode: 'simulatedsentence', groups: Array.from({ length: Math.ceil(sentences.length / 3) },
      (_, i) => sentences.slice(i * 3, i * 3 + 3)) }
  ];
}

async function runTrial({ mode, groups }, repetition, config, api) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hearwise-news-eval-'));
  let store;
  try {
    store = new api.ListeningStore(path.join(directory, 'listening.sqlite'));
    const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'microphone' }, 'news-evaluation');
    const totals = { initial_calls: 0, repair_calls: 0, model_errors: [], initial_rejections: 0, repair_rejections: 0 };
    const core = Object.fromEntries(coreNames.map(name => [name, { ids: new Set(), first_visible_ms: null }]));
    const segmentTexts = new Map();
    const batches = [];
    let active, trialFinalAt, firstVisibleMs = null, lastVisibleMs = null, sentenceNo = 0;
    const workflow = api.createKnowledgeWorkflow({ store, endpoint: config.endpoint,
      extract: async (...args) => { totals.initial_calls++; return api.extractKnowledge(...args); },
      repair: async (...args) => { totals.repair_calls++; return api.repairKnowledge(...args); },
      onError: error => totals.model_errors.push(safeError(error)),
      onRejected: (_job, _part, rejected, stage) => { totals[`${stage}_rejections`] += rejected.length; },
      onItems: (_id, items) => {
        const elapsed = Date.now() - active.final_at;
        active.first_visible_ms ??= elapsed;
        active.last_visible_ms = elapsed;
        firstVisibleMs ??= Date.now() - trialFinalAt;
        lastVisibleMs = Date.now() - trialFinalAt;
        for (const item of items) for (const name of coreNames) if (matches(item, name)) {
          core[name].ids.add(item.id);
          core[name].first_visible_ms ??= Date.now() - trialFinalAt;
        }
      }
    });
    for (const group of groups) {
      active = { batch: batches.length + 1, segment_count: group.length,
        final_at: Date.now(), first_visible_ms: null, last_visible_ms: null, jobs: [] };
      trialFinalAt ??= active.final_at;
      for (const text of group) {
        const { segment } = store.addSegment(run.listeningId, run.runId, { id: String(++sentenceNo), text });
        segmentTexts.set(segment.id, text);
      }
      while (store.extractionRange(run.listeningId).length) {
        const job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
        let result;
        for (let dispatch = 0; dispatch < 100; dispatch++) {
          const next = store.nextJob(run.listeningId);
          if (!next || next.id !== job.id) throw new Error('MISSING_PENDING_JOB');
          const readyAt = Math.max(next.ready_at || 0, next.retry_at ? Date.parse(next.retry_at) : 0);
          // Retain production request spacing; never simulate time during live measurements.
          for (let wait = readyAt - Date.now(); wait > 0; wait = readyAt - Date.now()) await delay(Math.min(wait, 1000));
          const running = store.markJob(next.id, 'running');
          result = await workflow.execute(running, config.key);
          if (result.kind === 'terminal') break;
        }
        if (result?.kind !== 'terminal') throw new Error('DISPATCH_LIMIT');
        active.jobs.push({ outcome: result.outcome, ...result.summary });
      }
      const current = store.knowledge(run.listeningId);
      active.coverage = Object.fromEntries(coreNames.map(name => [name,
        current.filter(item => matches(item, name) && item.display_label === 'organization').length]));
      active.completed_ms = Date.now() - active.final_at;
      delete active.final_at;
      batches.push(active);
      if (totals.model_errors.some(error => [400, 401, 403, 404, 422].includes(error.http_status))) break;
    }
    store.finishRun(run.runId);
    const items = store.knowledge(run.listeningId);
    const cards = Object.fromEntries(coreNames.map(name => [name, items.filter(item => matches(item, name))]));
    const sourceCards = items.filter(item => names(item).some(name => sources.has(name))).length;
    const mentions = items.flatMap(item => item.mentions);
    const supported = mentions.filter(mention => Boolean(api.findVerbatim(segmentTexts.get(mention.segment_id) || '', mention.surface_text))).length;
    const jobs = batches.flatMap(batch => batch.jobs);
    const sum = field => jobs.reduce((total, job) => total + (job[field] || 0), 0);
    const checks = {
      core_companies_separate: coreNames.every(name => cards[name].length === 1 && cards[name][0].display_label === 'organization') &&
        cards.Anthropic[0]?.id !== cards.Akamai[0]?.id,
      core_ids_stable: coreNames.every(name => core[name].ids.size === 1),
      no_source_only_cards: sourceCards === 0,
      no_unresolved: jobs.every(job => ['ok', 'empty'].includes(job.outcome)),
      evidence_verbatim: items.every(item => item.mentions.length > 0) && supported === mentions.length,
      all_groups_processed: batches.length === groups.length
    };
    return { mode, repetition, passed: Object.values(checks).every(Boolean), checks,
      card_count: items.length, source_only_card_count: sourceCards,
      core: Object.fromEntries(coreNames.map(name => [name, { card_count: cards[name].length,
        distinct_ids_seen: core[name].ids.size, first_visible_from_trial_first_final_ms: core[name].first_visible_ms,
        facts: cards[name].reduce((count, item) => count + item.facts.length, 0) }])),
      call_count: totals.initial_calls + totals.repair_calls, initial_call_count: totals.initial_calls,
      repair_call_count: totals.repair_calls, model_errors: totals.model_errors,
      initial_rejected_count: totals.initial_rejections, repair_rejected_count: totals.repair_rejections,
      initial_pass_without_correction: totals.repair_calls === 0 && totals.initial_rejections === 0 &&
        totals.model_errors.length === 0 && Object.values(checks).every(Boolean),
      unresolved_count: sum('unresolved_count'), failed_part_count: sum('failed_part_count'),
      evidence: { total: mentions.length, supported, rate: mentions.length ? supported / mentions.length : null },
      first_visible_from_first_final_ms: firstVisibleMs, last_visible_from_first_final_ms: lastVisibleMs,
      duration_from_first_final_ms: Date.now() - trialFinalAt, batches };
  } finally {
    try { store?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

async function main() {
  let config;
  try { config = options(); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (config.help) { process.stdout.write(HELP); return; }
  // Keep all executable model paths behind both explicit opt-in and key validation.
  const [storage, knowledge, workflow] = await Promise.all([
    import('../storage.mjs'), import('../knowledge.mjs'), import('../knowledge-workflow.mjs')
  ]);
  const text = await readFile(new URL('../test/fixtures/anthropic-akamai-news.txt', import.meta.url), 'utf8');
  const report = { model: knowledge.KNOWLEDGE_MODEL, repetitions: config.repetitions,
    planned_trials: 3 * config.repetitions, trials: [], stopped_early: false,
    measurement: 'Sequential synthetic final-text replay; live model and SQLite commit latency. No original ASR timing, scheduler batching wait, WebSocket or browser latency.',
    semantic_fact_review: 'Required separately for $11.6 billion = 116 亿美元, seven years, potential equity stake, and attributed 80x demand growth. Not inferred from keyword checks.' };
  outer: for (const grouping of groupings(text)) for (let repetition = 1; repetition <= config.repetitions; repetition++) {
    try {
      const trial = await runTrial(grouping, repetition, config, { ...storage, ...knowledge, ...workflow });
      report.trials.push(trial);
      if (trial.model_errors.some(error => [400, 401, 403, 404, 422].includes(error.http_status))) {
        report.stopped_early = true;
        report.stop_reason = 'model_configuration_rejected';
        break outer;
      }
    } catch (error) {
      report.trials.push({ mode: grouping.mode, repetition, passed: false, error: safeError(error) });
      report.stopped_early = true;
      report.stop_reason = 'evaluation_execution_failed';
      break outer;
    }
  }
  const count = report.trials.length;
  report.summary = { completed_trials: count, passed_trials: report.trials.filter(trial => trial.passed).length,
    initial_pass_trials: report.trials.filter(trial => trial.initial_pass_without_correction).length,
    repair_trials: report.trials.filter(trial => trial.repair_call_count > 0).length,
    unresolved_trials: report.trials.filter(trial => trial.unresolved_count > 0 || trial.failed_part_count > 0).length,
    call_count: report.trials.reduce((sum, trial) => sum + (trial.call_count || 0), 0) };
  report.summary.pass_rate = count ? report.summary.passed_trials / count : null;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.stopped_early || report.summary.passed_trials !== count) process.exitCode = 1;
}

main().catch(() => {
  // Never print an upstream message: providers may echo request data or credentials.
  console.error('评估执行失败；未输出服务端原始错误。');
  process.exitCode = 1;
});
