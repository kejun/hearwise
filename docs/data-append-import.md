# 数据追加导入（KEJ-25）

## 产品行为

设置中的「追加数据，否则覆盖原数据」默认不勾选，新打开设置时重置。勾选按完整收听追加，不勾选使用覆盖流程。预览显示数量与模式；已有收听 ID 整条跳过，标题、备注、字幕、知识和图谱保留本地版本。同名且不同 ID 可并存。旧备份可能重新加入本地已删除的记录。

第一版不合并同一收听内部的变化，也不按内容去重。新收听的子记录 ID 冲突、异常跨收听引用或结构不兼容使整次导入失败，不逐行忽略冲突。所有业务 ID 保留，不改写 JSON 快照中的引用。

## 接口与预览

- POST /api/data/import/validate?mode=append 或 mode=replace：上传 SQLite，完整性检查、仅在临时副本迁移到当前版本、停止未完成任务，创建 15 分钟有效的上传 token 与预览。
- POST /api/data/import/preview：JSON 参数 token、mode；无需再次上传，返回新的 previewToken、当前数量及预计新增/跳过数量。
- POST /api/data/import/commit：JSON 参数 token、mode、previewToken；模式或预览 token 不匹配返回 409 IMPORT_PREVIEW_STALE。没有有效上传 token 返回 410 IMPORT_EXPIRED。模式缺失或错误返回 400 INVALID_IMPORT_MODE。

提交时检查同一连接的 total_changes、其他连接提交的 data_version 和 schema_version。任何本地写入后须重新预览。UI 忽略旧的预览响应，重新计算时禁用确认按钮；过期预览自动刷新后仍须用户再次确认。提交后的 token 在异步清理前标记为已消费，防止同时重放。

## 表归属

| 表 | 收听归属 |
| --- | --- |
| listenings | id |
| listening_runs、segments、knowledge_items、extraction_jobs、knowledge_candidates | listening_id |
| knowledge_aliases、knowledge_mentions、knowledge_revisions、knowledge_facts | item_id → knowledge_items |
| extraction_parts | job_id → extraction_jobs |
| relation_windows、relation_jobs、relations、relation_rounds | listening_id |
| relation_requests | job_id → relation_jobs |
| relation_assertions、relation_revisions | relation_id → relations |
| relation_supports | assertion_id → relation_assertions → relations |
| knowledge_manual_items、knowledge_corrections、knowledge_edit_jobs | listening_id |

表名单、列结构、外键和唯一索引必须与当前版本匹配。未知表或列拒绝导入。追加前检查备份的外键完整性，逐项检查关联端点的收听归属，包括字幕的 run_id、知识引用的 segment_id，以及图谱支持的 job_id/window_id/segment_id。

没有数据库外键的 merged_from_id、correction_of、手动编辑 item_id，以及任务快照和修订 JSON 中已知实体 ID，也检查可解析对象的收听归属。历史修订允许引用已经删除的对象；保留原值，禁止指向其他收听。没有 ID 重映射，所以不需要重写快照。新增收听的快照逐行读取，限制递归深度；非法任务 JSON 拒绝追加。

## 写入、任务和缓存

追加先导出安全备份，再在 BEGIN IMMEDIATE 事务内再次校验预览。临时 import_added 表冻结新增收听集合；按表清单复制该集合的全部业务数据。使用延迟外键校验，主键和唯一约束仍正常执行。图谱触发器在事务内暂停并恢复，使已有窗口和图谱版本保持不变；失败时连触发器一起回滚。最终执行外键与数据库完整性检查后提交。

未完成收听转为 interrupted；待译字幕转为 failed；未完成知识任务转为 failed；未完成关系任务取消、进行中的关系轮次暂停；正在编辑的任务转为 failed。历史已完成的知识和图谱保留。导入不会继承本地 API Key，也不自动运行模型任务；重启后仍须用户手动恢复。

追加保留现有任务、授权和图谱缓存，仅失效新增收听的缓存；覆盖保留原有运行时重置语义。完成后刷新历史列表，保留结果与备份名称，关闭设置后重载以清除旧的选中字幕和图谱。

## 验证入口

- node scripts/run-tests.mjs test/data-transfer.test.mjs：完整追加、重复无操作、覆盖、备份、冲突回滚、预览失效、任务恢复和接口 token 验证。
- node scripts/run-browser-tests.mjs data-transfer：模式切换、响应乱序、过期预览、确认/取消、实际追加与覆盖、重复导入、标题转义和桌面/手机布局。
- npm test 与 npm run test:browser：完整回归；数据导入浏览器验收已加入默认列表。
