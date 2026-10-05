class KnowledgeEditorError extends Error {
  constructor(message, outcomeUnknown = false) { super(message); this.outcomeUnknown = outcomeUnknown; }
}

// Proxy error pages, empty responses and an outdated server are not word-matching failures.
// Never display response bodies: they may contain HTML, transcript text or credentials.
export async function readKnowledgeEditorResponse(response, method = 'GET') {
  const phase = method === 'GET' ? '读取知识条目' : method === 'JOB' ? '查询保存结果' : method === 'DELETE' ? '删除知识条目' : '保存知识修改';
  const status = `HTTP ${response.status}`;
  let result;
  try { result = JSON.parse(await response.text()); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const hint = [404, 405].includes(response.status) ? '请确认 Hearwise 服务已更新并重启，再刷新页面。' :
      [502, 503, 504].includes(response.status) ? '服务或代理暂时无法正常响应。' : '服务返回了无效或空响应。';
    throw new KnowledgeEditorError(`${phase}失败（${status}）：${hint}`, method !== 'GET');
  }
  if (!response.ok) {
    const message = typeof result?.error === 'string' && result.error.trim() ? result.error : '服务未能完成请求';
    const confirmedUnchanged = result?.code === 'KNOWLEDGE_EDIT_FAILED' && result.saved === false;
    throw new KnowledgeEditorError(`${phase}失败（${status}）：${message}`, method !== 'GET' && response.status >= 500 && !confirmedUnchanged);
  }
  const valid = result && typeof result === 'object' && !Array.isArray(result) &&
    (method === 'JOB' || method === 'PATCH' && response.status === 202 ? validJob(result.job) :
      method === 'GET' ? typeof result.revision === 'string' && result.revision.length > 0 &&
      typeof result.item?.id === 'string' && typeof result.item?.canonical_name === 'string' && Array.isArray(result.segments) :
      method === 'DELETE' ? result.ok === true : typeof result.item?.id === 'string' && typeof result.item?.canonical_name === 'string');
  if (!valid) throw new KnowledgeEditorError(`${phase}失败（${status}）：服务返回的内容不完整，请更新并重启 Hearwise 服务后刷新页面。`, method !== 'GET');
  return result;
}

function validJob(job) {
  return job && typeof job.id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(job.id) &&
    typeof job.name === 'string' && typeof job.source === 'string' &&
    (job.state === 'running' && job.saved === null || job.state === 'succeeded' && job.saved === true ||
      job.state === 'failed' && job.saved === false && typeof job.error === 'string' && job.error.length > 0);
}

function newEditId() {
  // getRandomValues also works when viewing history over a local HTTP address.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requestFailure(error, saving = false) {
  if (error instanceof KnowledgeEditorError) return error.message;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return saving ? '等待保存结果超时。' : '读取知识条目超时，请稍后重新打开。';
  return saving ? '保存请求或响应异常。' : '无法读取知识条目，请检查连接后重新打开。';
}

