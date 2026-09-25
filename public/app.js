const $ = id => document.getElementById(id);
const els = {
  toggle: $('toggle'), toggleLabel: $('toggle-label'), micIcon: $('mic-icon'), tabIcon: $('tab-icon'),
  status: $('status'), liveDot: $('live-dot'),
  hint: $('hint'), translation: $('translation'), original: $('original'), badge: $('caption-badge'),
  captionStage: document.querySelector('.caption-stage'), pinnedCaption: $('pinned-caption'),
  pinnedTranslation: $('pinned-translation'), pinnedBadge: $('pinned-badge'),
  modal: $('settings-modal'), settingsTrigger: $('settings-trigger'), closeSettings: $('close-settings'),
  settingsForm: $('settings-form'), apiKey: $('api-key'), audioInput: $('audio-input'),
  switchTab: $('switch-tab'), source: $('source-language'),
  target: $('target-language'), showKey: $('show-key'), testButton: $('test-connection'),
  testResult: $('test-result'), testSummary: $('test-summary'),
  testRecognition: $('test-recognition'), testTranslation: $('test-translation'), testKnowledge: $('test-knowledge'),
  newListening: $('new-listening'), historyListening: $('history-listening'), listeningView: $('listening-view'),
  historyView: $('history-view'), historyList: $('history-list'), historyMore: $('history-more'),
  historyError: $('history-error'), back: $('back-to-listening'),
  recordPanel: $('record-panel'), recordTitle: $('record-title'), processingStatus: $('processing-status'),
  retryProcessing: $('retry-processing'), knowledgeList: $('knowledge-list'), knowledgeCount: $('knowledge-count'),
  transcriptList: $('transcript-list'), runsList: $('runs-list'), loadMore: $('load-more')
};

const saved = {
  key: localStorage.getItem('tongsheng:qianwen-key') || ''
};
localStorage.removeItem('tongsheng:key');
localStorage.removeItem('tongsheng:region');
els.apiKey.value = saved.key;

let phase = 'idle';
let socket;
let stream;
let audioContext;
let sourceNode;
let processor;
let silenceNode;
let currentSentenceId = null;
let translationTimer;
let translationRequest;
let translationVersion = 0;
let pendingText = '';
let lastTranslationAt = 0;
let startAfterSave = false;
let testController;
let listeningId = null;
let detail = null;
let detailPage = 0;
let historyPage = 0;
let currentSegmentId = null;
let pollingTimer;
let retryAfterSave = false;
const liveSegments = new Map();
const liveKnowledge = new Map();

function syncPinnedCaption() {
  els.pinnedTranslation.textContent = els.translation.textContent;
  els.pinnedTranslation.classList.toggle('placeholder', els.translation.classList.contains('placeholder'));
  els.pinnedBadge.textContent = els.badge.textContent;
}

function updatePinnedCaption() {
  els.pinnedCaption.hidden = els.listeningView.hidden || els.captionStage.getBoundingClientRect().bottom > 12;
}

