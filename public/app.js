import { createKnowledgeEditor } from './knowledge-editor.js';
import { initTranscriptVisibility } from './transcript-visibility.js';
import { createCaptionFrontier } from './caption-frontier.js';
import { INTERIM_TRANSLATION_MAX_LENGTH, validateInterimTranslation } from './translation-params.js';
import { processingView, createProcessingPoller } from './processing-state.js';
import { createSpeechController } from './speech-controller.js';
import { speechConfig } from './speech-protocol.js';
import { createKnowledgeGraph, readKnowledgeView, saveKnowledgeView } from './knowledge-graph.js';

const $ = id => document.getElementById(id);
const els = {
  toggle: $('toggle'), toggleLabel: $('toggle-label'), micIcon: $('mic-icon'), tabIcon: $('tab-icon'),
  status: $('status'), liveDot: $('live-dot'),
  hint: $('hint'), translation: $('translation'), original: $('original'), badge: $('caption-badge'),
  livePanel: $('live-panel'), pinnedCaption: $('pinned-caption'),
  pinnedTranslation: $('pinned-translation'), pinnedBadge: $('pinned-badge'),
  pinnedToggle: $('pinned-toggle'), pinnedToggleLabel: $('pinned-toggle-label'),
  modal: $('settings-modal'), settingsTrigger: $('settings-trigger'), closeSettings: $('close-settings'),
  settingsForm: $('settings-form'), apiKey: $('api-key'), audioInput: $('audio-input'),
  switchTab: $('switch-tab'), source: $('source-language'),
  target: $('target-language'), showKey: $('show-key'), testButton: $('test-connection'),
  testResult: $('test-result'), testSummary: $('test-summary'),
  testRecognition: $('test-recognition'), testTranslation: $('test-translation'), testKnowledge: $('test-knowledge'),
  newListening: $('new-listening'), historyListening: $('history-listening'), listeningView: $('listening-view'),
  controls: $('listening-controls'), recordLoading: $('record-loading'), recordLoadingTitle: $('record-loading-title'),
  recordLoadingStatus: $('record-loading-status'), recordLoadingRetry: $('record-loading-retry'), recordLoadingBack: $('record-loading-back'),
  historyView: $('history-view'), historyList: $('history-list'), historyMore: $('history-more'),
  historyError: $('history-error'), back: $('back-to-listening'),
  recordPanel: $('record-panel'), recordTitle: $('record-title'), processingStatus: $('processing-status'),
  editRecord: $('edit-record'), recordEditor: $('record-editor'), recordTitleInput: $('record-title-input'),
  recordNotesInput: $('record-notes-input'), recordNotes: $('record-notes'), recordNotesPanel: $('record-notes-panel'),
  saveRecord: $('save-record'), cancelRecord: $('cancel-record'), recordEditError: $('record-edit-error'), recordEditStatus: $('record-edit-status'),
  retryProcessing: $('retry-processing'), knowledgeList: $('knowledge-list'), knowledgeCount: $('knowledge-count'),
  transcriptList: $('transcript-list'), runsPanel: $('runs-panel'), runsList: $('runs-list'), loadMore: $('load-more'), downloadSelect: $('download-select'),
  knowledgeToggleAll: $('knowledge-toggle-all'), knowledgeTrack: $('knowledge-track'), backToTop: $('back-to-top'),
  sizeSlider: $('translation-size'), captionMode: $('caption-mode'),
  dataExport: $('data-export'), dataImport: $('data-import'), dataImportFile: $('data-import-file'),
  dataImportReview: $('data-import-review'), dataImportSummary: $('data-import-summary'),
  dataImportConfirm: $('data-import-confirm'), dataTransferStatus: $('data-transfer-status')
};

initTranscriptVisibility(document);

const saved = {
  key: localStorage.getItem('tongsheng:qianwen-key') || ''
};
localStorage.removeItem('tongsheng:key');
localStorage.removeItem('tongsheng:region');
els.apiKey.value = saved.key;

// 译文字号滑块：范围 21-64，默认 44；保留范围内的偏好并修正旧值
const SIZE_KEY = 'tongsheng:translation-size';
function applyTranslationSize(value) {
  const number = value === null || String(value).trim() === '' ? NaN : Number(value);
  const size = Number.isFinite(number) ? Math.min(64, Math.max(21, Math.round(number))) : 44;
  els.sizeSlider.value = String(size);
  document.documentElement.style.setProperty('--translation-size', String(size));
}
const savedTranslationSize = localStorage.getItem(SIZE_KEY);
applyTranslationSize(savedTranslationSize);
if (savedTranslationSize !== null && savedTranslationSize !== els.sizeSlider.value) {
  localStorage.setItem(SIZE_KEY, els.sizeSlider.value);
}
els.sizeSlider.addEventListener('input', () => {
  applyTranslationSize(els.sizeSlider.value);
  localStorage.setItem(SIZE_KEY, els.sizeSlider.value);
});

const RUNS_PANEL_KEY = 'tongsheng:runs-panel-open';
els.runsPanel.open = localStorage.getItem(RUNS_PANEL_KEY) !== 'closed';
els.runsPanel.addEventListener('toggle', () => {
  localStorage.setItem(RUNS_PANEL_KEY, els.runsPanel.open ? 'open' : 'closed');
});

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
const sourceCaption = createCaptionFrontier();
const targetCaption = createCaptionFrontier();
let lastSourceHypothesis = '';
let lastPreviewInput = '';
let finalCaptionCorrected = false;
let lastTranslationAt = 0;
let startAfterSave = false;
let testController;
let pendingImportToken = null;
let listeningId = null;
let listeningGeneration = 0;
let detail = null;
let openingHistory = null;
let detailPage = 0;
let historyPage = 0;
let metadataVersion = 0;
let editingRecordId = null;
let savingRecord = false;
let currentSegmentId = null;
let liveProcessing = null;
const detailPoller = createProcessingPoller({
  read: async () => { await fetchDetail(); return detail; },
  isCurrent: id => id === listeningId && phase === 'idle' && !els.listeningView.hidden
});
let retryAfterSave = false;
const liveSegments = new Map();
const liveKnowledge = new Map();

// —— 字幕模式：UI 统一为"单句大字幕跟随说话人"；captionMode 只决定服务端 ASR 断句参数 ——
const CAPTION_MODE_KEY = 'tongsheng:caption-mode';
let captionMode = localStorage.getItem(CAPTION_MODE_KEY) === 'classic' ? 'classic' : 'realtime';
els.captionMode.value = captionMode;
els.captionMode.addEventListener('change', () => {
  captionMode = els.captionMode.value === 'classic' ? 'classic' : 'realtime';
  localStorage.setItem(CAPTION_MODE_KEY, captionMode);
});

