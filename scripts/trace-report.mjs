import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseTraceInput, buildTraceReport, compareTraceReports, buildBusinessOverview } from '../dist/server/index.js';
import { mountTraceReport, reportStyles, businessStyles } from './trace-report-view.mjs';

export function renderTraceReport(current, baseline) {
  const data = { format: 'hearwise-trace-report/v1', current, ...(baseline ? { baseline, comparison: compareTraceReports(current, baseline) } : {}) };
  data.overviews = Object.fromEntries(Object.entries({ current, baseline }).filter(([, report]) => report).map(([side, report]) =>
    [side, Object.fromEntries([...new Set(report.spans.map(s => s.listening))].map(id => [id, buildBusinessOverview(report, id)]))]));
  const json = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  const script = `(${mountTraceReport.toString()})(JSON.parse(document.getElementById('trace-data').textContent));`;
  const hash = createHash('sha256').update(script).digest('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Hearwise · 执行追踪报告</title><style>${reportStyles}${businessStyles}</style></head><body>
<header><div class="eyebrow">HEARWISE / BUSINESS TRACE</div><h1>业务执行报告</h1><p>先看业务工作量与异常，再逐层查看任务、调用和证据。规则分析，无模型调用。</p></header>
<div class="toolbar"><label>执行<select id="side"><option value="current">本次执行</option><option value="baseline">基准执行</option></select></label><label>筛选<input id="search" placeholder="步骤、任务 ID、failed、HTTP_429"></label><button id="collapse">折叠当前图</button><button id="export">导出脱敏证据 JSON</button></div>
<div class="layout"><aside><h2>业务记录</h2><div id="tasks"></div><p class="muted">显示已采集的识别、翻译、知识、关系和播报。临时请求与试听可能未关联收听记录。旧日志保持原有覆盖范围。</p></aside><main>
<section class="panel capture-panel"><div id="integrity"></div><p id="issues"></p><p id="versions"></p><p id="capture-time" class="muted"></p></section>
<section class="panel overview-panel"><div class="section-title"><h2>业务总览</h2><label>比较口径 <select id="metric"><option value="calls">调用尝试</option><option value="duration">累计调用耗时</option></select></label></div><p id="metric-note" class="muted"></p><div id="domains"></div></section>
<section class="panel"><div class="section-title"><h2>需要关注</h2><span id="insight-count"></span></div><div id="insights"></div></section>
<section class="panel"><div class="section-title"><h2 id="work-title">业务任务</h2><button id="all-domains">全部业务</button></div><div class="task-controls"><label>用途 <select id="purpose"></select></label><label>关联句子 <select id="sentence"></select></label></div><p id="work-note" class="muted"></p><div id="work-items"></div></section>
<details class="panel technical" id="call-tree"><summary>调用层级图 · 继续下钻</summary><p class="muted">连线表示明确的父子归属，不代表兄弟步骤的执行依赖。</p><div id="tree"></div></details>
<details class="panel technical"><summary>时间线 · 当前业务范围</summary><p class="muted">按进程分组，位置使用墙钟，耗时来自单调时钟。时钟变化可能影响位置；不跨进程对时，也不将并行耗时相加或推断关键路径。</p><div id="timeline"></div></details>
<section class="panel"><h2>两次执行对比</h2><p id="comparison-note" class="muted"></p><div id="comparison"></div></section>
</main><aside id="evidence" aria-live="polite"><h2>节点证据</h2><p>选择节点的“证据”按钮查看详情。</p></aside></div>
<footer>本地离线报告 · 无外部资源或网络请求 · 原始日志与模型正文不会进入报告 · 输入中主动放入业务 ID 的敏感内容仍需自行检查</footer>
<script type="application/json" id="trace-data">${json}</script><script>${script}</script></body></html>`;
}

export async function createTraceReport(input, output, baseline) {
  const read = async file => {
    if ((await stat(file)).size > 20 * 1024 * 1024) throw new Error('Trace input exceeds 20 MiB');
    return buildTraceReport(parseTraceInput(await readFile(file, 'utf8')));
  };
  const current = await read(input), before = baseline ? await read(baseline) : undefined;
  // A report must never overwrite its source, an accepted baseline, or an existing artifact.
  await writeFile(output, renderTraceReport(current, before), { flag: 'wx', mode: 0o600 });
  return { eventCount: current.eventCount, spans: current.spans.length, completeness: current.completeness };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), input = args.shift(); let output, baseline;
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('Missing option value');
      if (flag === '--output' && !output) output = value;
      else if (flag === '--baseline' && !baseline) baseline = value;
      else throw new Error('Unknown or repeated option');
    }
    if (!input || !output) throw new Error('Usage: npm run trace:report -- input.log --output report.html [--baseline baseline.log]');
    const result = await createTraceReport(input, output, baseline);
    console.log(JSON.stringify({ output: resolve(output), ...result }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