new MutationObserver(syncPinnedCaption).observe(els.translation, { childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
new MutationObserver(syncPinnedCaption).observe(els.badge, { childList: true, characterData: true });
window.addEventListener('scroll', updatePinnedCaption, { passive: true });
window.addEventListener('resize', updatePinnedCaption);
syncPinnedCaption();
updatePinnedCaption();

function setPhase(next, message) {
  phase = next;
  const active = next === 'listening';
  const tabInput = els.audioInput.value === 'tab';
  els.liveDot.classList.toggle('active', active);
  els.status.textContent = message || (next === 'listening' && tabInput ? '正在收听标签页' : { idle: '准备就绪', connecting: '正在连接…', listening: '正在聆听', stopping: '正在结束…' }[next]);
  els.toggle.disabled = next === 'connecting' || next === 'stopping';
  els.toggle.classList.toggle('listening', active);
  els.micIcon.hidden = tabInput;
  els.tabIcon.hidden = !tabInput;
  const action = tabInput ? '收听' : '聆听';
  els.toggleLabel.textContent = active ? `停止${action}` : next === 'connecting' ? '正在连接' : next === 'stopping' ? '正在结束' : listeningId ? '继续收听' : `开始${action}`;
  els.badge.textContent = active ? '实时更新' : next === 'connecting' ? '连接中' : next === 'stopping' ? '结束中' : '等待开始';
  els.audioInput.disabled = next !== 'idle';
  els.switchTab.hidden = !(active && tabInput);
  els.source.disabled = next !== 'idle';
  els.target.disabled = next !== 'idle';
  els.newListening.disabled = next !== 'idle';
  els.historyListening.disabled = next !== 'idle';
  if (tabInput && !els.hint.classList.contains('error')) els.hint.textContent = active ? '仅所选标签页的声音发送至阿里云' : '选择浏览器标签页，并勾选“共享标签页音频”';
}

function showError(message) {
  els.hint.textContent = message;
  els.hint.classList.add('error');
}

function clearError() {
  if (els.audioInput.value === 'tab') els.hint.textContent = phase === 'listening' ? '仅所选标签页的声音发送至阿里云' : '选择浏览器标签页，并勾选“共享标签页音频”';
  else els.hint.textContent = '音频仅在聆听期间发送至阿里云';
  els.hint.classList.remove('error');
}

els.audioInput.addEventListener('change', () => { clearError(); setPhase(phase); });

function openSettings(continueAfterSave = false) {
  startAfterSave = continueAfterSave;
  if (!els.apiKey.value) activateTab(0);
  els.modal.hidden = false;
  els.modal.scrollTop = 0;
  if (els.apiKey.value) els.closeSettings.focus();
  else els.apiKey.focus();
}

function resetConnectionTest() {
  testController?.abort();
  testController = null;
  els.testButton.disabled = false;
  els.testButton.textContent = '测试连接';
  els.testResult.hidden = true;
  els.testRecognition.textContent = '';
  els.testTranslation.textContent = '';
  els.testKnowledge.textContent = '';
}

function closeSettings() {
  resetConnectionTest();
  els.modal.hidden = true;
  startAfterSave = false;
  retryAfterSave = false;
  els.settingsTrigger.focus();
}

els.settingsTrigger.addEventListener('click', () => openSettings());
els.closeSettings.addEventListener('click', closeSettings);
els.modal.addEventListener('click', event => { if (event.target === els.modal) closeSettings(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !els.modal.hidden) closeSettings(); });

// Settings tabs: connection (default) / language
const settingsTabs = [
  { button: $('tab-connection-button'), panel: $('tab-connection') },
  { button: $('tab-language-button'), panel: $('tab-language') }
];
function activateTab(index, focusButton = false) {
  settingsTabs.forEach((tab, i) => {
    const active = i === index;
    tab.button.classList.toggle('active', active);
    tab.button.setAttribute('aria-selected', String(active));
    tab.button.tabIndex = active ? 0 : -1;
    tab.panel.hidden = !active;
  });
  if (focusButton) settingsTabs[index].button.focus();
}
settingsTabs.forEach((tab, index) => {
  tab.button.addEventListener('click', () => activateTab(index));
  tab.button.addEventListener('keydown', event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = (index + (event.key === 'ArrowRight' ? 1 : settingsTabs.length - 1)) % settingsTabs.length;
    activateTab(next, true);
  });
});
activateTab(0);
els.showKey.addEventListener('click', () => {
  const shown = els.apiKey.type === 'text';
  els.apiKey.type = shown ? 'password' : 'text';
  els.showKey.textContent = shown ? '显示' : '隐藏';
  els.showKey.setAttribute('aria-label', shown ? '显示 API Key' : '隐藏 API Key');
});
els.apiKey.addEventListener('input', resetConnectionTest);
els.testButton.addEventListener('click', async () => {
  const key = els.apiKey.value.trim();
  if (!key) {
    els.testResult.hidden = false;
    els.testSummary.textContent = '请先填写 API Key';
    els.apiKey.focus();
    return;
  }
  resetConnectionTest();
  const controller = new AbortController();
  testController = controller;
  els.testButton.disabled = true;
  els.testButton.textContent = '正在测试…';
  els.testResult.hidden = false;
  els.testSummary.textContent = '正在检查识别、翻译和知识抽取服务…';
  try {
    const response = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '测试失败');
    if (testController !== controller) return;
    const bothOk = result.recognition?.ok && result.translation?.ok && result.knowledge?.ok;
    els.testSummary.textContent = bothOk ? '连接成功，可以开始使用' : '有服务未通过检查';
    els.testRecognition.textContent = `实时识别：${result.recognition?.message || '未返回结果'}`;
    els.testTranslation.textContent = `实时翻译：${result.translation?.message || '未返回结果'}`;
    els.testKnowledge.textContent = `知识抽取：${result.knowledge?.message || '未返回结果'}`;
    els.testRecognition.className = result.recognition?.ok ? 'ok' : 'failed';
    els.testTranslation.className = result.translation?.ok ? 'ok' : 'failed';
    els.testKnowledge.className = result.knowledge?.ok ? 'ok' : 'failed';
  } catch (error) {
    if (error.name === 'AbortError' || testController !== controller) return;
    els.testSummary.textContent = error instanceof TypeError ? '本地服务无法连接，请刷新页面后重试' : error.message || '测试失败，请稍后重试';
  } finally {
    if (testController === controller) {
      testController = null;
      els.testButton.disabled = false;
      els.testButton.textContent = '重新测试';
    }
  }
});
els.settingsForm.addEventListener('submit', event => {
  event.preventDefault();
  saved.key = els.apiKey.value.trim();
  if (!saved.key) return;
  localStorage.setItem('tongsheng:qianwen-key', saved.key);
  const shouldStart = startAfterSave;
  const shouldRetry = retryAfterSave;
  closeSettings();
  clearError();
  if (shouldStart) start();
  else if (shouldRetry) els.retryProcessing.click();
});