// —— 知识追踪（issue #5）：开启后新知识到达时自动滚动到对应卡片并短暂高亮 ——
const KNOWLEDGE_TRACK_KEY = 'tongsheng:knowledge-track';
let trackKnowledge = localStorage.getItem(KNOWLEDGE_TRACK_KEY) === '1';
const knowledgeFlashTimers = new WeakMap();
function syncKnowledgeTrack() {
  els.knowledgeTrack.textContent = trackKnowledge ? '追踪中' : '追踪新增';
  els.knowledgeTrack.setAttribute('aria-pressed', trackKnowledge ? 'true' : 'false');
  els.knowledgeTrack.classList.toggle('active', trackKnowledge);
}
els.knowledgeTrack.addEventListener('click', event => {
  event.stopPropagation(); event.preventDefault(); // 按钮嵌在 summary 内，点击不应触发面板折叠
  trackKnowledge = !trackKnowledge;
  localStorage.setItem(KNOWLEDGE_TRACK_KEY, trackKnowledge ? '1' : '0');
  syncKnowledgeTrack();
});
syncKnowledgeTrack();
let knowledgeView = readKnowledgeView(localStorage);
const knowledgeEditor = createKnowledgeEditor({ getId: () => listeningId, getKey: () => saved.key,
  onRequireKey: () => { openSettings(); activateTab(0); els.apiKey.focus(); },
  onSaved: refreshEditedKnowledge
});
async function refreshEditedKnowledge(id) {
  if (id !== listeningId) return;
  listeningGeneration++;
  liveKnowledge.clear(); liveSegments.clear();
  detail = null; detailPage = 1;
  knowledgeGraph.select(null); knowledgeGraph.select(id);
  try { await fetchDetail(); startPolling(); } catch (error) { showError('修改已保存，但刷新失败，请重新打开这条收听'); }
}
const knowledgeGraph = createKnowledgeGraph({
  root: $('knowledge-graph'), getKey: () => saved.key,
  onRequireKey: () => { openSettings(); activateTab(0); els.apiKey.focus(); },
  onStarted: id => { if (id === listeningId) { fetchDetail().catch(() => {}); startPolling(); } },
  onEdit: item => knowledgeEditor.open(item),
  loadSegment: loadKnowledgeEvidence,
  locateSegment: locateKnowledgeEvidence,
  onNodes: items => { if (detail?.listening.id === listeningId) { detail.knowledge = items; renderKnowledge(); } },
  runNumber: segment => detail?.runs.find(run => run.id === segment.run_id)?.run_no || '?'
});
function setKnowledgeView(value) {
  knowledgeView = value === 'graph' ? 'graph' : 'list';
  saveKnowledgeView(localStorage, knowledgeView);
  els.knowledgeList.hidden = knowledgeView !== 'list';
  knowledgeGraph.setActive(knowledgeView === 'graph');
  $('knowledge-view-list').setAttribute('aria-pressed', String(knowledgeView === 'list'));
  $('knowledge-view-graph').setAttribute('aria-pressed', String(knowledgeView === 'graph'));
  syncKnowledgeToggleAll();
}
$('knowledge-view-list').addEventListener('click', () => setKnowledgeView('list'));
$('knowledge-view-graph').addEventListener('click', () => setKnowledgeView('graph'));
setKnowledgeView(knowledgeView);
let connectionGeneration = 0; // 每次连接递增；旧连接的事件/定时器不得污染新会话
let activeRunId = null;
let provisionalFor = null; // { sentenceId }：当前句已显示临时译文，final 到达前保留不闪空窗

// Speech is deliberately never restored as enabled. Only preferences may survive a reload.
const speechEls = Object.fromEntries(['toggle', 'pause', 'preview-pause', 'status', 'reading', 'jump', 'replay', 'backlog', 'settings', 'volume', 'provider', 'region', 'voice', 'rate', 'prompt', 'incremental', 'form', 'preview', 'result']
  .map(name => [name, $(`speech-${name}`)]));
const fishEls = Object.fromEntries(['key', 'model', 'voice', 'rate', 'latency', 'style'].map(name => [name, $(`speech-fish-${name}`)]));
const transcriptSpeech = Object.fromEntries(['controls', 'original', 'translation', 'stop', 'pause', 'status', 'reading', 'progress', 'seek', 'position']
  .map(name => [name, $(`transcript-speech-${name}`)]));
