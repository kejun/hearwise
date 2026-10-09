import type { ReportSpan, TraceReport } from './report.js';
import type { TraceEvent } from '../../shared/diagnostics.js';

export const BUSINESS_DOMAINS = [
  { key: 'recognition', label: '语音识别', unit: '会话' },
  { key: 'translation', label: '翻译', unit: '任务' },
  { key: 'knowledge', label: '知识整理', unit: '批次' },
  { key: 'relation', label: '关系提取', unit: '窗口任务' },
  { key: 'speech', label: '播报', unit: '语音单元' }
] as const;
const calls = new Set(['knowledge.http', 'translation.http', 'relation.http', 'speech.http', 'speech.stream']);
const businessSteps = new Set(['recognition.session', 'knowledge.execute', 'relation.execute', 'translation.execute',
  'translation.phrase', 'translation.preview', 'translation.check', 'speech.unit', 'speech.session']);
const purposeNames: Record<string, string> = { name_correction: '知识名称校正', preview: '预览 / 试听', check: '模型检查', realtime: '定稿翻译',
  background: '后台 / 恢复翻译', phrase: '提前播报短句', remainder: '提前播报尾句', original: '全文原文',
  translation: '全文译文', replay: '单句回放', live: '实时播报' };
const activities: Record<string, string> = { provider_started: '获准调用服务', request_started: '请求已发起',
  response_headers: '收到响应头', response_received: '收到响应体', checkpoint_reserved: '已预留请求',
  checkpoint_committed: '结果已提交', translation_committed: '译文已提交 / 交付', notification_sent: '通知已发送',
  first_pcm: '收到首段音频', pcm_sent: '音频已发送', browser_consumed: '客户端报告消费音频',
  playback_completed: '客户端报告播放完成', paused: '已暂停', resumed: '已恢复', draining: '收尾播放',
  waiting_translation: '等待译文', retry_scheduled: '已安排重试', source_committed: '原文已定稿',
  admitted: '任务已获准执行', passthrough: '同语言直通', cancel_requested: '已请求取消', source_linked: '关联输入句子' };
const terminalNames: Record<string, string> = { succeeded: '执行完成', failed: '执行失败', cancelled: '执行取消' };
const activityOf = (event: TraceEvent) => {
  if (event.state === 'succeeded') {
    const business: Record<string, string> = { continue: '本次执行结束，等待后续调度', partial: '本次执行部分完成',
      failed: '业务结果失败', invalid: '业务结果无效', discarded: '结果已丢弃', empty: '执行完成，结果为空' };
    if (business[String(event.attributes.outcome)]) return business[String(event.attributes.outcome)]!;
  }
  return activities[String(event.event)] ?? terminalNames[event.state] ?? '开始执行';
};
const endSequence = (span: ReportSpan) => span.events.at(-1)?.sequence ?? 0;
const attributes = (span: ReportSpan) => Object.assign({}, ...span.events.map(e => e.attributes)) as Record<string, unknown>;
const validDuration = (span: ReportSpan) => !span.issues.length && span.start !== undefined && span.duration !== undefined;
export interface BusinessTask {
  id: string; domain: string; label: string; purpose: string; state: string; quality: string; process: string;
  spanIds: string[]; focus: string; segments: string[]; calls: number; callMs: number; lastAt: number; activity: string;
  sequence?: number; session: boolean; job: string; historicalFailures: number;
}
export interface Insight { code: string; severity: 'error' | 'review' | 'evidence'; title: string; detail: string; spanIds: string[]; domain: string }
export interface DomainSummary {
  key: string; label: string; unit: string; observed: boolean; tasks: BusinessTask[]; calls: number; timedCalls: number;
  callMs: number; objectCount: number; sessions: number; states: Record<string, number>; lastAt?: number; activity?: string;
  accepted?: number; rejected?: number; generatedMs?: number; played: number; queueSamples: number; maxQueueMs?: number;
}

// Subtract the union of direct child intervals, never the sum of overlapping children.
// Wall-clock placement plus monotonic duration is usable only for coherent, contained intervals.
export function uncoveredDuration(parent: ReportSpan, children: ReportSpan[]): number | undefined {
  if (!validDuration(parent) || !children.length || children.some(child => !validDuration(child))) return;
  const start = parent.start!, end = start + parent.duration!;
  const intervals = children.map(child => [child.start!, child.start! + child.duration!] as const).sort((a, b) => a[0] - b[0]);
  if (intervals.some(([a, b]) => a < start - 5 || b > end + 5)) return;
  let covered = 0, edge = start;
  for (const [a, b] of intervals) { covered += Math.max(0, Math.min(b, end) - Math.max(a, edge, start)); edge = Math.max(edge, b); }
  return Math.max(0, parent.duration! - covered);
}

