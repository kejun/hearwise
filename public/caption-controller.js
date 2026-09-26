// 非阻塞焦点调度器（issue #1 §7）：FOLLOW/REVIEW、条目 Map、焦点单调推进、缺口 grace、可注入时钟与旁路计数。
// 纯逻辑模块：不访问 DOM；时钟（now）、定时器（schedule）与参数均可注入，便于确定性单元测试。
// 条目身份为 (listeningId, runId, segmentId) 三元组；complete 译文不可回退，重复 final 幂等，冲突 final 记录不覆盖。
export const DEFAULT_PARAMS = {
  reorderGraceMs: 250,      // 后句 ready、前句 pending 时的最大额外等待
  minFocusMs: 800,          // 避免新译文刚显示就被替换（不约束首条）
  targetFocusMs: 1600,      // 正常节奏参考，不形成 FIFO 阅读债务
  maxReadyUiWaitMs: 1500,   // 最新 ready 从到达到显示的 UI 等待上限
  pendingHintMs: 500,       // 短于该值的等待不闪“翻译中”
  slowTranslationMs: 2000,  // 从 final 接收起计的“处理较慢”提示阈值
  visibleRecentItems: 3     // 默认最近句上下文条数
};
const MAX_ROWS_PER_RUN = 500;
const TRIM_BEHIND_FOCUS = 10;

export function entryFromSegment(row) {
  return {
    listeningId: row.listening_id, runId: row.run_id, segmentId: row.id,
    sequence: row.sequence_no, source: row.original_text, target: row.translated_text ?? null,
    translationState: row.translation_state ?? 'pending', sourceEndMs: row.end_ms ?? null
  };
}

