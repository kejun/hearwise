# 调度准入与条件公平性验证（KEJ-67）

## 结论边界与入口

本验证对应 HW03、userstories 6/30/31 与 M3，依赖 KEJ-64 已验证的知识工作流。它验证服务层翻译共享额度、真实队列规则、知识调度准入与资源释放，并对明确有限域检查有条件的最终启动性质。它不代表 HW03 全业务或所有 M3 验收均已完成。

```sh
npm run setup:scheduler
npm run verify:scheduler
npm run verify:scheduler -- --deep
npm run verify:scheduler:report -- verification-evidence/scheduler/run-<id> --release
```

实际运行参数以 `package.json` 和运行器为准。正式结论必须来自交付源码的完整运行与独立报告门禁；下面的成本探针不是交付提交的替代证据。

必须完成的证据是：Quint 类型检查、全部声明域的 TLC 安全检查、TLC 条件时序正反例、固定见证与抽样轨迹的真实实现重放、独立原始记录核对、真实边界及负向测试。Apalache BMC 是分开的诊断项；本轮固定后端报错，不能写成 bounded proof 或 passed。

配置与完整检查计划在 `verification/scheduler-protocol/config.json`。属性注册使用 HW-03-02 至 HW-03-06；原 HW-03-01 seed 保留原范围。

## 从生产代码到模型

### 翻译

`translation.qnt` 同时包含 `createTranslationScheduler` 的选择规则和 `server.mjs` 的服务层同步准入，不能只用队列长度代表服务额度。

- `running.size + interim <= 2`；可选翻译最多占一个槽
- 可选工作只有在没有等待最终句、可选槽空闲、总额度未满时才能准入
- `pump` 一个动作同步补满所有可用槽，最多启动两个任务
- `settle_final`、`settle_interim` 包含真实 provider 结束、`finally` 释放以及自动补槽；取消以真实 abort 到清理完成为一个宏步
- request token 与 segment identity 分离。等待去重只检查等待队列。已启动 token 1 不会阻止具有相同 segment identity 的 token 2 再次排队、启动
- `window`、`streak`、`speechTurn` 是模型内部状态，不伪装成可直接读取的生产状态。streak 在 3 饱和，只保留生产选择器使用的 `<3` / `>=3` 区别
- 防饥饿首先选择等待至少 10000ms、且此前连续实时派发至少三次的最老显式 background；随后才是隔槽 speech head 与最近两条 realtime 锁定窗口

重要区别：旧 realtime 落出最新窗口后，生产代码并不把其 `kind` 改成 background。持续新实时到达时，10000ms/三次规则不能推出旧 realtime 的一般公平性。本时序目标明确为 `kind=background` 的 token 0。

生产内存阈值为 500。第 501 项入队时，只移除最老 background；全 realtime 队列可以超过 500。模型不增加 realtime 丢弃或硬容量策略。

### 知识

`knowledge.qnt` 以真实持久任务作为调度输入；受控 v2 executor 提供合法的终态或待续 checkpoint。付费请求预算、协议修复和 extraction 结果语义不在此重新证明，仍由 KEJ-64 负责。

- 三个核心 job 的会话映射为 0→0、1→0、2→1；同会话串行，并按 `lastServed` 旋转会话顺序
- 默认最多两个在途知识任务；翻译 busy 时，新启动检查使用一个槽
- busy 从 `translationWaiting > 0 || translationRunning > 0 || interim > 0` 推导。真实桥将它绑定到真实翻译服务计数与队列，不使用脱离服务的任意布尔开关
- busy 从 false 变 true 时，已有两个任务继续运行。约束是“新启动前 running 小于当时限额”，不是“任意时刻 running 必须小于动态限额”
- grace、每会话最小启动间隔、持久 ready/retry、有效 key、共享 key 冷却与 provider 冷却共同限制准入
- `retry` / `continue` 各至多一次只是小域的环境选择次数，不是产品最大重试次数。二者均代表受控 v2 executor 持久写 pending/ready_at 后返回合法 continuation
- `rate_limit` 代表真实 v2 executor 以 `{ status: 429, retryAfterMs: 2000 }` 异常拒绝；调度器将任务持久化为 failed 并设置 key 冷却，不组合成 empty terminal 与 rateLimitMs 的虚构单片工作流结果
- 运行时逻辑 `phase` 与 SQLite `durable` 分开。`close` 等待实际 runtime 取消并释放槽，原 durable running 不伪装成 complete；删除会话时 durable 为 deleted、key 被清除
- `runtime.start` 同步异常直接进入真实定向测试，不用“已经在途后再发生 start_error”的虚假模型事件

持久写可用是本域前提。持续 SQLite BUSY、无法写失败终态、真实进程终止与恢复属于 KEJ-65。

## 独立有限域

这些域不是任意组合的乘积，也不证明任意数量任务。

