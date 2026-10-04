// Runs in an offline document. All imported data is inserted with textContent.
export function mountTraceReport(data) {
  const labels = { succeeded: '成功', failed: '失败', cancelled: '已取消', partial: '部分成功', waiting: '等待后续执行', recovered: '成功 · 存在异常子步骤', unknown: '未观察到结束 / 待核实', running: '开始', event: '事件' };
  const issueLabels = { event_limit: '超过事件上限', invalid_event: '存在无效事件', buffer_truncated: '缓冲区已截断', capture_disabled: '采集未启用', unfinished_spans: '仍有未结束步骤', malformed_trace_line: '日志行截断或损坏', no_events: '未找到追踪事件', conflicting_duplicate: '重复事件内容冲突', conflicting_sequence: '事件序号冲突', sequence_gap: '事件序号缺失', mixed_builds: '包含多个构建版本', conflicting_span: '步骤归属冲突', span_boundary_missing_or_invalid: '步骤起止记录缺失或异常', event_after_span_end: '步骤结束后仍有事件', missing_parent: '父步骤缺失', invalid_parent_chain: '父子关系循环或过深', parent_owner_mismatch: '父子业务归属冲突' };
  const $ = selector => document.querySelector(selector);
  labels.discarded = '已丢弃 / 不再适用';
  const workflows = { knowledge: '知识整理', translation: '翻译', relation: '关系提取', speech: '播报', recognition: '语音识别' };
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
  let activeSide = 'current', selectedTask = '', filter = '', selectedDomain = '', selectedPurpose = '', selectedSentence = '';
  let metric = 'calls';
  const clock = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
  const humanDuration = value => value >= 1000 ? `${(value / 1000).toFixed(2)} 秒` : `${value.toFixed(1)} ms`;
  const currentOverview = () => data.overviews[activeSide]?.[selectedTask];
  const treeCache = new Map();
  const completeness = report => report.completeness === 'complete' ? '当前进程缓冲完整' : report.completeness === 'incomplete' ? '采集不完整' : '完整性未知';
  const aggregate = spans => {
    const priority = ['failed', 'waiting', 'unknown', 'partial'].find(state => spans.some(s => s.state === state));
    if (priority) return priority;
    if (spans.some(s => ['cancelled', 'discarded'].includes(s.state))) return spans.every(s => s.state === spans[0].state) ? spans[0].state : 'partial';
    return spans.some(s => s.state === 'recovered') ? 'recovered' : 'succeeded';
  };
  const describe = (side, span) => {
    $('#evidence').replaceChildren();
    const back = node('button', '返回业务任务'); back.onclick = () => $('#work-title').scrollIntoView({ block: 'start' });
    $('#evidence').append(back);
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
    const attributes = span.events[0]?.attributes || {};
    for (const [key, label] of Object.entries({ run_id: '收听片段', segment_id: '句子', consumer_id: '播放会话', unit_id: '语音单元', provider: '服务商', kind: '用途' })) {
      if (attributes[key] !== undefined) fields[label] = attributes[key];
    }
    const dl = node('dl');
    for (const [key, value] of Object.entries(fields)) dl.append(node('dt', key), node('dd', String(value)));
    $('#evidence').append(dl);
    const overview = data.overviews[side]?.[span.listening];
    const segmentIds = new Set(span.events.map(e => e.attributes.segment_id).filter(Boolean));
    if (segmentIds.size && overview) {
      const related = overview.tasks.filter(task => task.domain !== span.step.split('.')[0] && task.segments.some(id => segmentIds.has(id)));
      if (related.length) $('#evidence').append(node('h3', '同一句子的其他流程（业务关联）'));
      for (const item of related.slice(0, 50)) {
        const target = maps[side].get(item.focus);
        const button = node('button', `${item.label} · ${target.step}`, 'search-result'); button.onclick = () => describe(side, target); $('#evidence').append(button);
      }
    }
    if (span.ownState !== span.state) $('#evidence').append(node('p', '直接终态是步骤自己的结果；汇总状态还考虑子步骤和证据缺口。', 'muted'));
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
    $('#evidence').scrollIntoView({ block: 'start' });
  };
  const pageItems = (container, items, render) => {
    let offset = 0; const more = node('button', '显示更多（每页 50 项）', 'more');
    const append = () => {
      for (const item of items.slice(offset, offset + 50)) container.insertBefore(render(item), more);
      offset += 50; more.hidden = offset >= items.length;
    };
    more.onclick = append; container.append(more); append();
  };
  const renderBusiness = () => {
    const overview = currentOverview();
    for (const id of ['#domains', '#insights', '#work-items']) $(id).replaceChildren();
    if (!overview) return;
    $('#capture-time').textContent = overview.lastAt ? `所选记录最后观测：${clock(overview.lastAt)} · 离线快照，不代表现在仍在运行` : '没有可用的观测时间';
    $('#metric-note').textContent = overview.metricNote;
    const maximum = Math.max(1, ...overview.domains.map(d => metric === 'calls' ? d.calls : d.callMs));
    for (const domain of overview.domains) {
      const button = node('button', undefined, `domain-card${domain.key === selectedDomain ? ' active-domain' : ''}`);
      button.dataset.domain = domain.key; button.setAttribute('aria-pressed', String(domain.key === selectedDomain));
      const head = node('div', undefined, 'domain-head'); head.append(node('strong', domain.label), node('span', domain.observed ? '已观测' : '未观测到', 'muted'));
      button.append(head);
      if (domain.observed) {
        const value = metric === 'calls' ? domain.calls : domain.callMs;
        button.append(node('div', domain.key === 'recognition' ? `${domain.objectCount} 个识别会话` : metric === 'calls' ? `${domain.calls} 次调用尝试` : humanDuration(domain.callMs), 'domain-number'));
        const track = node('div', undefined, 'workload-track'), bar = node('div', undefined, 'workload-bar');
        bar.style.width = `${value / maximum * 100}%`; track.append(bar); button.append(track);
        button.append(node('p', domain.key === 'recognition' ? '长会话不计入请求耗时比较' : `${domain.objectCount} 个${domain.unit}${domain.sessions ? ` · ${domain.sessions} 个播放会话` : ''}`, 'domain-meta'));
        const states = node('div', undefined, 'state-list');
        for (const [state, count] of Object.entries(domain.states)) { const item = badge(state); item.append(` ${count}`); states.append(item); }
        button.append(states);
        const incomplete = domain.tasks.filter(task => task.quality === 'incomplete').length;
        if (incomplete) button.append(node('p', `${incomplete} 个业务对象 / 会话的证据有缺口`, 'quality-label'));
        if (domain.accepted !== undefined || domain.rejected !== undefined) button.append(node('p', `检查点接受 ${domain.accepted ?? '未记录'} · 拒绝 ${domain.rejected ?? '未记录'}（处理次数）`, 'domain-meta'));
        if (domain.generatedMs !== undefined) button.append(node('p', `已生成 ${(domain.generatedMs / 1000).toFixed(1)} 秒音频 · 播完反馈 ${domain.played} 次`, 'domain-meta'));
        if (domain.maxQueueMs !== undefined) button.append(node('p', `已准入任务最大排队 ${humanDuration(domain.maxQueueMs)} · ${domain.queueSamples} 个样本`, 'domain-meta'));
        button.append(node('p', `最后记录：${domain.activity} · ${clock(domain.lastAt)}`, 'last-activity'));
        if (metric === 'duration' && domain.timedCalls < domain.calls) button.append(node('p', `${domain.calls - domain.timedCalls} 次尝试缺少可靠耗时，未计入`, 'muted'));
      } else button.append(node('p', '当前日志没有该域证据。不能据此认定未开启或没有执行。', 'muted'));
      button.onclick = () => { selectedDomain = domain.key; selectedPurpose = ''; selectedSentence = ''; show(); $('#work-title').scrollIntoView({ block: 'nearest' }); };
      $('#domains').append(button);
    }
    const domainTasks = overview.tasks.filter(task => !selectedDomain || task.domain === selectedDomain);
    const options = (selector, values, selected, fallback) => {
      const select = $(selector); select.replaceChildren();
      const first = node('option', fallback); first.value = ''; select.append(first);
      for (const [value, label] of values) { const option = node('option', label); option.value = value; select.append(option); }
      select.value = selected;
    };
    options('#purpose', [...new Set(domainTasks.map(t => t.purpose))].map(value => [value, value]), selectedPurpose, '所有用途');
    const sentences = new Map();
    for (const task of overview.tasks) for (const id of task.segments) {
      if (!sentences.has(id) || task.sequence) sentences.set(id, task.sequence && task.segments.length === 1 ? `第 ${task.sequence} 句` : `句子 · ${id.slice(0, 8)}`);
    }
    options('#sentence', [...sentences], selectedSentence, '所有句子');
    const visible = domainTasks.filter(task => (!selectedPurpose || task.purpose === selectedPurpose) && (!selectedSentence || task.segments.includes(selectedSentence)));
    $('#work-title').textContent = selectedDomain ? `${workflows[selectedDomain]} · 业务任务` : '全部业务 · 任务';
    $('#work-note').textContent = `${visible.length} 个业务对象 / 会话。重试与继续执行归并到同一对象；没有句子编号时显示短 ID，不编造编号。`;
    pageItems($('#work-items'), visible, task => {
      const item = node('details', undefined, 'business-task'); item.dataset.task = task.id;
      const summary = node('summary'); summary.append(node('strong', task.label), badge(task.state), node('span', task.quality === 'incomplete' ? '证据有缺口' : '局部记录自洽', 'quality-label'));
      summary.append(node('p', `${workflows[task.domain]} / ${task.purpose} · ${task.calls} 次调用尝试 · ${humanDuration(task.callMs)} 累计调用耗时`, 'task-meta'));
      item.append(summary);
      let loaded = false;
      item.addEventListener('toggle', () => {
        if (!item.open || loaded) return; loaded = true;
        item.append(node('p', `最后记录：${task.activity} · ${clock(task.lastAt)}`, 'muted'));
        if (task.spanIds.length > 1) item.append(node('p', `共 ${task.spanIds.length} 次执行，以下保留全部历史。`));
        for (const id of task.spanIds) item.append(spanElement(activeSide, maps[activeSide].get(id)));
      });
      return item;
    });
    if (!visible.length) $('#work-items').append(node('p', '当前范围没有已观测业务对象。'));
    const roots = new Set(visible.flatMap(task => task.spanIds));
    const belongs = id => { let span = maps[activeSide].get(id); while (span) { if (roots.has(span.id)) return true; span = maps[activeSide].get(span.parent); } return false; };
    const insights = overview.insights.filter(item => (!selectedDomain || item.domain === selectedDomain) &&
      ((!selectedPurpose && !selectedSentence) || item.spanIds.some(belongs)));
    $('#insight-count').textContent = `${insights.length} 条 · 规则分析`;
    pageItems($('#insights'), insights, item => {
      const row = node('div', undefined, `insight ${item.severity}`); row.dataset.rule = item.code;
      row.append(node('strong', item.title), node('p', item.detail));
      for (const id of item.spanIds.slice(0, 10)) { const button = node('button', '查看证据'); button.onclick = () => describe(activeSide, maps[activeSide].get(id)); row.append(button); }
      return row;
    });
    if (!insights.length) $('#insights').append(node('p', '当前证据未触发诊断规则；不代表业务结果正确或采集完整。', 'muted'));
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
    const key = `${side}:${listening}:${selectedDomain}`;
    if (treeCache.has(key)) return treeCache.get(key);
    const report = reports[side], roots = report.roots.map(id => maps[side].get(id)).filter(s => s.listening === listening && (!selectedDomain || s.step.startsWith(selectedDomain + '.')));
    const container = node('section', undefined, 'task-tree');
    const task = node('details', undefined, 'group'); task.open = true;
    const taskSummary = node('summary'); taskSummary.append(node('span', `收听 · ${listening}`), badge(aggregate(roots))); task.append(taskSummary);
    for (const family of [...new Set(roots.map(root => root.step.split('.')[0]))]) {
      const members = roots.filter(root => root.step.split('.')[0] === family);
      const workflow = node('details', undefined, 'group'); workflow.open = true;
      const workflowSummary = node('summary'); workflowSummary.append(node('span', `${workflows[family] || family} · 已埋点流程`), badge(aggregate(members))); workflow.append(workflowSummary);
      const jobs = node('div', undefined, 'branch');
      pageItems(jobs, members, root => {
      const job = node('details', undefined, 'job'); job.dataset.job = root.job;
      const attrs = root.events[0]?.attributes || {};
      const business = data.overviews[side]?.[listening]?.tasks.find(task => task.spanIds.includes(root.id));
      const title = business ? `${business.label} · ${business.purpose}${root.attempt ? ` · 执行 ${root.attempt}` : ''}` : `任务 · ${root.job.slice(0, 8)}`;
      const summary = node('summary'); summary.append(node('span', title), badge(root.state)); job.append(summary);
      let loaded = false;
      job.addEventListener('toggle', () => { if (job.open && !loaded) { loaded = true; job.append(spanElement(side, root)); } });
      return job;
      });
      workflow.append(jobs); task.append(workflow);
    }
    container.append(task); treeCache.set(key, container); return container;
  };
  const show = () => {
    const side = activeSide, report = reports[side];
    const spans = report.spans;
    const tasks = [...new Set(spans.map(s => s.listening))];
    if (!tasks.includes(selectedTask)) selectedTask = tasks.find(id => id !== 'unknown') ?? tasks[0] ?? '';
    $('#tasks').replaceChildren();
    for (const listening of tasks) {
      const button = node('button', listening === 'unknown' ? '未关联业务记录' : `收听记录 · ${listening.slice(0, 8)}`, listening === selectedTask ? 'selected' : '');
      button.onclick = () => { selectedTask = listening; selectedDomain = ''; selectedPurpose = ''; selectedSentence = ''; $('#evidence').replaceChildren(node('p', '选择业务任务查看证据。')); show(); }; $('#tasks').append(button);
    }
    $('#integrity').textContent = `${completeness(report)} · 全文件 ${report.eventCount} 条事件 · ${report.spans.length} 个步骤`;
    $('#integrity').className = report.completeness === 'complete' ? 'integrity' : 'integrity warning';
    $('#issues').textContent = report.issues.map(i => issueLabels[i] ?? i).join('；') || (report.completeness === 'unknown' ? '文本日志没有结束清单，无法确认尾部是否丢失。' : '仅代表当前快照中的已埋点流程；未出现的分支不能推断为未执行。');
    $('#versions').textContent = report.builds.map(b => `${b.git_sha.slice(0, 12)}${b.build_dirty ? ' · 含未提交修改' : ''} · 埋点 v${b.instrumentation_version}`).join(' / ') || '版本未知';
    $('#tree').replaceChildren();
    if (!filter) {
      if (selectedTask) $('#tree').append(treeFor(side, selectedTask));
      else $('#tree').append(node('p', '没有可展示的追踪事件。'));
    } else {
      const matches = spans.filter(s => s.listening === selectedTask && (!selectedDomain || s.step.startsWith(selectedDomain + '.')) && `${s.path} ${s.job} ${s.state} ${s.events.map(e => e.error_code ?? '').join(' ')}`.toLowerCase().includes(filter));
      $('#tree').append(node('p', `匹配 ${matches.length} 个步骤；清空筛选可返回原展开状态。`));
      pageItems($('#tree'), matches, span => {
        const button = node('button', `${span.path} · ${labels[span.state]} · ${span.job}`, 'search-result');
        button.onclick = () => describe(side, span); return button;
      });
    }
    renderBusiness();
    $('#timeline').replaceChildren();
    const taskSpans = spans.filter(s => s.listening === selectedTask && (!selectedDomain || s.step.startsWith(selectedDomain + '.')));
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
  $('#metric').onchange = e => { metric = e.target.value; renderBusiness(); };
  $('#all-domains').onclick = () => { selectedDomain = ''; selectedPurpose = ''; selectedSentence = ''; show(); };
  $('#purpose').onchange = e => { selectedPurpose = e.target.value; renderBusiness(); };
  $('#sentence').onchange = e => { selectedSentence = e.target.value; selectedDomain = ''; selectedPurpose = ''; show(); };
  $('#search').addEventListener('input', e => { filter = e.target.value.trim().toLowerCase(); if (filter) $('#call-tree').open = true; show(); });
  $('#side').disabled = !data.baseline;
  $('#side').onchange = e => { activeSide = e.target.value; selectedTask = ''; selectedDomain = ''; selectedPurpose = ''; selectedSentence = ''; $('#evidence').replaceChildren(node('p', '选择节点的“证据”按钮查看详情。')); show(); };
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

// Business overview occupies the primary canvas; technical evidence remains available on demand.
export const businessStyles = `
.layout{grid-template-columns:170px minmax(0,1fr);max-width:1680px;margin:auto}.layout>main{min-width:0}#evidence{grid-column:2;position:static;max-height:none;border-top:3px solid #426f85}.layout>aside:first-child{grid-column:1;grid-row:1 / 3}.overview-panel{padding:20px}#domains{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.domain-card{text-align:left;padding:16px;background:#fbfcfd;min-width:0;display:flex;flex-direction:column;gap:9px;border:1px solid #d5dfe5;border-radius:7px}.domain-card:hover{background:#f0f6f8}.active-domain{border:2px solid #286e80;padding:15px;background:#eef6f7}.domain-head{display:flex;justify-content:space-between;gap:8px;align-items:center}.domain-head strong{font-size:17px}.domain-number{font-size:25px;font-weight:650;font-variant-numeric:tabular-nums}.domain-meta,.last-activity{margin:0;font-size:12px;color:#536b79}.last-activity{margin-top:auto;padding-top:7px;border-top:1px solid #e1e8ec}.workload-track{height:7px;background:#e0e8eb;border-radius:3px;overflow:hidden}.workload-bar{height:100%;background:#377e8d}.state-list{display:flex;flex-wrap:wrap;gap:5px}.capture-panel{padding:14px 18px}.capture-panel p{margin:5px 0}.task-controls{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}.task-controls label{display:flex;align-items:center;gap:6px}.task-controls select{max-width:260px}.business-task{border-top:1px solid #dfe6eb;padding:10px 0}.business-task>summary{padding:4px 0}.business-task>summary strong{font-size:15px}.task-meta{margin:6px 0;font-size:12px;color:#557080}.quality-label{font-size:11px;color:#756747;margin-left:9px}.business-task>.span-node{margin:8px 0 8px 14px;border-left:2px solid #b9cdd5;padding-left:12px}.insight{padding:12px 14px;margin:8px 0;background:#f5f8fa;border-left:3px solid #76909e}.insight.error{border-color:#b25d54;background:#fcf4f2}.insight.review{border-color:#b79457;background:#fbf8ef}.insight p{margin:6px 0;font-size:13px}.insight button{font-size:12px;margin-right:7px}.technical{background:white;border:1px solid #dbe2e7;border-radius:8px;padding:14px 18px;margin-bottom:18px}.technical>summary{font-weight:650}.section-title label{font-size:12px}.section-title{gap:12px;flex-wrap:wrap}#work-items .more,#insights .more{margin-left:0}.waiting{background:#e8f1f7;color:#3a6478}.discarded{background:#eceff1;color:#586974}
@media(min-width:1450px){#domains{grid-template-columns:repeat(5,minmax(0,1fr))}.domain-head{align-items:flex-start;flex-direction:column}.domain-number{font-size:23px}}
@media(max-width:1050px){.layout{grid-template-columns:140px minmax(0,1fr)}#domains{grid-template-columns:repeat(2,minmax(0,1fr))}.domain-number{font-size:22px}}
@media(max-width:640px){.layout{display:block}#domains{grid-template-columns:1fr}.layout>aside:first-child{margin-bottom:12px}.task-controls select{max-width:230px}#evidence{margin-top:18px}.domain-head{flex-direction:row}.domain-card{gap:6px}#tasks{flex-direction:row}.domain-card .last-activity{font-size:11px}}
`;
