import { knowledgeName } from './knowledge-name.js';

class KnowledgeEditorError extends Error {
  constructor(message, outcomeUnknown = false) { super(message); this.outcomeUnknown = outcomeUnknown; }
}

// Proxy error pages, empty responses and an outdated server are not word-matching failures.
// Never display response bodies: they may contain HTML, transcript text or credentials.
export async function readKnowledgeEditorResponse(response, method = 'GET') {
  const phase = method === 'REPLACE' ? '保存名称纠正' : method === 'SUGGESTION' ? '获取名称建议' : method.startsWith('NAME') ? '校正知识名称' : method === 'GET' ? '读取知识条目' : method === 'JOB' ? '查询保存结果' : method === 'DELETE' ? '删除知识条目' : '保存知识修改';
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
    const stale = response.status === 409 && result?.code === 'KNOWLEDGE_EDIT_STALE' && result.saved === false &&
      typeof result.revision === 'string' && /^[a-f0-9]{64}$/.test(result.revision);
    const confirmedUnchanged = (result?.code === 'KNOWLEDGE_EDIT_FAILED' || stale) && result.saved === false;
    throw Object.assign(new KnowledgeEditorError(`${phase}失败（${status}）：${message}`,
      method !== 'GET' && response.status >= 500 && !confirmedUnchanged),
    stale ? { code: result.code, revision: result.revision } : {});
  }
  const valid = result && typeof result === 'object' && !Array.isArray(result) &&
    (method === 'SUGGESTION' ? typeof result.suggestion?.name === 'string' && result.suggestion.name.trim().length > 0 &&
      result.suggestion.name.length <= 160 && !/[\u0000-\u001f\u007f]/.test(result.suggestion.name) &&
      typeof result.suggestion.reason === 'string' && result.suggestion.reason.trim().length > 0 && result.suggestion.reason.length <= 500 &&
      typeof result.revision === 'string' && /^[a-f0-9]{64}$/.test(result.revision) :
      method.startsWith('NAME') ? (method === 'NAME_LOOKUP' && result.job === null || validNameJob(result.job)) :
      method === 'REPLACE' || method === 'JOB' || method === 'PATCH' && response.status === 202 ? validJob(result.job) :
      method === 'GET' ? typeof result.revision === 'string' && result.revision.length > 0 &&
      typeof result.item?.id === 'string' && typeof result.item?.canonical_name === 'string' && Array.isArray(result.segments) :
      method === 'DELETE' ? result.ok === true : typeof result.item?.id === 'string' && typeof result.item?.canonical_name === 'string');
  if (!valid) throw new KnowledgeEditorError(`${phase}失败（${status}）：服务返回的内容不完整，请更新并重启 Hearwise 服务后刷新页面。`, method !== 'GET');
  return result;
}

function validJob(job) {
  return job && job.operation !== 'name_correction' && typeof job.id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(job.id) &&
    typeof job.name === 'string' && typeof job.source === 'string' &&
    (job.state === 'running' && job.saved === null || job.state === 'succeeded' && job.saved === true ||
      job.state === 'failed' && job.saved === false && typeof job.error === 'string' && job.error.length > 0);
}

export function validNameJob(job) {
  return job && job.operation === 'name_correction' && typeof job.id === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(job.id) && typeof job.revision === 'string' &&
    (job.state === 'running' && job.saved === null ||
      job.state === 'failed' && job.saved === false && typeof job.error === 'string' && job.error.length > 0 ||
      job.state === 'succeeded' && typeof job.saved === 'boolean' && typeof job.changed === 'boolean' &&
      job.saved === job.changed && job.result?.changed === job.changed && ['corrected', 'unchanged', 'insufficient_evidence'].includes(job.result.outcome) &&
      typeof job.result.name === 'string' && typeof job.result.previous_name === 'string' && typeof job.result.reason === 'string');
}

