// Diagnostics are an allowlisted, content-free boundary. Never expose raw model
// text, exception messages, inputs, identifiers, or credentials as a reason.
export const RELATION_REASON_LABELS = Object.freeze({
  FIELD_INVALID: '字段格式不正确', RELATION_INVALID: '关系结构不正确',
  ENDPOINT_INVALID: '关系两端不在候选节点中', ENDPOINT_LISTENING_MISMATCH: '节点不属于本次收听',
  PREDICATE_INVALID: '关系类型不受支持', QUALIFICATION_INVALID: '缺少或无效的肯否、时态或状态',
  SUPPORT_COUNT_INVALID: '证据数量不正确', SUPPORT_INVALID: '证据引用无效',
  QUOTE_NOT_EXACT_OR_AMBIGUOUS: '原文引用不精确或有歧义', SOURCE_REVISION_INVALID: '原文版本已改变',
  FOCUS_RELATION_REQUIRED: '缺少当前窗口的关系证据', IDENTITY_REFERENCE_UNANCHORED: '身份指代缺少原文锚点',
  CROSS_SENTENCE_REFERENCE_REQUIRED: '跨句身份指代缺少证据', COREFERENCE_REFERENCE_ORDER: '身份指代顺序不正确',
  COREFERENCE_AMBIGUOUS: '跨句指代有歧义', IDENTITY_AMBIGUOUS: '节点身份有歧义',
  CORRECTION_TARGET_INVALID: '更正对象无效', CORRECTION_TARGET_MISMATCH: '更正对象与关系不匹配',
  SEMANTIC_PREDICATE_UNSUPPORTED: '原文未支持该关系类型', SEMANTIC_DIRECTION_REVERSED: '关系方向与原文相反',
  SEMANTIC_NEGATION_DROPPED: '遗漏原文否定限定', SEMANTIC_NEGATION_UNSUPPORTED: '原文未支持否定关系',
  SEMANTIC_PLAN_DROPPED: '遗漏原文计划限定', SEMANTIC_PLAN_UNSUPPORTED: '原文未支持计划关系',
  SEMANTIC_UNCERTAINTY_DROPPED: '遗漏原文不确定限定', SEMANTIC_ATTRIBUTION_DROPPED: '遗漏原文转述来源',
  SEMANTIC_CONDITION_DROPPED: '遗漏原文条件限定', SEMANTIC_TIME_DROPPED: '遗漏原文时间限定',
  QUALIFIER_NOT_IN_SOURCE: '限定内容不在相关原文中', CORRECTION_NOT_EXPLICIT: '原文未明确更正旧说法',
  INVALID_ENDPOINT_OR_PREDICATE: '保存时节点或关系类型无效', MISSING_ENDPOINT: '保存时节点已不存在',
  INVALID_QUALIFIERS: '保存时限定字段无效', INVALID_TEXT: '保存时文本字段无效',
  INVALID_SUPPORTS: '保存时证据数量无效', INVALID_SUPPORT: '保存时证据或原文版本无效',
  MISSING_FOCUS_RELATION: '保存时缺少当前窗口证据', INVALID_CORRECTION: '保存时更正对象无效',
  RESPONSE_NOT_JSON: '模型返回内容不是有效 JSON', RESPONSE_TOO_LARGE: '模型返回内容过大',
  RELATION_COUNT_INVALID: '模型返回的关系数量或结构无效', RELATION_OUTPUT_LIMIT: '模型输出被截断',
  RELATION_REQUEST_TIMEOUT: '模型请求超时', RELATION_INVALID_RESPONSE: '模型返回内容校验失败',
  RELATION_STORAGE_FAILED: '关系结果保存失败', RELATION_EXECUTION_FAILED: '关系任务执行失败', RELATION_FAILED: '关系任务失败',
  RELATION_RESULT_COUNT_MISMATCH: '返回数量与校验数量不一致', RELATION_RESULT_LIMIT: '关系结果超过单次范围',
  HTTP_JSON_INVALID: '模型服务响应不是有效 JSON',
  REQUEST_TIMEOUT: '模型请求超时', REQUEST_FAILED: '模型请求失败',
  RELATION_CONTRACT_CHANGED: '任务使用旧版关系协议', RELATION_INPUT_INVALID: '关系输入无效',
  INPUT_BUDGET_EXCEEDED: '单个窗口输入超出范围', INPUT_FOCUS_MISSING: '缺少当前窗口原文',
  REQUEST_INTERRUPTED: '请求被中断', REQUEST_BUDGET_EXHAUSTED: '该窗口已达到重试次数上限',
  WINDOW_REQUEST_LIMIT: '该窗口已达到重试次数上限', RELATION_REQUEST_FAILED: '模型请求失败',
  HTTP_400: '模型服务请求参数无效', HTTP_404: '模型服务地址或模型不存在',
  HTTP_408: '模型服务请求超时', HTTP_422: '模型服务无法处理请求参数',
  HTTP_401: '模型服务认证失败', HTTP_403: '模型服务拒绝访问', HTTP_429: '模型服务限流',
  HTTP_500: '模型服务暂时失败', HTTP_502: '模型服务暂时失败', HTTP_503: '模型服务暂时失败',
  UNKNOWN_REASON: '未识别的拒绝原因（原始内容未展示）'
});
export function safeRelationReason(code) {
  return typeof code === 'string' && Object.hasOwn(RELATION_REASON_LABELS, code) ? code : 'UNKNOWN_REASON';
}
export function relationReasonSummary(rows) {
  const counts = new Map();
  for (const row of rows) {
    const code = safeRelationReason(row?.code);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => ({ code, count, label: RELATION_REASON_LABELS[code] }));
}

