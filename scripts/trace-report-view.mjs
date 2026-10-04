// Runs in an offline document. All imported data is inserted with textContent.
export function mountTraceReport(data) {
  const labels = { succeeded: '成功', failed: '失败', cancelled: '已取消', partial: '部分成功', waiting: '等待后续执行', recovered: '成功 · 存在异常子步骤', unknown: '未知 / 未结束', running: '开始', event: '事件' };
  const issueLabels = { event_limit: '超过事件上限', invalid_event: '存在无效事件', buffer_truncated: '缓冲区已截断', capture_disabled: '采集未启用', unfinished_spans: '仍有未结束步骤', malformed_trace_line: '日志行截断或损坏', no_events: '未找到追踪事件', conflicting_duplicate: '重复事件内容冲突', conflicting_sequence: '事件序号冲突', sequence_gap: '事件序号缺失', mixed_builds: '包含多个构建版本', conflicting_span: '步骤归属冲突', span_boundary_missing_or_invalid: '步骤起止记录缺失或异常', event_after_span_end: '步骤结束后仍有事件', missing_parent: '父步骤缺失', invalid_parent_chain: '父子关系循环或过深', parent_owner_mismatch: '父子业务归属冲突' };
  const $ = selector => document.querySelector(selector);
  issueLabels.source_incomplete = '源报告已标记不完整';
  issueLabels.snapshot_process_mismatch = '快照的进程归属不一致';
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const badge = state => node('span', labels[state] ?? state, `badge ${state}`);
  const ms = value => value === undefined ? '耗时未知' : `${value.toFixed(1)} ms`;
  const duration = span => ms(span.duration);
  const reports = { current: data.current, baseline: data.baseline };
  const maps = Object.fromEntries(Object.entries(reports).filter(([, report]) => report).map(([name, report]) => [name, new Map(report.spans.map(s => [s.id, s]))]));
  let activeSide = 'current', selectedTask = '', filter = '';
  const treeCache = new Map();
  const completeness = report => report.completeness === 'complete' ? '当前进程缓冲完整' : report.completeness === 'incomplete' ? '采集不完整' : '完整性未知';
  const aggregate = spans => {
    const priority = ['failed', 'waiting', 'unknown', 'partial'].find(state => spans.some(s => s.state === state));
    if (priority) return priority;
    if (spans.some(s => s.state === 'cancelled')) return spans.every(s => s.state === 'cancelled') ? 'cancelled' : 'partial';
    return spans.some(s => s.state === 'recovered') ? 'recovered' : 'succeeded';
  };
  const describe = (side, span) => {
    $('#evidence').replaceChildren();
    const chain = [span]; let parent = maps[side].get(span.parent);
    while (parent) { chain.unshift(parent); parent = maps[side].get(parent.parent); }
    const crumbs = node('nav', undefined, 'breadcrumbs'); crumbs.setAttribute('aria-label', '步骤路径');
    for (const item of chain) {
      const button = node('button', item.step); button.onclick = () => describe(side, item); crumbs.append(button);
    }
    $('#evidence').append(crumbs, node('h2', span.step), badge(span.state), node('p', `${duration(span)} · 直接终态：${labels[span.ownState]}`));
    const fields = { '执行版本': side === 'current' ? '本次' : '基准', '业务记录': span.listening, '任务': span.job,
      '尝试': span.attempt ?? '未记录', '进程': span.process, 'Trace': span.trace, 'Span': span.events[0]?.span_id ?? '未知',
      '逻辑路径': span.path };
    const dl = node('dl');
    for (const [key, value] of Object.entries(fields)) dl.append(node('dt', key), node('dd', String(value)));
    $('#evidence').append(dl);
    if (span.issues.length) $('#evidence').append(node('p', span.issues.map(i => issueLabels[i] ?? i).join('；'), 'warning'));
    $('#evidence').append(node('h3', `事件证据 · ${span.events.length}`));
    const events = node('div'); let shown = 0;
    const more = node('button', '继续显示事件', 'more');
    const addEvents = () => {
      for (const event of span.events.slice(shown, shown + 50)) {
        const detail = node('details', undefined, 'event');
        detail.append(node('summary', `#${event.sequence} ${event.event ?? labels[event.state]}${event.error_code ? ` · ${event.error_code}` : ''}`));
        detail.addEventListener('toggle', () => {
          if (detail.open && detail.children.length === 1) detail.append(node('pre', JSON.stringify(event, null, 2)));
        });
        events.append(detail);
      }
      shown += 50; more.hidden = shown >= span.events.length;
    };
    more.onclick = addEvents; addEvents(); $('#evidence').append(events, more);
    if (window.innerWidth < 1050) $('#evidence').scrollIntoView({ block: 'start' });
  };
  const pageItems = (container, items, render) => {
    let offset = 0; const more = node('button', '显示更多（每页 50 项）', 'more');
    const append = () => {
      for (const item of items.slice(offset, offset + 50)) container.insertBefore(render(item), more);
      offset += 50; more.hidden = offset >= items.length;
    };
    more.onclick = append; container.append(more); append();
  };
  const spanElement = (side, span) => {
    const detail = node('details', undefined, 'span-node'); detail.dataset.span = span.id;
    const summary = node('summary'); summary.append(node('span', span.step, 'step'), badge(span.state), node('span', duration(span), 'duration'));
    const inspect = node('button', '证据', 'inspect'); inspect.onclick = e => { e.preventDefault(); describe(side, span); };
    summary.append(inspect); detail.append(summary);
    let loaded = false;
    detail.addEventListener('toggle', () => {
      if (!detail.open || loaded) return;
      loaded = true;
      const children = node('div', undefined, 'branch');
      pageItems(children, span.children.map(id => maps[side].get(id)), child => spanElement(side, child));
      const evidence = node('button', `查看底层事件（${span.events.length}）`, 'evidence-link'); evidence.onclick = () => describe(side, span);
      children.append(evidence); detail.append(children);
    });
    return detail;
  };
  const treeFor = (side, listening) => {
    const key = `${side}:${listening}`;
    if (treeCache.has(key)) return treeCache.get(key);
    const report = reports[side], roots = report.roots.map(id => maps[side].get(id)).filter(s => s.listening === listening);
    const container = node('section', undefined, 'task-tree');
    const task = node('details', undefined, 'group'); task.open = true;
    const taskSummary = node('summary'); taskSummary.append(node('span', `收听 · ${listening}`), badge(aggregate(roots))); task.append(taskSummary);
    const workflow = node('details', undefined, 'group'); workflow.open = true;
    const workflowSummary = node('summary'); workflowSummary.append(node('span', '知识整理 · 已埋点流程'), badge(aggregate(roots))); workflow.append(workflowSummary);
    const jobs = node('div', undefined, 'branch');
    pageItems(jobs, roots, root => {
      const job = node('details', undefined, 'job'); job.dataset.job = root.job;
      const summary = node('summary'); summary.append(node('span', `批次 ${root.job} · 尝试 ${root.attempt ?? '?'}`), badge(root.state)); job.append(summary);
      let loaded = false;
      job.addEventListener('toggle', () => { if (job.open && !loaded) { loaded = true; job.append(spanElement(side, root)); } });
      return job;
    });
    workflow.append(jobs); task.append(workflow); container.append(task); treeCache.set(key, container); return container;
  };
  const show = () => {
    const side = activeSide, report = reports[side];
    const spans = report.spans;
    const tasks = [...new Set(spans.map(s => s.listening))];
    if (!tasks.includes(selectedTask)) selectedTask = tasks[0] ?? '';
    $('#tasks').replaceChildren();
    for (const listening of tasks) {
      const button = node('button', listening, listening === selectedTask ? 'selected' : '');
      button.onclick = () => { selectedTask = listening; show(); }; $('#tasks').append(button);
    }
    $('#integrity').textContent = `${completeness(report)} · ${report.eventCount} 条事件 · ${report.spans.length} 个步骤`;
    $('#integrity').className = report.completeness === 'complete' ? 'integrity' : 'integrity warning';
    $('#issues').textContent = report.issues.map(i => issueLabels[i] ?? i).join('；') || (report.completeness === 'unknown' ? '文本日志没有结束清单，无法确认尾部是否丢失。' : '仅代表已启用的知识流程采集范围。');
    $('#versions').textContent = report.builds.map(b => `${b.git_sha.slice(0, 12)}${b.build_dirty ? ' · 含未提交修改' : ''} · 埋点 v${b.instrumentation_version}`).join(' / ') || '版本未知';
    $('#tree').replaceChildren();
    if (!filter) {
      if (selectedTask) $('#tree').append(treeFor(side, selectedTask));
      else $('#tree').append(node('p', '没有可展示的追踪事件。'));
    } else {
      const matches = spans.filter(s => s.listening === selectedTask && `${s.path} ${s.job} ${s.state} ${s.events.map(e => e.error_code ?? '').join(' ')}`.toLowerCase().includes(filter));
      $('#tree').append(node('p', `匹配 ${matches.length} 个步骤；清空筛选可返回原展开状态。`));
      pageItems($('#tree'), matches, span => {
        const button = node('button', `${span.path} · ${labels[span.state]} · ${span.job}`, 'search-result');
        button.onclick = () => describe(side, span); return button;
      });
    }
    $('#timeline').replaceChildren();
    const taskSpans = spans.filter(s => s.listening === selectedTask);
    for (const process of [...new Set(taskSpans.map(s => s.process))]) {
      const group = taskSpans.filter(s => s.process === process), timed = group.filter(s => s.start !== undefined && s.duration !== undefined);
      const begin = Math.min(...timed.map(s => s.start)), end = Math.max(...timed.map(s => s.start + s.duration));
      $('#timeline').append(node('h3', `进程 ${process}`));
      const rows = node('div');
      pageItems(rows, group, span => {
        const row = node('button', undefined, 'time-row'); row.onclick = () => describe(side, span);
        row.append(node('span', span.step));
        const track = node('span', undefined, 'track'), bar = node('span', undefined, `bar ${span.state}`);
        if (span.start !== undefined && span.duration !== undefined && Number.isFinite(begin)) {
          bar.style.marginLeft = `${Math.max(0, Math.min(100, (span.start - begin) / Math.max(1, end - begin) * 100))}%`;
          bar.style.width = `${Math.max(.5, Math.min(100, span.duration / Math.max(1, end - begin) * 100))}%`;
          track.append(bar);
        } else track.textContent = '缺少起止证据';
        row.append(track, node('span', duration(span))); return row;
      });
      $('#timeline').append(rows);
    }
  };
  $('#search').addEventListener('input', e => { filter = e.target.value.trim().toLowerCase(); show(); });
  $('#side').disabled = !data.baseline;
  $('#side').onchange = e => { activeSide = e.target.value; selectedTask = ''; $('#evidence').replaceChildren(node('p', '选择节点的“证据”按钮查看详情。')); show(); };
  $('#collapse').onclick = () => { for (const detail of $('#tree').querySelectorAll('details')) detail.open = false; };
  $('#export').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = node('a'); a.href = url; a.download = 'hearwise-trace-evidence.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (data.comparison) {
    $('#comparison-note').textContent = data.comparison.warning + (data.comparison.instrumentationCompatible ? '' : ' 埋点版本不兼容，不能认定结构变化。');
    pageItems($('#comparison'), data.comparison.rows.filter(row => row.changed), row => {
      const item = node('details', undefined, 'diff');
      item.append(node('summary', `${row.path} · 观测次数 ${row.baseline.count} → ${row.current.count}`));
      for (const side of ['baseline', 'current']) {
        item.append(node('h3', side === 'current' ? '本次执行' : '基准执行'));
        const histogram = Object.entries(row[side].states).map(([state, count]) => `${labels[state]} ${count}`).join(' · ');
        item.append(node('p', histogram || '未观测到；不能据此认定未执行'));
        const buttons = node('div');
        pageItems(buttons, row[side].ids, id => {
          const span = maps[side].get(id), button = node('button', `${span.job} · ${span.step}`, 'search-result');
          button.onclick = () => describe(side, span); return button;
        });
        item.append(buttons);
      }
      return item;
    });
    if (!data.comparison.rows.some(row => row.changed)) $('#comparison').append(node('p', '已观测的步骤次数和状态相同；不证明业务结果相同。'));
  } else $('#comparison-note').textContent = '生成报告时传入 --baseline 可查看两次执行的步骤路径、次数和状态差异。';
  show();
}

