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
// Keep existing cells forever within a listening. Additions never reflow a reader's map.
export function stableGraphLayout(nodes, relations, previous = new Map()) {
  const ids = new Set(nodes.map(n => n.id));
  const result = new Map([...previous].filter(([id]) => ids.has(id)));
  const occupied = new Set([...result.values()].map(p => `${p.col},${p.row}`));
  const neighbors = new Map(nodes.map(n => [n.id, []]));
  for (const r of relations) {
    if (!ids.has(r.subject_item_id) || !ids.has(r.object_item_id)) continue;
    neighbors.get(r.subject_item_id).push(r.object_item_id);
    neighbors.get(r.object_item_id).push(r.subject_item_id);
  }
  const order = [], visited = new Set();
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (visited.has(node.id)) continue;
    const queue = [node.id]; visited.add(node.id);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]; order.push(id);
      for (const next of neighbors.get(id).sort()) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  for (const id of order) {
    if (result.has(id)) continue;
    const near = neighbors.get(id).map(n => result.get(n)).find(Boolean);
    let cell;
    if (near) {
      for (const [dc, dr] of [[1, 0], [0, 1], [-1, 0], [1, 1], [0, -1], [-1, 1]]) {
        const col = near.col + dc, row = near.row + dr;
        if (col >= 0 && col < 5 && row >= 0 && !occupied.has(`${col},${row}`)) { cell = { col, row }; break; }
      }
    }
    if (!cell) for (let index = 0; !cell; index++) {
      const col = index % 5, row = Math.floor(index / 5);
      if (!occupied.has(`${col},${row}`)) cell = { col, row };
    }
    occupied.add(`${cell.col},${cell.row}`);
    result.set(id, { ...cell, x: 36 + cell.col * 264, y: 40 + cell.row * 154 });
  }
  return result;
}

