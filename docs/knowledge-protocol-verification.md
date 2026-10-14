# 知识请求预算与纠正协议验证（KEJ-64）

本验证针对一个知识任务在进程持续存活时的自动处理周期。生产代码使用原有 `createKnowledgeScheduler`、`createKnowledgeWorkflow` 和真实临时 SQLite；模型、供应商桩和测试门点不修改生产控制流。原有关系试点 HW-04-01 与 KEJ-63 的 HW-04-02..05 保持独立。

| 性质卡 | 需求 | 原验收映射 |
| --- | --- | --- |
| HW-04-06 | 调用前持久预留、共享额外/协议预算、分片独立一次纠正 | AC-P01、AC-P02 |
| HW-04-07 | 已接受结果保留、sourceIndex 至多应用一次、定向纠正、正常空结果 | AC-P02、AC-P10 |
| HW-04-08 | 付费响应后存储失败不重发、通知失败不回滚 | AC-P05、AC-P06 |
| HW-04-09 | 混合错误预算、认证终止、429 与分片间隔/冷却 | AC-P09 |

性质卡在 `verification/knowledge-protocol/properties.mjs`。卡片登记需求、映射和证据范围，不是通过记录。任何通过结论都必须绑定某次完整运行的源码、配置、日志及证据文件。

## 运行与工具链

```bash
npm run setup:knowledge-protocol
npm run verify:knowledge-protocol -- --release
npm run verify:knowledge-protocol -- --release --deep
npm run verify:knowledge-protocol:report -- RUN_DIR --release
```

使用仓库要求的 Node 24 和 Java 21。Quint 固定为本 checkout 锁文件中的 `@informalsystems/quint@0.33.0`；模拟与确定性测试显式使用 TypeScript 后端。Apalache 固定为 0.62.1，归档和安装 JAR 均按 `toolchain.json` 的 SHA256 校验；同一 JAR 提供上游声明的 TLC 1.8.0 与 Z3 4.14.1，不另下载模拟 evaluator。

`QUINT_HOME` 是缓存根目录本身，例如 `/tmp/hearwise-quint`。后端在 `$QUINT_HOME/apalache-dist-0.62.1/apalache`，不再追加 `.quint`。每次检查使用独立本地服务端口，并在超时、取消和完成时清理整个子进程组。不能依赖 `--apalache-version` 核验已运行的未知服务。

每次运行使用新的证据目录。开发测量和脏工作区证据不是发布通过；`--release` 应拒绝不完整、过期、被修改或未绑定干净源码的证据。fast 与 deep 必须分别记录，不能借用另一 profile 的成功结果。

## 有限模型的真实范围

`protocol.qnt` 定义状态、动作和不变量，`configurations.qnt` 实例化两种正常配置：

- `single`：`PARTS = {0}`。
- `two_parts`：`PARTS = {0, 1}`，按分片编号顺序执行。两个分片共享同一 `extra_requests` 和 `protocol_retries`。

两种配置在每次合法响应处都自由选择所有声明的响应类别，包含预留失败、成功响应后的提交失败与通知失败。多分片不是固定响应脚本。每分片最多两个条目槽，不声明任意条目数或分片数的一般性证明。

初始抽取可返回：`ok`、`empty`、`partial`、`rejected`、`unrepairable`、`protocol`、`transient`、`auth`、`rate_limit`、`rate_limit_long`、`unexpected`。纠正可返回 `ok`、`empty` 及相同错误类别。

| 响应 | 接受槽 | 未解槽 | 带锚点槽 |
| --- | --- | --- | --- |
| 初始 ok | {0} | {} | {} |
| 初始 empty | {} | {} | {} |
| 初始 partial | {0} | {1} | {1} |
| 初始 rejected | {} | {0} | {0} |
| 初始 unrepairable | {} | {0} | {} |
| 纠正 ok | 原接受槽并入当前带锚点未解槽 | 移除已接受槽 | 移除已接受槽 |
| 纠正 empty/错误 | 保留原接受槽 | 保留未解槽 | 保留锚点 |

`sourceIndex` 是分片内身份，分片 0 的 slot0 与分片 1 的 slot0 不相同。合法初始空结果走 `empty`；无锚点拒绝项走 `invalid`，但都不触发纠正。空纠正不等于正常初始空结果，它保留未解目标并得到 `partial` 或 `invalid`。

## 状态与实现投影

标量包括 `stage/outcome/ready/extra_requests/protocol_retries/cycle`。每分片映射包括 `phase/initial_requests/repair_reserved/extract_calls/repair_calls/initial_complete/retry_kind/accepted/unresolved/anchored/replies`。