function clearTranslationWork() {
  clearTimeout(translationTimer);
  translationTimer = null;
  translationRequest?.abort();
  translationRequest = null;
  translationVersion++;
}

function scheduleTranslation(text, final) {
  if (!text.trim()) return;
  pendingText = text;
  if (final) clearTranslationWork();
  else if (translationTimer) return;
  const delay = final ? 0 : Math.max(0, lastTranslationAt + 1800 - Date.now());
  translationTimer = setTimeout(async () => {
    translationTimer = null;
    translationRequest?.abort();
    const version = ++translationVersion;
    const input = pendingText;
    lastTranslationAt = Date.now();
    const controller = new AbortController();
    translationRequest = controller;
    els.badge.textContent = '翻译中';
    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: saved.key, text: input, target: els.target.value }),
        signal: controller.signal
      });
      const result = await response.json();
      if (response.status === 429) { els.badge.textContent = '最终译文优先处理中'; return; }
      if (!response.ok) throw new Error(result.error || '翻译失败');
      if (version !== translationVersion) return;
      els.translation.textContent = result.text.trim() || input;
      els.translation.classList.remove('placeholder');
      els.badge.textContent = phase === 'listening' ? '实时更新' : '已完成';
    } catch (error) {
      if (error.name === 'AbortError' || version !== translationVersion) return;
      els.badge.textContent = '翻译失败';
      showError(error.message || '翻译失败，请检查 API Key');
    }
  }, delay);
}

