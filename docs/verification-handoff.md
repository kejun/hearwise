# 全业务验收与维护交接（KEJ-87）

本文是交接准备，不是最终验收结论。核对基线：`4631de0100d554ad9715cfdff2a1159156516e57`；需求为 [增强验证规格 v1.0](https://linear.app/kejunz/document/hearwise-增强验证需求规格-v10-5e0275a3dac3)，对应 [KEJ-87](https://linear.app/kejunz/issue/KEJ-87)。基线已有 KEJ-66、KEJ-83、KEJ-85 的实现；合并、性质登记和一次技术检查均不等于全业务验收。

## 判定与责任

- 本文矩阵是入口索引，不是第二份可执行注册表。性质定义以 `verification/`、AC 映射以 `scripts/lib/m1-evidence.mjs`、技术/外部义务以 `verification/release/policy.mjs` 为准。修改契约时同时检查本索引；不能以本文缩小原要求。
- 每行的模块责任为所列子工单的实现维护者；验证维护者负责驱动、原始观测和重放；发布负责人负责冻结阈值/支持矩阵、历史适用性和最终结论。实际个人须在对应 Linear 工单明确认领并由交接接收者确认。本基线的角色记录不证明个人已认领；个人责任确认是未完成项，不能填入推测的姓名。
- 下表所有“证据入口”均是寻找/产生/复核证据的位置，不声明该候选已通过。先取得同一最终 SHA 的原始报告、日志、退出状态和附件，再由既有 reader 重验；未提供则为 `not_run`，运行被截断为 `incomplete`，业务反例为 `failed`，源码/配置失配为 `stale`。静态性质卡 `evidenceStatus`/`gaps` 不是在线结果。
- 18 个技术 suite、15 个全业务义务和 8 类外部义务继续由同一发布门禁执行。基线的全业务适配器及外部冻结配置仍未齐备，`release` 必须拒绝。付费服务、实体音频设备及真实性能验收不能由桩、离线评分器或 Chromium 代签。

### Linear 责任快照（2026-10-15）

审查时 KEJ-62 至 KEJ-87 的 assignee：KEJ-77、KEJ-79、KEJ-87 未指派；其余为 Kejun Zhang。状态：KEJ-77/78/80/81 In Progress，KEJ-79/87 Todo，其余 20 项 Done。这个任务指派快照不等于发布负责人或交接接收者已经签收，也不代表全部外部证据完成；签收时重新读取 Linear。

## HW-01 至 HW-15：实现、责任与证据入口

各行同时关联全业务 `HW-xx:complete` 义务；子性质通过不能关闭伞形要求。角色和当前候选 `not_run` 规则适用于每行。

| HW / 登记主卡 | 模块责任子工单 | 实现边界 | 证据/复现说明 | 仍须独立验收 |
| --- | --- | --- | --- | --- |
| HW-01 / `HW-01-01` | KEJ-74, KEJ-77, KEJ-79 | `server.mjs`<br>`storage.mjs` | [session-verification.md](session-verification.md) | 真实 ASR 质量与采集/权限设备矩阵 |
| HW-02 / `HW-02-01` | KEJ-74, KEJ-77, KEJ-81 | `server.mjs`<br>`public/caption-frontier.js` | [session-verification.md](session-verification.md) | 真实翻译质量和端到端延迟 |
| HW-03 / `HW-03-01` | KEJ-67 | `translation-queue.mjs`<br>`knowledge-queue.mjs`<br>`provider-admission.mjs` | [scheduler-verification.md](scheduler-verification.md) | 条件公平性的环境前提、真实负载 |
| HW-04 / `HW-04-01` | KEJ-62, KEJ-63, KEJ-64, KEJ-65, KEJ-66 | `relation-workflow.mjs`<br>`relation-storage.mjs`<br>`relations.mjs` | [knowledge-protocol-verification.md](knowledge-protocol-verification.md) | 真实知识/关系质量；四域 M1 原始证据 |
| HW-05 / `HW-05-01` | KEJ-63, KEJ-76, KEJ-78 | `knowledge.mjs`<br>`relations.mjs`<br>`relation-evidence.mjs` | [relation-result-verification.md](relation-result-verification.md) | 人工标注语义质量；空结果不补边 |
| HW-06 / `HW-06-01` | KEJ-68, KEJ-69 | `knowledge-revision.mjs`<br>`knowledge-edit.mjs`<br>`public/knowledge-editor.js` | [edit-protocol-verification.md](edit-protocol-verification.md) | Lean 公理/差分及并发 UI 各自保留 |
| HW-07 / `HW-07-01` | KEJ-70, KEJ-71 | `knowledge-name-replacement.mjs`<br>`knowledge-name.mjs` | [name-protocol-evidence.md](name-protocol-evidence.md) | UTF-16 前提、关联事务及页面证据 |
| HW-08 / `HW-08-01` | KEJ-75, KEJ-79 | `speech-service.mjs`<br>`public/speech-controller.js`<br>`public/speech-player.js` | [verification-playback.md](verification-playback.md) | 真实输出听测、移动/锁屏设备 |
| HW-09 / `HW-09-01` | KEJ-72, KEJ-73 | `data-transfer.mjs`<br>`storage.mjs` | [verification-import-atomicity.md](verification-import-atomicity.md) | 支持环境恢复证据；进程终止非断电 |
| HW-10 / `HW-10-01` | KEJ-65, KEJ-66 | `relation-workflow.mjs`<br>`knowledge-workflow.mjs`<br>`storage.mjs` | [generation-verification.md](generation-verification.md) | 实际进程边界、取消/删除/重启范围 |
| HW-11 / `HW-11-01` | KEJ-69, KEJ-71, KEJ-85 | `public/index.html`<br>`public/knowledge-editor.js` | [user-journey-verification-plan.md](user-journey-verification-plan.md) | 同一库完整旅程；真实设备和人工视觉审查 |
| HW-12 / `HW-12-01` | KEJ-82 | `server.mjs`<br>`data-transfer.mjs`<br>`src/server/diagnostics/report.ts` | [verification-security.md](verification-security.md) | 当前部署契约；哨兵不证明所有秘密安全 |
| HW-13 / `HW-13-01` | KEJ-80, KEJ-81 | `server.mjs`<br>`storage.mjs`<br>`public/knowledge-graph-renderer.js` | [realtime-baseline.md](realtime-baseline.md) | 冻结设备/规模/时长/分位数/资源门槛实测 |
| HW-14 / `HW-14-01` | KEJ-79, KEJ-83 | `scripts/build.mjs`<br>`scripts/preflight.mjs`<br>`storage.mjs` | [install-upgrade-verification.md](install-upgrade-verification.md) | 实际平台支持矩阵及升级恢复外部义务 |
| HW-15 / `HW-15-01` | KEJ-62, KEJ-84, KEJ-86, KEJ-87 | `src/server/diagnostics/business.ts`<br>`scripts/lib/verification-evidence.mjs` | [release-evidence-gate.md](release-evidence-gate.md) | 同候选完整 CI、历史适用理由及最终签收 |

## 42 条用户故事逐项索引

编号沿用规格，不另设故事编号或复制判定逻辑。性质范围 `a–b` 包含两端。每行通过上述 HW 表继承实现边界、证据入口及三方责任；补充列给出更精确的登记/执行入口。对于多个 HW，所有对应义务均保留。AC 关联见下一节，不能从故事行推断 AC 已通过。

| 故事 | 要求摘要 | HW / 已有性质 | 责任子工单 | 具体登记或补充证据入口 |
| --- | --- | --- | --- | --- |
| 1 | 停止后旧识别不写新会话 | HW-01-02–03 | KEJ-74 | session-properties.mjs |
| 2 | 权限拒绝/断连可恢复 | HW-01-03; HW-11-02 | KEJ-74, KEJ-79 | session-properties.mjs |
| 3 | 重复 final 身份规则 | HW-01-02 | KEJ-74 | session-properties.mjs |
| 4 | 译文绑定正确原文版本 | HW-02-02 | KEJ-74 | session-properties.mjs |
| 5 | 接受缩短/重写的最终字幕 | HW-02-03 | KEJ-74 | session-properties.mjs |
| 6 | 调度准入与条件公平 | HW-03-02–06 | KEJ-67 | scheduler-protocol/properties.mjs |
| 7 | 持久预算跨重启 | HW-04-02–03,06,09–13 | KEJ-63, KEJ-64, KEJ-65 | relation-protocol/properties.mjs; knowledge-protocol/properties.mjs; process-crash/properties.mjs |
| 8 | 响应后写失败不重发 | HW-04-04,08,11–13 | KEJ-63, KEJ-64, KEJ-65 | 同上；AC-P05 |
| 9 | 取消/删除使旧结果失效 | HW-10-01; HW-04-14–16 | KEJ-66 | generation-protocol/properties.mjs |
| 10 | 失败/空/部分/取消区分 | HW-05-03; HW-15-02–04 | KEJ-76, KEJ-84 | relation-result-properties.mjs; trace-business-properties.mjs |
| 11 | 知识独立、无依据不补关系 | HW-05-02–03 | KEJ-76, KEJ-78 | relation-result-properties.mjs; semantic-quality |
| 12 | 正确来源可核对 | HW-05-02 | KEJ-76, KEJ-78 | relation-result-properties.mjs; semantic-quality |
| 13 | 数字否定条件专名单测 | HW-01-05; HW-02-05; HW-05-04 | KEJ-77, KEJ-78 | asr-translation-quality/properties.mjs; scripts/lib/semantic-quality-offline.mjs（真实质量未运行） |
| 14 | 旧编辑明确冲突 | HW-06-06 | KEJ-69 | edit-consistency-properties.mjs |
| 15 | 保存不确定保留输入 | HW-06-07; HW-11-04 | KEJ-69 | edit-consistency-properties.mjs |
| 16 | 名称只改相关记录 | HW-07-09 | KEJ-71 | name-properties.mjs |
| 17 | 长短名称引用区间正确 | HW-07-02–06,09 | KEJ-70, KEJ-71 | name-interval/profile.mjs; name-properties.mjs |
| 18 | 同一纠正重试一致 | HW-07-07–08,10 | KEJ-71 | name-properties.mjs |
| 19 | 停止跳转切换旧音频失效 | HW-08-02,04–05 | KEJ-75 | playback-properties.mjs; playback-protocol/properties.mjs |
| 20 | 可播报内容不重不漏 | HW-08-03 | KEJ-75, KEJ-79 | playback-properties.mjs；真实听测另验 |
| 21 | 导出完整可恢复 | HW-09-06–07,09; HW-11-09 | KEJ-73, KEJ-85 | import-atomicity; user-journey-properties.mjs |
| 22 | append 保留同 ID 本地会话 | HW-09-06 | KEJ-73 | import-atomicity |
| 23 | 导入冲突/写失败整体回滚 | HW-09-03,07–09 | KEJ-72, KEJ-73 | import-protocol/properties.mjs; import-atomicity |
| 24 | 过期预览拒绝提交 | HW-09-02–03,05 | KEJ-72 | import-protocol/properties.mjs |
| 25 | 迁移/恢复不自动付费 | HW-09-04,09; HW-10-01 | KEJ-65, KEJ-72, KEJ-73, KEJ-83 | import-protocol/properties.mjs; import-atomicity/properties.mjs; process-crash/properties.mjs; upgrade-properties.mjs |
| 26 | 历史图谱持续聆听可用 | HW-13-01 | KEJ-80, KEJ-81 | realtime-baseline.json；性能配置与真实报告另验 |
| 27 | 凭据不进日志报告导出 | HW-12-02,05 | KEJ-82 | security-properties.mjs |
| 28 | 外部文本不能执行脚本 | HW-12-03–04 | KEJ-82 | security-properties.mjs |
| 29 | 性质编号/负责人可追踪 | HW-15-01 | KEJ-62, KEJ-87 | properties.mjs；本交接责任未认领项 |
| 30 | 模型对应真实事务异步边界 | HW-03; HW-04; HW-06; HW-07; HW-08; HW-09; HW-10 | KEJ-63, KEJ-64, KEJ-65, KEJ-66, KEJ-67, KEJ-69, KEJ-71, KEJ-72, KEJ-75 | 各域 properties/config 与实际重放，见形式化清单 |
| 31 | 供应商忽略取消仍可晚到 | HW-04-14–16; HW-10-01 | KEJ-66 | generation-protocol/properties.mjs |
| 32 | 反例重放逐步比真实状态 | HW-04; HW-03; HW-06; HW-07; HW-08; HW-09; HW-10 | KEJ-63, KEJ-64, KEJ-65, KEJ-66, KEJ-67, KEJ-69, KEJ-71, KEJ-72, KEJ-75 | 各域原始 ITF/SQLite/HTTP 轨迹，不只看摘要 |
| 33 | 纯函数与 JavaScript 差分 | HW-06-02–05; HW-07-02–06 | KEJ-68, KEJ-70 | revision/profile.mjs; name-interval/profile.mjs |
| 34 | 破坏防护确实被检出 | HW-04-17; HW-06-05; HW-07-06; HW-15-05 | KEJ-66, KEJ-68, KEJ-70, KEJ-84 | 各域实际 production-copy negative；AC-P12 |
| 35 | 默认规则输入输出完成条件 | HW-01–15 | KEJ-62, KEJ-87 | properties.mjs + 各域 profile/config；规格 v1.0 |
| 36 | 模拟/有界/完整/证明分清 | HW-15-11 | KEJ-86, KEJ-87 | release/properties.mjs；方法与范围清单 |
| 37 | 源码工具模型语料版本齐备 | HW-15-11 | KEJ-62, KEJ-86, KEJ-87 | release/properties.mjs；原始 report 和绑定附件 |
| 38 | 变更影响选择验证 | HW-15-10 | KEJ-86 | release/policy.mjs |
| 39 | 未运行超时缺失过期不通过 | HW-15-11–12 | KEJ-86, KEJ-87 | release/properties.mjs；三态复现 |
| 40 | 模型提示词供应商触发质量回归 | HW-15-10,12; HW-01; HW-02; HW-04; HW-05; HW-08 | KEJ-77, KEJ-78, KEJ-79, KEJ-86 | release/policy.mjs prompts-models/provider 规则；真实质量另验 |
| 41 | 升级恢复真机独立证据 | HW-14-02–04; HW-01; HW-08; HW-11 | KEJ-79, KEJ-83 | upgrade-properties.mjs；physical-devices/upgrade-recovery 外部义务 |
| 42 | 修复保留最小反例 | HW-15-11; HW-04-17 | 各域维护工单及87 | 各域回归；下文反例维护流程 |

## AC-P01 至 AC-P12：复用四域 M1 映射

下表直接核对 `scripts/lib/m1-evidence.mjs#m1Coverage` 的基线导出；运行时不要复制此表生成另一套 gate。四域 reader 各自重验完整原始证据及相同目标源码，缺任一域则 M1 不通过。各域的责任是对应子工单维护者与验证维护者；M1 不涵盖全部业务验收。

| AC | 责任工单 / 性质（所有列项都必需） |
| --- | --- |
| AC-P01 | KEJ-63 / `HW-04-02`; KEJ-64 / `HW-04-06` |
| AC-P02 | KEJ-63 / `HW-04-02`; KEJ-64 / `HW-04-06`; KEJ-64 / `HW-04-07` |
| AC-P03 | KEJ-65 / `HW-04-10`; KEJ-65 / `HW-04-13` |
| AC-P04 | KEJ-65 / `HW-04-10`; KEJ-65 / `HW-04-11`; KEJ-65 / `HW-04-13` |
| AC-P05 | KEJ-63 / `HW-04-04`; KEJ-64 / `HW-04-08`; KEJ-65 / `HW-04-11`; KEJ-65 / `HW-04-12`; KEJ-65 / `HW-04-13` |
| AC-P06 | KEJ-63 / `HW-04-04`; KEJ-64 / `HW-04-08`; KEJ-65 / `HW-04-12`; KEJ-65 / `HW-04-13` |
| AC-P07 | KEJ-66 / `HW-04-14` |
| AC-P08 | KEJ-66 / `HW-04-15` |
| AC-P09 | KEJ-63 / `HW-04-03`; KEJ-64 / `HW-04-09` |
| AC-P10 | KEJ-63 / `HW-04-05`; KEJ-64 / `HW-04-07` |
| AC-P11 | KEJ-66 / `HW-04-16` |
| AC-P12 | KEJ-66 / `HW-04-17` |

复核命令（先按各域文档运行，不允许把四个不同 SHA 的目录拼接）：

执行前，将 `RELATION_RUN`、`KNOWLEDGE_RUN`、`PROCESS_RUN`、`GENERATION_RUN` 分别替换为前序对应 profile 命令实际打印的唯一 run 目录，且四者属于同一候选。它们只是占位符，不是已经存在的目录；缺失目录仍按 not_run 非零退出。

```sh
mkdir -p verification-evidence
npm run verify:m1:report -- --relation RELATION_RUN --knowledge KNOWLEDGE_RUN --process PROCESS_RUN --generation GENERATION_RUN --release --output verification-evidence/m1-summary.json
```

该命令会重新调用四域 gate；`verification-evidence/m1-summary.json` 不是可以代替原目录的证据。AC-P12 必须有真实预期/实际状态差异；下文 HTTP 401 演示只证明三态报告闭环，不替代 AC-P12 的预算/代次破坏检出。

## 形式化、实现桥与假设清单

- Revision：`verification/revision/profile.mjs` 的 HW-06-02 列出 10 个必需定理；`verification/lean/AxiomAudit.lean` 逐项检查传递公理。`HW-06-03–05` 分别保留差分、冻结旧协议回归和真实 mutation 证据。[输入域](verification-revision.md)限定 UTF-16、普通无副作用对象、稠密数组及安全整数；不证明 SHA-256 单射，也不把旧协议排序语义套进当前定理。
- Name interval：`verification/name-interval/profile.mjs` 的 HW-07-02 列出 14 个必需定理；`NameIntervalAxiomAudit.lean` 检查传递公理。HW-07-03–06 保留真实 SQLite 差分、词边界、非法输入拒绝及 code-point/UTF-16 负例。[输入域](verification-name-interval.md)要求合法有序区间和明确端点规则；不证明所有 Unicode 字素语义。
- 两个 Lean profile 均固定 Lean 4.35.0 / commit `eb6cafb7290e8bd5f2937522d8d804f58f02bafc`，各自保留 `proof-build.log`、`axiom-audit.log`、`axioms.json`、完整 corpus、oracle execution 和差分结果。允许的标准公理依赖以各审计文件精确断言为准；`sorry`、`admit`、`sorryAx` 或新自定义公理不能混入通过结果。
- Quint 配置分布在 `verification/{relation-protocol,knowledge-protocol,process-crash,generation-protocol,scheduler-protocol,edit-protocol,name-protocol,import-protocol,playback-protocol}/config.json`。每域文档记录有限域、故障动作、预算和重放；以配置的实际字段为准。完整 TLC、有限深度 Apalache、带 seed 的模拟、可达见证和真实实现重放分别报告，不能互相升格。scheduler 条件公平性必须保留其服务完成/调度假设；诊断 backend error 不算有界证明。
- 所有形式化通过都保留输入域、环境假设、profile 名称、实际工具版本、模型/配置摘要、完整退出和原始 ITF/观测。深度检查失败/未完不能被 fast 通过覆盖；不支持的 deep profile 不得改名伪装。
- [发布证据契约](release-evidence-gate.md)说明各域现有严格 reader 的实现桥及负例要求。真实 SQLite/HTTP/工作流是桥接边界，桩供应商不提供真实语义质量保证，SIGKILL 不提供断电/磁盘满保证。

## 干净隔离 checkout 的真实三态复现

接收者选择实际待交接的完整提交 SHA（不能用移动中的 main 名称作为报告身份）。新建独立 checkout/worktree，不借用其他 checkout 的 node_modules；使用 Node 24 和锁文件。按 [开发流程](development-workflow.md)记录预检结果。以下不安装模型工具、不联网调用供应商、不使用真实用户数据，也不修改报告内容。

```sh
# 在目标仓库运行；HANDOFF_SHA 替换为已经存在的完整提交 SHA。
git worktree add --detach ../hearwise-handoff-check "$HANDOFF_SHA"
cd ../hearwise-handoff-check
npm ci --ignore-scripts
npm run preflight
npm run build
git status --porcelain
node --version
npm --version
# 每次命令都会打印独立的 run-* 目录；逐次记录完整输出及退出码。
npm run verify -- --release --scenario=success
npm run verify -- --release --scenario=business-failure
npm run verify -- --release --scenario=timeout
# 可另验真实 SIGTERM 中断：
npm run verify -- --release --scenario=interrupt
# 分别将各自打印的目录传给现有报告器，不复制上一轮目录：
npm run verify:report -- SUCCESS_RUN --release
npm run verify:report -- FAILURE_RUN --release
npm run verify:report -- TIMEOUT_RUN --release
```

预期判据：

| 场景 | 执行及报告器退出 | 原始事实 | 应有状态 |
| --- | --- | --- | --- |
| success | 0 / 0 | 文件 SQLite；调用前 budget=1/账本=1，真实关系工作流提交一条关系，终态 ok | `passed`、complete=true |
| business-failure | 1 / 1 | 同一真实工作流接收注入 401；业务失败，成功性质断言得到具体反例，原始观测记录实际终态 | `failed`、complete=true |
| timeout | 1 / 1 | 真实 worker 已预留并进入 PROVIDER_PENDING；1.5 秒 watchdog 终止不响应的 worker，清理临时数据库 | `incomplete`、complete=false、timedOut=true |

不要对预期负例使用 `|| true` 后宣称整组通过。依次记录真实 `$?`；状态、原因或退出与预期不符时暂停签收，保留原目录诊断。仅 `failed` 文字而无真实业务失败不算反例。`scripts/release-demo.mjs` 的损坏报告副本只测 gate，不替代这里的实际执行。复现为独立 worktree/进程/临时库级隔离，不宣称容器、独立 OS 或物理设备隔离。

每个目录保留 `context.json`、`report.json`、`result.json`、`observations.json`、`worker.log`；报告器重算绑定附件的摘要。源码必须同一 SHA 且 dirty=false，完整退出/信号/超时、Node/SQLite/OS/架构/锁文件信息必须可查。接收者记录姓名、日期、checkout 路径和三条结果目录，并亲自读出一次预算、失败终态及超时诊断；作者代跑不等于另一位维护者已签收。

若接收者还要复现实际资源回收防护被破坏的反例，直接复用 [实时基线](realtime-baseline.md) 的已登记负例，不另造失败报告：

```sh
npm run verify:realtime-baseline -- --profile=smoke
npm run verify:realtime-baseline -- --profile=smoke --negative=retain-asr-socket
```

正常 smoke 应退出 0；负例应退出 1 且 `complete=true`、`negativeDetected=true`，原始失败应明确是停止后实际 ASR 上游连接未释放。检查 `retainedCloseCalls`、`failure.providerAsrConnections`、资源/事件日志及最终 cleanup，不把超时或其他失败算作检出。该脚本没有 `--release` 参数，必须另验报告 source/target 同一干净 SHA；其 `--report=DIR` 返回码不能单独当通过条件，应检查读回内容。smoke/定向故障只验证测量与检错，不替代真实多小时资源稳定性、性能阈值或 AC-P12 的预算/代次反例。

## 反例维护、变更影响与工具升级

1. 发现问题先保存最小输入、种子/动作序列、源 SHA、真实 expected/actual 差异和业务后果，关联原子工单/性质。区分模型违反、实现不一致、驱动不可重放；不可重放保持 incomplete，不作为正确性通过。
2. 在既有域夹具/轨迹中加入固定回归，先展示原版本失败，再独立审查修复并展示新版本通过。正常路径、定向破坏及必要恢复场景一起保留；不删除反例、放宽断言/预算或缩小承诺换通过。
3. 修改前后执行 `npm run verify:impact -- --base FULL_BASE_SHA`；保留完整祖先链（包含 merge parents、删除和改名）。未知影响扩大检查。按 `release/policy.mjs` 选择现有 18 suite，不新增第二套框架、不跳过既有必需 CI。
4. 工具升级先在独立变更中固定新版本及下载校验/锁文件，记录旧→新 Lean/Quint/TLC/Apalache/Java/Node/SQLite/Playwright/OS；同时核对配置、seed、深度、预算、证明公理和 reader 契约。旧编译缓存不等于旧证据继续适用。
5. 新工具重新执行受影响的证明、模型、实现桥和实际负例，比较状态数/范围/方法及失败原因；不可只更新报告中的版本或 hash。Lean 改动要重跑全部必需定理与传递公理审计；Quint/backend 改动要重验原有限配置、故障动作、ITF 重放及负例。新增公理/范围变化须单独审查。
6. 旧报告保留原 SHA/版本/环境，标记失效原因和替代目录。历史自动复核目前仅支持 relation-protocol、knowledge-protocol、revision，仍需原始 checkout、完整影响链及相同保守依赖闭包/工具/环境。name-interval 的 `original_execution_origin_not_recorded` 不能豁免；其他域/外部实测未注册继承能力时重跑或保留 not_run。
7. 模型、提示词、供应商或支持环境变化触发相应真实质量/性能/设备重新评估；先冻结语料 split、阈值、重复次数、严重错误、设备/时长及评审者，再产生候选结果。需要费用/凭据/设备时由发布负责人落实授权，不由离线演示补填通过。

## 证据保存与搬移

`.github/workflows/ci.yml` 中的验证和发布证据 artifacts 按现有配置保留 14 天；其他工作流按各自期限，例如 `acceptance-audit.lock.yml` 包含 1 天和 3 天的 artifacts。发布负责人应在对应 artifact 实际过期前保存完整原包、GitHub run/artifact 身份、原 SHA、下载时间和包摘要；临时云目录与链接存在不证明原始文件仍可读取。不能只保存汇总 JSON 或截图，不能声称已重下/重放未实际取得的历史产物。

搬移保留原执行 cwd、工具位置和所有相对结构，不编辑 provenance 字段来适配新路径。使用该域支持的 reader 重新检查原始附件；某 reader 拒绝搬移/跨 checkout 时保留拒绝，回到受支持的原环境复核或在新目标重跑。历史证据失效、丢失、过期或缺少原始对象时保持 not_run/incomplete/stale；发布摘要标清原来源和未复核原因。

## 发布与接收者核对单

- [ ] 在 Linear 逐项确认实际模块维护者、验证维护者、发布负责人和交接接收者；更新 42 故事/HW/AC 的未归属项。
- [ ] 同一最终候选干净 SHA 的现有必需 CI 和 18 suite 全部完整成功；逐项核对实际 jobs/head，pending/skipped/cancelled/timeout 不算通过。
- [ ] AC-P01–12 四域 reader、Lean 必需定理/公理/差分、Quint 配置/重放/真实负例均有有效证据。保留输入域与所有环境假设。
- [ ] 真实 ASR/MT/知识/关系/TTS、物理设备、性能和支持环境升级恢复达到结果产生前冻结的门槛。历史适用性单独列原来源、影响分析及理由，不声称重新运行。
- [ ] 接收者在干净隔离 checkout 完成上述三态复现，记录原始来源与重跑方法；确认反例和工具升级的后续责任。
- [ ] 执行既有 `release` gate，十五完整业务义务和外部义务全部真实满足；记录最终结论、残余风险及明确批准的非支持范围交父票审查。禁止用未批准的“不适用”掩盖高影响缺口。

截至本文基线，KEJ-87/KEJ-61 仍未完成。尤其外部验收、全业务 reader、个人责任/接收者签收不能由本交接文档完成。最终结论不得写“整个应用已获得数学证明”。