- `phase` 直接读真实 `extraction_parts.phase`，取值为 `extract_pending/extract_inflight/repair_pending/repair_inflight/done`。
- `stage` 是测试观察门点，取值为 `idle/reserved/inflight/received/done`；它不冒充数据库阶段。
- `accepted/unresolved/anchored` 来自真实检查点的 `sourceIndex`；供应商调用计数独立于持久预留计数，避免用同一变量自证。
- `ready` 仅在下一 dispatch 未到期的 `idle` 为 false。活跃及终止阶段为 true；它不是另一个待执行任务标志。
- `accepted_ever` 和 `apply_counts` 只存在于模型，用来检测历史结果丢失与重复应用；它们不进入实现相等性投影。真实适配器另核对结果唯一性、事实和版本。
- `cycle` 在有限模型中始终为 1。自动恢复与人工重试由明确标记的持久化补充证据覆盖。

ITF 整数按 `#bigint` 解码，映射按 `#map` 解码，整数集合按 `#set` 规范化为排序且不重复的数组。模块命名空间只取最后的变量名后缀；同名冲突、缺字段、非法编码必须拒绝，不静默补齐。

| 动作 | 实际接点及可观察状态 |
| --- | --- |
| init | 使用公开初始化接口和合法不可变 focus_refs 建立任务；零预留、零调用 |
| admit | 启动真实调度器，在 context.step 供应商接点前停住；SQLite 预留已成功提交 |
| send | 放开供应商调用门点；独立 extract/repair 调用计数增加 |
| response | 桩返回成功或抛错；成功留在响应包装门点，异常由真实 catch、save、settle 处理 |
| commit | 放开成功响应，真实事务、同步通知、后续 settle 在同一个继续执行段完成 |
| commit_notify_failure | 同上，但通知回调抛错；不得伪造提交和通知之间的异步边界 |
| commit_fail | 成功付费响应后使真实检查点事务失败；真实调度器按已有接受结果收敛 partial/invalid |
| reserve_fail | 让当前初始或纠正预留事务失败；无新预留、无新供应商调用 |
| advance_time | 将注入时钟推进到真实 nextJob 的间隔、重试或冷却截止时间 |
| stutter | 终态只读自环，不再调用工作流 |

知识工作流在 `await extract/repair` 之后同步保存和通知，没有关系工作流的异步提交/通知接点。因此不能复用关系模型的 `committed → notify` 分段来声称真实并发边界。

存储失败后的 `stage` 是 done，但持久 `phase` 可以仍为 inflight；预留失败后可以仍为 pending。这是实际调度器的异常终态，不应为了匹配模型擅自将阶段改为 done。已有接受结果时 job 为 complete/partial，否则为 failed/invalid。`terminalOutcome` 使用独立的完整分类等式，不调用转换中的 `result` helper：活跃阶段为 none；终态且所有 phase=done、所有 initial_complete=true、所有 unresolved 为空时，有已接受结果为 ok，否则为 empty；其他终态按有无已接受结果取 partial/invalid。这样正常成功误标 partial、正常空误标 invalid，或首分片失败后把整批误标 ok 都不能满足 Safety。

## 预算、错误分类与时间

一次自动周期内，全任务最多额外抽取两次，协议错误触发的重试最多一次。每个分片的第一次抽取不消耗 extra_requests；后续抽取预留时才增加。纠正有独立的 `repair_reserved`，不消耗这两个额外抽取预算。成功的前一分片不会因后一分片失败而重放。

`protocol_retries` 在以 protocol 原因再次预留抽取时增加，不是协议错误返回次数。协议→暂态与暂态→协议都可能合法用完两个 extra；不能照搬关系窗口“累计请求数小于二”的协议判断。

认证配置错误会停止所有尚未完成分片，保留已接受结果。429 参与可重试判断并持久化冷却；Retry-After 超过 300000 毫秒时不自动重试。即使纠正本身永不自动重试，纠正429的冷却仍约束下一分片。

模型把时间压缩为到期前/到期后：provider 调用、响应交付、commit 与通知期间虚拟时钟保持不变，只有 `advance_time` 跳到持久 deadline。因此当前域中 continuation 都先等待，`admit` 要求 ready。真实慢响应已越过2000毫秒间隔、因而下一次 dispatch 可即时执行的时序不在当前模型时间域；这不是生产实现要求每次响应后额外再等2000毫秒。2000 毫秒最小间隔、实际 Retry-After 和持久化截止时间必须由真实适配器与补充测试核验，不能只用布尔模型宣布毫秒级证明。

## 各类证据与开发测量

### TLC 完整有限域探索

TLC 必须出现正常完成消息、零剩余队列并正常退出，不能使用模拟、max-depth 截断或中途进度替代完整探索。2026-10-14 的首次开发测量为：