export function buildBusinessOverview(report: TraceReport, listening: string) {
  const spans = report.spans.filter(s => s.listening === listening), byId = new Map(spans.map(s => [s.id, s]));
  const tasks: BusinessTask[] = [], insights: Insight[] = [], grouped = new Map<string, ReportSpan[]>();
  const childrenOf = (span: ReportSpan): ReportSpan[] => {
    const result: ReportSpan[] = [], pending = [span], visited = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!; if (visited.has(next.id)) continue;
      visited.add(next.id); result.push(next);
      for (const id of next.children) { const child = byId.get(id); if (child) pending.push(child); }
    }
    return result;
  };
  for (const span of spans) {
    if (!businessSteps.has(span.step)) continue;
    const key = JSON.stringify([span.process, span.step, span.job === 'unknown' ? span.id : span.job]);
    const items = grouped.get(key) ?? []; items.push(span); grouped.set(key, items);
  }
  for (const [id, instances] of grouped) {
    instances.sort((a, b) => endSequence(a) - endSequence(b));
    const latest = instances.at(-1)!, meta = attributes(latest), domain = latest.step.split('.')[0]!;
    const descendants = [...new Map(instances.flatMap(childrenOf).map(s => [s.id, s])).values()];
    const events = descendants.flatMap(s => s.events).sort((a, b) => a.sequence - b.sequence);
    const last = events.at(-1)!, requests = descendants.filter(s => calls.has(s.step));
    const sourceSequence = latest.events[0]?.attributes.segment_sequence;
    const sequence = Number.isSafeInteger(sourceSequence) && Number(sourceSequence) > 0 ? Number(sourceSequence) : undefined;
    const purpose = purposeNames[String(meta.kind)] ?? ({ knowledge: '知识抽取与修复', relation: '关系整理', recognition: '实时识别' }[domain] || '用途未记录');
    const noun = ({ knowledge: '整理批次', relation: '关系窗口', recognition: '识别会话', speech: latest.step === 'speech.session' ? '播放会话' : '语音单元', translation: '翻译任务' } as Record<string, string>)[domain];
    const label = sequence ? `第 ${sequence} 句 · ${noun}${meta.unit_id !== undefined ? ` ${meta.unit_id}` : ''}`
      : `${noun}${meta.unit_id !== undefined ? ` ${meta.unit_id}` : ''} · ${latest.job === 'unknown' ? '标识缺失' : latest.job.slice(0, 8)}`;
    const failures = descendants.filter(s => s.ownState === 'failed').length;
    let state = latest.ownState;
    if (state === 'succeeded' && (failures || latest.state === 'recovered')) state = 'recovered';
    const segments = [...new Set(events.map(e => e.attributes.segment_id).filter((value): value is string => typeof value === 'string'))];
    const task: BusinessTask = { id, domain, label, purpose, state,
      quality: descendants.some(s => s.issues.length) ? 'incomplete' : 'consistent', process: latest.process,
      spanIds: instances.map(s => s.id), focus: latest.id, segments, calls: requests.length,
      callMs: requests.filter(validDuration).reduce((n, s) => n + s.duration!, 0), lastAt: last.timestamp_ms,
      activity: activityOf(last),
      sequence, session: latest.step === 'speech.session', job: latest.job, historicalFailures: failures };
    tasks.push(task);
    if (state === 'failed') insights.push({ code: 'business_failed', severity: 'error', domain, title: `${label}失败`, detail: '任务有明确失败结果。展开查看安全错误码、请求和提交证据。', spanIds: task.spanIds });
    else if (state === 'recovered') insights.push({ code: 'recovered', severity: 'review', domain, title: `${label}完成，但保留异常历史`, detail: `已观察到 ${failures} 个失败步骤；不将历史失败覆盖，也不将多个嵌套失败等同于重试次数。`, spanIds: task.spanIds });
    else if (state === 'partial' || (state === 'waiting' && failures > 0)) insights.push({ code: 'followup_needed', severity: 'review', domain,
      title: `${label}${state === 'partial' ? '部分完成' : '曾失败，等待后续执行'}`, detail: '当前记录不能作为整个业务对象已成功完成的证据。查看检查点、后续调度或修复记录。', spanIds: task.spanIds });
    if (task.quality === 'incomplete') insights.push({ code: 'missing_evidence', severity: 'evidence', domain, title: `${label}证据不完整`, detail: '存在起止或父子记录缺口。直接终态与证据质量分别显示，不能据此断言业务仍在运行。', spanIds: task.spanIds });
    if (latest.step === 'speech.unit' && state === 'unknown' && events.some(e => e.event === 'pcm_sent') && !events.some(e => e.event === 'playback_completed')) {
      insights.push({ code: 'playback_unobserved', severity: 'evidence', domain, title: `${label}已生成，未观察到播放完成`, detail: '日志中没有播放完成反馈。可能是采集截止、记录缺失或尚未反馈，不能据此判定播放故障。', spanIds: task.spanIds });
    }
  }
  for (const span of spans) {
    const domain = span.step.split('.')[0]!;
    if (calls.has(span.step) && validDuration(span)) {
      const threshold = domain === 'translation' ? 5000 : domain === 'speech' ? 15000 : 20000;
      if (span.duration! >= threshold) insights.push({ code: 'slow_call', severity: 'review', domain, title: `${BUSINESS_DOMAINS.find(d => d.key === domain)?.label}调用耗时较长`,
        detail: `本次 ${(span.duration! / 1000).toFixed(2)} 秒，达到诊断阈值 ${threshold / 1000} 秒。调用区间可能包含等待，不直接归因为模型计算。`, spanIds: [span.id] });
    }
    if (businessSteps.has(span.step) && !['speech.session', 'recognition.session', 'speech.unit'].includes(span.step)) {
      const uncovered = uncoveredDuration(span, span.children.map(id => byId.get(id)!).filter(Boolean));
      if (uncovered !== undefined && uncovered >= 2000 && uncovered >= span.duration! * .4) insights.push({ code: 'unattributed_time', severity: 'review', domain,
        title: '任务存在尚未归因的耗时', detail: `约 ${(uncovered / 1000).toFixed(2)} 秒未被已观测的直接子步骤区间覆盖。排队、提交、通知或其他原因需进一步核对，差值本身不是根因证据。采集不完整时也可能是子步骤缺失。`, spanIds: [span.id] });
    }
    for (const event of span.events.filter(e => e.event === 'checkpoint_committed')) {
      const accepted = event.attributes.accepted_count, rejected = event.attributes.rejected_count;
      if (typeof rejected === 'number' && rejected > 0 && typeof accepted === 'number' && accepted === 0) insights.push({ code: 'results_rejected', severity: 'review', domain,
        title: '本次提交没有接受候选结果', detail: `本次检查点接受 0 项、拒绝 ${rejected} 项。这不等于正常空结果，也不代表整个任务最终没有产出。`, spanIds: [span.id] });
    }
  }
  const domains: DomainSummary[] = BUSINESS_DOMAINS.map(definition => {
    const members = spans.filter(s => s.step.startsWith(definition.key + '.')), objects = tasks.filter(t => t.domain === definition.key);
    const requests = members.filter(s => calls.has(s.step)), timed = requests.filter(validDuration);
    const states: Record<string, number> = {};
    for (const task of objects.filter(t => !t.session)) states[task.state] = (states[task.state] || 0) + 1;
    const events = members.flatMap(s => s.events), last = events.reduce<typeof events[number] | undefined>((a, b) => !a || b.timestamp_ms > a.timestamp_ms || (b.timestamp_ms === a.timestamp_ms && b.process_id === a.process_id && b.sequence > a.sequence) ? b : a, undefined);
    const sum = (name: string, eventName: string): number | undefined => {
      const values = events.filter(e => e.event === eventName).map(e => e.attributes[name]).filter((v): v is number => typeof v === 'number' && v >= 0);
      return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
    };
    const queue = events.filter(e => e.event === 'admitted').map(e => e.attributes.queue_ms).filter((v): v is number => typeof v === 'number' && v >= 0);
    return { ...definition, observed: members.length > 0, tasks: objects.sort((a, b) => b.lastAt - a.lastAt), calls: requests.length, timedCalls: timed.length,
      callMs: timed.reduce((n, s) => n + s.duration!, 0), objectCount: objects.filter(t => !t.session).length, sessions: objects.filter(t => t.session).length,
      states, lastAt: last?.timestamp_ms, activity: last ? activityOf(last) : undefined,
      accepted: sum('accepted_count', 'checkpoint_committed'), rejected: sum('rejected_count', 'checkpoint_committed'),
      generatedMs: sum('audio_ms', 'pcm_sent'), played: events.filter(e => e.event === 'playback_completed').length,
      queueSamples: queue.length, maxQueueMs: queue.length ? Math.max(...queue) : undefined };
  });
  const rank = { error: 0, review: 1, evidence: 2 };
  insights.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { listening, domains, tasks, insights, lastAt: spans.length ? Math.max(...spans.flatMap(s => s.events.map(e => e.timestamp_ms))) : undefined,
    quality: report.completeness, metricNote: '只统计已观测调用尝试；含重试。累计调用区间可能包含等待，不是整次任务时长或模型纯计算时间。识别长会话不参与调用耗时比较。' };
}