let transcriptSeeking = false, transcriptProgressState = null;
function renderTranscriptProgress() {
  const state = transcriptProgressState;
  const active = state?.enabled && state.mode === 'transcript' && state.total > 0;
  transcriptSpeech.progress.hidden = !active;
  transcriptSpeech.seek.disabled = !active || state.total < 2;
  if (!active) { transcriptSeeking = false; return; }
  transcriptSpeech.seek.max = state.total;
  if (!transcriptSeeking) transcriptSpeech.seek.value = state.position;
  const position = Number(transcriptSpeech.seek.value);
  transcriptSpeech.position.textContent = `第 ${position} / ${state.total} 句`;
  transcriptSpeech.seek.setAttribute('aria-valuetext', `第 ${position} 句，共 ${state.total} 句`);
}
let speechPreview = false;
let speechCanJump = false;
const speech = createSpeechController({ onChange(state) {
  transcriptProgressState = state; renderTranscriptProgress();
  $('speech-tab-indicator').hidden = !state.enabled;
  $('live-speech-tab').title = state.enabled ? '语音播报已开启，点击管理播报' : '';
  speechPreview = state.preview;
  speechEls.toggle.textContent = state.enabled ? '关闭播报' : '开启译文播报';
  speechEls.toggle.setAttribute('aria-pressed', String(state.enabled));
  speechEls.toggle.classList.toggle('active', state.enabled);
  speechEls.toggle.disabled = !state.enabled && (phase !== 'listening' || els.target.value !== 'Chinese');
  for (const [button, visible] of [[speechEls.pause, state.enabled], [speechEls['preview-pause'], state.enabled && state.preview], [transcriptSpeech.pause, state.enabled && state.mode === 'transcript']]) {
    button.hidden = !visible;
    button.textContent = state.paused ? '继续播报' : '暂停播报';
    button.disabled = state.resuming;
  }
  speechEls.status.textContent = state.message;
  speechEls.result.textContent = state.message;
  if (state.mode === 'transcript') transcriptSpeech.status.textContent = state.message;
  transcriptSpeech.stop.hidden = !state.enabled || state.mode !== 'transcript';
  for (const kind of ['original', 'translation']) {
    const active = state.enabled && state.mode === 'transcript' && state.kind === kind;
    transcriptSpeech[kind].setAttribute('aria-pressed', String(active));
    transcriptSpeech[kind].classList.toggle('active', active);
  }
  if (state.canJump !== undefined) speechCanJump = state.canJump;
  speechEls.jump.hidden = !state.enabled || state.preview || phase !== 'listening' || !speechCanJump;
  speechEls.preview.textContent = state.preview ? '停止试听' : '试听语音';
  if (state.canReplay !== undefined) speechEls.replay.hidden = !state.canReplay;
  if (state.backlog !== undefined) speechEls.backlog.textContent = state.backlog;
  if (state.reading !== undefined) {
    speechEls.reading.textContent = state.reading ? `正在读：${state.reading}` : '';
    speechEls.reading.hidden = !state.reading;
    transcriptSpeech.reading.textContent = state.mode === 'transcript' ? state.reading : '';
    transcriptSpeech.reading.hidden = !transcriptSpeech.reading.textContent;
  }
} });
let speechPreferences;
try { speechPreferences = JSON.parse(localStorage.getItem('hearwise:speech') || '{}'); } catch { speechPreferences = {}; }
if (!speechPreferences || typeof speechPreferences !== 'object' || Array.isArray(speechPreferences)) speechPreferences = {};
// Qwen uses the saved connection key. Fish credentials have their own browser-only slot.
sessionStorage.removeItem('hearwise:speech-key');
localStorage.removeItem('hearwise:speech-key');
speechEls.region.value = speechPreferences.region || 'beijing';
speechEls.voice.value = speechPreferences.voice || 'Cherry';
speechEls.rate.value = String(speechPreferences.rate || 1);
speechEls.prompt.value = typeof speechPreferences.prompt === 'string' ? speechPreferences.prompt : '';
speechEls.volume.value = String(speechPreferences.volume ?? .8);
speechEls.incremental.checked = speechPreferences.incremental === true;
speechEls.provider.value = speechPreferences.provider === 'fish' ? 'fish' : 'qwen';
const storedFish = speechPreferences.fish && typeof speechPreferences.fish === 'object' ? speechPreferences.fish : {};
fishEls.key.value = localStorage.getItem('hearwise:fish-key') || '';
fishEls.model.value = storedFish.model || 's2.1-pro-free';
fishEls.voice.value = storedFish.referenceId || 'bbfff76fd7c74f35a04a33366574f2d6';
fishEls.rate.value = String(storedFish.rate ?? 1);
fishEls.latency.value = storedFish.latency || 'balanced';
fishEls.style.value = typeof storedFish.style === 'string' ? storedFish.style : '';
function syncSpeechProvider() {
  const fish = speechEls.provider.value === 'fish';
  $('speech-qwen-fields').hidden = $('speech-qwen-fields').disabled = fish;
  $('speech-fish-fields').hidden = $('speech-fish-fields').disabled = !fish;
  $('speech-qwen-model').value = speechEls.prompt.value.trim() ? 'Qwen3-TTS-Instruct-Flash-Realtime' : 'Qwen3-TTS-Flash-Realtime';
  $('speech-service-note').textContent = fish
    ? '开启或试听时，待播报文本会发送至 Fish Audio，费用按所选模型计费。'
    : '使用连接设置中的 API Key。开启或试听时，待播报文本会发送至所选地域的阿里云服务，可能产生费用。';
}
speechEls.provider.addEventListener('change', () => { speech.stop('服务商已切换，请保存设置后手动开启播报'); syncSpeechProvider(); });
speechEls.prompt.addEventListener('input', syncSpeechProvider);
syncSpeechProvider();
function readSpeechConfig() {
  const provider = speechEls.provider.value;
  return speechConfig(provider === 'fish'
    ? { provider, key: fishEls.key.value, model: fishEls.model.value, referenceId: fishEls.voice.value, rate: Number(fishEls.rate.value), latency: fishEls.latency.value, style: fishEls.style.value }
    : { provider, key: saved.key, region: speechEls.region.value, voice: speechEls.voice.value, rate: Number(speechEls.rate.value), prompt: speechEls.prompt.value });
}
function openSpeechSettings() { openSettings(); activateTab(2); speechEls.provider.focus(); }
function speechConfigError(error) {
  if (speechEls.provider.value === 'fish') {
    openSpeechSettings();
    if (!fishEls.key.value.trim()) fishEls.key.focus();
    else if (error.message.includes('音色 ID')) fishEls.voice.focus();
    else if (error.message.includes('表达风格')) fishEls.style.focus();
  }
  else if (!saved.key) { openSettings(); activateTab(0); els.apiKey.focus(); }
  else { openSpeechSettings(); if (error.message.startsWith('语音 Prompt')) speechEls.prompt.focus(); }
  speechEls.status.textContent = error.message;
  speechEls.result.textContent = error.message;
}
function enableSpeech(reason) {
  try { void speech.start(readSpeechConfig(), { volume: Number(speechEls.volume.value), reason, incremental: speechPreferences.incremental === true }); }
  catch (error) { speechConfigError(error); }
}
speechEls.toggle.addEventListener('click', () => speech.enabled ? speech.stop() : enableSpeech());
for (const button of [speechEls.pause, speechEls['preview-pause'], transcriptSpeech.pause]) {
  button.addEventListener('click', () => speech.paused ? void speech.resume() : speech.pause());
}
speechEls.jump.addEventListener('click', () => enableSpeech('skip'));
speechEls.replay.addEventListener('click', () => {
  try { void speech.replay(readSpeechConfig(), { volume: Number(speechEls.volume.value) }); }
  catch (error) { speechConfigError(error); }
});
speechEls.settings.addEventListener('click', openSpeechSettings);
speechEls.preview.addEventListener('click', () => {
  if (speechPreview) return speech.stop('试听已停止');
  try { void speech.start(readSpeechConfig(), { preview: true, volume: Number(speechEls.volume.value) }); }
  catch (error) { speechConfigError(error); }
});
speechEls.volume.addEventListener('input', () => {
  speech.volume(Number(speechEls.volume.value));
  speechPreferences.volume = Number(speechEls.volume.value);
  localStorage.setItem('hearwise:speech', JSON.stringify(speechPreferences));
});
speechEls.form.addEventListener('submit', event => {
  event.preventDefault();
  try {
    const config = readSpeechConfig();
    speech.stop('设置已保存，请手动开启译文播报');
    speechPreferences = { ...speechPreferences, provider: config.provider, volume: Number(speechEls.volume.value), incremental: speechEls.incremental.checked };
    if (config.provider === 'fish') {
      const { key, provider, ...preferences } = config;
      speechPreferences.fish = preferences;
      localStorage.setItem('hearwise:fish-key', key);
      fishEls.key.value = key; fishEls.voice.value = config.referenceId; fishEls.style.value = config.style;
    } else {
      Object.assign(speechPreferences, { region: config.region, voice: config.voice, rate: config.rate, prompt: config.prompt });
      speechEls.prompt.value = config.prompt;
    }
    localStorage.setItem('hearwise:speech', JSON.stringify(speechPreferences));
    closeSettings();
  } catch (error) { speechConfigError(error); }
});
for (const kind of ['original', 'translation']) transcriptSpeech[kind].addEventListener('click', () => {
  if (phase !== 'idle' || !listeningId) return;
  try { void speech.start(readSpeechConfig(), { transcript: kind, volume: Number(speechEls.volume.value) }); }
  catch (error) { speechConfigError(error); }
});
transcriptSpeech.stop.addEventListener('click', () => speech.stop('全文播报已停止'));
transcriptSpeech.seek.addEventListener('pointerdown', () => { transcriptSeeking = true; });
transcriptSpeech.seek.addEventListener('input', () => { transcriptSeeking = true; renderTranscriptProgress(); });
transcriptSpeech.seek.addEventListener('change', () => {
  const position = Number(transcriptSpeech.seek.value);
  transcriptSeeking = false;
  void speech.seek(position);
});
transcriptSpeech.seek.addEventListener('pointerup', () => setTimeout(() => {
  transcriptSeeking = false; renderTranscriptProgress();
}, 0));
for (const event of ['pointercancel', 'blur']) transcriptSpeech.seek.addEventListener(event, () => {
  transcriptSeeking = false; renderTranscriptProgress();
});
function syncTranscriptSpeech() {
  transcriptSpeech.controls.hidden = phase !== 'idle' || !detail?.segmentCount || detail.listening?.id !== listeningId;
  const active = detail?.runs?.some(run => run.state === 'active');
  transcriptSpeech.original.disabled = transcriptSpeech.translation.disabled = Boolean(active);
}
function syncSpeechContext() {
  speech.setContext({ phase, listeningId, runId: activeRunId, target: els.target.value, audioSource: els.audioInput.value });
  speechEls.toggle.disabled = !speech.enabled && (phase !== 'listening' || els.target.value !== 'Chinese');
  speechEls.toggle.title = els.target.value === 'Chinese' ? '开启后从新的完整译文开始播报' : '当前仅支持中文译文播报';
  speechEls.jump.hidden = !speech.enabled || speechPreview || phase !== 'listening' || !speechCanJump;
  syncTranscriptSpeech();
}
els.target.addEventListener('change', syncSpeechContext);
syncSpeechContext();

// 限高字幕框内更新文本：仅当更新前已贴近底部才跟随贴底，用户上滚回看时不拽回
function updateText(el, text) {
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.textContent = text;
  el.captionParts = null;
  if (stick) el.scrollTop = el.scrollHeight;
}

function renderCaption(el, caption) {
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  if (!el.captionParts) {
    const committed = document.createElement('span'), tail = document.createElement('span');
    committed.className = 'caption-committed'; tail.className = 'caption-tail';
    el.replaceChildren(committed, tail); el.captionParts = { committed, tail };
  }
  if (el.captionParts.committed.textContent !== caption.committed) el.captionParts.committed.textContent = caption.committed;
  if (el.captionParts.tail.textContent !== caption.tail) el.captionParts.tail.textContent = caption.tail;
  el.classList.toggle('caption-review', caption.correctionPending);
  if (stick) el.scrollTop = el.scrollHeight;
}

function syncPinnedCaption() {
  // Only the text scrolls, so the collapse control always remains reachable.
  updateText(els.pinnedTranslation, els.translation.textContent);
  els.pinnedTranslation.classList.toggle('placeholder', els.translation.classList.contains('placeholder'));
  els.pinnedTranslation.classList.toggle('provisional', els.translation.classList.contains('provisional'));
  els.pinnedBadge.textContent = els.badge.textContent;
}

function updatePinnedCaption() {
  els.pinnedCaption.hidden = els.listeningView.hidden || els.livePanel.hidden || els.livePanel.getBoundingClientRect().bottom > 12;
}