| 配置 | 生成状态 | 唯一状态 | 剩余队列 | 完整图搜索深度 | 外层耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| single | 846 | 536 | 0 | 19 | 7.37 秒 |
| two_parts | 78,872 | 40,912 | 0 | 29 | 11.22 秒 |

收紧 terminalOutcome 后也重新完成了两个 TLC 域，状态数和图深度与表中一致；表中耗时是首次成本测量。这些数值不是将来运行的硬编码成功条件，也不是无界执行长度。原始日志包含指纹碰撞概率估计；应与完成状态一起保留。

### Apalache 有界检查

fast 对 single/two_parts 都检查12步，deep 都检查18步。两个 profile 使用相同的完整 TLC 有限域。配置内每个 profile 声明自己的最大转换步数。初始状态是第 0 步，不能将到达某深度的进行中日志当作该界限已通过。首次成本探测先执行 depth8，再执行 depth12 与 depth18；这些成本数字来自收紧 terminalOutcome 不变量之前的版本，仅用于选界限，不能作为收紧后模型的 BMC 通过记录。最终 profile 和其完成状态以 `config.json` 及本次报告为准。

开发探测均已正常退出完成：depth12 的 single 为12.91秒、two_parts 为30.64秒；depth18 的 single 为18.24秒、two_parts 为224.30秒。单项成本探测上限为240秒，均未超时；这也说明 deep 的两个分片组合比 fast 明显更贵。开发测量使用未提交源码，不能替代最终发布证据。

### 确定性见证与有种子模拟

39 个确定性见证使用与模型检查完全相同的动作：single 28 个、two_parts 11 个；固定 seed42、max-samples1，并从 Quint 导出真实 ITF。路径覆盖成功/空/partial、定向纠正成功/空/错误、无锚点、初始和纠正预留/提交失败、通知失败、协议/暂态/混合预算、认证错误、429、过长 Retry-After、共享两分片预算和结果保留。

模拟配置为 TypeScript 后端、seed20261014、每个 main 100 samples、最多40步、保留5条 ITF。模拟只覆盖有限样本，不替代 TLC。确定性见证保证指定路径被执行，不依赖随机命中。

所有选中 ITF 逐步进入真实 scheduler/workflow/SQLite 适配器，比较业务投影并检查持久检查点、知识结果与事实。driver 不计算“预期状态”；预期只能来自模型轨迹。首次分歧保留最短失败前缀并区分 `matched`、`implementation_mismatch` 与 `unreplayable`。

### 负向对照

| 模型变体 | 预期失败性质 | 首次开发反例 |
| --- | --- | --- |
| mutant_send_without_reserve | budgetBeforeSend | 第2步：调用1、预留0 |
| mutant_third_extra | sharedBudget | 第13步：extra_requests=3、initial_requests=4 |
| mutant_accepted_loss | acceptedPreserved | 第9步：partial→空纠正后 accepted={}、accepted_ever={0} |
| mutant_wrong_terminal_outcome | terminalOutcome | 第4步：合法 empty 响应提交后误标 invalid；这条错误曾满足旧的单向约束 |

负向轨迹必须由模型合法转换生成，不能伪造变量赋值或将轨迹解析错误算作检出缺陷。counterexample 非零退出只有在完成、真实 ITF 存在、且目标性质确实被违反时才算负向检查通过。还需真实实现变体的首次投影分歧，证明重放链能拒绝错误实现。

## 持久化恢复与人工重试的范围

`recoverKnowledgeCheckpoints` 不创建新 cycle，不重置全任务 extra/protocol 预算；已预留抽取回到 pending，已预留纠正标为 done 并记录中断。仅显式 `store.retry` 会为可重试任务增加 cycle、重置当前周期额外预算，并只恢复未解决工作；已接受 sourceIndex 和完整成功分片保留。

这里允许使用静止检查点重开数据库及针对恢复方法的真实 SQLite 测试来验证这些规则。它们必须在报告中单独标记，不冒充包含 crash 动作的模型轨迹，更不冒充真实进程 kill/restart 的完整故障矩阵。已有 `test/knowledge-checkpoint.test.mjs` 和 `test/knowledge-workflow.test.mjs` 也是明确范围的补充实现资产，不自动等于本轮已执行通过。

## 不覆盖的范围

本次不证明全 M1。真实进程崩溃交错属于 KEJ-65；取消、删除、epoch/来源变化、多任务共享密钥公平性、无限分片/条目、供应商语义质量和持续磁盘故障不在这两个有限模型配置内。性质卡、干净源码证据、有限域探索、深度检查和真实实现回放应分别报告，不能互相替代。
