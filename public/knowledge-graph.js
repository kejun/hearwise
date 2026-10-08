import { createGraphRenderer } from './knowledge-graph-renderer.js';

// The graph is a presentation of persisted knowledge, never a source of new facts.
export const KNOWLEDGE_VIEW_KEY = 'tongsheng:knowledge-view';
const TYPES = { person: '人物', organization: '组织', product: '产品', work: '作品', method: '方法', event: '事件', place: '地点', term: '术语', other: '其他' };
const PREDICATES = { founded: '创立', leads: '领导', member_of: '属于', developed: '开发', released: '推出', authored: '创作', uses: '使用', based_on: '基于', part_of: '组成部分', partners_with: '合作', compared_with: '比较', participated_in: '参与', located_in: '位于', acquired: '收购', causes: '导致' };
const SYMMETRIC = new Set(['partners_with', 'compared_with']);
export function knowledgeType(item) { return TYPES[item.display_label] || TYPES[item.type] || item.display_label || item.type || '其他'; }
export function readKnowledgeView(storage) { try { return storage?.getItem(KNOWLEDGE_VIEW_KEY) === 'graph' ? 'graph' : 'list'; } catch { return 'list'; } }
export function saveKnowledgeView(storage, value) { try { storage?.setItem(KNOWLEDGE_VIEW_KEY, value === 'graph' ? 'graph' : 'list'); } catch { /* Private browsing must still work. */ } }
export function visibleAssertions(relation) { return (relation.assertions || []).filter(a => ['active', 'needs_review'].includes(a.status)); }
export function assertionQualifiers(assertion) {
  const parts = [];
  if (assertion.polarity === 'negative') parts.push('否定');
  if (assertion.modality === 'planned') parts.push('计划');
  if (assertion.modality === 'uncertain') parts.push('推测');
  if (assertion.status === 'needs_review') parts.push('待核对');
  if (assertion.status === 'stale') parts.push('依据已失效');
  if (assertion.status === 'superseded') parts.push('已被更正');
  if (assertion.conditions) parts.push(`条件：${assertion.conditions}`);
  if (assertion.time_scope) parts.push(`时间：${assertion.time_scope}`);
  if (assertion.attribution) parts.push(`转述：${assertion.attribution}`);
  return parts;
}
export function relationLabel(relation) {
  const label = PREDICATES[relation.predicate] || relation.predicate;
  const assertions = visibleAssertions(relation);
  const variants = [...new Set(assertions.map(a => {
    const marks = [];
    if (a.polarity === 'negative') marks.push('否定');
    if (a.modality === 'planned') marks.push('计划');
    if (a.modality === 'uncertain') marks.push('推测');
    if (a.status === 'needs_review') marks.push('待核对');
    if (a.time_scope) marks.push('时间限定');
    if (a.conditions) marks.push('有条件');
    if (a.attribution) marks.push('转述');
    return marks.length ? `${marks.join('·')} ${label}` : label;
  }))];
  return variants.join(' / ') || label;
}
export function filterGraph(nodes, relations, { query = '', type = '', localId = null } = {}) {
  const ids = new Set(nodes.map(n => n.id));
  const valid = relations.filter(r => ids.has(r.subject_item_id) && ids.has(r.object_item_id) && visibleAssertions(r).length);
  const local = localId ? new Set([localId]) : null;
  if (local) for (const r of valid) {
    if (r.subject_item_id === localId) local.add(r.object_item_id);
    if (r.object_item_id === localId) local.add(r.subject_item_id);
  }
  const needle = query.trim().toLocaleLowerCase();
  const filtered = nodes.filter(n => (!type || knowledgeType(n) === type) && (!local || local.has(n.id)) &&
    (!needle || [n.canonical_name, n.short_description, n.dialogue_summary, ...(n.aliases || [])].join(' ').toLocaleLowerCase().includes(needle)));
  const shown = new Set(filtered.map(n => n.id));
  return { nodes: filtered, relations: valid.filter(r => shown.has(r.subject_item_id) && shown.has(r.object_item_id)), total: nodes.length };
}
// One request at a time, monotonic revisions, and a generation for A→B→A switches.
// Poll active work even if a start response or the last invalidation event is lost.
export function createGraphSnapshotLoader({ read, onSnapshot, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let id = null, generation = 0, revision = -1, wanted = -1, controller, timer, timerKind;
  let flight = false, queued = false, polling = false, failures = 0;
  function stop() {
    generation++; controller?.abort(); clearTimer(timer); timer = null; timerKind = null;
    flight = queued = polling = false; failures = 0;
  }
  function schedule(delay = 35, kind = 'refresh') {
    if (!id) return;
    if (timer != null) {
      if (kind !== 'refresh' || timerKind === 'refresh') return;
      clearTimer(timer);
    }
    const gen = generation;
    timerKind = kind;
    timer = setTimer(() => { timer = null; timerKind = null; if (gen === generation) void refresh(); }, delay);
  }
  function setPolling(value) {
    const wasPolling = polling; polling = Boolean(value);
    if (!polling && (timerKind === 'poll' || wasPolling && timerKind === 'retry')) { clearTimer(timer); timer = null; timerKind = null; }
    if (polling && !flight) schedule(2000, 'poll');
  }
  async function refresh() {
    if (!id) return;
    if (flight) { queued = true; return; }
    clearTimer(timer); timer = null; timerKind = null; flight = true; queued = false;
    const selected = id, gen = generation;
    const abort = new AbortController(); controller = abort;
    let stale = false, failed = false;
    try {
      const snapshot = await read(selected, abort.signal);
      if (gen !== generation || selected !== id || abort.signal.aborted || snapshot.listeningId !== selected) return;
      const next = Number(snapshot.graphRevision) || 0;
      if (next < revision || next < wanted) { stale = true; return; }
      revision = next; failures = 0;
      setPolling(graphWorkActive(snapshot.status) && snapshot.status?.state !== 'waiting_key' && snapshot.status?.waitReason !== 'waiting_key' && snapshot.status?.keyAvailable !== false);
      onSnapshot(snapshot);
    } catch (error) {
      if (gen === generation && !abort.signal.aborted) {
        failures++; failed = error.status !== 404;
        if (!failed) { polling = false; queued = false; }
        onError(error);
      }
    } finally {
      if (gen === generation) {
        flight = false;
        if (queued || stale) schedule(stale ? 1000 : 35);
        // Inactive reads get three recovery attempts. Active work keeps checking
        // with capped backoff until an authoritative terminal snapshot arrives.
        else if (failed && (polling || failures <= 3)) schedule(Math.min(15000, 2000 * 2 ** Math.min(failures, 3)), 'retry');
        else if (polling) schedule(2000, 'poll');
      }
    }
  }
  return {
    select(next) { if (id === next) return; stop(); id = next; revision = wanted = -1; if (id) schedule(0); },
    invalidate(selected, next) { if (selected !== id) return; const value = Number(next) || 0; if (value <= revision && value <= wanted) return; wanted = Math.max(wanted, value); if (flight) queued = true; else schedule(); },
    refresh,
    reconcile() { const wasPolling = polling; stop(); polling = wasPolling; return refresh(); },
    setPolling,
    stop() { stop(); id = null; revision = wanted = -1; }
  };
}

const GRAPH_TERMINAL = new Set(['paused', 'cancelled', 'complete', 'empty', 'ok', 'failed', 'invalid', 'partial', 'waiting_nodes']);
const terminalSignature = status => GRAPH_TERMINAL.has(status.state) ? JSON.stringify([status.round?.id, status.round?.epoch, status.state, status.requestCount, status.progress, status.failedJobs, status.partialJobs]) : null;
const retryableGraph = status => status.canRetryProblems === true;
const RELATION_STOPPED = new Set(['paused', 'cancelled', 'complete', 'empty', 'ok', 'failed', 'invalid', 'partial', 'waiting_nodes', 'not_generated']);
export function graphWorkActive(status = {}) {
  if (status.enabled === false || RELATION_STOPPED.has(status.state)) return false;
  return ['running', 'queued', 'pending', 'retrying', 'waiting_key'].includes(status.state) ||
    Boolean(status.pendingJobs || status.runningJobs || status.retryingJobs);
}
// Detail polls/SSE may arrive after a newer start or cancel. Content completion
// is different: new source windows may legitimately resume the same active round.
export function acceptGraphProcessing(current = {}, incoming = {}) {
  const previous = current.round, next = incoming.round;
  if (previous && !next && (incoming.state === 'not_generated' || incoming.enabled === false)) return false;
  if (previous && next) {
    if (previous.epoch != null && next.epoch != null) {
      if (Number(next.epoch) < Number(previous.epoch)) return false;
    } else if (previous.id !== next.id && timestamp(next.startedAt) < timestamp(previous.startedAt)) return false;
    if (['paused', 'cancelled'].includes(current.state) && graphWorkActive(incoming) && previous.id === next.id) return false;
  }
  return true;
}
export function graphStatusText(status = {}, hasRelations = false) {
  if (typeof status === 'string') status = { state: status };
  const state = status.state || status.status;
  if (state === 'cancelled') return '关系整理已取消，已保存的关系仍可查看；剩余内容需手动继续';
  if (state === 'paused') return '历史关系任务已暂停，已保存的关系仍可查看；点击继续处理剩余内容';
  if (state === 'not_generated' || status.enabled === false) return '尚未生成关系，知识条目可先独立查看';
  if (state === 'waiting_key' || status.waitReason === 'waiting_key' || status.keyAvailable === false && graphWorkActive(status)) return '关系待继续整理：需连接设置中的 API Key';
  if (graphWorkActive(status)) {
    if (status.waitReason === 'foreground') return '正在等待实时翻译等前台任务，关系暂未发起新请求';
    if (status.waitReason === 'provider_cooldown') return '服务商限流冷却中，等待后再尝试';
    if (['retrying', 'network_retry'].includes(status.waitReason)) return '上次请求未完成，正在等待重试';
    if (status.waitReason === 'quiet_period') return '等待原文与知识条目稳定后再整理，暂未发起新请求';
    if (status.waitReason === 'admission_interval') return '等待请求间隔，暂未发起新请求';
    if (status.waitReason === 'translations') return '等待相关译文完成后再整理关系';
    if (status.waitReason === 'queued' || !status.runningJobs && ['pending', 'queued'].includes(state)) return '关系已排队，等待可用处理位置';
    return '正在整理关系…字幕与条目可继续使用';
  }
  if (status.failedJobs || ['failed', 'invalid'].includes(state)) return '关系整理失败，已有条目与关系仍可查看；可手动重试未完成内容';
  if (status.partialJobs || state === 'partial') return '关系部分完成，部分内容未处理完整；已保存关系可继续查看';
  if (state === 'waiting_nodes') return '当前可关联的知识条目不足，条目可独立查看';
  if (['complete', 'empty', 'ok'].includes(state) || status.completedJobs || status.completeJobs) {
    return hasRelations ? '关系整理完成' : '关系整理完成，未发现有充分依据的关系；知识条目可独立查看';
  }
  if (hasRelations) return '已保存的对话关系';
  return '尚未生成关系，知识条目可先独立查看';
}
const numberText = value => value != null && Number.isFinite(Number(value)) ? Math.max(0, Number(value)).toLocaleString('en-US') : '未知';
function timestamp(value) { return typeof value === 'number' ? value : value ? Date.parse(value) : NaN; }
function durationText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
export function graphProgressText(status = {}, now = Date.now()) {
  const progress = status.progress, round = status.round;
  const progressText = progress ? `已处理 ${numberText(progress.completedWindows)} / ${numberText(progress.totalWindows)} 个文本窗口${progress.partialWindows ? `（其中 ${numberText(progress.partialWindows)} 个部分完成）` : ''} · 剩余 ${numberText(progress.remainingWindows)} 个` : '';
  if (!round) return { progress: progressText, round: '' };
  const started = timestamp(round.startedAt), finished = timestamp(round.finishedAt);
  const working = graphWorkActive(status);
  const elapsed = Number.isFinite(started) && (working || Number.isFinite(finished))
    ? ` · ${working ? '本轮已等待/处理' : '本轮用时'} ${durationText((working ? now : finished) - started)}` : '';
  const tokens = ` · 已返回用量 ${numberText(round.totalTokens)} tokens（${numberText(round.measuredRequests)} 次请求）`;
  const unknown = Math.max(0, (Number(round.requestCount) || 0) - (Number(round.measuredRequests) || 0));
  return { progress: progressText, round: `本轮请求 ${numberText(round.requestCount)} 次${elapsed}${tokens}${unknown ? ` · ${numberText(unknown)} 次用量尚未知，仍可能计费` : ''}` };
}
export function graphUsageText(hour) {
  if (!hour) return '过去 1 小时用量暂不可用；未记录或未返回用量不代表免费。费用以服务商账单为准。';
  const unknown = Math.max(0, (Number(hour.requests) || 0) - (Number(hour.measuredRequests) || 0));
  return `本次收听过去 1 小时：${numberText(hour.requests)} 次关系请求；${numberText(hour.measuredRequests)} 次返回用量，共 ${numberText(hour.totalTokens)} tokens（输入 ${numberText(hour.inputTokens)} / 输出 ${numberText(hour.outputTokens)}）。${unknown ? `${numberText(unknown)} 次请求用量未知，未计入 token 合计，仍可能产生费用。` : ''}费用以服务商账单为准。`;
}
export function graphDiagnosticsText(status = {}) {
  const d = status.diagnostics;
  if (status.state === 'not_generated') return [];
  if (!d) return status.state && status.state !== 'not_generated' ? ['诊断暂不可用；不能根据空图谱判断模型是否返回了关系候选。'] : [];
  const lines = [
    `服务端关系：当前可见 ${numberText(d.visibleRelationCount)} 条 · 已保存 ${numberText(d.storedRelationCount)} 条（含已失效关系）`,
    `各窗口最近一次已记录结果（不是本轮累计）：模型返回 ${numberText(d.returnedCount)} 项 · 通过校验 ${numberText(d.validatorAcceptedCount)} 项 · 最终接收 ${numberText(d.acceptedCount)} 项 · 已忽略候选 ${numberText(d.rejectedCount)} 项`,
    `写入新关系 ${numberText(d.insertedRelationCount)} 条 · 复用已有关系 ${numberText(d.deduplicatedCount)} 项（可能新增表述或依据）`,
    `已完成或部分完成的窗口结果：${numberText(d.resultJobs)} 个，其中 ${numberText(d.measuredJobs)} 个有完整数量记录 · ${numberText(d.coverageLimitedWindows)} 个窗口存在输入覆盖限制`
  ];
  if (d.resultJobs === 0) lines.push('尚无已完成或部分完成的窗口结果；请求失败原因及当前已保存关系仍可在此查看。');
  if (d.unknownJobs || ['returnedCount', 'validatorAcceptedCount', 'acceptedCount', 'insertedRelationCount', 'deduplicatedCount'].some(key => d[key] == null)) {
    lines.push(`有 ${numberText(d.unknownJobs)} 个窗口的数量未记录或尚未取得（可能是历史记录、等待处理或解析失败）；未知不等于 0，也不能据此认定模型没有返回关系。`);
  }
  for (const [field, title] of [['rejectionReasons', '未保存候选详情'], ['failureReasons', '请求失败原因']]) {
    const reasons = Array.isArray(d[field]) ? d[field] : [];
    if (reasons.length) lines.push(`${title}：${reasons.map(reason => `${reason.label || reason.code || '原因未记录'}（${numberText(reason.count)} 项${reason.label && reason.code ? `，${reason.code}` : ''}）`).join('；')}`);
  }
  return lines;
}

export function graphCostText() {
  return '将相关原文、译文和条目发送给千问，产生模型费用。可随时取消，已发出的请求仍可能计费。';
}

export function createKnowledgeGraph({ root, getKey, onRequireKey, onStarted = () => {}, loadSegment, locateSegment, onNodes = () => {}, onEdit, runNumber = () => '?' }) {
  const doc = root.ownerDocument;
  function element(tag, className = '', text) {
    const node = doc.createElement(tag); node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(text, id, action, className = 'graph-button') {
    const node = element('button', className, text); node.type = 'button'; if (id) node.id = id;
    node.addEventListener('click', action); return node;
  }
  let listeningId = null, nodes = [], relations = [], snapshotStatus = {}, selected = null;
  let active = false, generation = 0, detailGeneration = 0, trigger = null, renderer = null, autoFit = true;
  let generated = false, generating = false, cancelling = false, recovering = false, progressTimer = null, localId = null, panelFingerprint = '', updates = 0;
  let terminalSyncing = false, lastTerminalSignature = null, retryIntent = null;
  const nodeElements = new Map(), edgeElements = new Map(), resultElements = new Map(), evidenceControllers = new Set();
  const toolbar = element('div', 'graph-toolbar');
  const searchLabel = element('label', 'graph-search-label', '搜索知识');
  const search = element('input'); search.type = 'search'; search.id = 'graph-search'; search.placeholder = '名称、别名或简介'; searchLabel.append(search);
  const typeLabel = element('label', 'graph-type-label', '类型');
  const type = element('select'); type.id = 'graph-type'; typeLabel.append(type);
  const zoomOut = button('−', 'graph-zoom-out', () => zoom(1 / 1.2)); zoomOut.setAttribute('aria-label', '缩小图谱');
  const zoomIn = button('+', 'graph-zoom-in', () => zoom(1.2)); zoomIn.setAttribute('aria-label', '放大图谱');
  const fit = button('适应全部', 'graph-fit', () => fitView());
  const local = button('一跳邻居', 'graph-local', () => { localId = localId ? null : selected?.kind === 'node' ? selected.id : null; render(); fitView(); });
  local.setAttribute('aria-pressed', 'false'); local.title = '选择节点后查看它和直接相连的节点';
  const relayout = button('重新布局', 'graph-relayout', () => { renderer?.arrange(); render(); fitView(); });
  relayout.title = '按当前关系重新聚拢节点';
  const fullscreen = button('全屏', 'graph-fullscreen', () => setFullscreen(!savedView));
  fullscreen.setAttribute('aria-pressed', 'false'); fullscreen.setAttribute('aria-label', '全屏查看图谱');
  toolbar.append(searchLabel, typeLabel, zoomOut, zoomIn, fit, relayout, local, fullscreen);
  const count = element('p', 'graph-count'); count.id = 'graph-count'; count.setAttribute('role', 'status');
  const viewport = element('div', 'graph-viewport'); viewport.id = 'graph-viewport'; viewport.tabIndex = 0; viewport.setAttribute('role', 'group');
  viewport.setAttribute('aria-label', '知识图谱：拖动节点或空白处，滚轮或双指缩放。也可用方向键平移、加减键缩放，或下方列表浏览');
  const help = element('p', 'graph-help', '拖动节点调整位置 · 拖动空白平移 · 滚轮 / 双指缩放 · 选择节点突出直接关系');
  help.id = 'graph-help'; viewport.setAttribute('aria-describedby', help.id);
  const legend = element('div', 'graph-legend'); legend.setAttribute('aria-label', '图谱分组');
  const groupLabels = new Map(['connected', 'independent'].map(group => {
    const label = element('span', 'graph-group-label'); label.dataset.graphGroup = group; legend.append(label); return [group, label];
  }));
  const noNodes = element('p', 'graph-empty', '尚无知识条目，最终原文出现后会持续整理。');
  const resultDetails = element('details', 'graph-results');
  resultDetails.append(element('summary', '', '节点列表'));
  const resultList = element('ul'); resultList.id = 'graph-results'; resultDetails.append(resultList);
  const relationDetails = element('details', 'graph-relations');
  relationDetails.append(element('summary', '', '关系列表与依据'));
  const relationList = element('ul'); relationDetails.append(relationList);
  resultDetails.setAttribute('aria-label', '节点列表，可用键盘浏览');
  relationDetails.setAttribute('aria-label', '关系列表，包含方向、限定与依据');
  const accessibleLists = element('div', 'graph-accessible'); accessibleLists.append(resultDetails, relationDetails);
  const refresh = button('刷新关系', 'graph-refresh', () => { void loader.refresh(); });
  refresh.title = '仅重新读取已保存的关系，不调用模型';
  const status = element('p', 'graph-status'); status.id = 'graph-status'; status.setAttribute('role', 'status');
  const notice = element('p', 'graph-notice'); notice.id = 'graph-updates'; notice.setAttribute('role', 'status');
  const generate = button('生成本次收听的关系', 'graph-generate', () => { void startGeneration(); });
  const retry = button('重试未完成窗口', 'graph-retry', () => showRetryConfirmation());
  const cancel = button('取消关系整理', 'graph-cancel', () => { void cancelGeneration(); });
  const costs = element('p', 'graph-cost'); costs.id = 'graph-cost'; generate.setAttribute('aria-describedby', 'graph-cost'); cancel.setAttribute('aria-describedby', 'graph-cost');
  const progress = element('p', 'graph-progress'); progress.id = 'graph-progress'; progress.setAttribute('role', 'status');
  const progressBar = element('progress', 'graph-progress-bar'); progressBar.setAttribute('aria-label', '关系文本窗口完成进度');
  const round = element('p', 'graph-round'); round.id = 'graph-round';
  const actions = element('div', 'graph-actions'); actions.append(generate, retry, cancel, refresh);
  const actionNotice = element('p', 'graph-notice'); actionNotice.id = 'graph-action-notice'; actionNotice.setAttribute('role', 'status');
  const retryPanel = element('section', 'graph-retry-panel'); retryPanel.id = 'graph-retry-panel'; retryPanel.hidden = true;
  retryPanel.setAttribute('aria-label', '重试关系确认');
  const retryWarning = element('p', '', '仅重新处理请求失败或未处理完整的文本窗口；没有可靠关系的窗口无需重试；成功窗口和已保存关系保留。会再次发送相关原文、译文及知识条目给千问，可能产生额外模型费用。');
  retryWarning.id = 'graph-retry-warning'; retry.setAttribute('aria-describedby', retryWarning.id);
  const confirmRetry = button('确认重试，可能产生费用', 'graph-retry-confirm', () => { void confirmSelectiveRetry(); });
  const dismissRetry = button('暂不重试', 'graph-retry-dismiss', () => { retryIntent = null; retryPanel.hidden = true; retry.focus({ preventScroll: true }); });
  const retryActions = element('div', 'graph-actions'); retryActions.append(confirmRetry, dismissRetry); retryPanel.append(retryWarning, retryActions);
  const jobPanel = element('section', 'graph-job-panel'); jobPanel.setAttribute('aria-label', '关系整理进度与费用');
  const diagnostics = element('details', 'graph-diagnostics');
  const diagnosticSummary = element('summary', '', '整理详情'); diagnostics.id = 'graph-diagnostics'; diagnostics.setAttribute('aria-label', '关系生成诊断');
  const usage = element('p', 'graph-cost'); usage.id = 'graph-usage';
  const disclaimer = element('p', 'graph-disclaimer', '连线表示对话中有这样的表述，不代表已经外部事实核查。计划、否定、推测和时间条件会保留。');
  const panel = element('section', 'graph-details'); panel.id = 'graph-details'; panel.hidden = true;
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '知识与关系详情');
  const panelHeader = element('div', 'graph-details-header');
  const panelTitle = element('h3'); panelTitle.id = 'graph-detail-title'; panel.setAttribute('aria-labelledby', panelTitle.id);
  const close = button('关闭', 'graph-close', () => closeDetails()); panelHeader.append(panelTitle, close);
  const panelBody = element('div', 'graph-details-body'); panel.append(panelHeader, panelBody);
  const explorer = element('section', 'graph-explorer'); explorer.setAttribute('aria-label', '知识图谱');
  explorer.append(toolbar, count, legend, viewport, help, noNodes, notice, accessibleLists, disclaimer, panel);
  const fullscreenDialog = element('dialog', 'graph-fullscreen-dialog'); fullscreenDialog.id = 'graph-fullscreen-dialog';
  fullscreenDialog.setAttribute('aria-label', '全屏知识图谱');
  let savedView = null;
  function ensureRenderer() {
    if (!renderer && active && viewport.clientWidth && viewport.clientHeight) renderer = createGraphRenderer({ container: viewport,
      onSelect: (kind, id) => openDetails(kind, id, viewport), onBackground: () => closeDetails(false),
      onViewportChange: () => { autoFit = false; } });
    return renderer;
  }
  function setFullscreen(value, restoreFocus = true) {
    if (value === Boolean(savedView)) return;
    if (value) {
      savedView = { view: renderer?.save(), autoFit, overflow: doc.body.style.overflow };
      fullscreenDialog.append(explorer); fullscreenDialog.showModal(); doc.body.style.overflow = 'hidden';
      fullscreen.textContent = '退出全屏'; fullscreen.setAttribute('aria-label', '退出全屏图谱');
      fullscreen.setAttribute('aria-pressed', 'true'); autoFit = true; renderer?.resize(); renderer?.arrange(); render(); fitView(); fullscreen.focus({ preventScroll: true });
    } else {
      const previous = savedView; savedView = null;
      fullscreenDialog.close(); root.append(explorer); doc.body.style.overflow = previous.overflow;
      fullscreen.textContent = '全屏'; fullscreen.setAttribute('aria-label', '全屏查看图谱'); fullscreen.setAttribute('aria-pressed', 'false');
      autoFit = false; render(); renderer?.resize();
      if (previous.view && !renderer?.restore(previous.view)) { renderer?.arrange(); render(); fitView(); }
      else autoFit = previous.autoFit;
      if (restoreFocus) fullscreen.focus({ preventScroll: true });
    }
  }
  // Native modal dialogs make the page inert, but Chromium can still move Tab
  // focus to browser chrome. Keep keyboard graph navigation inside this view.
  fullscreenDialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !fullscreenDialog.open) return;
    const controls = [...fullscreenDialog.querySelectorAll('button, input, select, summary, a[href], [tabindex]')]
      .filter(control => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && doc.activeElement === first || !event.shiftKey && doc.activeElement === last) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus({ preventScroll: true });
    }
  });
  fullscreenDialog.addEventListener('cancel', event => { event.preventDefault(); setFullscreen(false); });
  fullscreenDialog.addEventListener('close', () => { if (savedView && !fullscreenDialog.open) setFullscreen(false); });
  jobPanel.append(status, progress, progressBar, round, actions, actionNotice, retryPanel, diagnostics, costs);
  root.append(jobPanel, explorer, fullscreenDialog);
  const loader = createGraphSnapshotLoader({
    read: async (id, signal) => {
      const controller = new AbortController(), abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 10000);
      try {
        const response = await fetch(`/api/listenings/${encodeURIComponent(id)}/graph`, { signal: controller.signal });
        const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || '关系读取失败，请重试'), { status: response.status }); return data;
      } catch (error) { if (controller.signal.aborted && !signal.aborted) throw new Error('关系读取超时'); throw error; }
      finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
    },
    onSnapshot(data) {
      if (data.listeningId !== listeningId) return;
      if (!acceptGraphProcessing(snapshotStatus, data.status || {})) { render(); return; }
      recovering = terminalSyncing = false;
      lastTerminalSignature = terminalSignature(data.status || {});
      const previousNodes = JSON.stringify(nodes);
      for (const id of data.deletedItemIds || []) deletedNodes.add(id);
      nodes = nodes.filter(node => !deletedNodes.has(node.id));
      mergeNodes(data.nodes || []); relations = data.relations || [];
      if (acceptGraphProcessing(snapshotStatus, data.status || {})) snapshotStatus = data.status || {};
      generated = generated || Boolean(relations.length || snapshotStatus.state && snapshotStatus.state !== 'not_generated');
      status.textContent = graphStatusText(snapshotStatus, relations.some(r => visibleAssertions(r).length));
      render();
      if (JSON.stringify(nodes) !== previousNodes) onNodes([...nodes]);
    },
    onError(error) { status.textContent = `${error.message || '关系暂时无法读取'}；知识条目仍可查看${recovering ? '。服务器操作状态尚未确认，请刷新关系后再继续' : terminalSyncing ? '。最终图谱尚未同步，请刷新关系；当前连线数量不是最终结果' : ''}`; }
  });
  const deletedNodes = new Set();
  function mergeNodes(incoming) {
    const all = new Map(nodes.map(n => [n.id, n]));
    for (const node of incoming) {
      if (deletedNodes.has(node.id)) continue;
      const old = all.get(node.id);
      if (!old || (node.content_version || 0) > (old.content_version || 0) ||
        (node.content_version || 0) === (old.content_version || 0) && (node.updated_at || '') >= (old.updated_at || '')) all.set(node.id, node);
    }
    nodes = [...all.values()];
  }
  function zoom(factor) { autoFit = false; ensureRenderer()?.zoom(factor); }
  function fitView() { autoFit = true; ensureRenderer()?.fit(); }
  function abortEvidence() { for (const c of evidenceControllers) c.abort(); evidenceControllers.clear(); }
  function closeDetails(restore = true) {
    panel.hidden = true; selected = null; panelFingerprint = ''; detailGeneration++; abortEvidence();
    if (restore && active) {
      const target = trigger?.isConnected && !trigger.hidden && trigger.getClientRects().length ? trigger : viewport;
      target.focus({ preventScroll: true });
    }
    trigger = null; render();
  }
  function openDetails(kind, id, origin) {
    selected = { kind, id }; trigger = origin; panelFingerprint = ''; panel.hidden = false;
    renderDetails(true); render(); close.focus({ preventScroll: true });
  }
  async function populateEvidence(support, container, gen) {
    const selectedListening = listeningId, controller = new AbortController(); evidenceControllers.add(controller);
    container.textContent = '读取原文与最终译文…';
    try {
      const segment = await loadSegment(support.segment_id, controller.signal);
      if (gen !== detailGeneration || selectedListening !== listeningId || controller.signal.aborted || !container.isConnected) return;
      container.replaceChildren();
      container.append(element('p', 'graph-evidence-location', `第 ${segment.run_no || runNumber(segment)} 次收听 · 第 ${segment.sequence_no} 句`));
      const original = element('p', 'graph-evidence-original'); original.append(element('strong', '', '原文：'));
      const source = segment.original_text || '', quote = support.quote || support.surface_text || '';
      const start = Number.isInteger(support.start) ? support.start : source.indexOf(quote), end = Number.isInteger(support.end) ? support.end : start + quote.length;
      if (quote && start >= 0 && source.slice(start, end) === quote) {
        original.append(doc.createTextNode(source.slice(0, start)), element('mark', '', quote), doc.createTextNode(source.slice(end)));
      } else original.append(doc.createTextNode(source));
      container.append(original, element('p', 'graph-evidence-translation', segment.translation_state === 'complete'
        ? `最终译文：${segment.translation_text || '（与原文相同）'}`
        : segment.translation_state === 'failed' ? '最终译文：翻译失败，以上原文仍可核对' : '最终译文：尚未完成，暂不使用临时译文'));
      container.append(button('定位到全文原句', '', () => { closeDetails(false); setFullscreen(false, false); locateSegment(segment); }));
    } catch (error) {
      if (gen !== detailGeneration || selectedListening !== listeningId || controller.signal.aborted) return;
      container.textContent = error.message || '证据暂时无法读取';
      container.append(button('重试读取', '', () => { void populateEvidence(support, container, gen); }));
    } finally { evidenceControllers.delete(controller); }
  }
  function evidence(support, open = false) {
    const entry = element('details', 'graph-evidence');
    const role = { subject_reference: '主体指代', object_reference: '客体指代', relation: '关系依据' }[support.role] || '原文依据';
    const invalid = support.state && !['active', 'valid'].includes(support.state);
    entry.append(element('summary', '', `${invalid ? '失效依据（不再支持当前表述） · ' : ''}${role}：“${support.quote || support.surface_text || '查看原句'}”`));
    if (invalid) entry.append(element('p', 'graph-qualifiers', '此引用对应的来源已失效，仅供查阅历史，不作为有效关系依据。'));
    const content = element('div', 'graph-evidence-content'); entry.append(content);
    let loaded = false;
    entry.addEventListener('toggle', () => { if (entry.open && !loaded) { loaded = true; void populateEvidence(support, content, detailGeneration); } });
    entry.open = open; return entry;
  }
  function appendRelation(relation, container, expanded = false) {
    const subject = nodes.find(n => n.id === relation.subject_item_id), object = nodes.find(n => n.id === relation.object_item_id);
    const section = element('details', 'graph-relation-detail'); section.open = expanded;
    section.append(element('summary', '', `${visibleAssertions(relation).length ? '' : '历史表述 · '}${subject?.canonical_name || '知识'} ${SYMMETRIC.has(relation.predicate) ? '↔' : '→'} ${relationLabel(relation)} ${SYMMETRIC.has(relation.predicate) ? '↔' : '→'} ${object?.canonical_name || '知识'}`));
    const otherId = selected?.id === relation.subject_item_id ? relation.object_item_id : relation.subject_item_id;
    const other = nodes.find(n => n.id === otherId);
    if (other) section.append(button(`查看知识：${other.canonical_name}`, '', event => openDetails('node', otherId, nodeElements.get(otherId) || viewport)));
    for (const assertion of relation.assertions || []) {
      const article = element('article', 'graph-assertion');
      article.append(element('p', 'graph-statement', assertion.statement));
      const qualifiers = assertionQualifiers(assertion);
      if (qualifiers.length) article.append(element('p', 'graph-qualifiers', qualifiers.join(' · ')));
      for (const support of assertion.supports || []) article.append(evidence(support, expanded));
      section.append(article);
    }
    container.append(section);
  }
  function renderDetails(force = false) {
    if (!selected || panel.hidden) return;
    const item = selected.kind === 'node' ? nodes.find(n => n.id === selected.id) : relations.find(r => r.id === selected.id);
    if (!item) { closeDetails(false); return; }
    const related = selected.kind === 'node' ? relations.filter(r => r.subject_item_id === item.id || r.object_item_id === item.id) : [];
    const fingerprint = JSON.stringify([selected, item, related]);
    if (fingerprint === panelFingerprint) return;
    // Background updates do not replace controls beneath the reader's focus.
    if (!force && panel.contains(doc.activeElement)) { notice.textContent = '详情有更新，重新选择此节点可查看；当前阅读位置已保留'; return; }
    panelFingerprint = fingerprint; detailGeneration++; abortEvidence(); panelBody.replaceChildren();
    panelTitle.textContent = selected.kind === 'node' ? item.canonical_name : relationLabel(item);
    if (selected.kind === 'node') {
      panelBody.append(element('p', 'knowledge-type', knowledgeType(item)));
      if (item.certainty === 'needs_review') panelBody.append(element('p', 'graph-qualifiers', '知识身份待确认'));
      panelBody.append(element('p', 'graph-description', item.short_description || item.dialogue_summary || '暂无简介'));
      if (item.aliases?.length) panelBody.append(element('p', 'knowledge-aliases', `别名：${item.aliases.join('、')}`));
      for (const fact of item.facts || []) panelBody.append(element('p', 'knowledge-dialogue', `本次提到：${fact.content}`));
      if (item.background_note) panelBody.append(element('p', 'knowledge-background', `背景补充（模型生成，不作为关系依据）：${item.background_note}`));
      if (onEdit) panelBody.append(button('修改 / 删除', 'graph-edit-node', () => onEdit(item)));
      panelBody.append(element('h4', '', '相关知识'));
      if (!related.length) panelBody.append(element('p', '', '暂未发现有明确依据的关系；该知识仍作为独立节点保留。'));
      for (const relation of related) appendRelation(relation, panelBody);
      panelBody.append(element('h4', '', '对话原文依据'));
      for (const mention of item.mentions || []) panelBody.append(evidence(mention));
      if (!item.mentions?.length) panelBody.append(element('p', '', '此条目暂无可用引用'));
    } else appendRelation(item, panelBody, true);
    panelBody.append(element('p', 'graph-disclaimer', '依据仅证明对话这样表述，不等于外部事实核查；这里只定位文字，不提供音频回放。'));
  }
  function render() {
    const filtered = filterGraph(nodes, relations, { query: search.value, type: type.value, localId });
    const options = ['全部类型', ...new Set(nodes.map(knowledgeType).sort())];
    if (JSON.stringify([...type.options].map(o => o.textContent)) !== JSON.stringify(options)) {
      const value = type.value; type.replaceChildren(...options.map((label, index) => { const option = element('option', '', label); option.value = index ? label : ''; return option; })); type.value = value;
    }
    const shown = new Set(filtered.nodes.map(n => n.id));
    const valid = filterGraph(nodes, relations);
    const connected = new Set(valid.relations.flatMap(r => [r.subject_item_id, r.object_item_id]));
    for (const [group, label] of groupLabels) {
      const length = filtered.nodes.filter(n => connected.has(n.id) === (group === 'connected')).length;
      label.hidden = !length; label.textContent = `${group === 'connected' ? '有关联的条目' : '独立条目'} · ${length}`;
    }
    const pendingEdges = relations.filter(r => visibleAssertions(r).length && (!nodes.some(n => n.id === r.subject_item_id) || !nodes.some(n => n.id === r.object_item_id))).length;
    count.textContent = `正在显示 ${filtered.nodes.length} / ${nodes.length} 个节点 · ${terminalSyncing ? '正在读取最新关系数量…' : `${filtered.relations.length} 条关系`}${localId ? ' · 一跳邻居' : ''}${pendingEdges ? ' · 部分关系等待节点同步' : ''}`;
    noNodes.hidden = filtered.nodes.length > 0;
    noNodes.textContent = nodes.length ? '没有符合筛选的知识。可清空搜索、选择全部类型或退出一跳视图。' : '尚无知识条目，最终原文出现后会持续整理。';
    local.disabled = !localId && selected?.kind !== 'node'; local.setAttribute('aria-pressed', String(Boolean(localId))); local.textContent = localId ? '退出一跳视图' : '一跳邻居';
    const allIds = new Set(nodes.map(n => n.id));
    for (const [id, entry] of resultElements) if (!allIds.has(id)) { entry.remove(); resultElements.delete(id); nodeElements.delete(id); }
    for (const node of nodes) {
      let entry = resultElements.get(node.id);
      if (!entry) {
        entry = element('li'); const b = button('', '', event => openDetails('node', node.id, event.currentTarget), 'graph-result-button');
        b.dataset.resultNodeId = node.id; entry.append(b); resultList.append(entry); resultElements.set(node.id, entry); nodeElements.set(node.id, b);
      }
      entry.hidden = !shown.has(node.id); entry.firstChild.textContent = `${node.canonical_name} · ${knowledgeType(node)}`;
      entry.firstChild.setAttribute('aria-pressed', String(selected?.kind === 'node' && selected.id === node.id));
      entry.firstChild.setAttribute('aria-label', `查看${knowledgeType(node)}：${node.canonical_name}`);
    }
    const visibleEdges = new Set(filtered.relations.map(r => r.id));
    for (const [id, entry] of edgeElements) if (!visibleEdges.has(id)) { entry.remove(); edgeElements.delete(id); }
    for (const relation of filtered.relations) {
      let entry = edgeElements.get(relation.id);
      if (!entry) {
        entry = element('li'); const b = button('', '', event => openDetails('relation', relation.id, event.currentTarget), 'graph-result-button');
        b.dataset.relationId = relation.id; entry.append(b); relationList.append(entry); edgeElements.set(relation.id, entry);
      }
      const subject = nodes.find(n => n.id === relation.subject_item_id), object = nodes.find(n => n.id === relation.object_item_id);
      const label = `${subject?.canonical_name} ${SYMMETRIC.has(relation.predicate) ? '↔' : '→'} ${relationLabel(relation)} ${SYMMETRIC.has(relation.predicate) ? '↔' : '→'} ${object?.canonical_name}`;
      entry.firstChild.textContent = label; entry.firstChild.setAttribute('aria-label', `查看关系依据：${label}`);
      entry.firstChild.setAttribute('aria-pressed', String(selected?.kind === 'relation' && selected.id === relation.id));
    }
    resultDetails.hidden = !filtered.nodes.length; relationDetails.hidden = !filtered.relations.length;
    const engine = ensureRenderer();
    if (engine) {
      const change = engine.update(nodes.map(n => ({ ...n, typeLabel: knowledgeType(n) })), valid.relations.map(r => ({ ...r,
        label: relationLabel(r), symmetric: SYMMETRIC.has(r.predicate), qualified: visibleAssertions(r).some(a => assertionQualifiers(a).length) })),
      { visibleNodes: filtered.nodes, visibleRelations: filtered.relations, selection: selected });
      if (autoFit && (change.structural || change.filtered)) engine.fit();
    }
    generate.disabled = generating || cancelling || recovering || terminalSyncing || !listeningId || snapshotStatus.state !== 'waiting_key' && graphWorkActive(snapshotStatus);
    generate.hidden = ['failed', 'partial', 'invalid'].includes(snapshotStatus.state);
    retry.hidden = !retryableGraph(snapshotStatus) || graphWorkActive(snapshotStatus);
    retry.textContent = `重试未完成窗口${snapshotStatus.retryableWindows ? `（${numberText(snapshotStatus.retryableWindows)} 个）` : ''}`;
    retry.disabled = generating || cancelling || recovering || terminalSyncing || !Number.isInteger(snapshotStatus.round?.epoch);
    if (retryIntent && (retryIntent.id !== listeningId || retryIntent.gen !== generation || retryIntent.expectedEpoch !== snapshotStatus.round?.epoch || graphWorkActive(snapshotStatus))) retryIntent = null;
    retryPanel.hidden = !retryIntent;
    confirmRetry.disabled = generating || cancelling || recovering || terminalSyncing;
    cancel.hidden = !graphWorkActive(snapshotStatus) && !cancelling;
    cancel.disabled = generating || cancelling || recovering;
    cancel.textContent = cancelling ? '正在取消…' : '取消关系整理';
    usage.textContent = graphUsageText(snapshotStatus.usageLastHour);
    costs.textContent = graphCostText(snapshotStatus);
    const diagnosticLines = graphDiagnosticsText(snapshotStatus);
    diagnostics.replaceChildren(diagnosticSummary, ...diagnosticLines.map(text => element('p', '', text)), usage); diagnostics.hidden = diagnosticLines.length === 0 && !snapshotStatus.usageLastHour;
    generate.textContent = generating ? '正在启动…' : recovering ? '正在确认服务器状态…' : ['failed', 'invalid'].includes(snapshotStatus.state) ? '重试未完成的关系' : snapshotStatus.state === 'partial' ? '检查新增或变化的内容' : generated ? '继续关系整理' : '生成本次收听的关系';
    loader.setPolling(!generating && !cancelling && graphWorkActive(snapshotStatus) && snapshotStatus.state !== 'waiting_key' && snapshotStatus.waitReason !== 'waiting_key' && snapshotStatus.keyAvailable !== false);
    renderProgress();
    renderDetails();
  }
  function renderProgress() {
    clearTimeout(progressTimer); progressTimer = null;
    const text = graphProgressText(snapshotStatus);
    progress.textContent = text.progress; progress.hidden = !text.progress;
    round.textContent = text.round; round.hidden = !text.round;
    const values = snapshotStatus.progress;
    progressBar.hidden = !values || !values.totalWindows;
    progressBar.max = Math.max(1, Number(values?.totalWindows) || 1);
    progressBar.value = Math.max(0, Number(values?.completedWindows) || 0);
    if (active && graphWorkActive(snapshotStatus) && snapshotStatus.round) progressTimer = setTimeout(renderProgress, 1000);
  }
  function showRetryConfirmation() {
    if (retry.disabled || retry.hidden || !listeningId) return;
    retryIntent = { id: listeningId, gen: generation, expectedEpoch: snapshotStatus.round.epoch };
    retryPanel.hidden = false; confirmRetry.focus({ preventScroll: true });
  }
  function confirmSelectiveRetry() {
    const intent = retryIntent;
    if (!intent || generating || cancelling || recovering || terminalSyncing) return;
    retryIntent = null; retryPanel.hidden = true;
    if (intent.id !== listeningId || intent.gen !== generation || intent.expectedEpoch !== snapshotStatus.round?.epoch || graphWorkActive(snapshotStatus)) return;
    return changeGeneration('POST', { retry: 'failed_partial', expectedEpoch: intent.expectedEpoch });
  }
  async function changeGeneration(method, options = {}) {
    if (!listeningId || generating || cancelling || recovering || terminalSyncing) return;
    const starting = method === 'POST';
    if (starting && snapshotStatus.state !== 'waiting_key' && graphWorkActive(snapshotStatus)) return;
    if (!starting && !graphWorkActive(snapshotStatus)) return;
    const key = getKey()?.trim();
    if (starting && !key) { status.textContent = '请先在连接设置填写 API Key，再点击生成关系'; onRequireKey(); return; }
    const id = listeningId, gen = generation;
    actionNotice.textContent = '';
    // An older GET must not replace the result of a start/cancel action.
    loader.stop(); recovering = terminalSyncing = false; retryIntent = null; generating = starting; cancelling = !starting; render();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`/api/listenings/${encodeURIComponent(id)}/graph`, { method, signal: controller.signal,
        ...(starting ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, ...options }) } : {}) });
      const data = await response.json();
      if (gen !== generation || id !== listeningId) return;
      if (!response.ok) throw Object.assign(new Error(data.error || (starting ? '启动关系整理失败' : '取消失败，请重试')), { status: response.status, code: data.code });
      generated = true; snapshotStatus = data.status || { ...snapshotStatus, state: starting ? 'queued' : 'cancelled' };
      status.textContent = graphStatusText(snapshotStatus, relations.some(r => visibleAssertions(r).length));
      onStarted(id);
    } catch (error) {
      if (gen === generation && error.status) actionNotice.textContent = error.message;
      if (gen === generation) status.textContent = controller.signal.aborted
        ? '操作响应超时，正在重新读取服务器状态；已发出的请求仍可能执行'
        : `${error.message || (starting ? '启动关系整理失败' : '取消失败，请重试')}；正在重新读取服务器状态`;
    }
    finally {
      clearTimeout(timeout);
      if (gen === generation) {
        generating = cancelling = false; recovering = true;
        loader.select(id); render();
        // select(sameId) is deliberately a no-op; explicitly reconcile every
        // action outcome, including a lost response, without repeating POST/DELETE.
        void loader.refresh();
      }
    }
  }
  function startGeneration() { if (!generate.hidden) return changeGeneration('POST'); }
  function cancelGeneration() { return changeGeneration('DELETE'); }
  const changeFilter = () => { render(); fitView(); };
  search.addEventListener('input', changeFilter); type.addEventListener('change', changeFilter);
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopPropagation(); closeDetails(); }
    if (event.target === viewport && ['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); if (event.key === '0') fitView();
      else if (event.key.startsWith('Arrow')) { autoFit = false; renderer?.pan(event.key === 'ArrowLeft' ? 50 : event.key === 'ArrowRight' ? -50 : 0, event.key === 'ArrowUp' ? 50 : event.key === 'ArrowDown' ? -50 : 0); }
      else zoom(event.key === '-' ? 1 / 1.2 : 1.2);
    }
  });
  const reconcile = () => { if (doc.visibilityState !== 'hidden') void loader.refresh(); };
  doc.defaultView?.addEventListener('online', reconcile);
  doc.addEventListener?.('visibilitychange', reconcile);
  let resizeFrame = null, lastViewportSize = '';
  const viewportObserver = doc.defaultView?.ResizeObserver ? new doc.defaultView.ResizeObserver(() => {
    if (resizeFrame != null) doc.defaultView.cancelAnimationFrame(resizeFrame);
    resizeFrame = doc.defaultView.requestAnimationFrame(() => {
      resizeFrame = null;
      if (!active || !viewport.clientWidth || !viewport.clientHeight) return;
      const size = `${viewport.clientWidth},${viewport.clientHeight}`;
      if (size === lastViewportSize) return;
      lastViewportSize = size;
      ensureRenderer()?.resize();
      if (autoFit) { if (savedView) renderer?.arrange(); render(); fitView(); }
    });
  }) : null;
  viewportObserver?.observe(viewport);
  render();
  return {
    select(id) {
      if (id === listeningId) return;
      deletedNodes.clear();
      setFullscreen(false, false); generation++; actionNotice.textContent = ''; terminalSyncing = false; lastTerminalSignature = null; retryIntent = null; abortEvidence(); closeDetails(false); listeningId = id; nodes = []; relations = []; snapshotStatus = {}; generated = generating = cancelling = recovering = false;
      for (const b of nodeElements.values()) b.remove(); nodeElements.clear();
      for (const e of resultElements.values()) e.remove(); resultElements.clear();
      search.value = ''; type.value = ''; localId = null; autoFit = true; updates = 0; notice.textContent = ''; status.textContent = graphStatusText();
      viewport.scrollLeft = viewport.scrollTop = 0; loader.select(id); render();
    },
    setNodes(items) { mergeNodes(items); render(); return [...nodes]; },
    setActive(value) { if (!value) setFullscreen(false, false); active = value; root.hidden = !value; if (value) { render(); renderer?.resize(); if (autoFit) fitView(); } renderProgress(); },
    invalidate(id, revision) { loader.invalidate(id, revision); },
    refresh() { return loader.refresh(); },
    setProcessing(value = {}) {
      if (!value || !Object.keys(value).length || generating || cancelling) return;
      // A delayed detail poll from this round cannot resurrect a stopped round.
      if (!acceptGraphProcessing(snapshotStatus, value)) return;
      const signature = terminalSignature(value);
      const needsFinalSnapshot = signature && signature !== lastTerminalSignature;
      snapshotStatus = { ...snapshotStatus, ...value };
      generated = generated || Boolean(snapshotStatus.state && snapshotStatus.state !== 'not_generated');
      if (needsFinalSnapshot) { terminalSyncing = true; lastTerminalSignature = signature; }
      else if (!signature) { terminalSyncing = false; lastTerminalSignature = null; }
      status.textContent = terminalSyncing ? '关系处理已结束，正在读取最新图谱…' : graphStatusText(snapshotStatus, relations.some(r => visibleAssertions(r).length)); render();
      // Terminal detail/SSE can arrive before the final graph invalidation. Read
      // authoritative edges once, fencing any older request still in flight.
      if (needsFinalSnapshot) void loader.reconcile();
    },
    highlight(id, follow) {
      if (!active) return;
      updates++; notice.textContent = `已收到 ${updates} 次知识更新`;
      if (follow) { renderer?.highlight(id); const node = nodeElements.get(id); node?.classList.remove('graph-node-updated'); if (node) { void node.offsetWidth; node.classList.add('graph-node-updated'); } }
    },
    destroy() { setFullscreen(false, false); generation++; viewportObserver?.disconnect(); if (resizeFrame != null) doc.defaultView.cancelAnimationFrame(resizeFrame); doc.defaultView?.removeEventListener('online', reconcile); doc.removeEventListener?.('visibilitychange', reconcile); clearTimeout(progressTimer); abortEvidence(); loader.stop(); renderer?.destroy(); root.replaceChildren(); }
  };
}