function receiveSentence(message) {
  if (typeof message.text !== 'string' || !message.text.trim()) return;
  if (message.id !== currentSentenceId) {
    currentSentenceId = message.id;
    currentSegmentId = null;
    els.translation.textContent = '正在翻译…';
    els.translation.classList.add('placeholder');
  }
  els.original.textContent = message.text;
  els.original.classList.remove('placeholder');
  if (message.text.trim().length >= 5) scheduleTranslation(message.text, false);
}

function displayFinal(segment) {
  clearTranslationWork();
  currentSentenceId = segment.asr_sentence_id;
  currentSegmentId = segment.id;
  els.original.textContent = segment.original_text;
  els.original.classList.remove('placeholder');
  els.translation.textContent = segment.translation_text || (segment.translation_state === 'failed' ? '翻译失败，可点击继续处理' : '正在翻译…');
  els.translation.classList.toggle('placeholder', !segment.translation_text);
  els.badge.textContent = segment.translation_state === 'failed' ? '翻译失败' : segment.translation_text ? '已完成' : '翻译中';
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function renderRuns() {
  els.runsList.replaceChildren();
  const sourceNames = { auto: '自动识别', zh: '中文', en: '英语', ja: '日语', ko: '韩语' };
  const targetNames = { Chinese: '简体中文', English: '英语', Japanese: '日语', Korean: '韩语' };
  for (const run of detail?.runs || []) {
    const card = el('article', 'run-item');
    const state = run.state === 'active' ? '进行中' : run.state === 'interrupted' ? '意外中断' : '已结束';
    card.append(el('strong', '', `第 ${run.run_no} 次 · ${state}`),
      el('span', '', `${formatTime(run.started_at)} — ${run.ended_at ? formatTime(run.ended_at) : '现在'}`),
      el('span', '', `${run.audio_source === 'tab' ? '浏览器标签页' : '麦克风'} · ${sourceNames[run.source_lang] || run.source_lang} → ${targetNames[run.target_lang] || run.target_lang}`));
    els.runsList.append(card);
  }
}
function renderTranscript() {
  els.transcriptList.replaceChildren();
  for (const segment of detail?.segments || []) {
    const card = el('article', 'transcript-item');
    card.id = `segment-${segment.id}`;
    const run = detail.runs.find(r => r.id === segment.run_id);
    const time = el('div', 'transcript-time', `第 ${run?.run_no || '?'} 次 · 第 ${segment.sequence_no} 句 · ${formatTime(segment.created_at)}`);
    const original = el('p', 'transcript-original', segment.original_text);
    const translation = el('p', 'transcript-translation', segment.translation_text ||
      (segment.translation_state === 'failed' ? '翻译失败，可点击继续处理' : '等待翻译…'));
    card.append(time, original, translation);
    els.transcriptList.append(card);
  }
  els.loadMore.hidden = !detail || detail.segments.length >= detail.segmentCount;
}
function renderKnowledge() {
  els.knowledgeCount.textContent = String(detail?.knowledge.length || 0);
  els.knowledgeList.replaceChildren();
  if (!detail?.knowledge.length) { els.knowledgeList.append(el('p', 'empty-note', '尚无知识条目，最终原文出现后会持续整理。')); return; }
  const names = { person: '人物', term: '术语', event: '事件', other: '其他' };
  for (const item of detail.knowledge) {
    const card = el('article', 'knowledge-item');
    const heading = el('div', 'knowledge-heading');
    heading.append(el('strong', '', item.canonical_name), el('span', 'knowledge-type', names[item.type] || item.type));
    if (item.certainty === 'needs_review') heading.append(el('span', 'needs-review', '待确认'));
    card.append(heading);
    if (item.aliases?.length) card.append(el('p', 'knowledge-aliases', `别名：${item.aliases.join('、')}`));
    card.append(el('p', 'knowledge-dialogue', `对话中提到：${item.dialogue_summary}`));
    if (item.background_note) card.append(el('p', 'knowledge-background', `背景补充（模型生成）：${item.background_note}`));
    for (const revision of item.revisions || []) card.append(el('p', 'knowledge-revision', `更名记录：${revision.old_value} → ${revision.new_value}（${revision.reason}）`));
    const evidence = el('div', 'knowledge-evidence');
    for (const mention of item.mentions || []) {
      const link = el('a', '', `“${mention.surface_text}”`);
      link.href = `#segment-${mention.segment_id}`;
      link.addEventListener('click', event => {
        if (!document.getElementById(`segment-${mention.segment_id}`)) {
          event.preventDefault(); showError('该证据句尚未加载，请加载更多句子');
        }
      });
      evidence.append(link);
    }
    card.append(evidence); els.knowledgeList.append(card);
  }
}
function renderProcessing() {
  if (!detail) return;
  const failedTranslations = Math.max(detail.processing?.failedTranslations || 0, detail.segments.filter(s => s.translation_state === 'failed').length);
  const pendingTranslations = Math.max(detail.processing?.pendingTranslations || 0, detail.segments.filter(s => s.translation_state === 'pending').length);
  const failedJobs = detail.jobs.filter(j => j.state === 'failed').length;
  const pendingJobs = detail.jobs.filter(j => j.state === 'pending' || j.state === 'running').length;
  const failed = failedTranslations + failedJobs;
  const pending = pendingTranslations + pendingJobs;
  els.processingStatus.textContent = failed ? `${failed} 项处理失败` : pending ? detail.processingAvailable ? `${pending} 项处理中` : `${pending} 项待继续处理（需 API Key）` : '已处理';
  els.retryProcessing.hidden = !failed && !pending;
}
function renderDetail() {
  if (!detail) return;
  els.recordPanel.hidden = false;
  els.recordTitle.textContent = detail.listening.title;
  renderRuns(); renderTranscript(); renderKnowledge(); renderProcessing();
}
async function fetchDetail(page = 1, append = false) {
  if (!listeningId) return;
  const requestedId = listeningId;
  const response = await fetch(`/api/listenings/${requestedId}?page=${page}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '无法读取收听记录');
  if (listeningId !== requestedId) return;
  const segments = new Map(result.segments.map(s => [s.id, s]));
  if (detail?.listening.id === result.listening.id) for (const old of detail.segments) {
    if (!segments.has(old.id) || (phase === 'listening' && old.translation_state === 'complete' && segments.get(old.id).translation_state !== 'complete')) segments.set(old.id, old);
  }
  for (const live of liveSegments.values()) {
    const serverRow = segments.get(live.id);
    if (!serverRow || (live.translation_state === 'complete' && serverRow.translation_state !== 'complete')) segments.set(live.id, live);
  }
  result.segments = [...segments.values()].sort((a, b) => a.sequence_no - b.sequence_no);
  result.segmentCount = Math.max(result.segmentCount, detail?.segmentCount || 0, ...result.segments.map(s => s.sequence_no));
  const knowledge = new Map(result.knowledge.map(k => [k.id, k]));
  for (const live of liveKnowledge.values()) if (!knowledge.has(live.id) || live.updated_at > knowledge.get(live.id).updated_at) knowledge.set(live.id, live);
  result.knowledge = [...knowledge.values()];
  detail = result; detailPage = append ? page : Math.max(1, detailPage); renderDetail();
}
function showListening() {
  els.listeningView.hidden = false; els.historyView.hidden = true;
  updatePinnedCaption();
}
async function showHistory() {
  if (phase !== 'idle') return;
  clearInterval(pollingTimer); showListening();
  els.listeningView.hidden = true; els.historyView.hidden = false;
  updatePinnedCaption();
  await reloadHistory();
}
async function reloadHistory() {
  els.historyError.hidden = true;
  els.historyList.replaceChildren(); historyPage = 0;
  await loadHistory();
}
async function loadHistory() {
  const response = await fetch(`/api/listenings?page=${historyPage + 1}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '无法读取历史收听');
  historyPage++;
  if (!result.items.length && historyPage === 1) els.historyList.append(el('p', 'empty-note', '还没有收听记录。成功开始收听后，最终句子会保存在这里。'));
  for (const item of result.items) {
    const row = el('div', 'history-item');
    const open = el('button', 'history-open'); open.type = 'button';
    open.setAttribute('aria-label', `查看“${item.title}”`);
    open.append(el('strong', '', item.title), el('span', '', `最后收听 ${formatTime(item.last_listened_at)} · ${item.segment_count} 句 · ${item.knowledge_count} 条知识`));
    open.addEventListener('click', () => selectListening(item.id).catch(error => showError(error.message)));
    const remove = el('button', 'history-delete', '删除'); remove.type = 'button';
    remove.setAttribute('aria-label', `删除“${item.title}”`);
    remove.addEventListener('click', () => deleteListening(item, remove));
    row.append(open, remove);
    els.historyList.append(row);
  }
  els.historyMore.hidden = historyPage * result.pageSize >= result.total;
}
async function deleteListening(item, button) {
  if (!window.confirm(`确定删除“${item.title}”吗？该记录的原文、译文和知识将永久删除。`)) return;
  button.disabled = true;
  els.historyError.hidden = true;
  try {
    const response = await fetch(`/api/listenings/${item.id}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '删除收听记录失败');
    if (listeningId === item.id) resetListening();
    await reloadHistory();
  } catch (error) {
    button.disabled = false;
    els.historyError.textContent = error.message || '删除收听记录失败';
    els.historyError.hidden = false;
  }
}
async function selectListening(id) {
  listeningId = id; detail = null; detailPage = 0; liveSegments.clear(); liveKnowledge.clear();
  await fetchDetail();
  if (listeningId !== id || !detail) return;
  const lastRun = detail.runs.at(-1);
  if (lastRun) {
    els.source.value = lastRun.source_lang;
    els.target.value = lastRun.target_lang;
    els.audioInput.value = lastRun.audio_source;
  }
  clearError(); setPhase('idle'); showListening();
  const last = detail.latestSegment || detail.segments.at(-1);
  if (last) displayFinal(last);
}
function resetListening() {
  clearInterval(pollingTimer);
  listeningId = null; detail = null; detailPage = 0; currentSentenceId = null; currentSegmentId = null;
  liveSegments.clear(); liveKnowledge.clear();
  clearTranslationWork();
  els.recordPanel.hidden = true;
  els.original.textContent = '开始聆听后，实时识别的文字会出现。';
  els.translation.textContent = '字幕会显示在这里';
  els.original.classList.add('placeholder'); els.translation.classList.add('placeholder');
  els.source.value = 'en'; els.target.value = 'Chinese'; els.audioInput.value = 'microphone';
  clearError(); setPhase('idle');
}
function newListening() {
  if (phase !== 'idle') return;
  resetListening(); showListening();
}
function startPolling() {
  clearInterval(pollingTimer);
  if (!listeningId) return;
  pollingTimer = setInterval(async () => {
    if (phase === 'listening' || phase === 'connecting') return;
    try {
      await fetchDetail(1);
      const pending = (detail.processing?.pendingTranslations || 0) > 0 || detail.jobs.some(j => ['pending','running'].includes(j.state));
      if (!pending) clearInterval(pollingTimer);
    } catch { clearInterval(pollingTimer); }
  }, 2000);
}

els.newListening.addEventListener('click', newListening);
els.historyListening.addEventListener('click', () => showHistory().catch(error => els.historyList.replaceChildren(el('p', 'empty-note', error.message))));
els.back.addEventListener('click', showListening);
els.historyMore.addEventListener('click', () => loadHistory().catch(error => showError(error.message)));
els.loadMore.addEventListener('click', () => fetchDetail(detailPage + 1, true).catch(error => showError(error.message)));
els.retryProcessing.addEventListener('click', async () => {
  if (!saved.key) { retryAfterSave = true; openSettings(); return; }
  els.retryProcessing.disabled = true;
  try {
    const response = await fetch(`/api/listenings/${listeningId}/retry`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: saved.key }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法继续处理');
    await fetchDetail(); startPolling();
  } catch (error) { showError(error.message); }
  finally { els.retryProcessing.disabled = false; }
});

async function chooseTab() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器不支持标签页音频采集，请使用新版 Chrome 或 Edge');
  const selected = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' }, audio: true,
    selfBrowserSurface: 'exclude', surfaceSwitching: 'include'
  });
  const surface = selected.getVideoTracks()[0]?.getSettings().displaySurface;
  const audioTrack = selected.getAudioTracks()[0];
  if ((surface && surface !== 'browser') || !audioTrack || audioTrack.readyState !== 'live') {
    selected.getTracks().forEach(track => track.stop());
    throw new Error('请选择浏览器标签页，并勾选“共享标签页音频”');
  }
  return selected;
}

function watchTabEnd(selected) {
  const onEnded = () => {
    if (stream !== selected || phase === 'idle') return;
    showError('标签页共享已停止，请重新选择');
    if (phase === 'listening') { stop(); return; }
    socket?.close();
    releaseAudio();
    setPhase('idle');
  };
  selected.getTracks().forEach(track => track.addEventListener('ended', onEnded, { once: true }));
}

async function prepareAudio() {
  if (!window.AudioWorkletNode) throw new Error('当前浏览器不支持实时音频采集，请使用新版 Chrome 或 Edge');
  const tabInput = els.audioInput.value === 'tab';
  if (tabInput) stream = await chooseTab();
  else {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风实时采集');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  }
  if (tabInput) watchTabEnd(stream);
  const context = new AudioContext({ sampleRate: 16000 });
  audioContext = context;
  await context.audioWorklet.addModule('/audio-processor.js');
  if (phase !== 'connecting') return;
  if (stream?.getAudioTracks()[0]?.readyState !== 'live') throw new Error('音频来源已停止，请重新选择');
  sourceNode = context.createMediaStreamSource(stream);
  processor = new AudioWorkletNode(context, 'pcm-processor');
  silenceNode = context.createGain();
  silenceNode.gain.value = 0;
  processor.port.onmessage = event => {
    if (phase === 'listening' && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 512_000) socket.send(event.data);
  };
  sourceNode.connect(processor);
  processor.connect(silenceNode);
  silenceNode.connect(context.destination);
  await context.resume();
}

async function releaseAudio() {
  const currentStream = stream;
  const currentContext = audioContext;
  const currentProcessor = processor;
  const currentSource = sourceNode;
  const currentSilence = silenceNode;
  stream = audioContext = sourceNode = processor = silenceNode = null;
  currentProcessor?.disconnect();
  currentSource?.disconnect();
  currentSilence?.disconnect();
  currentStream?.getTracks().forEach(track => track.stop());
  if (currentContext && currentContext.state !== 'closed') await currentContext.close().catch(() => {});
}

async function start() {
  if (phase !== 'idle') return;
  if (!saved.key) { openSettings(true); return; }
  clearError();
  currentSentenceId = null; currentSegmentId = null;
  clearTranslationWork();
  setPhase('connecting', els.audioInput.value === 'tab' ? '请选择要收听的标签页…' : '正在申请麦克风…');
  try {
    await prepareAudio();
    if (phase !== 'connecting') return;
    setPhase('connecting', '正在连接千问AI平台…');
    const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    socket = connection;
    connection.addEventListener('open', () => connection.send(JSON.stringify({ type: 'start', key: saved.key, source: els.source.value, targetLang: els.target.value, audioSource: els.audioInput.value, listeningId })));
    connection.addEventListener('message', async event => {
      const message = JSON.parse(event.data);
      if (message.type === 'listening-ready') {
        listeningId = message.listeningId;
        setPhase('listening');
        fetchDetail().catch(error => showError(error.message));
      }
      if (message.type === 'sentence') receiveSentence(message);
      if (message.type === 'segment-final') {
        liveSegments.set(message.segment.id, message.segment);
        displayFinal(message.segment);
        if (detail) {
          if (!detail.segments.some(s => s.id === message.segment.id)) detail.segments.push(message.segment);
          detail.segmentCount = Math.max(detail.segmentCount, message.segment.sequence_no);
          renderDetail();
        }
      }
      if (message.type === 'translation-updated') {
        liveSegments.set(message.segment.id, message.segment);
        if (message.segment.id === currentSegmentId) displayFinal(message.segment);
        if (detail) {
          const index = detail.segments.findIndex(s => s.id === message.segment.id);
          if (index >= 0) detail.segments[index] = message.segment;
          renderTranscript(); renderProcessing();
        }
      }
      if (message.type === 'knowledge-upserted') {
        liveKnowledge.set(message.item.id, message.item);
        if (detail) {
          const index = detail.knowledge.findIndex(k => k.id === message.item.id);
          if (index >= 0) detail.knowledge[index] = message.item;
          else detail.knowledge.push(message.item);
          renderKnowledge();
        }
      }
      if (message.type === 'processing-updated') fetchDetail().catch(() => {});
      if (message.type === 'error') { showError(message.message || '连接失败'); connection.close(); }
      if (message.type === 'finished') { connection.close(); }
    });
    connection.addEventListener('error', () => showError('本地连接失败，请确认服务仍在运行'));
    connection.addEventListener('close', async () => {
      if (socket !== connection) return;
      socket = null;
      await releaseAudio();
      if (phase === 'listening' || phase === 'connecting') {
        if (!els.hint.classList.contains('error')) showError('连接已断开，请重试');
      }
      setPhase('idle');
      startPolling();
      if (!els.translation.classList.contains('placeholder')) els.badge.textContent = '已完成';
    });
  } catch (error) {
    await releaseAudio();
    setPhase('idle');
    const permissionMessage = els.audioInput.value === 'tab' ? '请允许共享标签页及其音频，然后重试' : '请允许浏览器使用麦克风，然后重试';
    showError(error.name === 'NotAllowedError' ? permissionMessage : error.message || '无法启动音频采集');
  }
}

async function switchTab() {
  if (phase !== 'listening' || els.audioInput.value !== 'tab' || els.switchTab.disabled) return;
  els.switchTab.disabled = true;
  els.switchTab.textContent = '选择中…';
  let selected;
  try {
    selected = await chooseTab();
    if (phase !== 'listening' || !audioContext || !processor) return;
    const nextSource = audioContext.createMediaStreamSource(selected);
    nextSource.connect(processor);
    const oldStream = stream;
    const oldSource = sourceNode;
    stream = selected;
    sourceNode = nextSource;
    watchTabEnd(selected);
    oldSource?.disconnect();
    oldStream?.getTracks().forEach(track => track.stop());
    selected = null;
    clearError();
  } catch (error) {
    if (error.name !== 'NotAllowedError') showError(error.message || '无法更换标签页');
  } finally {
    selected?.getTracks().forEach(track => track.stop());
    els.switchTab.disabled = false;
    els.switchTab.textContent = '更换标签页';
  }
}

async function stop() {
  if (phase !== 'listening') return;
  setPhase('stopping');
  await releaseAudio();
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
  else setPhase('idle');
  setTimeout(() => { if (phase === 'stopping') socket?.close(); }, 5000);
}

els.toggle.addEventListener('click', () => phase === 'listening' ? stop() : start());
els.switchTab.addEventListener('click', switchTab);
window.addEventListener('beforeunload', () => { stream?.getTracks().forEach(track => track.stop()); socket?.close(); });