export function createKnowledgeEditor({ getId, getKey, onSaved, onRequireKey }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'knowledge-editor'; dialog.id = 'knowledge-editor';
  dialog.setAttribute('aria-labelledby', 'knowledge-editor-title');
  dialog.innerHTML = `<form>
    <h2 id="knowledge-editor-title">修改知识条目</h2>
    <p class="form-note">纠正本条目引用的原文，并重新生成卡片。本次收听及以后继续收听时，会沿用纠正后的写法。</p>
    <label for="knowledge-edit-source">原文中的错误词</label>
    <input id="knowledge-edit-source" required maxlength="160" autocomplete="off">
    <label for="knowledge-edit-name">正确名称</label>
    <input id="knowledge-edit-name" required maxlength="160" autocomplete="off">
    <p class="form-note">重新生成会将相关原文发送给千问。已有译文保持原样；改动原文后，相关图谱关系需要重新核对。</p>
    <p id="knowledge-edit-status" role="status" aria-live="polite"></p>
    <div class="knowledge-edit-actions">
      <button type="submit" class="save-button" id="knowledge-edit-save">保存并重新生成</button>
      <button type="button" id="knowledge-edit-cancel">取消</button>
      <button type="button" id="knowledge-edit-delete">删除条目</button>
    </div>
    <section id="knowledge-delete-confirm" hidden>
      <p>删除后，卡片及其关系会移除，原文保留。本条目不会在这条收听中自动重新创建。</p>
      <button type="button" id="knowledge-delete-submit">确认删除条目</button>
      <button type="button" id="knowledge-delete-cancel">保留条目</button>
    </section>
  </form>`;
  document.body.append(dialog);
  const $ = id => dialog.querySelector(`#${id}`);
  let selected = null, busy = false, generation = 0, outcomeUnknown = false, polling = false;
  const status = $('knowledge-edit-status');
  function setBusy(value) {
    busy = value;
    for (const control of dialog.querySelectorAll('input,button')) control.disabled = value;
    if (polling) $('knowledge-edit-cancel').disabled = false;
    $('knowledge-edit-cancel').textContent = polling ? '关闭窗口' : '取消';
    if (!value) for (const id of ['knowledge-edit-save', 'knowledge-edit-delete', 'knowledge-delete-submit'])
      $(id).disabled = !selected || outcomeUnknown;
    dialog.setAttribute('aria-busy', String(value));
  }
  function close() { if (!busy || polling) { generation++; selected = null; polling = false; setBusy(false); dialog.close(); } }
  dialog.addEventListener('cancel', event => { if (busy && !polling) event.preventDefault(); else close(); });
  $('knowledge-edit-cancel').onclick = close;
  $('knowledge-edit-delete').onclick = () => { $('knowledge-delete-confirm').hidden = false; $('knowledge-delete-cancel').focus(); };
  $('knowledge-delete-cancel').onclick = () => { $('knowledge-delete-confirm').hidden = true; $('knowledge-edit-delete').focus(); };
  async function waitForJob(current, jobId, initial, gen) {
    polling = true; setBusy(true);
    status.textContent = '正在后台重新生成，成功后将同步保存。可关闭窗口，重新打开查看。';
    const deadline = Date.now() + 120000;
    let job = initial, failures = 0;
    while (gen === generation && current.listeningId === getId()) {
      if (job) {
        if (!validJob(job) || job.id !== jobId) throw new KnowledgeEditorError('保存任务响应不匹配。', true);
        if (job.state === 'succeeded') return true;
        if (job.state === 'failed') throw new KnowledgeEditorError(job.error, false);
      }
      if (Date.now() >= deadline) throw new KnowledgeEditorError('暂时无法确认后台保存结果，请重新打开条目核对。', true);
      if (job) await new Promise(resolve => setTimeout(resolve, 1000));
      if (gen !== generation || current.listeningId !== getId()) return false;
      try {
        const response = await fetch(`${current.url}/edits/${jobId}`, { signal: AbortSignal.timeout(5000) });
        if (response.status === 404) throw new KnowledgeEditorError('保存任务未找到，请重新打开条目核对。', true);
        job = (await readKnowledgeEditorResponse(response, 'JOB')).job;
        failures = 0;
      } catch (error) {
        if (++failures >= 3) throw new KnowledgeEditorError('查询保存结果失败，请重新打开条目核对。', true);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    return false;
  }
  async function save(method) {
    if (busy || !selected || outcomeUnknown) return;
    if (selected.listeningId !== getId()) { close(); return; }
    const key = getKey();
    if (method === 'PATCH' && !key) { close(); onRequireKey(); return; }
    const current = selected, gen = generation;
    setBusy(true); status.textContent = method === 'PATCH' ? '正在重新生成，成功后将同步保存…' : '正在删除…';
    try {
      const body = method === 'PATCH' ? { name: $('knowledge-edit-name').value, source: $('knowledge-edit-source').value, key, revision: current.revision } : { revision: current.revision };
      const jobId = method === 'PATCH' ? newEditId() : null;
      let result;
      try {
        const response = await fetch(current.url, { method, headers: { 'Content-Type': 'application/json',
          ...(jobId ? { Prefer: 'respond-async', 'Idempotency-Key': jobId } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
        result = await readKnowledgeEditorResponse(response, method);
      } catch (error) {
        // A lost acceptance response must trigger a read, never another paid write.
        if (!jobId || error instanceof KnowledgeEditorError && !error.outcomeUnknown) throw error;
        try {
          const response = await fetch(`${current.url}/edits/${jobId}`, { signal: AbortSignal.timeout(5000) });
          result = await readKnowledgeEditorResponse(response, 'JOB');
        } catch { throw error; }
      }
      if (result.job && !await waitForJob(current, jobId, result.job, gen)) return;
      if (gen !== generation) return;
      polling = false;
      setBusy(false); close();
      await onSaved(current.listeningId);
    } catch (error) {
      if (gen !== generation) return;
      outcomeUnknown = !(error instanceof KnowledgeEditorError) || error.outcomeUnknown;
      status.textContent = requestFailure(error, true) + (outcomeUnknown ? ' 输入已保留；保存结果尚未确认，请关闭后重新打开核对，避免重复提交。' : ' 输入已保留。');
    } finally { if (gen === generation) { polling = false; setBusy(false); } }
  }
  dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); void save('PATCH'); });
  $('knowledge-delete-submit').onclick = () => { void save('DELETE'); };
  return {
    close,
    async open(item) {
      if (busy) return;
      const gen = ++generation, listeningId = getId();
      const url = `/api/listenings/${listeningId}/knowledge/${item.id}`;
      selected = null; outcomeUnknown = false; $('knowledge-delete-confirm').hidden = true;
      $('knowledge-edit-name').value = item.canonical_name; $('knowledge-edit-source').value = item.canonical_name;
      status.textContent = '正在读取最新内容…'; dialog.showModal(); setBusy(true);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const result = await readKnowledgeEditorResponse(response);
        if (gen !== generation || listeningId !== getId()) return;
        selected = { listeningId, url, revision: result.revision };
        if (result.editJob) {
          if (!validJob(result.editJob)) throw new KnowledgeEditorError('保存任务信息不完整，请稍后重新打开。', true);
          $('knowledge-edit-name').value = result.editJob.name; $('knowledge-edit-source').value = result.editJob.source;
          if (await waitForJob(selected, result.editJob.id, result.editJob, gen)) {
            if (gen !== generation) return;
            polling = false; setBusy(false); close(); await onSaved(listeningId);
          }
          return;
        }
        $('knowledge-edit-name').value = result.item.canonical_name; $('knowledge-edit-source').value = result.item.canonical_name;
        status.textContent = `关联 ${result.segments.length} 段原文；只替换其中完整匹配的错误词。`;
        setBusy(false); $('knowledge-edit-name').focus(); $('knowledge-edit-name').select();
      } catch (error) {
        if (gen !== generation) return;
        outcomeUnknown = Boolean(error.outcomeUnknown);
        status.textContent = requestFailure(error);
      } finally {
        if (gen === generation) {
          polling = false; setBusy(false);
          if (!selected) { $('knowledge-edit-save').disabled = true; $('knowledge-edit-delete').disabled = true; }
        }
      }
    }
  };
}
