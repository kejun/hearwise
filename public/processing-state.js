export function processingView(detail) {
  const p = detail.processing || {};
  const k = p.knowledge || {};
  const jobs = detail.jobs || [];
  const segments = detail.segments || [];
  const failedTranslations = p.failedTranslations ?? segments.filter(s => s.translation_state === 'failed').length;
  const pendingTranslations = p.pendingTranslations ?? segments.filter(s => s.translation_state === 'pending').length;
  const failedKnowledge = k.failedJobs ?? jobs.filter(j => j.state === 'failed' && j.outcome !== 'legacy').length;
  const partial = k.partialJobs ?? jobs.filter(j => j.state === 'complete' && j.outcome === 'partial').length;
  const legacy = k.legacyRecoveryJobs ?? jobs.filter(j => j.state === 'failed' && j.outcome === 'legacy').length;
  const retrying = k.retryingJobs ?? jobs.filter(j => j.state === 'pending' && j.retry_at != null).length;
  const knowledgePending = (k.bufferedSegments || 0) + retrying +
    (k.pendingJobs ?? jobs.filter(j => j.state === 'pending' && j.retry_at == null).length) +
    (k.runningJobs ?? jobs.filter(j => j.state === 'running').length);
  // 补全是既有排队/执行任务的阶段，不再计为另一份待处理工作。
  const repairing = (k.repairPendingJobs || 0) + (k.repairingJobs || 0);
  const pending = pendingTranslations + knowledgePending;
  const labels = [];
  if (failedTranslations) labels.push(`${failedTranslations} 项译文处理失败`);
  if (failedKnowledge) labels.push('知识整理失败');
  if (partial) labels.push('部分知识未能整理');
  if (legacy) labels.push('历史任务需重新核对');
  if (pending && !detail.processingAvailable) labels.push('内容待继续处理（需 API Key）');
  else {
    if (pendingTranslations) labels.push('译文处理中');
    if (knowledgePending && repairing) labels.push('知识整理中，正在补全部分条目');
    else if (knowledgePending > retrying) labels.push('知识整理中');
    if (retrying) labels.push('知识稍后自动重试');
  }
  return { text: labels.join(' · ') || '已处理', pending,
    canRetry: Boolean(failedTranslations || failedKnowledge || partial || (pending && !detail.processingAvailable)) };
}

// 一次只读一个快照；网络短暂失败后继续补齐，旧记录的迟到响应不得重新启动轮询。
export function createProcessingPoller({ read, isCurrent,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = timer => clearTimeout(timer) }) {
  let generation = 0, timer;
  function stop() { generation++; clearTimer(timer); timer = null; }
  function start(id) {
    stop();
    const gen = generation;
    let failures = 0;
    const current = () => gen === generation && isCurrent(id);
    async function poll() {
      if (!current()) return;
      let delay = 2000;
      try {
        const detail = await read(id);
        if (!current()) return;
        failures = 0;
        if (!detail || !detail.processingAvailable || !processingView(detail).pending) return;
      } catch (error) {
        if (error.status === 404) return;
        delay = Math.min(15000, 2000 * 2 ** Math.min(++failures, 3));
      }
      if (current()) timer = setTimer(poll, delay);
    }
    void poll();
  }
  return { start, stop };
}
