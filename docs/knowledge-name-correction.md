# 一键校正知识名称（KEJ-36）

本文记录 KEJ-36 的旧显示覆盖实现与兼容 API。当前界面已按 KEJ-37 合并为「纠正名称」；手动保存直接替换实际名称与关联原文，自动校对只提供建议。当前行为见 [统一名称纠正](knowledge-name-replacement.md)。

旧 API 的任务可继续查询；旧页面发起的校对不会因界面升级重复执行。刷新页面后使用统一入口。

## 改动范围

数据库 v12 在 `knowledge_items` 增加 `name_override` 和 `name_override_identity`。后者绑定原始 `canonical_name`、`type`、`display_label` 的摘要；公开读取增加 `display_name`，前端列表、图谱标签、关系端点、搜索和人工编辑的名称默认值使用此字段。

名称校正只写显示覆盖、内容版本、修改时间及审计记录。原始身份、别名、原文、译文、简介、事实、引用和关系保持原值。内容补充不取消覆盖；原始身份变化使覆盖自动失效。完整人工编辑清除覆盖并继续沿用原有原文替换和卡片重新生成流程。现有 TXT 导出只包含原文或译文，没有知识名称导出；SQLite 备份保留显示名称和任务记录。

关系输入仍读取原始身份。显示字段更新仅使图谱显示版本增加，不使关系窗口变脏，也不改变正在执行的关系任务指纹。通知直接刷新客户端，不唤醒关系或知识队列；此操作使用的 Key 不存入后台授权表。

## 请求预算和证据

| 情况 | 本名称任务新增 LLM 请求数 |
| --- | --- |
| 同一 UUID 重放、同输入正在处理、命中有效缓存 | 0 |
| 没有可用关联段落、当前名称已由人工确认 | 0 |
| 新输入需模型核对 | 最多 1 |
| 失败后用户点击「重试校正」 | 新尝试最多 1 |

模型为现有 `qwen3.8-flash`，`enable_thinking=false`，单请求超时 30 秒。复用请求调度和执行追踪，不追加修复、自动重试、切分、替代模型或外部查询。输入 JSON 最多 8000 个 JavaScript 字符，包含名称、类别、前 8 个别名、最多 6 段完整关联原文与已完成译文，再在剩余空间纳入同一收听片段的相邻段落。过长段落整体跳过，不截断引用；名称元数据本身超限时拒绝请求。

输出为 `corrected`、`unchanged` 或 `insufficient_evidence`。名称为 1–160 字符，理由最多 500 字符，引用最多 6 条。服务端严格验证结构及逐字引用。新名称还必须完整出现在目标关联段落的引用中；仅出现于相邻其他对象、英文单词子串或模型记忆中的名称不采纳。此规则只能核对原文、译文中的拼写，不能独立纠正二者都未提供的标准名称；无法确定对象时保留原名。与同一收听的其他条目原名、显示名或别名冲突时拒绝覆盖。

预算在 `knowledge_edit_jobs.request_reserved` 中以原子更新 0→1 持久化。它表示该任务已消费发起请求的资格，服务崩溃后不释放、不重发，也不代表一定已计费。该上限只约束名称操作新发起的请求；独立的既有后台任务仍可继续。

## 异步任务与恢复

`knowledge_edit_jobs.operation` 区分 `manual_regenerate` 与 `name_correction`，旧任务迁移保留原有 fingerprint。名称任务的输入版本、上下文摘要、应用后摘要及结果持久化，Key 不入库。缓存绑定条目、输入版本、原文、译文、上下文、提示词版本、模型及 thinking 参数；保存后的上下文摘要使改名后的再次点击也命中缓存。输入变化不沿用旧缓存。

| API | 用途 |
| --- | --- |
| `GET /api/listenings/:id/knowledge/:itemId` | 读取条目、revision 和可恢复的 nameCorrectionJob |
| `POST /api/listenings/:id/knowledge/:itemId/name-corrections` | JSON `{revision,key?}`，UUID `Idempotency-Key`，202 返回 accepted job |
| `GET /api/listenings/:id/knowledge/:itemId/edits/:jobId` | 只读查询任务 |
| `GET /api/listenings/:id/knowledge/:itemId/name-corrections?revision=...` | 恢复并发合并后原始 accepted job ID |

同一输入的不同 UUID 并发提交返回同一任务 ID。前端始终轮询返回的 ID，提交响应丢失时先查提交 UUID，再查输入版本，绝不自动重新 POST。无法确认结果时隐藏重试入口；关闭再打开只读恢复。已知失败才允许明确重试。保存前重读完整快照并验证上下文，名称覆盖、审计及成功任务回执在同一事务提交。

运行中的名称任务与原有修改共享收听级锁；数据导入期间也作为未完成修改阻止覆盖和追加。重启将未完成任务标为失败，已成功任务保持成功。SQLite 追加保留任务与预算，验证结果 JSON 中的段落引用属于同一收听，拒绝跨收听引用。

## 验证入口

revision 的固定投影、v11/v12 缓存兼容、失败可见性和只读冲突恢复见 [知识编辑版本兼容](knowledge-edit-revision.md)。旧、新口径的相同输入可合并任务；公开结果不包含内部 revision 别名。

`test/knowledge-name.test.mjs` 继续验证旧 API 的显示改动边界、关系在途提交、并发与缓存、证据、身份失效、人工编辑、真实 v11 迁移、重启预算、追加/覆盖导入及真实服务器的模型请求次数。`scripts/verify-knowledge-name-browser.mjs` 验证当前统一编辑框的建议与确认流程；已加入默认浏览器验收。

执行追踪保留 `name_correction` 用途、请求数、缓存标记和结论，不记录 Key、原文、译文或模型输出。终态 UUID 重放不生成重复执行追踪。