export const reportStyles = `
*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#192b39;font:14px/1.55 system-ui,-apple-system,sans-serif}button,input,select{font:inherit}button,select{cursor:pointer}button{background:#fff;border:1px solid #d2dae0;border-radius:5px;padding:6px 10px;color:inherit}button:hover{background:#edf4fa}button:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid #4486b9;outline-offset:3px}[hidden]{display:none!important}header{padding:25px 30px 18px;background:#172e40;color:#fff}header h1{margin:2px 0;font-size:25px;font-weight:650}header p{margin:6px 0;color:#c4d6e1}.eyebrow{font-size:11px;letter-spacing:2px}.toolbar{display:flex;gap:9px;flex-wrap:wrap;padding:15px 30px;background:#fff;border-bottom:1px solid #d8e0e5}.toolbar input{width:290px;padding:7px;border:1px solid #cbd5dd;border-radius:5px}.toolbar label{display:flex;align-items:center;gap:8px}.layout{display:grid;grid-template-columns:190px minmax(350px,1fr) minmax(300px,370px);gap:20px;padding:22px 24px}aside,main{min-width:0}h2{font-size:17px;margin:0 0 12px}h3{font-size:13px;margin:16px 0 8px}p{overflow-wrap:anywhere}#tasks{display:flex;flex-direction:column;gap:7px}#tasks button{overflow-wrap:anywhere;text-align:left}.selected{border-color:#316d97;background:#e6f0f7}section.panel,#evidence{background:#fff;border:1px solid #dbe2e7;border-radius:8px;padding:17px;margin-bottom:18px}#evidence{position:sticky;top:15px;max-height:calc(100vh - 30px);overflow:auto;align-self:start}.integrity{font-weight:650;color:#25775f}.warning{color:#985411;background:#fff5e7;padding:8px 10px;border-radius:4px}.muted,#issues,#versions{font-size:12px;color:#607380}.badge{display:inline-block;padding:2px 7px;border-radius:4px;background:#edf1f4;color:#576778;font-size:11px;white-space:normal}.succeeded{background:#e2f3eb;color:#24654e}.failed{background:#fbe9e7;color:#a13c35}.partial,.recovered{background:#fff0d9;color:#946014}.cancelled{background:#eaeaf5;color:#626383}.unknown{background:#edf1f4;color:#596774}details{min-width:0}summary{cursor:pointer;overflow-wrap:anywhere;padding:9px 5px}summary .badge{margin-left:8px}summary .step{font-family:ui-monospace,monospace;font-size:12px}.duration{font-size:11px;color:#71818d;margin-left:8px}.branch{margin:3px 0 7px 10px;padding-left:13px;border-left:1px solid #c7d5df}.span-node,.job{position:relative;border-top:1px solid #e8edf1}.branch>.span-node:before{content:'';position:absolute;width:13px;top:22px;left:-13px;border-top:1px solid #c7d5df}.group>.group{margin-left:10px}.inspect{padding:1px 5px;font-size:11px;margin-left:8px}.more,.evidence-link{margin:8px;font-size:12px}.breadcrumbs{display:flex;gap:5px;flex-wrap:wrap}.breadcrumbs button{font-size:10px;padding:3px}dl{display:grid;grid-template-columns:65px minmax(0,1fr);font-size:12px;gap:7px}dt{color:#657581}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f5f7;padding:10px;font-size:11px}.event{border-top:1px solid #e5ebef}.search-result{display:block;width:100%;text-align:left;margin:5px 0;overflow-wrap:anywhere}.time-row{display:grid;grid-template-columns:120px minmax(35px,1fr) 80px;width:100%;gap:8px;border:0;font-size:11px;align-items:center;padding:5px 0;text-align:left}.track{background:#f0f3f5;overflow:hidden;height:14px}.bar{display:block;height:100%;background:#6d9db9}.bar.failed{background:#c7796e}.bar.cancelled{background:#9090ae}.bar.unknown{background:#aab4bc}.diff{border-top:1px solid #dfe5e9}.section-title{display:flex;justify-content:space-between;align-items:center}.section-title span{font-size:11px;color:#6e8392}footer{padding:15px 30px;color:#657783;font-size:12px}@media(max-width:1050px){.layout{grid-template-columns:150px minmax(0,1fr)}#evidence{position:static;max-height:none;grid-column:2}}@media(max-width:640px){header,.toolbar{padding:16px}.layout{display:block;padding:12px}aside{margin-bottom:15px}#tasks{flex-direction:row;overflow:auto}#tasks button{min-width:140px}#evidence{max-height:none}.toolbar input{width:100%}.time-row{grid-template-columns:110px minmax(30px,1fr) 70px}.branch{padding-left:8px;margin-left:5px}}
`;