| 域 | 大小与动作范围 | 不得混淆的边界 |
| --- | --- | --- |
| translation_small | 3 token、1 background、CAP=2；全部安全模型动作 | 缩小淘汰规则实例，不是真实500边界 |
| translation_alias | 3 token，其中两 token 共享 segment identity | 等待去重与在途身份分开 |
| translation_soft_cap | 3个 realtime、CAP=2 | 长度3合法，无 realtime 硬容量 |
| translation_replay | 4 token、生产 CAP=500 | 不触发淘汰；真实500/501另测 |
| knowledge_core | 3 job、2会话、共享key；并发/busy/轮转/grace/interval/普通终态/remove/close | 不混入每一种 provider/key/retry 环境变化 |
| knowledge_deadlines | 1 job；完整 key/provider/ready/continuation/retry 门控动作 | 不代表多job所有门控组合 |
| knowledge_cooldown_shared / separate | 2 job、共享或独立 key；持续翻译busy、冷却/时间/终态/清理 | key 保持有效，不混入无限授权变动 |
| translation_fair | 1个 background + 3个可循环 realtime 身份 | 目标是显式background；循环有限身份不等于任意新身份 |
| knowledge_fair | 3 job、2会话，会话0可循环积压；busy可变 | key/provider可用；有限调度冷却仍需显式时间推进 |

知识公平域的 recycle(0/1) 是有限身份的持续 backlog 抽象：它保留旧 token 的会话内位置和 readiness，表达竞争会话持续存在可准入工作。真实新 job 会有新的身份、from_sequence 和 created_at；这里不声称逐字段模拟新 job 创建。当前知识公平成功见证只含 clock/pump/settle/stutter，未把 recycle 伪重放成真实业务动作；知识适配器应将该抽象动作明确标为不可重放。随机模拟的真实重放只使用 translation_replay 域。 这一过近似只增加竞争会话的可准入工作，不帮助目标准入；有限域的条件时序结论与31条固定真实重放轨迹分别提供证据，不互相替代。

TLC 每个安全域都枚举该域的全部可达状态。早期把所有环境开关放在同一大域的成本探针已中断，不计为通过，也不以新分域声称旧大域已完成。

## 时间、等待与公平前提

翻译的 `advance_time` 显式跨过队列中既有任务的 10000ms 防饥饿阈值。成功、普通错误和取消不隐式前进时间。翻译 timeout 使用生产的 15000ms 参数：真实桥推进逻辑钟 15000ms，再 abort 并等待 finally；模型在同一宏步把当时等待任务标为 aged 后补槽。

知识时间用各截止条件的未到期/到期值表示。`advance_time` 对应延迟的一次事件循环跨过全部既有有限截止时间；之后 timer/pump 是显式动作。此域不声称每个任务恰好在最早毫秒启动，也不把合法 grace/cooldown/interval 等待当死锁。

两条时序性质都是“目标最终启动”，不是成功生成自然语言内容：

1. 目标没有被取消、删除或淘汰，所需授权与 provider 条件可用
2. 时间推进动作获得弱公平调度
3. 调度动作持续获得弱公平执行机会
4. 在途工作可终止，完成/错误/超时等 settle 动作获得弱公平执行机会

`fairStep` 直接包含与假设相同的 `fairClock`、`fairPump`、`fairFinish`，没有假设一个 Step 根本不可能执行的公平动作。目标启动或已排除后，观察域结束，三个 fair 动作明确 disabled；因此成功后可以无限 stutter，并满足全部弱公平假设。两个成功见证都检查了目标达到后的稳定尾迹。

每个模型分别删除 clock、pump、finish 的必要假设，得到真实 TLC 循环反例；两个选择器 mutation 在全部保留公平条件下仍出现饥饿反例。检查器对循环逐状态重算 enabled、实际业务状态变化与动作效果：保留的 WF 必须满足，被删除的 WF 必须确实失败；坏选择器还须有可解码的错误派发，包括循环闭合边上的派发。

Quint 的 TLC 包装传入 `-deadlock`，因此不宣称完成独立的全局 deadlock 检查。此处的无限等待判断来自明确的有限条件时序性质。随机模拟和有限成功见证都不单独构成一般活性证明。

## 真实重放与可观测投影

所有模型变量平铺导出 ITF。转换拒绝重复规范化变量名、未知结构与越域 token。两个真实投影为：

- 翻译：有序 queue、running、phase、interim、当前宏步 recentStarts
- 知识：phase、durable、running、lastServed、recentStarts、translationWaiting、translationRunning、interim、closed、listenings、keyAvailable

队列投影保留 ITF list 顺序。生产调度器的只读 `queuedIds` 返回实际等待队列的 segment ID 新数组，适配器将每项映射到唯一等待 token，不按 token 大小排序，也不暴露可修改的任务引用。独立 raw gate 按初始队列、成功入队、取消和真实 HTTP 启动重建剩余顺序；即使轨迹在下一次派发前结束，顺序差异也会拒绝。FIFO、最新窗口、锁定窗口与 speech head 的实际选取还由真实 HTTP `recentStarts` 顺序核对。