// One request at a time, monotonic revisions, and a generation for A→B→A switches.
export function createGraphSnapshotLoader({ read, onSnapshot, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let id = null, generation = 0, revision = -1, wanted = -1, controller, timer, flight = false, queued = false;
  function stop() {
    generation++; controller?.abort(); clearTimer(timer); timer = null; flight = false; queued = false;
  }
  function schedule(delay = 35) {
    if (!id || timer != null) return;
    const gen = generation;
    timer = setTimer(() => { timer = null; if (gen === generation) void refresh(); }, delay);
  }
  async function refresh() {
    if (!id) return;
    if (flight) { queued = true; return; }
    clearTimer(timer); timer = null; flight = true; queued = false;
    const selected = id, gen = generation;
    const abort = new AbortController(); controller = abort;
    let stale = false;
    try {
      const snapshot = await read(selected, abort.signal);
      if (gen !== generation || selected !== id || abort.signal.aborted || snapshot.listeningId !== selected) return;
      const next = Number(snapshot.graphRevision) || 0;
      if (next < revision || next < wanted) { stale = true; return; }
      revision = next;
      onSnapshot(snapshot);
    } catch (error) {
      if (gen === generation && !abort.signal.aborted) onError(error);
    } finally {
      if (gen === generation) {
        flight = false;
        if (queued || stale) schedule(stale ? 1000 : 35);
      }
    }
  }
  return {
    select(next) { if (id === next) return; stop(); id = next; revision = wanted = -1; if (id) schedule(0); },
    invalidate(selected, next) { if (selected !== id) return; const value = Number(next) || 0; if (value <= revision && value <= wanted) return; wanted = Math.max(wanted, value); if (flight) queued = true; else schedule(); },
    refresh,
    stop() { stop(); id = null; revision = wanted = -1; }
  };
}

export function graphStatusText(status = {}, hasRelations = false) {
  if (typeof status === 'string') status = { state: status };
  const state = status.state || status.status;
  if (state === 'not_generated' || status.enabled === false) return '尚未生成关系，知识条目可先独立查看';
  if (state === 'waiting_key') return '关系待继续整理：需连接设置中的 API Key';
  if (status.keyAvailable === false && (status.pendingJobs || status.runningJobs || state === 'waiting_key')) return '关系待继续整理：需连接设置中的 API Key';
  if (status.runningJobs || state === 'running') return '正在整理关系…字幕与条目可继续使用';
  if (status.pendingJobs || status.retryingJobs || ['pending', 'queued'].includes(state)) return '关系已排队，稍后补齐';
  if (status.failedJobs || ['failed', 'invalid'].includes(state)) return '关系整理失败，已有条目与关系仍可查看';
  if (status.partialJobs || state === 'partial') return '关系部分完成，仍有未能确认的内容';
  if (status.waitingNodes || status.waitingNodesJobs || state === 'waiting_nodes') return '等待更多已确认知识条目';
  if (state === 'waiting_key') return '关系待继续整理：需 API Key';
  if (['complete', 'empty', 'ok'].includes(state) || status.completedJobs || status.completeJobs) return hasRelations ? '关系整理完成' : '整理完成，暂无有明确依据的关系';
  if (hasRelations) return '已保存的对话关系';
  return '尚未生成关系，知识条目可先独立查看';
}

export function createKnowledgeGraph({ root, getKey, onRequireKey, onStarted = () => {}, loadSegment, locateSegment, onNodes = () => {}, runNumber = () => '?' }) {
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
  let listeningId = null, nodes = [], relations = [], positions = new Map(), snapshotStatus = {}, selected = null;
  let scale = 1, width = 800, height = 420, active = false, generation = 0, detailGeneration = 0, trigger = null;
  let generated = false, generating = false, localId = null, panelFingerprint = '', updates = 0;
  const nodeElements = new Map(), edgeElements = new Map(), resultElements = new Map(), evidenceControllers = new Set();
  const toolbar = element('div', 'graph-toolbar');
  const searchLabel = element('label', 'graph-search-label', '搜索知识');
  const search = element('input'); search.type = 'search'; search.id = 'graph-search'; search.placeholder = '名称、别名或简介'; searchLabel.append(search);
  const typeLabel = element('label', 'graph-type-label', '类型');
  const type = element('select'); type.id = 'graph-type'; typeLabel.append(type);
  const zoomOut = button('−', 'graph-zoom-out', () => zoom(scale / 1.2)); zoomOut.setAttribute('aria-label', '缩小图谱');
  const zoomIn = button('+', 'graph-zoom-in', () => zoom(scale * 1.2)); zoomIn.setAttribute('aria-label', '放大图谱');
  const zoomLabel = element('output', 'graph-zoom-value', '100%'); zoomLabel.setAttribute('aria-label', '图谱缩放');
  const fit = button('适应全部', 'graph-fit', () => fitView());
  const local = button('一跳邻居', 'graph-local', () => { localId = localId ? null : selected?.kind === 'node' ? selected.id : null; render(); });
  local.setAttribute('aria-pressed', 'false'); local.title = '选择节点后查看它和直接相连的节点';
  toolbar.append(searchLabel, typeLabel, zoomOut, zoomLabel, zoomIn, fit, local);
  const count = element('p', 'graph-count'); count.id = 'graph-count'; count.setAttribute('role', 'status');
  const viewport = element('div', 'graph-viewport'); viewport.id = 'graph-viewport'; viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', '知识图谱，可滚动浏览。使用缩放按钮或下方节点列表');
  const canvas = element('div', 'graph-canvas'), world = element('div', 'graph-world');
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('graph-edges'); svg.setAttribute('aria-hidden', 'true');
  const defs = doc.createElementNS(svg.namespaceURI, 'defs');
  const marker = doc.createElementNS(svg.namespaceURI, 'marker');
  for (const [key, value] of Object.entries({ id: 'graph-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' })) marker.setAttribute(key, value);
  const arrow = doc.createElementNS(svg.namespaceURI, 'path'); arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); marker.append(arrow); defs.append(marker); svg.append(defs);
  world.append(svg); canvas.append(world); viewport.append(canvas);
  const noNodes = element('p', 'graph-empty', '尚无知识条目，最终原文出现后会持续整理。');
  const resultDetails = element('details', 'graph-results');
  resultDetails.append(element('summary', '', '节点列表（可用键盘浏览）'));
  const resultList = element('ul'); resultList.id = 'graph-results'; resultDetails.append(resultList);
  const refresh = button('刷新关系', 'graph-refresh', () => { void loader.refresh(); });
  refresh.title = '仅重新读取已保存的关系，不调用模型';
  const status = element('p', 'graph-status'); status.id = 'graph-status'; status.setAttribute('role', 'status');
  const notice = element('p', 'graph-notice'); notice.id = 'graph-updates'; notice.setAttribute('role', 'status');
  const generate = button('生成本次收听的关系', 'graph-generate', () => { void startGeneration(); });
  const costs = element('p', 'graph-cost', '手动生成会使用连接设置中的千问 API Key，发送本次收听的最终原文、已完成的译文与已有知识条目，增加模型调用和费用。不会自动处理其他历史记录。'); costs.id = 'graph-cost'; generate.setAttribute('aria-describedby', 'graph-cost');
  const usage = element('p', 'graph-cost'); usage.id = 'graph-usage';
  const disclaimer = element('p', 'graph-disclaimer', '连线表示对话中有这样的表述，不代表已经外部事实核查。计划、否定、推测和时间条件会保留。');
  const panel = element('section', 'graph-details'); panel.id = 'graph-details'; panel.hidden = true;
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '知识与关系详情');
  const panelHeader = element('div', 'graph-details-header');
  const panelTitle = element('h3'); panelTitle.id = 'graph-detail-title'; panel.setAttribute('aria-labelledby', panelTitle.id);
  const close = button('关闭', 'graph-close', () => closeDetails()); panelHeader.append(panelTitle, close);
  const panelBody = element('div', 'graph-details-body'); panel.append(panelHeader, panelBody);
  root.append(toolbar, count, viewport, noNodes, notice, resultDetails, status, generate, refresh, costs, usage, disclaimer, panel);
  const loader = createGraphSnapshotLoader({
    read: async (id, signal) => {
      const controller = new AbortController(), abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 10000);
      try {
        const response = await fetch(`/api/listenings/${encodeURIComponent(id)}/graph`, { signal: controller.signal });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || '关系读取失败，请重试'); return data;
      } catch (error) { if (controller.signal.aborted && !signal.aborted) throw new Error('关系读取超时'); throw error; }
      finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
    },
    onSnapshot(data) {
      if (data.listeningId !== listeningId) return;
      const previousNodes = JSON.stringify(nodes);
      mergeNodes(data.nodes || []); relations = data.relations || []; snapshotStatus = data.status || {};
      generated = generated || Boolean(relations.length || snapshotStatus.state && snapshotStatus.state !== 'not_generated');
      status.textContent = graphStatusText(snapshotStatus, relations.some(r => visibleAssertions(r).length));
      render();
      if (JSON.stringify(nodes) !== previousNodes) onNodes([...nodes]);
    },
    onError(error) { status.textContent = `${error.message || '关系暂时无法读取'}；知识条目仍可查看`; }
  });
  function mergeNodes(incoming) {
    const all = new Map(nodes.map(n => [n.id, n]));
    for (const node of incoming) {
      const old = all.get(node.id);
      if (!old || (node.content_version || 0) > (old.content_version || 0) ||
        (node.content_version || 0) === (old.content_version || 0) && (node.updated_at || '') >= (old.updated_at || '')) all.set(node.id, node);
    }
    nodes = [...all.values()];
  }
  function syncScale() {
    world.style.transform = `scale(${scale})`; canvas.style.width = `${Math.ceil(width * scale)}px`; canvas.style.height = `${Math.ceil(height * scale)}px`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    root.classList.toggle('graph-zoom-small', scale < .6);
  }
  function zoom(next) {
    const old = scale, centerX = viewport.scrollLeft + viewport.clientWidth / 2, centerY = viewport.scrollTop + viewport.clientHeight / 2;
    scale = Math.min(2, Math.max(.01, next)); syncScale();
    viewport.scrollLeft = centerX / old * scale - viewport.clientWidth / 2; viewport.scrollTop = centerY / old * scale - viewport.clientHeight / 2;
  }
  function fitView() {
    scale = Math.min(1, Math.max(.01, Math.min((viewport.clientWidth - 24) / width, (viewport.clientHeight - 24) / height)));
    syncScale(); viewport.scrollLeft = 0; viewport.scrollTop = 0;
  }
  function abortEvidence() { for (const c of evidenceControllers) c.abort(); evidenceControllers.clear(); }
  function closeDetails(restore = true) {
    panel.hidden = true; selected = null; panelFingerprint = ''; detailGeneration++; abortEvidence();
    if (restore && active) {
      const target = trigger?.isConnected && !trigger.hidden ? trigger : search;
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
      container.append(button('定位到全文原句', '', () => { closeDetails(false); locateSegment(segment); }));
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
    if (other) section.append(button(`查看知识：${other.canonical_name}`, '', event => openDetails('node', otherId, nodeElements.get(otherId) || event.currentTarget)));
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
    positions = stableGraphLayout(nodes, relations, positions);
    const options = ['全部类型', ...new Set(nodes.map(knowledgeType).sort())];
    if (JSON.stringify([...type.options].map(o => o.textContent)) !== JSON.stringify(options)) {
      const value = type.value; type.replaceChildren(...options.map((label, index) => { const option = element('option', '', label); option.value = index ? label : ''; return option; })); type.value = value;
    }
    const shown = new Set(filtered.nodes.map(n => n.id));
    width = Math.max(320, ...filtered.nodes.map(n => positions.get(n.id).x + 244));
    height = Math.max(260, ...filtered.nodes.map(n => positions.get(n.id).y + 128));
    world.style.width = `${width}px`; world.style.height = `${height}px`; svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
    const pendingEdges = relations.filter(r => visibleAssertions(r).length && (!nodes.some(n => n.id === r.subject_item_id) || !nodes.some(n => n.id === r.object_item_id))).length;
    count.textContent = `正在显示 ${filtered.nodes.length} / ${nodes.length} 个节点 · ${filtered.relations.length} 条关系${localId ? ' · 一跳邻居' : ''}${pendingEdges ? ' · 部分关系等待节点同步' : ''}`;
    noNodes.hidden = filtered.nodes.length > 0;
    noNodes.textContent = nodes.length ? '没有符合筛选的知识。可清空搜索、选择全部类型或退出一跳视图。' : '尚无知识条目，最终原文出现后会持续整理。';
    local.disabled = !localId && selected?.kind !== 'node'; local.setAttribute('aria-pressed', String(Boolean(localId))); local.textContent = localId ? '退出一跳视图' : '一跳邻居';
    for (const node of nodes) {
      let nodeButton = nodeElements.get(node.id), entry = resultElements.get(node.id);
      if (!nodeButton) {
        nodeButton = button('', '', event => openDetails('node', node.id, event.currentTarget), 'graph-node'); nodeButton.dataset.nodeId = node.id;
        nodeButton.append(element('strong'), element('span', 'graph-node-type')); world.append(nodeButton); nodeElements.set(node.id, nodeButton);
        entry = element('li'); const b = button('', '', event => openDetails('node', node.id, event.currentTarget), 'graph-result-button'); b.dataset.resultNodeId = node.id; entry.append(b); resultList.append(entry); resultElements.set(node.id, entry);
      }
      const p = positions.get(node.id); nodeButton.style.left = `${p.x}px`; nodeButton.style.top = `${p.y}px`;
      nodeButton.firstChild.textContent = node.canonical_name; nodeButton.lastChild.textContent = knowledgeType(node);
      nodeButton.title = `${node.canonical_name} · ${knowledgeType(node)}`;
      nodeButton.setAttribute('aria-label', `查看${knowledgeType(node)}：${node.canonical_name}`);
      nodeButton.setAttribute('aria-pressed', String(selected?.kind === 'node' && selected.id === node.id));
      nodeButton.hidden = !shown.has(node.id); entry.hidden = !shown.has(node.id); entry.firstChild.textContent = `${node.canonical_name} · ${knowledgeType(node)}`;
    }
    const visibleEdges = new Set(filtered.relations.map(r => r.id));
    for (const [id, entry] of edgeElements) if (!visibleEdges.has(id)) { entry.line.remove(); entry.button.remove(); edgeElements.delete(id); }
    for (const relation of filtered.relations) {
      let entry = edgeElements.get(relation.id);
      if (!entry) {
        const line = doc.createElementNS(svg.namespaceURI, 'path'); svg.append(line);
        const b = button('', '', event => openDetails('relation', relation.id, event.currentTarget), 'graph-edge-label'); b.dataset.relationId = relation.id; world.append(b);
        entry = { line, button: b }; edgeElements.set(relation.id, entry);
      }
      const a = positions.get(relation.subject_item_id), b = positions.get(relation.object_item_id);
      const dx = b.x - a.x, dy = b.y - a.y, factor = Math.min(Math.abs(dx) > 0 ? 108 / Math.abs(dx) : Infinity, Math.abs(dy) > 0 ? 42 / Math.abs(dy) : Infinity);
      const x1 = a.x + 108 + dx * factor, y1 = a.y + 42 + dy * factor, x2 = b.x + 108 - dx * factor, y2 = b.y + 42 - dy * factor;
      entry.line.setAttribute('d', `M${x1},${y1} L${x2},${y2}`);
      if (SYMMETRIC.has(relation.predicate)) entry.line.removeAttribute('marker-end'); else entry.line.setAttribute('marker-end', 'url(#graph-arrow)');
      entry.button.textContent = relationLabel(relation); entry.button.style.left = `${(x1 + x2) / 2}px`; entry.button.style.top = `${(y1 + y2) / 2}px`;
      entry.button.title = relationLabel(relation); entry.button.setAttribute('aria-label', `查看关系依据：${nodes.find(n => n.id === relation.subject_item_id)?.canonical_name}，${relationLabel(relation)}，${nodes.find(n => n.id === relation.object_item_id)?.canonical_name}`);
      entry.button.classList.toggle('graph-adjacent', selected?.kind === 'node' && [relation.subject_item_id, relation.object_item_id].includes(selected.id));
    }
    generate.disabled = generating || !listeningId || Boolean(snapshotStatus.enabled !== false && snapshotStatus.state !== 'waiting_key' && (snapshotStatus.runningJobs || snapshotStatus.pendingJobs || snapshotStatus.state === 'running' || snapshotStatus.state === 'queued'));
    const hour = snapshotStatus.usageLastHour;
    usage.hidden = !hour;
    usage.textContent = hour ? `本次收听过去 1 小时：${hour.requests || 0} 次关系请求；${hour.measuredRequests || 0} 次返回用量，共 ${hour.totalTokens || 0} tokens（输入 ${hour.inputTokens || 0} / 输出 ${hour.outputTokens || 0}）。未返回用量的请求不计入 token 总数。` : '';
    generate.textContent = generating ? '正在启动…' : generated ? '继续整理本次关系' : '生成本次收听的关系';
    syncScale(); renderDetails();
  }
  async function startGeneration() {
    if (!listeningId || generating) return;
    if (!getKey()?.trim()) { status.textContent = '请先在连接设置填写 API Key，再点击生成关系'; onRequireKey(); return; }
    const id = listeningId, gen = generation;
    generating = true; render();
    try {
      const response = await fetch(`/api/listenings/${encodeURIComponent(id)}/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: getKey() }) });
      const data = await response.json();
      if (gen !== generation || id !== listeningId) return;
      if (!response.ok) throw new Error(data.error || '启动关系整理失败');
      generated = true; snapshotStatus = data.status || { state: 'queued' }; status.textContent = graphStatusText(snapshotStatus);
      void loader.refresh(); onStarted(id);
    } catch (error) { if (gen === generation) status.textContent = error.message || '启动关系整理失败'; }
    finally { if (gen === generation) { generating = false; render(); } }
  }
  search.addEventListener('input', render); type.addEventListener('change', render);
  viewport.addEventListener('click', event => { if ([viewport, canvas, world, svg].includes(event.target)) closeDetails(); });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopPropagation(); closeDetails(); }
    if (event.target === viewport && ['+', '-', '0'].includes(event.key)) { event.preventDefault(); if (event.key === '0') fitView(); else zoom(event.key === '+' ? scale * 1.2 : scale / 1.2); }
  });
  render();
  return {
    select(id) {
      if (id === listeningId) return;
      generation++; abortEvidence(); closeDetails(false); listeningId = id; nodes = []; relations = []; positions = new Map(); snapshotStatus = {}; generated = generating = false;
      for (const b of nodeElements.values()) b.remove(); nodeElements.clear();
      for (const e of resultElements.values()) e.remove(); resultElements.clear();
      search.value = ''; type.value = ''; localId = null; scale = 1; updates = 0; notice.textContent = ''; status.textContent = graphStatusText();
      viewport.scrollLeft = viewport.scrollTop = 0; loader.select(id); render();
    },
    setNodes(items) { mergeNodes(items); render(); return [...nodes]; },
    setActive(value) { active = value; root.hidden = !value; },
    invalidate(id, revision) { loader.invalidate(id, revision); },
    refresh() { return loader.refresh(); },
    setProcessing(value = {}) { if (value && Object.keys(value).length) { snapshotStatus = { ...snapshotStatus, ...value }; status.textContent = graphStatusText(snapshotStatus, relations.some(r => visibleAssertions(r).length)); render(); } },
    highlight(id, follow) {
      if (!active) return;
      updates++; notice.textContent = `已收到 ${updates} 次知识更新，当前视图位置保持不变`;
      if (follow) { const node = nodeElements.get(id); node?.classList.remove('graph-node-updated'); if (node) { void node.offsetWidth; node.classList.add('graph-node-updated'); } }
    },
    destroy() { generation++; abortEvidence(); loader.stop(); root.replaceChildren(); }
  };
}
