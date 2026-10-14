# 音频、字幕与译文会话一致性（KEJ-74）

规格：Hearwise 增强验证需求规格 v1.0，HW-01、HW-02、HW-11。

## 复现入口

按 `docs/development-workflow.md` 安装当前 checkout 的锁定依赖，使用 Node 24。

```sh
npm test -- test/session-consistency.test.mjs test/caption-frontier.test.mjs test/interim-translation-ui.test.mjs test/session-evidence.test.mjs
npm run test:browser -- session
node scripts/verify-session-browser.mjs --release
```

浏览器入口由既有必需 Chromium job 执行，包含 Node 业务回归和 1280×950 / 390×950 Chromium 操作。`--release`（CI 自动启用）要求干净、已提交源码。独立 `session-*` 目录保存源码 SHA/dirty、规范摘要、Node/SQLite/Chromium/系统版本、退出码、超时/中断、逐项日志、持久业务观测、截图和五条性质结果。读 `report.json` 的 `summary.rows`、`complete` 与 `ok`；不要从“测试文件存在”推断通过。

浏览器不可启动时可以运行 `node scripts/verify-session-browser.mjs --node-only`。该命令仍执行 Node/SQLite 回归，但四条需要浏览器的性质明确 `not_run`，整体验收退出 1。缺失、失败、超时或脏源码不成为发布通过。执行器复用进程组 watchdog、单项期限和夹具关闭；外层将临时数据库放入本次独立目录并在子进程结束后移除。

## 性质与实现边界

- HW-01-02：身份是 `run_id + asr_sentence_id`。同一 run 的重复 final 只有一条记录，冲突 final 保留首次定稿并提示。新 run 可重用 sentence ID。停止时终态前的尾句合法；`task-finished` 后同一批已排队 frame 不可落库。
- HW-01-03：一次麦克风拒绝不创建收听，键盘重试可恢复；真实 AudioWorklet/fake media track 在停止或断连后结束。断连后可继续同一收听，切换新收听后旧 socket 事件不能污染页面或记录。
- HW-02-02：最终翻译提交以请求捕获的 `original_text` 和持久行原文相等为条件，无 schema/public HTTP 变更。正常 pending 阻止编辑，但某个并发尝试失败后可合法纠正原文，因此不能仅靠 pending 状态假定来源不变。过期成功和失败都丢弃；显式重试从新原文生成译文。这里沿用既有内容来源版本：基线 dcd2c7f 的 `relation-storage.mjs`（构建来源时 `source_revision: hash(s.original_text)`，提交时再次核 hash）及 `knowledge-name-replacement.mjs`（原文改变时持久更新 support.source_revision）都采用原文 SHA-256。SQL 精确文本比较具有相同内容等价语义且不引入哈希碰撞。知识卡片编辑 revision 还含内容版本等字段，不是 MT 的来源版本。固定合法 A→B→A 回归确认成功/失败响应按同内容处理，已完成的新译文仍不可覆盖；不增加单调修订计数。现行语义允许名称纠正保留已完成译文，本改动不重新计费或自动重译。
- HW-02-03：复用字幕前沿测试验证相同来源上下文不增加确认、深度重写和 Unicode。浏览器验证更短的 interim→final、原文/译文显示与停止尾句的最终翻译补齐。这里不是允许同身份的冲突 final 覆写首次定稿。
- HW-11-02：桌面/窄屏明确错误、可操作恢复、键盘开始、停止、继续、新建收听与横向布局；不是 HW-11 整个编辑/迁移旅程的完成声明。

测试通过公开 HTTP/WS、现有业务存储与实际页面操作，不新增生产调试 API。故意晚到的浏览器事件派发到旧 transport，未调用 app 私有函数；供应商尾句/终态顺序在原有 speech fixture 注入。

## 已固定的两个反例

1. 原版本在 `task-finished` 后仍以 `started=true` 接收同批 ASR final，导致已结束 run 新增记录。红提交 `2f74f1a` 中 `session-consistency.test.mjs` 可复现。修复检查 terminal 和 client transport 状态，同时保留终态前尾句。
2. 旧翻译成功返回时，仅按 segment ID 写入，不能识别原文已被合法纠正。固定轨迹：两个显式重试在途 → 后发空结果失败 → 使用当前修订改名 → 旧成功晚到 → 核对原文/译文 → 显式重试新原文。SQLite 重开、旧失败响应和已有新结果不被覆盖另有边界回归。

初次红证据记录三条失败断言，随后最小修复绿；HTTP 整体重放额外验证服务端确实传入原文快照。原有预算、队列、首次 final 和名称纠正语义保持不变。完整本次测试状态以目标提交 CI 和证据报告为准。

## 明确未覆盖

本地合成 ASR/MT、Chromium 假麦克风只证明协议与页面一致性，不证明真实语音准确率、翻译意义、实际设备权限提示、真实麦克风、锁屏/后台采集、端到端时延或长期资源指标。质量由 KEJ-77 等对应评测提供，实体设备由相应设备工单提供；没有付费 API、真实凭据或敏感语料。原 HW-01-01 / HW-02-01 / HW-11-01 广义卡仍保留缺口，不因这些子性质通过而关闭整个能力组。

## 失败路径补强

会话与关系 profile 复用 `scripts/lib/verification-checks.mjs` 的严格 TAP、顺序预算和按性质汇总。TAP 必须实际完成全部测试：pass + fail = tests，cancelled/skipped/todo 均为 0；断言失败保留失败，未执行完整保持 incomplete。浏览器或字幕检查失败不会污染独立完成的来源性质，整个 profile 仍失败。缺少应执行的检查、性质缺失/重复和源码变化不能成为通过。

两个 Node 检查各最多 30 秒、浏览器最多 100 秒，但共享 150 秒总检查预算（最坏 30/30/90），父运行器保持 180 秒。超时、中断或不完整 TAP 立即停止后续检查，并在 finally 清理临时运行目录；预留余量用于终止进程组、哈希和最终报告。关系 profile 保持此前 40/40/70 的边界与行为。

`test/session-evidence-failures.test.mjs` 固定浏览器/字幕/来源失败隔离、全 skip/todo/缺少 pass 的假通过、超时仍启动后续的红回归。共享真实挂起子进程终止与最终报告回归仍由 `test/relation-result-evidence.test.mjs` 执行。合成结果只验证证据门禁，不能替代真实 Chromium 或 ASR/MT 质量验收。

TAP 计数只接受唯一、顺序完整、以 duration_ms 结束的最终顶层 Node footer（含 plan/suites）。测试正文里转义或嵌套的计数日志不能替代 reporter 数据；重复、乱序、不完整或后有输出的 footer 保持 incomplete。真实 Node 子进程固定带伪造计数的 skip/fail/pass 三种输出，防止跳过覆盖被日志伪装为通过。