export function createCaptionController(options = {}) {
  const params = { ...DEFAULT_PARAMS, ...(options.params || {}) };
  const now = options.now || (() => Date.now());
  const schedule = options.schedule || ((delayMs, fn) => { const t = setTimeout(fn, delayMs); return () => clearTimeout(t); });
  const onChange = options.onChange || (() => {});
  const onFocus = options.onFocus || (() => {});
  const onBypass = options.onBypass || (() => {});

  const timelines = new Map(); // runId -> item[]（按 sequence 升序）
  const conflicts = [];
  let run = null;              // { listeningId, runId, generation }
  let mode = 'FOLLOW';
  let focusSequence = null;    // FOLLOW 自动推进只增不减
  let focusStartedAt = null;
  let reorderStartedAt = null; // grace 绑定缺口区间；区间消失或游标越过时清除
  let hidden = false;
  let draft = null;            // { sentenceId, text, updatedAt } —— 弱化草稿区
  let wakeCancel = null;

  function rows(runId) { return timelines.get(runId) || []; }
  function currentRows() { return run ? rows(run.runId) : []; }
  function isCurrentRun(runId) { return !!run && run.runId === runId; }
  function insertSorted(list, item) {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].sequence < item.sequence) lo = mid + 1; else hi = mid; }
    list.splice(lo, 0, item);
  }
  function findItem(listeningId, runId, segmentId) {
    return rows(runId).find(it => it.listeningId === listeningId && it.segmentId === segmentId) || null;
  }
  function focusItem() {
    if (focusSequence == null || !run) return null;
    return currentRows().find(it => it.sequence === focusSequence) || null;
  }
  function trim(list) {
    if (mode === 'REVIEW' || list.length <= MAX_ROWS_PER_RUN || focusSequence == null) return;
    const cutoff = focusSequence - TRIM_BEHIND_FOCUS;
    while (list.length > MAX_ROWS_PER_RUN - TRIM_BEHIND_FOCUS && list.length && list[0].sequence < cutoff) list.shift();
  }

  function setFocus(item, t, { markBypass = true } = {}) {
    const list = rows(item.runId);
    const bypassedNow = [];
    if (markBypass) {
      for (const it of list) {
        if (it === item) continue;
        if (it.sequence > (focusSequence ?? -Infinity) && it.sequence < item.sequence && !it.bypassed) {
          it.bypassed = true;
          bypassedNow.push(it);
        }
      }
    }
    focusSequence = item.sequence;
    focusStartedAt = t;
    reorderStartedAt = null;
    item.everFocused = true;
    item.bypassed = false;
    if (bypassedNow.length) onBypass(bypassedNow);
    onFocus({ item, readyReceivedAt: item.readyReceivedAt, focusedAt: t,
      uiWaitMs: item.readyReceivedAt == null ? null : t - item.readyReceivedAt,
      waitingTranslation: item.translationState !== 'complete' });
    onChange();
  }

  // 纯决策：返回下一次需要唤醒的时刻（ms），无需唤醒返回 null。副作用仅有 setFocus 的回调。
  function tick() {
    if (!run || mode === 'REVIEW' || hidden) return null;
    const t = now();
    const list = currentRows();
    const ready = list.filter(it => it.translationState === 'complete' && (focusSequence == null || it.sequence > focusSequence));
    if (!ready.length) { reorderStartedAt = null; return null; }
    const newest = ready[ready.length - 1];
    if (focusSequence == null) { setFocus(newest, t); return null; } // 首条完整译文立即聚焦，多条同批选最新
    const candidate = (ready.length >= 3 || (newest.readyReceivedAt != null && t - newest.readyReceivedAt >= params.maxReadyUiWaitMs))
      ? newest : ready[0];
    const focusAge = focusStartedAt == null ? Infinity : t - focusStartedAt;
    if (focusAge < params.minFocusMs) return focusStartedAt + params.minFocusMs;
    const newestUiAge = newest.readyReceivedAt == null ? 0 : t - newest.readyReceivedAt;
    const uiBudgetEnd = (newest.readyReceivedAt ?? t) + params.maxReadyUiWaitMs;
    const gap = list.some(it => it.sequence > focusSequence && it.sequence < candidate.sequence && it.translationState !== 'complete');
    if (gap && reorderStartedAt == null) reorderStartedAt = t;
    if (!gap) reorderStartedAt = null;
    if (gap && t - reorderStartedAt < params.reorderGraceMs && newestUiAge < params.maxReadyUiWaitMs)
      return Math.min(reorderStartedAt + params.reorderGraceMs, uiBudgetEnd);
    if (focusAge < params.targetFocusMs && ready.length < 3 && newestUiAge < params.maxReadyUiWaitMs)
      return Math.min(focusStartedAt + params.targetFocusMs, uiBudgetEnd);
    setFocus(candidate, t);
    return null;
  }

  function scheduleTick() {
    if (wakeCancel) { wakeCancel(); wakeCancel = null; }
    const wake = tick();
    if (wake != null) {
      const delay = Math.max(0, wake - now());
      wakeCancel = schedule(delay, () => { wakeCancel = null; scheduleTick(); });
    }
  }
  function cancelWake() { if (wakeCancel) { wakeCancel(); wakeCancel = null; } }

  return {
    params,
    conflicts,
    get mode() { return mode; },
    get focusSequence() { return focusSequence; },
    get draft() { return draft; },
    startRun(info) { // { listeningId, runId, generation }
      run = { ...info };
      if (!timelines.has(run.runId)) timelines.set(run.runId, []);
      mode = 'FOLLOW'; focusSequence = null; focusStartedAt = null; reorderStartedAt = null; draft = null;
      cancelWake(); onChange();
    },
    // 恢复：整段替换该 run 的时间线（幂等键 segmentId，complete 不被更旧 pending 覆盖由调用方保证快照新鲜）
    loadSnapshot(runInfo, entries) {
      run = { ...runInfo };
      timelines.set(run.runId, entries.map(e => ({
        listeningId: e.listeningId, runId: e.runId, segmentId: e.segmentId, sequence: e.sequence,
        source: e.source, target: e.target ?? null, translationState: e.translationState ?? 'pending',
        finalReceivedAt: e.finalReceivedAt ?? now(), readyReceivedAt: e.readyReceivedAt ?? null,
        sourceEndMs: e.sourceEndMs ?? null, everFocused: false, bypassed: false
      })).sort((a, b) => a.sequence - b.sequence));
      mode = 'FOLLOW'; focusSequence = null; focusStartedAt = null; reorderStartedAt = null;
      cancelWake(); onChange();
    },
    onFinal(entry, generation) {
      if (!timelines.has(entry.runId)) return { ignored: true }; // 未跟踪的 run：不属于本视图
      const list = rows(entry.runId);
      const existing = findItem(entry.listeningId, entry.runId, entry.segmentId);
      if (existing) {
        if (existing.source !== entry.source) {
          conflicts.push({ at: now(), listeningId: entry.listeningId, runId: entry.runId, segmentId: entry.segmentId });
          onChange();
          return { conflict: true, item: existing };
        }
        return { duplicate: true, item: existing };
      }
      const item = { listeningId: entry.listeningId, runId: entry.runId, segmentId: entry.segmentId, sequence: entry.sequence,
        source: entry.source, target: null, translationState: 'pending', finalReceivedAt: now(), readyReceivedAt: null,
        sourceEndMs: entry.sourceEndMs ?? null, everFocused: false, bypassed: false };
      insertSorted(list, item);
      trim(list);
      if (draft && draft.sentenceId != null && draft.sentenceId === entry.segmentId) draft = null;
      if (isCurrentRun(entry.runId) && generation === run.generation) scheduleTick();
      else onChange();
      return { item };
    },
    onTranslation(entry, generation) {
      const item = findItem(entry.listeningId, entry.runId, entry.segmentId);
      if (!item) return { ignored: true };
      if (item.translationState === 'complete') return { item, unchanged: true }; // complete 不可回退
      if (entry.translationState === 'failed') item.translationState = 'failed';
      else if (entry.translationState === 'complete') {
        item.translationState = 'complete';
        item.target = entry.target;
        item.readyReceivedAt = now();
      } else item.translationState = entry.translationState || 'pending';
      // 补全当前焦点的空译文：一次性填入并重启焦点停留计时，不改变 focusSequence
      if (isCurrentRun(entry.runId) && focusItem() === item && item.translationState === 'complete') focusStartedAt = now();
      if (isCurrentRun(entry.runId) && generation === run.generation && mode === 'FOLLOW') scheduleTick();
      else onChange(); // 旧 run 或 REVIEW：仅原位补齐，不抢焦点
      return { item };
    },
    onDraft(draftInfo) { // { sentenceId, text }
      draft = { ...draftInfo, updatedAt: now() };
      onChange();
    },
    clearDraft() { draft = null; onChange(); },
    enterReview() {
      if (mode === 'REVIEW') return;
      mode = 'REVIEW';
      cancelWake(); onChange();
    },
    backToLatest() {
      const list = currentRows();
      const updatedCount = list.filter(it => focusSequence == null || it.sequence > focusSequence).length;
      mode = 'FOLLOW';
      const ready = list.filter(it => it.translationState === 'complete');
      if (ready.length) setFocus(ready[ready.length - 1], now(), { markBypass: false });
      else if (list.length) setFocus(list[list.length - 1], now(), { markBypass: false }); // 定位最新 final 原文，明确“等待译文”
      else { focusSequence = null; focusStartedAt = null; onChange(); }
      scheduleTick();
      return { updatedCount };
    },
    setHidden(value) {
      hidden = !!value;
      if (hidden) cancelWake();
      else scheduleTick(); // 后台恢复不闪播：tick 会按追赶规则一次到最新
    },
    getState() {
      const t = now();
      const list = currentRows();
      const focus = focusItem();
      const newer = list.filter(it => focusSequence == null || it.sequence > focusSequence).length;
      const bypassed = list.filter(it => it.bypassed).length;
      let hint = null;
      if (focus && focus.translationState !== 'complete') {
        const age = t - focus.finalReceivedAt;
        if (age >= params.slowTranslationMs) hint = 'slow-translation';
        else if (age >= params.pendingHintMs) hint = 'translating';
      } else if (!draft && !list.some(it => it.translationState === 'complete' && (focusSequence == null || it.sequence > focusSequence))) {
        hint = 'waiting-next';
      }
      return {
        mode, hidden,
        runId: run?.runId ?? null, generation: run?.generation ?? null,
        focus, focusStartedAt,
        recent: list.slice(-params.visibleRecentItems),
        draft, counts: { newer, bypassed, total: list.length,
          pending: list.filter(it => it.translationState === 'pending').length },
        hint
      };
    },
    dispose() { cancelWake(); }
  };
}