const PINNED_COLLAPSED_KEY = 'tongsheng:pinned-caption-collapsed';
let pinnedCollapsed = localStorage.getItem(PINNED_COLLAPSED_KEY) === '1';
function applyPinnedCollapse() {
  els.pinnedCaption.classList.toggle('collapsed', pinnedCollapsed);
  els.pinnedTranslation.hidden = els.pinnedBadge.hidden = pinnedCollapsed;
  els.pinnedToggle.setAttribute('aria-expanded', String(!pinnedCollapsed));
  els.pinnedToggle.setAttribute('aria-label', pinnedCollapsed ? '展开吸顶字幕' : '收起吸顶字幕');
  els.pinnedToggleLabel.textContent = pinnedCollapsed ? '展开' : '收起';
  if (!pinnedCollapsed) els.pinnedTranslation.scrollTop = els.pinnedTranslation.scrollHeight;
}
els.pinnedToggle.addEventListener('click', () => {
  pinnedCollapsed = !pinnedCollapsed;
  localStorage.setItem(PINNED_COLLAPSED_KEY, pinnedCollapsed ? '1' : '0');
  applyPinnedCollapse();
});
applyPinnedCollapse();

// View changes never start or stop speech. The shared panel is the pinning boundary.
const liveTabs = [
  { button: $('live-caption-tab'), panel: $('live-caption-panel') },
  { button: $('live-speech-tab'), panel: $('live-speech-panel') }
];
function activateLiveTab(index, focusButton = false) {
  liveTabs.forEach((tab, i) => {
    const active = i === index;
    tab.button.classList.toggle('active', active);
    tab.button.setAttribute('aria-selected', String(active));
    tab.button.tabIndex = active ? 0 : -1;
    tab.panel.hidden = !active;
  });
  if (focusButton) liveTabs[index].button.focus();
  if (index === 0) {
    els.translation.scrollTop = els.translation.scrollHeight;
    els.original.scrollTop = els.original.scrollHeight;
  }
  updatePinnedCaption();
}
liveTabs.forEach((tab, index) => {
  tab.button.addEventListener('click', () => activateLiveTab(index));
  tab.button.addEventListener('keydown', event => {
    const next = { ArrowRight: (index + 1) % liveTabs.length, ArrowLeft: (index + liveTabs.length - 1) % liveTabs.length, Home: 0, End: liveTabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    activateLiveTab(next, true);
  });
});
activateLiveTab(0);

new MutationObserver(syncPinnedCaption).observe(els.translation, { childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
new MutationObserver(syncPinnedCaption).observe(els.badge, { childList: true, characterData: true });
window.addEventListener('scroll', updatePinnedCaption, { passive: true });
window.addEventListener('resize', updatePinnedCaption);
syncPinnedCaption();
updatePinnedCaption();

// 返回顶部浮标：滚动超过两屏才显示（z-index 低于设置弹窗）
function updateBackToTop() {
  els.backToTop.hidden = window.scrollY <= window.innerHeight * 2;
}
els.backToTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
window.addEventListener('scroll', updateBackToTop, { passive: true });
window.addEventListener('resize', updateBackToTop);
updateBackToTop();

function setPhase(next, message) {
  phase = next;
  if (next !== 'idle') closeRecordEditor();
  renderRecordMetadata();
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
  els.captionMode.disabled = next !== 'idle';
  syncSpeechContext();
  els.newListening.disabled = next !== 'idle';
  els.historyListening.disabled = next !== 'idle';
  if (tabInput && !els.hint.classList.contains('error')) els.hint.textContent = active ? '仅所选标签页的声音发送至阿里云' : '选择浏览器标签页，并勾选“共享标签页音频”';
}

let hintErrorSource = null;
function showError(message, source = 'general') {
  // A provisional translation must not replace a connection/audio error.
  if (source === 'interim-translation' && hintErrorSource && hintErrorSource !== source) return;
  hintErrorSource = source;
  els.hint.textContent = message;
  els.hint.classList.add('error');
}

function clearError(source) {
  if (source && hintErrorSource !== source) return;
  hintErrorSource = null;
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
  // Closing without saving must not turn an experimental path on (or alter a running epoch).
  speechEls.incremental.checked = speechPreferences.incremental === true;
  if (speechPreview) speech.stop();
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
  { button: $('tab-language-button'), panel: $('tab-language') },
  { button: $('tab-speech-button'), panel: $('tab-speech') },
  { button: $('tab-data-button'), panel: $('tab-data') }
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

function setDataTransferStatus(message, failed = false) {
  els.dataTransferStatus.textContent = message;
  els.dataTransferStatus.classList.toggle('error', failed);
}
function resetImportReview() {
  pendingImportToken = null;
  els.dataImportReview.hidden = true;
  els.dataImportSummary.textContent = '';
}
els.dataExport.addEventListener('click', () => {
  setDataTransferStatus('正在生成备份…');
  els.dataExport.disabled = true;
  try {
    const link = document.createElement('a');
    link.href = `/api/data/export?download=${Date.now()}`;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
    setDataTransferStatus('备份已开始下载。');
  } finally {
    els.dataExport.disabled = false;
  }
});
els.dataImport.addEventListener('click', () => {
  if (phase !== 'idle') {
    setDataTransferStatus('当前正在收听，请结束当前收听后再导入数据。', true);
    return;
  }
  els.dataImportFile.click();
});
els.dataImportFile.addEventListener('change', async () => {
  const file = els.dataImportFile.files?.[0];
  if (!file) return;
  resetImportReview();
  setDataTransferStatus('正在验证备份…');
  els.dataImport.disabled = true;
  try {
    const response = await fetch('/api/data/import/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.sqlite3' },
      body: file
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '备份验证失败');
    pendingImportToken = result.token;
    els.dataImportSummary.textContent = `数据库版本：${result.databaseVersion} · 历史收听：${result.listeningCount} 条`;
    els.dataImportReview.hidden = false;
    setDataTransferStatus('备份验证通过。');
  } catch (error) {
    setDataTransferStatus(error.message || '备份验证失败，请重新选择文件。', true);
  } finally {
    els.dataImport.disabled = false;
    els.dataImportFile.value = '';
  }
});
els.dataImportConfirm.addEventListener('click', async () => {
  if (!pendingImportToken) return;
  if (phase !== 'idle') {
    setDataTransferStatus('当前正在收听，请结束当前收听后再导入数据。', true);
    return;
  }
  const confirmed = window.confirm('导入 Hearwise 数据？\n\n当前历史收听、知识条目和知识图谱将被备份文件完整替换，不会自动合并。\n\nHearwise 会先自动备份当前数据库。');
  if (!confirmed) return;
  els.dataImportConfirm.disabled = true;
  els.dataImport.disabled = true;
  els.dataExport.disabled = true;
  setDataTransferStatus('正在导入并校验数据…');
  try {
    const response = await fetch('/api/data/import/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pendingImportToken })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '导入失败');
    pendingImportToken = null;
    els.dataImportReview.hidden = true;
    setDataTransferStatus(`数据导入成功，当前数据已自动备份为 ${result.safetyBackup}。正在刷新…`);
    setTimeout(() => window.location.reload(), 500);
  } catch (error) {
    setDataTransferStatus(error.message || '导入失败，当前数据未被替换。', true);
    els.dataImportConfirm.disabled = false;
    els.dataImport.disabled = false;
    els.dataExport.disabled = false;
  }
});

els.showKey.addEventListener('click', () => {
  const shown = els.apiKey.type === 'text';
  els.apiKey.type = shown ? 'password' : 'text';
  els.showKey.textContent = shown ? '显示' : '隐藏';
  els.showKey.setAttribute('aria-label', shown ? '显示 API Key' : '隐藏 API Key');
});
els.apiKey.addEventListener('input', () => {
  els.apiKey.setCustomValidity('');
  resetConnectionTest();
});
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
  const key = els.apiKey.value.trim();
  if (!key) {
    els.apiKey.setCustomValidity('请输入有效的 API Key');
    els.apiKey.reportValidity();
    return;
  }
  els.apiKey.setCustomValidity('');
  if (key !== saved.key && speechEls.provider.value === 'qwen') speech.stop('API Key 已更新，请手动开启播报');
  localStorage.setItem('tongsheng:qianwen-key', key);
  saved.key = key;
  clearTranslationWork();
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
  lastPreviewInput = '';
}

// 识别语言=译文语言：不请求翻译，译文区直接显示识别原文（auto 无法判定，仍走翻译）
const sameLanguageTargets = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean' };
const isPassthrough = () => sameLanguageTargets[els.source.value] === els.target.value;

function deferLongTranslation() {
  clearTranslationWork();
  clearError('interim-translation');
  els.badge.textContent = '长句识别中，等待完整译文';
}

function showInterimTranslationError(message) {
  els.badge.textContent = '等待完整译文';
  showError(`临时译文暂不可用：${message}`, 'interim-translation');
}

function scheduleTranslation(text) {
  if (!text.trim() || isPassthrough()) return;
  pendingText = text.trim();
  if (pendingText.length > INTERIM_TRANSLATION_MAX_LENGTH) { deferLongTranslation(); return; }
  if (translationTimer || translationRequest || pendingText === lastPreviewInput) return;
  const delay = Math.max(0, lastTranslationAt + 1200 - Date.now());
  translationTimer = setTimeout(async () => {
    translationTimer = null;
    const version = ++translationVersion;
    const input = { key: saved.key, text: pendingText, target: els.target.value, source: els.source.value };
    const invalid = validateInterimTranslation(input);
    if (invalid) {
      if (invalid.code === 'INTERIM_TEXT_TOO_LONG') deferLongTranslation();
      else showInterimTranslationError(invalid.error);
      return;
    }
    lastPreviewInput = input.text;
    lastTranslationAt = Date.now();
    const controller = new AbortController();
    translationRequest = controller;
    // Keep an existing provisional translation visible during background refresh.
    if (els.translation.classList.contains('placeholder')) els.badge.textContent = '翻译中';
    try {
      const response = await fetch('/api/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input), signal: controller.signal
      });
      const result = await response.json();
      // Check before ALL response branches: even a late 429 must not change the current caption.
      if (version !== translationVersion) return;
      if (response.status === 429) {
        clearError('interim-translation');
        lastPreviewInput = '';
        els.badge.textContent = '最终译文优先处理中';
        return;
      }
      if (!response.ok && result?.code === 'INTERIM_TEXT_TOO_LONG') { deferLongTranslation(); return; }
      if (!response.ok) throw new Error(result?.error || '翻译请求失败');
      if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('翻译服务未返回文字');
      clearError('interim-translation');
      const caption = targetCaption.update(result.text.trim(), { sourceContext: input.text });
      renderCaption(els.translation, caption);
      els.translation.classList.remove('placeholder');
      els.translation.classList.add('provisional');
      provisionalFor = { sentenceId: String(currentSentenceId) };
      els.badge.textContent = caption.correctionPending ? '识别有修订，等待完整译文' : '临时译文 · 尾部更新中';
    } catch (error) {
      if (error.name === 'AbortError' || version !== translationVersion) return;
      lastPreviewInput = '';
      showInterimTranslationError(error.message || '请稍后重试');
    } finally {
      if (translationRequest === controller) translationRequest = null;
      if (version === translationVersion && pendingText !== input.text) scheduleTranslation(pendingText);
    }
  }, delay);
}

function receiveSentence(message) {
  if (typeof message.text !== 'string' || !message.text.trim()) return;
  const passthrough = isPassthrough(); // 同语言：原文直接镜像到译文区，不显示"正在翻译"占位
  if (message.id !== currentSentenceId) { // 新句开始：原文先行，译文待翻译
    clearTranslationWork();
    clearError('interim-translation');
    els.badge.textContent = passthrough ? '无需翻译' : '正在识别';
    currentSentenceId = message.id;
    sourceCaption.reset(); targetCaption.reset(); lastSourceHypothesis = ''; finalCaptionCorrected = false;
    currentSegmentId = null;
    provisionalFor = null;
    if (!passthrough) updateText(els.translation, '正在翻译…');
    els.translation.classList.toggle('placeholder', !passthrough);
    els.translation.classList.remove('provisional');
  }
  if (message.text === lastSourceHypothesis) return;
  lastSourceHypothesis = message.text;
  const sourceState = sourceCaption.update(message.text);
  renderCaption(els.original, sourceState);
  if (sourceState.correctionPending) els.badge.textContent = '识别有修订，等待定稿';
  els.original.classList.remove('placeholder');
  if (passthrough) {
    renderCaption(els.translation, targetCaption.update(message.text));
    els.translation.classList.remove('placeholder');
    els.badge.textContent = '无需翻译';
  } else if (message.text.trim().length >= 5) scheduleTranslation(message.text);
}

function displayFinal(segment) {
  clearTranslationWork();
  clearError('interim-translation');
  if (String(currentSentenceId) !== String(segment.asr_sentence_id)) { sourceCaption.reset(); targetCaption.reset(); finalCaptionCorrected = false; }
  currentSentenceId = segment.asr_sentence_id;
  currentSegmentId = segment.id;
  const sourceFinal = sourceCaption.update(segment.original_text, { final: true });
  finalCaptionCorrected ||= sourceFinal.corrected;
  renderCaption(els.original, sourceFinal);
  els.original.classList.remove('placeholder');
  if (segment.translation_text) { // final 译文到达：无缝替换临时译文
    provisionalFor = null;
    const targetFinal = targetCaption.update(segment.translation_text, { final: true });
    finalCaptionCorrected ||= targetFinal.corrected;
    renderCaption(els.translation, targetFinal);
    els.translation.classList.remove('placeholder');
    els.translation.classList.remove('provisional');
    els.badge.textContent = finalCaptionCorrected ? '已定稿 · 已修正临时字幕' : isPassthrough() ? '无需翻译' : '已完成';
  } else if (segment.translation_state === 'failed') {
    provisionalFor = null;
    updateText(els.translation, '翻译失败，可点击继续处理');
    els.translation.classList.add('placeholder');
    els.translation.classList.remove('provisional');
    els.badge.textContent = '翻译失败';
  } else if (provisionalFor && provisionalFor.sentenceId === String(segment.asr_sentence_id)) {
    els.badge.textContent = '翻译中'; // 保留同句临时译文，避免闪回占位
  } else {
    updateText(els.translation, '正在翻译…');
    els.translation.classList.add('placeholder');
    els.translation.classList.remove('provisional');
    els.badge.textContent = '翻译中';
  }
}

// 停止后补齐：当前显示句的 final 译文到达时自动更新焦点字幕（无需点击）
let segmentPollTimer = null;
function pollCurrentSegment(gen) {
  clearInterval(segmentPollTimer);
  if (!listeningId || !currentSegmentId || !activeRunId) return;
  const segId = currentSegmentId;
  let rounds = 0;
  segmentPollTimer = setInterval(async () => {
    if (gen !== connectionGeneration || ++rounds > 90) { clearInterval(segmentPollTimer); return; }
    try {
      const response = await fetch(`/api/listenings/${listeningId}/segments?runId=${encodeURIComponent(activeRunId)}&ids=${segId}`);
      const result = await response.json();
      if (!response.ok) return;
      const row = (result.items || [])[0];
      if (!row || row.translation_state === 'pending') return; // 等下一轮
      clearInterval(segmentPollTimer);
      if (gen === connectionGeneration && currentSegmentId === segId) displayFinal(row);
    } catch { /* 下一轮重试 */ }
  }, 2000);
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
  syncTranscriptSpeech();
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
// Fetch by stable segment UUID, independent of transcript pagination.
async function loadKnowledgeEvidence(segmentId, signal) {
  const requestedId = listeningId;
  const requestedGeneration = listeningGeneration;
  if (!requestedId) throw new Error('请先选择收听记录');
  const loaded = detail?.segments.find(segment => segment.id === segmentId);
  if (loaded?.translation_state === 'complete') return loaded;
  const response = await fetch(`/api/listenings/${encodeURIComponent(requestedId)}/segments?ids=${encodeURIComponent(segmentId)}`, { signal });
  const result = await response.json();
  if (listeningId !== requestedId || listeningGeneration !== requestedGeneration || signal?.aborted) throw new Error('已切换收听记录，请重新选择证据');
  if (!response.ok) throw new Error(result.error || '原文依据读取失败');
  const segment = result.items?.find(row => row.id === segmentId);
  if (!segment) throw new Error('原文依据不存在或已删除');
  return segment;
}
function locateKnowledgeEvidence(segment) {
  if (!detail || segment.listening_id && segment.listening_id !== listeningId) return;
  const index = detail.segments.findIndex(row => row.id === segment.id);
  if (index < 0) detail.segments.push(segment); else detail.segments[index] = segment;
  detail.segments.sort((a, b) => a.sequence_no - b.sequence_no);
  renderTranscript();
  const card = document.getElementById(`segment-${segment.id}`);
  if (!card) return;
  const panel = card.closest('details'); if (panel) panel.open = true;
  card.tabIndex = -1;
  card.scrollIntoView({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  card.focus({ preventScroll: true });
}
function renderKnowledge() {
  knowledgeGraph.select(listeningId);
  const graphNodes = knowledgeGraph.setNodes(detail?.knowledge || []);
  if (detail && graphNodes) detail.knowledge = graphNodes;
  els.knowledgeCount.textContent = String(detail?.knowledge.length || 0);
  // 全量重建会丢展开状态：重建前记录 open 条目，重建后恢复（实时 knowledge-upserted 会频繁触发重建）
  const openIds = new Set();
  for (const card of els.knowledgeList.querySelectorAll('details.knowledge-item')) if (card.open) openIds.add(card.dataset.kid);
  els.knowledgeList.replaceChildren();
  if (!detail?.knowledge.length) { els.knowledgeList.append(el('p', 'empty-note', '尚无知识条目，最终原文出现后会持续整理。')); syncKnowledgeToggleAll(); return; }
  const names = { person: '人物', term: '术语', event: '事件', other: '其他' };
  for (const item of detail.knowledge) {
    const card = el('details', 'knowledge-item');
    card.dataset.kid = String(item.id ?? item.canonical_name);
    card.dataset.id = item.id != null ? String(item.id) : ''; // 追踪定位按事件条目 id 查找（不一定是列表末尾）
    card.open = openIds.has(card.dataset.kid); // 默认收起；重建后恢复原有展开状态
    const heading = el('summary', 'knowledge-heading');
    const titleLine = el('span', 'knowledge-title-line');
    const labels = { person: '人物', organization: '组织', product: '产品', work: '作品', method: '方法', event: '事件', place: '地点' };
    titleLine.append(el('strong', '', item.canonical_name), el('span', 'knowledge-type', labels[item.display_label] || names[item.type] || item.type));
    if (item.certainty === 'needs_review') titleLine.append(el('span', 'needs-review', '待确认'));
    heading.append(titleLine);
    if (item.short_description || item.dialogue_summary) heading.append(el('span', 'knowledge-brief', item.short_description || item.dialogue_summary));
    card.append(heading);
    if (item.aliases?.length) card.append(el('p', 'knowledge-aliases', `别名：${item.aliases.join('、')}`));
    if (item.facts?.length) {
      for (const fact of item.facts) card.append(el('p', 'knowledge-dialogue', `本次提到：${fact.content}`));
    } else card.append(el('p', 'knowledge-dialogue', `对话中提到：${item.dialogue_summary}`));
    if (item.background_note) card.append(el('p', 'knowledge-background', `背景补充（模型生成）：${item.background_note}`));
    for (const revision of item.revisions || []) card.append(el('p', 'knowledge-revision', `更名记录：${revision.old_value} → ${revision.new_value}（${revision.reason}）`));
    const evidence = el('div', 'knowledge-evidence');
    for (const mention of item.mentions || []) {
      const link = el('a', '', `“${mention.surface_text}”`);
      link.href = `#segment-${mention.segment_id}`;
      link.addEventListener('click', async event => {
        event.preventDefault();
        const selectedId = listeningId;
        try {
          const segment = await loadKnowledgeEvidence(mention.segment_id);
          if (selectedId === listeningId) locateKnowledgeEvidence(segment);
        } catch (error) { if (selectedId === listeningId) showError(error.message); }
      });
      evidence.append(link);
    }
    const edit = el('button', 'knowledge-edit-button', '修改 / 删除'); edit.type = 'button';
    edit.setAttribute('aria-label', `修改或删除 ${item.canonical_name}`);
    edit.addEventListener('click', () => { void knowledgeEditor.open(item); });
    card.append(evidence, edit); els.knowledgeList.append(card);
  }
  syncKnowledgeToggleAll();
}
// 知识条目「全部展开/收起」：按钮在 summary 内，点击不得触发面板自身折叠
function syncKnowledgeToggleAll() {
  const cards = els.knowledgeList.querySelectorAll('details.knowledge-item');
  els.knowledgeToggleAll.hidden = knowledgeView !== 'list' || !cards.length;
  if (cards.length) els.knowledgeToggleAll.textContent = [...cards].some(card => !card.open) ? '全部展开' : '全部收起';
}
// 追踪新增知识：面板折叠时先展开，再平滑滚动到卡片并短暂高亮；仅在开关开启时生效
function focusKnowledgeItem(itemId) {
  if (knowledgeView === 'graph') { knowledgeGraph.highlight(itemId, trackKnowledge); return; }
  if (!trackKnowledge || itemId == null) return;
  const card = els.knowledgeList.querySelector(`details.knowledge-item[data-id="${String(itemId)}"]`);
  if (!card) return;
  const panel = card.closest('details.knowledge-panel');
  if (panel && !panel.open) panel.open = true;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('knowledge-flash');
  void card.offsetWidth; // 重新触发动画：连续 upsert 同一卡片也要看到高亮
  card.classList.add('knowledge-flash');
  clearTimeout(knowledgeFlashTimers.get(card));
  knowledgeFlashTimers.set(card, setTimeout(() => card.classList.remove('knowledge-flash'), 1900));
}
els.knowledgeToggleAll.addEventListener('click', event => {
  event.stopPropagation(); event.preventDefault();
  const cards = els.knowledgeList.querySelectorAll('details.knowledge-item');
  const shouldOpen = [...cards].some(card => !card.open); // 有收起的→全部展开；否则全部收起
  for (const card of cards) card.open = shouldOpen;
  syncKnowledgeToggleAll();
});

function renderProcessing() {
  if (!detail) return;
  const view = processingView(detail);
  els.processingStatus.textContent = view.text;
  els.retryProcessing.hidden = !view.canRetry;
  knowledgeGraph.setProcessing(detail.processing?.relations);
  const revision = detail.graph?.graphRevision ?? detail.graph?.revision ?? detail.graph_revision;
  if (revision != null) knowledgeGraph.invalidate(listeningId, revision);
}
function renderRecordMetadata() {
  if (!detail) return;
  els.recordTitle.textContent = detail.listening.title;
  const notes = detail.listening.notes || '';
  els.recordNotes.textContent = notes;
  els.recordNotesPanel.hidden = !notes.trim();
  els.editRecord.disabled = phase !== 'idle' || detail.runs.some(run => run.state === 'active') || savingRecord;
}
function closeRecordEditor() {
  editingRecordId = null;
  els.recordEditor.hidden = true;
  els.editRecord.setAttribute('aria-expanded', 'false');
  els.recordEditError.hidden = true;
  els.recordEditStatus.textContent = '';
}
function openRecordEditor() {
  if (!detail || phase !== 'idle' || savingRecord || editingRecordId || detail.runs.some(run => run.state === 'active')) return;
  editingRecordId = listeningId;
  els.recordTitleInput.value = detail.listening.title;
  els.recordTitleInput.setCustomValidity('');
  els.recordNotesInput.value = detail.listening.notes || '';
  els.recordEditError.hidden = true;
  els.recordEditStatus.textContent = '';
  els.recordEditor.hidden = false;
  els.editRecord.setAttribute('aria-expanded', 'true');
  els.recordTitleInput.focus();
}
async function saveRecordMetadata(event) {
  event.preventDefault();
  if (!editingRecordId || editingRecordId !== listeningId || savingRecord) return;
  const title = els.recordTitleInput.value.trim();
  if (!title) {
    els.recordTitleInput.setCustomValidity('请输入标题');
    els.recordTitleInput.reportValidity();
    return;
  }
  const requestedId = editingRecordId;
  savingRecord = true;
  els.saveRecord.disabled = els.cancelRecord.disabled = true;
  els.recordTitleInput.disabled = els.recordNotesInput.disabled = true;
  els.saveRecord.textContent = '保存中…';
  els.recordEditError.hidden = true;
  renderRecordMetadata();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/api/listenings/${requestedId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ title, notes: els.recordNotesInput.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败，请稍后重试');
    if (listeningId !== requestedId || detail?.listening.id !== requestedId) return;
    metadataVersion++;
    detail.listening = { ...detail.listening, ...result.listening };
    renderRecordMetadata();
    if (!els.historyView.hidden) {
      reloadHistory().catch(error => {
        els.historyError.textContent = error.message || '历史列表刷新失败，请重试';
        els.historyError.hidden = false;
      });
    }
    if (editingRecordId === requestedId) {
      closeRecordEditor();
      els.recordEditStatus.textContent = '标题与备注已保存';
      els.editRecord.focus();
    }
  } catch (error) {
    if (editingRecordId !== requestedId) return;
    els.recordEditError.textContent = controller.signal.aborted ? '保存超时，请重试；如已保存，重试不会重复创建记录' : (error.message || '保存失败，请稍后重试');
    els.recordEditError.hidden = false;
  } finally {
    clearTimeout(timeout);
    savingRecord = false;
    els.saveRecord.disabled = els.cancelRecord.disabled = false;
    els.recordTitleInput.disabled = els.recordNotesInput.disabled = false;
    els.saveRecord.textContent = '保存';
    renderRecordMetadata();
  }
}
els.editRecord.addEventListener('click', openRecordEditor);
els.recordTitleInput.addEventListener('input', () => els.recordTitleInput.setCustomValidity(''));
els.recordEditor.addEventListener('submit', saveRecordMetadata);
els.cancelRecord.addEventListener('click', () => { closeRecordEditor(); els.editRecord.focus(); });
els.recordEditor.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !savingRecord) { event.preventDefault(); closeRecordEditor(); els.editRecord.focus(); }
});

function renderDetail() {
  if (!detail) return;
  els.recordPanel.hidden = false;
  renderRecordMetadata();
  renderRuns(); renderTranscript(); renderKnowledge(); renderProcessing();
}
async function fetchDetail(page = 1, append = false, controller = new AbortController()) {
  if (!listeningId) return;
  const requestedId = listeningId;
  const generationAtStart = listeningGeneration;
  const metadataAtStart = metadataVersion;
  const processingAtStart = liveProcessing;
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response, result;
  try {
    response = await fetch(`/api/listenings/${requestedId}?page=${page}`, { signal: controller.signal });
    result = await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error('读取收听记录超时，请稍后重试');
    throw error;
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw Object.assign(new Error(result.error || '无法读取收听记录'), { status: response.status });
  if (listeningId !== requestedId || generationAtStart !== listeningGeneration) return;
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
  if (liveProcessing !== processingAtStart && liveProcessing?.listeningId === requestedId) {
    result.processing = liveProcessing.processing;
    result.processingAvailable = liveProcessing.processingAvailable;
  }
  if (metadataVersion !== metadataAtStart && detail?.listening.id === requestedId) {
    result.listening = { ...result.listening, title: detail.listening.title, notes: detail.listening.notes };
  }
  detail = result; detailPage = append ? page : Math.max(1, detailPage); renderDetail();
  void knowledgeGraph.refresh();
}
function showListening() {
  els.listeningView.hidden = false; els.historyView.hidden = true;
  updatePinnedCaption();
}
async function showHistory() {
  knowledgeEditor.close();
  closeRecordEditor();
  if (phase !== 'idle') return;
  if (openingHistory) resetListening();
  speech.stop();
  detailPoller.stop(); showListening();
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
    open.addEventListener('click', () => { void selectListening(item.id, item.title); });
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
function renderHistoryOpening(error = '') {
  const opening = Boolean(openingHistory);
  els.recordLoading.hidden = !opening;
  els.livePanel.hidden = els.controls.hidden = opening;
  els.listeningView.setAttribute('aria-busy', String(opening && !error));
  if (opening) {
    els.recordPanel.hidden = true;
    els.recordLoadingTitle.textContent = openingHistory.title;
    els.recordLoadingStatus.textContent = error || '正在加载收听内容…';
    els.recordLoadingStatus.classList.toggle('error', Boolean(error));
    els.recordLoadingRetry.hidden = !error;
  }
  updatePinnedCaption();
}
async function selectListening(id, title = '收听记录') {
  if (phase !== 'idle') return;
  resetListening();
  listeningId = id;
  const opening = { id, title, controller: new AbortController() };
  openingHistory = opening;
  renderHistoryOpening(); showListening();
  window.scrollTo({ top: 0, behavior: 'instant' });
  els.recordLoadingTitle.focus();
  try {
    // Open the page before awaiting network; graph reads begin when detail is rendered.
    await fetchDetail(1, false, opening.controller);
    if (openingHistory !== opening || !detail) return;
    const lastRun = detail.runs.at(-1);
    if (lastRun) {
      els.source.value = lastRun.source_lang;
      els.target.value = lastRun.target_lang;
      els.audioInput.value = lastRun.audio_source;
    }
    openingHistory = null;
    renderHistoryOpening();
    clearError(); setPhase('idle');
    const last = detail.latestSegment || detail.segments.at(-1);
    if (last) displayFinal(last);
    if (detail.processingAvailable && processingView(detail).pending) startPolling();
  } catch (error) {
    if (openingHistory !== opening) return;
    renderHistoryOpening(error.message || '无法读取收听记录，请重试');
  }
}
els.recordLoadingRetry.addEventListener('click', () => {
  if (openingHistory) void selectListening(openingHistory.id, openingHistory.title);
});
els.recordLoadingBack.addEventListener('click', () => {
  showHistory().catch(error => { els.historyError.textContent = error.message; els.historyError.hidden = false; });
});
function resetListening() {
  knowledgeEditor.close();
  openingHistory?.controller.abort();
  openingHistory = null;
  renderHistoryOpening();
  closeRecordEditor();
  speech.stop();
  detailPoller.stop();
  clearInterval(segmentPollTimer);
  listeningGeneration++;
  listeningId = null; detail = null; detailPage = 0; currentSentenceId = null; currentSegmentId = null;
  knowledgeGraph.select(null);
  activeRunId = null; provisionalFor = null;
  liveSegments.clear(); liveKnowledge.clear(); liveProcessing = null;
  clearTranslationWork();
  els.recordPanel.hidden = true;
  updateText(els.original, '开始聆听后，实时识别的文字会出现。');
  updateText(els.translation, '字幕会显示在这里');
  els.original.classList.add('placeholder'); els.translation.classList.add('placeholder');
  els.translation.classList.remove('provisional');
  els.source.value = 'en'; els.target.value = 'Chinese'; els.audioInput.value = 'microphone';
  clearError(); setPhase('idle');
}
function newListening() {
  if (phase !== 'idle') return;
  resetListening(); showListening();
}
function startPolling() {
  if (listeningId) detailPoller.start(listeningId);
}

els.newListening.addEventListener('click', newListening);
els.historyListening.addEventListener('click', () => showHistory().catch(error => els.historyList.replaceChildren(el('p', 'empty-note', error.message))));
els.back.addEventListener('click', () => { showListening(); startPolling(); });
els.historyMore.addEventListener('click', () => loadHistory().catch(error => showError(error.message)));
els.loadMore.addEventListener('click', () => fetchDetail(detailPage + 1, true).catch(error => showError(error.message)));
els.downloadSelect.addEventListener('change', () => {
  const kind = els.downloadSelect.value;
  els.downloadSelect.value = '';
  if (kind) downloadTranscript(kind);
});
async function downloadTranscript(kind) {
  if (!listeningId) return;
  try {
    const response = await fetch(`/api/listenings/${listeningId}/export?kind=${kind}`);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || '下载失败，请稍后重试');
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const marker = "filename*=UTF-8''";
    const start = disposition.indexOf(marker);
    const fallbackTitle = Array.from((detail?.listening.title || '收听记录').replace(/[\\/:*?"<>|\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')).slice(0, 80).join('') || '收听记录';
    const fallback = `${fallbackTitle}-${kind === 'original' ? '原文' : '译文'}.txt`;
    const name = start >= 0 ? decodeURIComponent(disposition.slice(start + marker.length).split(';')[0]) : fallback;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
  } catch (error) { showError(error.message || '下载失败，请稍后重试'); }
}
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
    selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude'
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

async function prepareAudio(preselected) {
  if (!window.AudioWorkletNode) throw new Error('当前浏览器不支持实时音频采集，请使用新版 Chrome 或 Edge');
  const tabInput = els.audioInput.value === 'tab';
  if (tabInput) stream = preselected || await chooseTab();
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
  const capture = { frames: 0, samples: 0, droppedFrames: 0, droppedSamples: 0 };
  processor.port.onmessage = event => {
    if (phase !== 'listening') return;
    capture.frames++; capture.samples += event.data.byteLength / 2;
    if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 512_000) socket.send(event.data);
    else {
      capture.droppedFrames++; capture.droppedSamples += event.data.byteLength / 2;
      if (capture.droppedFrames === 1 || capture.droppedFrames % 50 === 0) {
        console.warn('audio_capture_drop', { ...capture, audioMs: capture.samples / 16 });
      }
    }
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

async function start(preselected) {
  if (phase !== 'idle' || openingHistory) return;
  if (!saved.key) { preselected?.getTracks().forEach(track => track.stop()); openSettings(true); return; }
  speech.stop();
  detailPoller.stop();
  clearError();
  currentSentenceId = null; currentSegmentId = null;
  clearTranslationWork();
  setPhase('connecting', els.audioInput.value === 'tab' ? '请选择要收听的标签页…' : '正在申请麦克风…');
  try {
    await prepareAudio(preselected);
    if (phase !== 'connecting') return;
    setPhase('connecting', '正在连接千问AI平台…');
    const gen = ++connectionGeneration; // 所有回调绑定 generation，旧 timer/事件不得污染新会话
    const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    socket = connection;
    connection.addEventListener('open', () => connection.send(JSON.stringify({ type: 'start', key: saved.key, source: els.source.value, targetLang: els.target.value, audioSource: els.audioInput.value, listeningId, captionMode })));
    connection.addEventListener('message', async event => {
      if (gen !== connectionGeneration || socket !== connection) return;
      const message = JSON.parse(event.data);
      if (message.type === 'listening-ready') {
        if (listeningId !== message.listeningId) listeningGeneration++;
        listeningId = message.listeningId;
        knowledgeGraph.select(listeningId);
        if (gen === connectionGeneration) activeRunId = message.runId;
        setPhase('listening');
        fetchDetail().catch(error => showError(error.message));
      }
      if (message.type === 'caption-correction' && gen === connectionGeneration) showError(message.message);
      if (message.type === 'sentence' && gen === connectionGeneration) receiveSentence(message);
      if (message.type === 'segment-final') {
        liveSegments.set(message.segment.id, message.segment);
        if (gen === connectionGeneration) displayFinal(message.segment);
        if (detail) {
          if (!detail.segments.some(s => s.id === message.segment.id)) detail.segments.push(message.segment);
          detail.segmentCount = Math.max(detail.segmentCount, message.segment.sequence_no);
          renderDetail();
        }
      }
      if (message.type === 'translation-updated') {
        liveSegments.set(message.segment.id, message.segment);
        if (gen === connectionGeneration && message.segment.id === currentSegmentId) displayFinal(message.segment);
        if (detail) {
          const index = detail.segments.findIndex(s => s.id === message.segment.id);
          if (index >= 0) detail.segments[index] = message.segment;
          renderTranscript(); renderProcessing();
        }
      }
      if (message.type === 'knowledge-edited' && message.listeningId === listeningId) void refreshEditedKnowledge(listeningId);
      if (message.type === 'knowledge-upserted' && (!message.listeningId || message.listeningId === listeningId)) {
        liveKnowledge.set(message.item.id, message.item);
        if (detail) {
          const index = detail.knowledge.findIndex(k => k.id === message.item.id);
          if (index >= 0) detail.knowledge[index] = message.item;
          else detail.knowledge.push(message.item);
          renderKnowledge();
          focusKnowledgeItem(message.item.id); // 追踪开关开启时定位高亮（含更新已有条目）
        }
      }
      if (message.type === 'graph-invalidated' && message.listeningId === listeningId) {
        knowledgeGraph.invalidate(message.listeningId, message.graphRevision);
      }
      if (message.type === 'processing-updated' && (!message.listeningId || message.listeningId === listeningId)) {
        if (message.processing) {
          liveProcessing = { ...message, listeningId };
          if (detail) {
            detail.processing = message.processing;
            detail.processingAvailable = message.processingAvailable;
            renderProcessing();
          }
        }
        if (message.refreshDetail || !message.processing) fetchDetail().catch(() => {});
      }
      if (message.type === 'error' && gen === connectionGeneration) { showError(message.message || '连接失败'); connection.close(); }
      if (message.type === 'finished') { connection.close(); }
    });
    connection.addEventListener('error', () => { if (gen === connectionGeneration) showError('本地连接失败，请确认服务仍在运行'); });
    connection.addEventListener('close', async () => {
      if (socket !== connection) return;
      clearTranslationWork();
      socket = null;
      await releaseAudio();
      if (phase === 'listening' || phase === 'connecting') {
        if (!els.hint.classList.contains('error')) showError('连接已断开，请重试');
      }
      setPhase('idle');
      startPolling();
      if (gen === connectionGeneration) pollCurrentSegment(gen); // 当前句译文未到位时自动补齐，不需要点击
      if (!els.translation.classList.contains('placeholder') && !els.translation.classList.contains('provisional')) els.badge.textContent = isPassthrough() ? '无需翻译' : '已完成';
    });
  } catch (error) {
    await releaseAudio();
    setPhase('idle');
    const permissionMessage = els.audioInput.value === 'tab' ? '请允许共享标签页及其音频，然后重试' : '请允许浏览器使用麦克风，然后重试';
    showError(error.name === 'NotAllowedError' ? permissionMessage : error.message || '无法启动音频采集');
    startPolling();
  }
}

async function switchTab() {
  if (phase !== 'listening' || els.audioInput.value !== 'tab' || els.switchTab.disabled) return;
  els.switchTab.disabled = true;
  els.switchTab.textContent = '选择中…';
  let selected;
  const selectedGeneration = connectionGeneration;
  try {
    selected = await chooseTab();
    if (phase !== 'listening' || selectedGeneration !== connectionGeneration || !audioContext || !processor) return;
    // A new source is a new run: close the old ASR boundary before reading the new tab.
    const oldConnection = socket;
    speech.stop();
    const closed = new Promise(resolve => oldConnection.addEventListener('close', resolve, { once: true }));
    await stop();
    await closed;
    // The existing close handler releases input resources before returning to idle.
    if (phase !== 'idle') await releaseAudio();
    setPhase('idle');
    const next = selected;
    selected = null;
    await start(next);
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
  const stoppingConnection = socket;
  speech.drain();
  setPhase('stopping');
  // 尾包 flush 确认：有限等待（400ms），超时记录丢尾风险而不是永远卡住
  if (processor && socket?.readyState === WebSocket.OPEN) {
    const workletPort = processor.port;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { workletPort.removeEventListener('message', onMessage); reject(new Error('flush-timeout')); }, 400);
        function onMessage(event) {
          if (event.data instanceof ArrayBuffer) { // flush 出来的尾包 PCM：仍然发完
            if (socket?.readyState === WebSocket.OPEN) socket.send(event.data);
            return;
          }
          if (event.data?.type === 'flushed') {
            clearTimeout(timer); workletPort.removeEventListener('message', onMessage); resolve();
          }
        }
        workletPort.addEventListener('message', onMessage);
        workletPort.postMessage({ type: 'flush' });
      });
    } catch { console.warn('audio_flush_timeout: 尾包未确认，本次停止可能丢失最后不足 20ms 的音频'); }
  }
  await releaseAudio();
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
  else setPhase('idle');
  setTimeout(() => { if (phase === 'stopping' && socket === stoppingConnection) stoppingConnection?.close(); }, 5000);
}

els.toggle.addEventListener('click', () => phase === 'listening' ? stop() : start());
els.switchTab.addEventListener('click', switchTab);
window.addEventListener('beforeunload', () => { speech.stop(); stream?.getTracks().forEach(track => track.stop()); socket?.close(); });