// Works on v8 too: missing result-count columns remain undefined/unknown.
export function readRelationDiagnostics(db, listeningId) {
  // Latest result per window, rather than cumulative attempts across retries.
  const jobs = db.prepare(`SELECT * FROM (SELECT j.*,ROW_NUMBER() OVER
    (PARTITION BY window_id ORDER BY epoch DESC,window_revision DESC,created_at DESC,id DESC) AS rank
    FROM relation_jobs j WHERE listening_id=?) WHERE rank=1`).all(listeningId);
  const results = jobs.filter(j => ['complete', 'partial'].includes(j.state));
  const known = results.filter(j => j.returned_count != null && j.accepted_count != null);
  const unknownJobs = jobs.length - known.length;
  const sum = column => known.reduce((total, job) => total + (job[column] || 0), 0);
  const rejects = results.flatMap(j => { try { return JSON.parse(j.rejected_json); } catch { return [{ code: 'UNKNOWN_REASON' }]; } });
  const failures = jobs.filter(j => j.state === 'failed').map(j => ({ code: j.last_error }));
  const stored = db.prepare('SELECT COUNT(*) AS n FROM relations WHERE listening_id=?').get(listeningId).n;
  const visible = db.prepare(`SELECT COUNT(DISTINCT r.id) AS n FROM relations r JOIN relation_assertions a ON a.relation_id=r.id
    JOIN knowledge_items s ON s.id=r.subject_item_id AND s.listening_id=r.listening_id
    JOIN knowledge_items o ON o.id=r.object_item_id AND o.listening_id=r.listening_id
    WHERE r.listening_id=? AND a.status IN ('active','needs_review')`).get(listeningId).n;
  return { scope: 'latest_result_per_window', resultJobs: results.length, measuredJobs: known.length, unknownJobs,
    returnedCount: unknownJobs ? null : sum('returned_count'),
    validatorAcceptedCount: unknownJobs ? null : sum('validator_accepted_count'),
    acceptedCount: unknownJobs ? null : sum('accepted_count'), rejectedCount: rejects.length,
    insertedRelationCount: unknownJobs ? null : sum('inserted_relation_count'),
    deduplicatedCount: unknownJobs ? null : sum('deduplicated_count'),
    storedRelationCount: stored, visibleRelationCount: visible,
    coverageLimitedWindows: results.filter(j => { try { return JSON.parse(j.input_json).coverage_limited; } catch { return false; } }).length,
    rejectionReasons: relationReasonSummary(rejects), failureReasons: relationReasonSummary(failures) };
}