翻译桥对原 `server.mjs` 仅精确追加测试 export，并记录原始/加载源码哈希，不改生产函数体。平台 `Date.now` 与 `AbortSignal.timeout` 在隔离 worker 中受控；timeout 保留生产 15000 参数，并实际发出 abort，不实等十五秒。queue-only 到 service pump 的分步是明确的测试控制门点；额外真实 HTTP 测试验证入口自动 pump 的连接。

多数 final 轨迹走生产 `task.done` 支路以控制任务身份；普通持久 background 的成功、错误、取消另用真实 SQLite 路径核对原文、译文、状态与 diagnostics。知识桥使用实际 `createKnowledgeScheduler`、runtime、provider admission 和 SQLite；executor seam 只控制合法 v2 结果，不冒充付费 provider 逻辑。

真实桥之外，独立 raw gate 从原始 HTTP ledger、服务 live counters、SQLite 快照和启动记录重建投影；不信任适配器预计算 expected 字段。ready/cooldown flags 属模型 ghost：实际截止规则由原始创建时间、ready_at、真实启动时间、provider.readyAt 和受控 rate-limit 输入独立核对。 知识桥在实际 markJob(running) 调用之前只读捕获 checkpoint，透传原参数和返回值、不改变事务或调度顺序；门禁将该记录绑定到前一步 SQLite 快照。runningBefore 与 previousStart 从先前真实调用和准入记录重建，part ready_at 按真实 continuation 写入核对，共享冷却从 block/429 事件重建。翻译完成 callback 必须与实际结束的 HTTP ledger 一一对应。

## 工具链与证据门禁

固定 Quint 0.33.0、Apalache 0.62.1 及其捆绑 TLC 1.8；校验方式见 `toolchain.json`。Quint 原生 `--backend tlc --temporal` 用于完整时序检查，不使用 Apalache 的实验性时序模式。

配置拆成 core、fairness、mutations、replay 文件，避免 Quint 将过多实例分析 IR 一起送入 RPC 时超过 Apalache 的 20,000,000 字符 JSON 限制。拆分只改变文件组织，不改变单个模块语义。

`checker.mjs` 的 `checkTlcOutput(raw, execution, check)` 是纯检查器：

- 正向必须正常退出、完整可达图、最终 queue=0；时序还必须完成 complete-state-space temporal sweep
- 安全 mutation 必须从完整状态中重算实际额度、生命周期、准入时机或 busy 撤销违规；exit=1 或 counterexample 字样不够
- 时序反例必须有连续完整 State 序列、合法 Back-to-state 或 stuttering 锚点，目标全程未启动且符合资格，并复核循环公平性
- 仅支持本域实际使用的安全整数、字符串、布尔、整数集合/列表和整数键有限 map；未知语法、截断、重复变量、工具异常一律拒绝

Quint 0.33 的 TLC 后端不返回 trace 对象，并删除临时 TLC 目录；`--out-itf` 不能导出 TLC lasso。报告保留原始 stdout 与已解析循环锚点，不制造 ITF loop metadata。Quint witness/simulation 的 ITF 与 TLC 时序反例是不同证据来源。

### 已实测成本与 profile

本轮源码成本探针的七个完整安全域 distinct state 数为：32311、21965、26273、8400、17763、439、1576。翻译与知识时序正向分别为 4940、1009，均完成完整时序扫描且 queue=0。24项模型检查包括7安全正向、2时序正向、6去假设时序反例、2选择器时序反例、7安全 mutation，全部获得对应的严格可解析结果。

单项完整命令最长约33秒（含编译/启动）。固定单项 TLC 上限180秒；中断或超时只会使证据不完整，不能变绿。fast 与 deep 使用相同完整 TLC 域，区别只在抽样：

- fast：seed 20261014，100样本，每条40步，保留5条；模拟本体约1.2秒
- deep：seed 20261015，500样本，每条80步，保留10条；模拟本体约11.7秒

固定见证共31条，含两种模型的公平成功尾迹。抽样仅用于探索和真实重放。完整工具门禁、真实边界与各类报告篡改测试仍须在交付源码重新运行；不得把这些开发探针直接当作 clean-source 发布证据。

### Apalache 的独立失败诊断

最初 whole-state 嵌套表达在 InlinePass 后断开连接。将翻译批量 pump 等价改为直接计算两个选择后，固定 Apalache 0.62.1 能通过内联进入 SMT，但 depth=4 probe 报 `key not found: $C$54`。该次源码哈希、命令、工具版本、退出码和原始日志保存在 `verification/scheduler-protocol/diagnostics/apalache-0.62.1-depth4.json` 及 `.log`。

这是后端错误，不是模型反例，也不是 bounded pass。TLC 的有限安全/时序检查与真实实现重放在同一模型源码独立完成。若以后改变模型、后端或运行方式，须重新探测并明确区分诊断与 required evidence。
