import { newEditId, readKnowledgeEditorResponse, validNameJob } from './knowledge-editor.js';
import { knowledgeName } from './knowledge-name.js';

export function createNameCorrector({ getId, getKey, onSaved, onRequireKey }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'knowledge-name-correction'; dialog.className = 'knowledge-editor knowledge-name-correction';
  dialog.setAttribute('aria-labelledby', 'knowledge-name-title');
  dialog.innerHTML = `<div class="knowledge-editor-header"><h2 id="knowledge-name-title">校正知识名称</h2>
    <button type="button" id="knowledge-name-close" aria-label="关闭名称校正">关闭</button></div>
    <p class="form-note">根据关联原文和已有译文核对名称，原文、知识内容和关系保持不变。</p>
    <p id="knowledge-name-status" role="status" aria-live="polite"></p>
    <button type="button" id="knowledge-name-retry" hidden>重试校正</button>`;
  document.body.append(dialog);
  const status = dialog.querySelector('#knowledge-name-status'), retry = dialog.querySelector('#knowledge-name-retry');
  let selected = null, generation = 0, busy = false;
  function close() { generation++; selected = null; busy = false; dialog.close(); }
  dialog.querySelector('#knowledge-name-close').onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  const current = (selection, gen) => gen === generation && selection.listeningId === getId();
  function showFailure(error, selection, gen) {
    if (!current(selection, gen)) return;
    busy = false; dialog.setAttribute('aria-busy', 'false');
    status.textContent = (error?.message || '暂时无法校正名称。') + (error.outcomeUnknown
      ? ' 结果尚未确认，请关闭后重新打开查询；不会自动重复请求。' : ' 原名称已保留。');
    retry.hidden = Boolean(error.outcomeUnknown); retry.disabled = false;
  }
  async function finish(job, selection, gen) {
    if (!current(selection, gen)) return;
    busy = false; dialog.setAttribute('aria-busy', 'false'); retry.hidden = true;
    const result = job.result;
    status.textContent = result.changed ? `名称已校正：${result.previous_name} → ${result.name}。` :
      result.outcome === 'insufficient_evidence' ? `依据不足，保留“${result.name}”。${result.reason}` :
        `保留“${result.name}”。${result.reason}`;
    try { await onSaved(selection.listeningId); }
    catch { if (current(selection, gen)) status.textContent += ' 检查已完成，但刷新失败，请重新打开这条收听。'; }
  }
  async function poll(job, selection, gen) {
    if (!validNameJob(job)) throw Object.assign(new Error('校正任务响应不完整'), { outcomeUnknown: true });
    const acceptedId = job.id, deadline = Date.now() + 120000;
    while (current(selection, gen)) {
      if (!validNameJob(job) || job.id !== acceptedId) throw Object.assign(new Error('校正任务响应不匹配'), { outcomeUnknown: true });
      if (job.state === 'succeeded') { await finish(job, selection, gen); return; }
      if (job.state === 'failed') throw Object.assign(new Error(job.error + (job.staleRevision
        ? ' 此后条目或原文已改变，重试前将重新核对最新内容。' : '')), { outcomeUnknown: false });
      if (Date.now() >= deadline) throw Object.assign(new Error('暂时无法确认校正结果'), { outcomeUnknown: true });
      status.textContent = '正在校正名称，可关闭窗口后重新打开查看。';
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!current(selection, gen)) return;
      try {
        job = (await readKnowledgeEditorResponse(await fetch(`${selection.url}/edits/${acceptedId}`,
          { signal: AbortSignal.timeout(5000) }), 'NAME_JOB')).job;
      } catch { throw Object.assign(new Error('查询校正结果失败'), { outcomeUnknown: true }); }
    }
  }
  async function recover(selection, jobId) {
    try {
      return (await readKnowledgeEditorResponse(await fetch(`${selection.url}/edits/${jobId}`,
        { signal: AbortSignal.timeout(5000) }), 'NAME_JOB')).job;
    } catch {
      const result = await readKnowledgeEditorResponse(await fetch(
        `${selection.url}/name-corrections?revision=${encodeURIComponent(selection.revision)}`,
        { signal: AbortSignal.timeout(5000) }), 'NAME_LOOKUP');
      if (!result.job) throw Object.assign(new Error('校正任务尚未找到'), { outcomeUnknown: true });
      return result.job;
    }
  }
  async function submit(selection, gen) {
    const jobId = newEditId();
    let job;
    try {
      const response = await fetch(`${selection.url}/name-corrections`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': jobId },
        body: JSON.stringify({ revision: selection.revision, key: getKey() || '' }), signal: AbortSignal.timeout(10000) });
      job = (await readKnowledgeEditorResponse(response, 'NAME')).job;
    } catch (error) {
      if (error.outcomeUnknown === false) {
        if (!getKey() && /API Key/.test(error.message)) { close(); onRequireKey(); return; }
        throw error;
      }
      // A lost acceptance response is reconciled only by reads, never a new POST.
      try { job = await recover(selection, jobId); }
      catch { throw Object.assign(new Error('提交响应丢失，暂时无法确认校正结果'), { outcomeUnknown: true }); }
    }
    await poll(job, selection, gen);
  }
  async function open(item, explicitRetry = false) {
    if (busy) return;
    const gen = ++generation, selection = { listeningId: getId(), item };
    selection.url = `/api/listenings/${selection.listeningId}/knowledge/${item.id}`;
    selected = selection; busy = true; retry.hidden = true;
    status.textContent = `正在核对“${knowledgeName(item)}”…`; dialog.setAttribute('aria-busy', 'true');
    if (!dialog.open) dialog.showModal();
    try {
      const snapshot = await readKnowledgeEditorResponse(await fetch(selection.url, { signal: AbortSignal.timeout(10000) }));
      if (!current(selection, gen)) return;
      selection.revision = snapshot.revision;
      if (snapshot.nameCorrectionJob && !(explicitRetry && snapshot.nameCorrectionJob.state === 'failed')) {
        await poll(snapshot.nameCorrectionJob, selection, gen); return;
      }
      await submit(selection, gen);
    } catch (error) {
      if (error.code === 'KNOWLEDGE_EDIT_STALE') {
        try {
          const latest = await readKnowledgeEditorResponse(await fetch(selection.url, { signal: AbortSignal.timeout(10000) }));
          if (!current(selection, gen)) return;
          selection.item = latest.item; selection.revision = latest.revision;
          showFailure(Object.assign(new Error(`条目或原文已改变，已读取最新名称“${knowledgeName(latest.item)}”；请确认后点击重试校正。`),
            { outcomeUnknown: false }), selection, gen);
        } catch { showFailure(Object.assign(new Error('条目已改变，本次未校正，但读取最新内容失败'), { outcomeUnknown: true }), selection, gen); }
      } else showFailure(error, selection, gen);
    }
    finally { if (current(selection, gen)) { busy = false; dialog.setAttribute('aria-busy', 'false'); } }
  }
  retry.onclick = () => { if (selected && !busy) void open(selected.item, true); };
  return { close, correct: item => open(item) };
}