export function newEditId() {
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

export function createKnowledgeEditor({ getId, getKey, onSaved }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'knowledge-editor'; dialog.id = 'knowledge-editor';
  dialog.setAttribute('aria-labelledby', 'knowledge-editor-title');
  dialog.innerHTML = `<form>
    <div class="knowledge-editor-header">
      <h2 id="knowledge-editor-title">纠正名称</h2>
      <button type="button" id="knowledge-edit-close" aria-label="关闭知识条目编辑" title="关闭">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </div>
    <p class="form-note">填写正确名称并保存，同步替换关联原文和引用中的对应词。不需要 API Key。</p>
    <label for="knowledge-edit-source">当前写法</label>
    <input id="knowledge-edit-source" readonly autocomplete="off">
    <label for="knowledge-edit-name">正确名称</label>
    <input id="knowledge-edit-name" required maxlength="160" autocomplete="off">
    <details id="knowledge-edit-current" hidden><summary>核对最新条目与原文</summary>
      <p id="knowledge-edit-current-name"></p><div id="knowledge-edit-current-source"></div></details>
    <button type="button" id="knowledge-edit-suggest">获取校对建议</button>
    <p class="form-note">自动建议需要 API Key，会发送关联原文和已有译文供核对。建议可修改，点击保存后才生效；已有译文保持原样。</p>
    <p id="knowledge-edit-status" role="status" aria-live="polite"></p>
    <div class="knowledge-edit-actions">
      <button type="submit" class="save-button" id="knowledge-edit-save">保存纠正</button>
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
  function showCurrent(snapshot) {
    $('knowledge-edit-current').hidden = false; $('knowledge-edit-current').open = true;
    $('knowledge-edit-current-name').textContent = `最新名称：${knowledgeName(snapshot.item)}`;
    const container = $('knowledge-edit-current-source'); container.replaceChildren();
    for (const segment of snapshot.segments) {
      const paragraph = document.createElement('p');
      paragraph.textContent = segment.original_text + (segment.translation_text ? `\n译文：${segment.translation_text}` : '');
      container.append(paragraph);
    }
  }
  async function refreshStale(current, gen) {
    const snapshot = await readKnowledgeEditorResponse(await fetch(current.url, { signal: AbortSignal.timeout(10000) }));
    if (gen !== generation || current.listeningId !== getId()) return;
    current.revision = snapshot.revision;
    $('knowledge-edit-source').value = snapshot.item.canonical_name;
    $('knowledge-delete-confirm').hidden = true;
    showCurrent(snapshot);
    outcomeUnknown = snapshot.editJob?.state === 'running' || snapshot.nameCorrectionJob?.state === 'running';
    status.textContent = outcomeUnknown ? '另一个保存任务正在处理，输入已保留；请重新打开查询结果。' :
      '条目或原文已改变，本次未保存或删除。已读取最新内容，输入已保留；请核对后再次点击保存，或重新确认删除。';
  }
  function setBusy(value) {
    busy = value;
    for (const control of dialog.querySelectorAll('input,button')) control.disabled = value;
    if (polling) $('knowledge-edit-close').disabled = false;
    if (!value) for (const id of ['knowledge-edit-save', 'knowledge-edit-delete', 'knowledge-delete-submit', 'knowledge-edit-suggest'])
      $(id).disabled = !selected || outcomeUnknown;
    dialog.setAttribute('aria-busy', String(value));
  }
  function close() { if (!busy || polling) { generation++; selected = null; polling = false; setBusy(false); dialog.close(); } }
  dialog.addEventListener('cancel', event => { if (busy && !polling) event.preventDefault(); else close(); });
  $('knowledge-edit-close').onclick = close;
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
    const current = selected, gen = generation;
    setBusy(true); status.textContent = method === 'POST' ? '正在保存名称纠正…' : '正在删除…';
    try {
      const body = method === 'POST' ? { name: $('knowledge-edit-name').value, revision: current.revision } : { revision: current.revision };
      const jobId = method === 'POST' ? newEditId() : null;
      let result;
      try {
        const response = await fetch(current.url + (jobId ? '/name-replacements' : ''), { method, headers: { 'Content-Type': 'application/json',
          ...(jobId ? { 'Idempotency-Key': jobId } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
        result = await readKnowledgeEditorResponse(response, jobId ? 'REPLACE' : method);
      } catch (error) {
        // A lost save response triggers a receipt read, never a second write.
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
      if (error.code === 'KNOWLEDGE_EDIT_STALE') {
        try { await refreshStale(current, gen); }
        catch {
          if (gen !== generation) return;
          outcomeUnknown = true;
          status.textContent = '条目已改变，本次未保存或删除。输入已保留，但读取最新内容失败；请关闭后重新打开核对。';
        }
        return;
      }
      outcomeUnknown = !(error instanceof KnowledgeEditorError) || error.outcomeUnknown;
      status.textContent = requestFailure(error, true) + (outcomeUnknown ? ' 输入已保留；保存结果尚未确认，请关闭后重新打开核对，避免重复提交。' : ' 输入已保留。');
    } finally { if (gen === generation) { polling = false; setBusy(false); } }
  }
  $('knowledge-edit-suggest').onclick = async () => {
    if (busy || !selected || outcomeUnknown) return;
    const key = getKey();
    if (!key) { status.textContent = '自动建议需要在连接设置填写 API Key；也可直接填写正确名称并保存。'; return; }
    const current = selected, gen = generation;
    setBusy(true); status.textContent = '正在获取校对建议…';
    try {
      const result = await readKnowledgeEditorResponse(await fetch(`${current.url}/name-suggestions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, revision: current.revision }),
        signal: AbortSignal.timeout(40000)
      }), 'SUGGESTION');
      if (gen !== generation || current.listeningId !== getId()) return;
      if (result.revision !== current.revision) throw new KnowledgeEditorError('名称建议的版本不匹配，请重新打开核对。');
      $('knowledge-edit-name').value = result.suggestion.name;
      status.textContent = `建议：${result.suggestion.reason} 尚未保存，请核对名称后点击「保存纠正」。`;
    } catch (error) {
      if (gen !== generation) return;
      if (error.code === 'KNOWLEDGE_EDIT_STALE') {
        try { await refreshStale(current, gen); }
        catch { status.textContent = '条目已改变，读取最新内容失败；输入已保留，请重新打开核对。'; outcomeUnknown = true; }
      } else status.textContent = '获取建议失败，原内容未更改；输入已保留，可直接修改名称并保存。';
    } finally { if (gen === generation) setBusy(false); }
  };
  dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); void save('POST'); });
  $('knowledge-delete-submit').onclick = () => { void save('DELETE'); };
  return {
    close,
    async open(item) {
      if (busy) return;
      const gen = ++generation, listeningId = getId();
      const url = `/api/listenings/${listeningId}/knowledge/${item.id}`;
      selected = null; outcomeUnknown = false; $('knowledge-delete-confirm').hidden = true; $('knowledge-edit-current').hidden = true;
      $('knowledge-edit-name').value = knowledgeName(item); $('knowledge-edit-source').value = item.canonical_name;
      status.textContent = '正在读取最新内容…'; dialog.showModal(); setBusy(true);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const result = await readKnowledgeEditorResponse(response);
        if (gen !== generation || listeningId !== getId()) return;
        selected = { listeningId, url, revision: result.revision };
        if (result.nameCorrectionJob?.state === 'running') {
          outcomeUnknown = true;
          status.textContent = '旧版名称校对任务正在处理；可关闭后重新打开查询结果，当前输入未保存。';
          return;
        }
        if (result.editJob) {
          if (!validJob(result.editJob)) throw new KnowledgeEditorError('保存任务信息不完整，请稍后重新打开。', true);
          if (result.editJob.state === 'failed' && result.editJob.staleRevision) {
            $('knowledge-edit-name').value = knowledgeName(result.item); $('knowledge-edit-source').value = result.item.canonical_name;
            showCurrent(result);
            status.textContent = `上次保存未完成：${result.editJob.error} 此后条目或原文已改变，已显示最新内容；旧任务未重试。`;
            return;
          }
          $('knowledge-edit-name').value = result.editJob.name; $('knowledge-edit-source').value = result.item.canonical_name;
          if (await waitForJob(selected, result.editJob.id, result.editJob, gen)) {
            if (gen !== generation) return;
            polling = false; setBusy(false); close(); await onSaved(listeningId);
          }
          return;
        }
        $('knowledge-edit-name').value = knowledgeName(result.item); $('knowledge-edit-source').value = result.item.canonical_name;
        status.textContent = `关联 ${result.segments.length} 段原文；只替换其中完整匹配的错误词。`;
        if (result.nameCorrectionJob?.state === 'failed') status.textContent += ` 上次名称校对未完成：${result.nameCorrectionJob.error} 可直接填写正确名称并保存。`;
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
