# KEJ-65：进程崩溃与恢复验证

## 结论的精确范围

本套验证研究应用进程在已知工作流边界被 `SIGKILL` 后，使用同一 SQLite 文件启动全新 PID 的恢复行为。它不是同进程 `close/reopen` 测试，也不是断电、硬盘损坏、操作系统崩溃或存储控制器持久性的证明。

`verification/process-crash/` 是两个独立 Quint 模型及其公共配置、见证和性质卡。它不替换 `verification/relation-protocol/`（KEJ-63）或 `verification/knowledge-protocol/`（KEJ-64），不缩小它们原有的完整检查域。旧域继续独立验证。新性质编号为 HW-04-10..13，不改变其他性质组的承诺。

有限域为：

- 最多一次全进程崩溃；`generation` 从 0 到 1。实际 PID、退出信号、握手记录另存实现证据，PID 不进入模型。
- 关系单 actor，最大累计请求数 3，全部原有响应、预留失败、一次性提交失败及通知失败选择。
- 真实关系 scheduler 使用现有可注入选项 quietMs=0、minStartIntervalMs=0、maxConcurrent=声明CAP，以隔离请求/恢复协议；本profile不证明关系准入间隔、前台优先与一般公平性。知识 scheduler 保留现有2000毫秒派发间隔。
- 关系三 actors：0 为 session0/window0，1 为 session1/window0，2 为 session0/window1；分别检查容量 1 和 2。actor0 第一次预留后的响应为 protocol，后续为 ok；actor1 第一次为 transient，后续为 empty；actor2 为 filtered。穷举这些脚本的合法交错，不宣称三任务任意响应组合。
- 知识一个或两个顺序分片、一个自动周期；所有合法初始/纠正响应和错误选择、一次性预留/提交故障与通知故障保持开放，无多分片固定响应脚本。所有分片共享额外抽取上限 2、协议重试上限 1；各分片独立纠正预留上限 1。
- 每个知识分片最多两个抽象 sourceIndex。ok 接受 slot0，partial 接受 slot0 并留下带锚点 slot1，rejected 留下带锚点 slot0，unrepairable 留下无锚点 slot0。纠正成功只接受当前有锚点的未解槽。
- 虚拟时钟在外呼、响应、提交、通知和崩溃恢复期间保持不变。只有 `advance_time` 跳到实际持久化截止时间与调度器本代准入间隔的较晚值。慢响应已经越过间隔、可立即继续的时序不在本时间域。

没有任意次数崩溃、任意数量任务/分片/条目、取消删除、来源/epoch变化、人工重试新周期、调度公平性、供应商语义质量或 M1 全量正确性保证。

## 四个真实边界

1. 预留事务已成功返回，供应商 HTTP 请求尚未发出。
2. 父进程 HTTP 服务已记录请求，但应用尚未取得结果。外部累计调用已增加。
3. 实际请求结果已返回应用，结果事务尚未提交。响应只在当前进程内存里。
4. 真实结果事务 COMMIT 已结束，但首个结果通知尚未运行。

边界必须由应用工作进程与父控制器握手确认，随后父控制器对整个工作进程发送 `SIGKILL`，确认旧 PID 以该信号退出，再启动新 PID。不能只杀一个 actor；同进程内全部 actor 都失去内存状态。

第四点用测试专用同步包装：调用真实保存方法，原方法返回后写入文件 marker，然后做有期限的同步等待。知识原有 `checkpoint_committed` 事件晚于 `save()` 内的 `onItems/onProgress`，不能拿该事件冒充首通知前边界。包装不改生产代码、不插入生产 `await`。同步暂停期间整个 JavaScript 进程都不能处理另一 actor 的动作；关系模型在任一 actor 处于 committed 时仅允许该 actor 的 notify/notify_fail 或全局 crash。

父观察器只用只读 `DatabaseSync` 读取同一数据库，不构造 `ListeningStore`，避免观察本身触发恢复。父 HTTP 服务和账本不会随应用进程终止，累计真实请求必须跨代保留。工作流投影来自实际持久化状态和账本，不能从 Quint expected 状态写入数据库。

## 持久状态与恢复映射

真实恢复顺序见 `storage.mjs` 的 `ListeningStore` 构造器：先 `recoverKnowledgeCheckpoints()`、`recoverRelationJobs()`，再处理普通 extraction running→pending 恢复。模型的 observational stage 与数据库 part phase 是不同概念。

### 知识

- extract_inflight → extract_pending。initial_requests、extra_requests、protocol_retries、stats.retry_kind、last_request_at 等保留。预留但未发送也保守占用预算。
- repair_inflight → done。repair_reserved 仍为 1；已接受结果和未解目标保留，真实存储增加 REPAIR_INTERRUPTED 信息，不自动重新发送纠正。
- 初始或纠正结果已提交时，part 可能已经 done 或 repair_pending，但 job 仍是 pending、outcome 为空。恢复不能凭 part 状态捏造任务已终结。
- 恢复后的内存 replies 全部清 none，stage 回 idle。本模型允许崩溃的四个边界都发生在固定时钟的请求间隔内，因此 ready=false。
- 即使所有 part 都 done，实际调度器 `nextJob()` 仍可能受 last_request_at+2000 限制。先 advance_time，到期后用 `settle` 无外呼完成 job。
- 调度器每次派发（包括不外呼的 settle_exhausted）仍记录本代 lastStarted，并要求 2000 毫秒派发间隔。适配器从真实 execute 入口观测 schedulerReadyAt；它不是新增持久字段，重启后清零，已有请求的持久截止仍有效。
- 已预留的初始请求恢复为 extract_pending，但 extra 或 protocol 预算已经耗尽时，`settle_exhausted` 标记该片 done 并收敛/继续。它不是一次新的供应商请求。没有此动作会得到虚假的恢复死锁。
- commit 只持久保存结果并到 committed，outcome 仍 none；notify/notify_fail 继续执行真实通知及 settle。accepted_ever/apply_counts 和预留历史是验证 ghost，不参与实现恢复。

### 关系

- reserved/inflight/received 对应未提交结果的 running job；恢复为 pending（模型 idle）。如果累计请求数已达 3，则恢复为 failed（模型 done/failed）。预算及尝试 journal 保留。
- 已提交结果的 job 已是 complete/partial；恢复把 observational committed 变为 done，保留结果和 outcome，不再外呼。
- 已在 retry_wait 的 actor 保留其待重试状态及截止时间；advance_time 后才能再次准入。
- 所有 replies 恢复清 none。收到但未提交的成功响应不持久；恢复允许在剩余预算内再次外呼。进程持续存活时的 paidResponseNoRetry 性质不能不加条件地跨越进程消失。
- crash 时关系每 actor 的 observational phase 仍作为最后观测快照保留，另用 processState=down 明确进程已不存在；它不意味着死进程仍能执行动作。

两域都没有给已经 terminal 的进程新增 crash/recover 转换。terminal stutter 保持业务投影。未知结果可能已经在供应商侧完成，本系统没有供应商幂等协议，不能承诺供应商 exactly-once。

## ITF、可执行见证和负向控制

配置包含五个 main：relation_single、relation_multi_cap1、relation_multi_cap2、knowledge_single、knowledge_two_parts。固定见证共 29 条，分别为 8、1、2、14、4 条，使用模型检查的同一组动作导出原生 ITF。

见证包含两域四个崩溃点、纠正四点、预留但未发送仍占预算、发送/收到但未提交后的新调用、第三次预算耗尽、协议预算耗尽、跨分片保留结果、全局两个 inflight actor、已提交与另一已预留 actor 的全局崩溃、已提交后无调用 settle、以及恢复后的提交/通知故障。`normalSuccessTest` 特指关系预留→崩溃→恢复→成功，用于能确实触发恢复的实现负向入口；无崩溃普通成功称 `relationNoCrashSuccessTest`。

导出变量须剥离到最后一个 `::` 后的名称并拒绝重复名称；ITF `#map`、`#set` 和 `#bigint` 解码后逐步比较。关系沿用原七个业务字段加 processState/generation；知识沿用原十七个业务字段加这两个字段。模型历史 ghost 不冒充实现数据。

三个模型负向控制都走合法转移：

- mutant_relation_reset_on_recovery：预留→crash→recover，错误清零 counts；3 步内违反 durableReservationHistory。
- mutant_knowledge_reset_on_recovery：预留→crash→recover，错误清零初始/纠正及共享预算；3 步内违反 durableReservationHistory。
- mutant_knowledge_reapply_committed：结果提交→crash→recover，错误再次应用已接受槽；6 步内违反 sourceIndexExactlyOnce。

负向检查必须保留实际 counterexample ITF，并验证其具体违背的性质，不能仅凭非零退出码或任何错误日志判定成功。实现负向控制必须从合法固定 ITF 产生实际数据库/账本与 expected 的首个差异，保留该最短失败前缀。

## SQLite 故障与诊断的边界

模型的 reserve_fail/commit_fail 是一次性故障，假设后续失败状态能够写入数据库；notify_fail 是已捕获的回调异常。真实HTTP夹具将 unexpected 映射为非重试、非全任务配置故障的 418；401/auth 仍停止全部知识分片。两片回归分别验证后片可继续与配置失败全停，不能把422配置错误假装成普通 unexpected。

它们不能证明持续 SQLITE_BUSY、磁盘写满或持续终结写入失败时任务一定安全终结。

真实 SQLite 锁/写失败检查必须分别记录：请求是否发出、预留与已接受数据是否保留、实际 SQLite 错误码与诊断、失败终结是否真正落库、恢复锁释放后的可继续操作性。若持续锁暴露缺口，必须报告缺口，不得把失败状态保存失败改写成完成，也不能用只会抛一次错误的桩替代持续锁。


本次真实独立连接 `BEGIN IMMEDIATE` 锁矩阵曾复现知识调度器缺口：已付费响应后的结果写入和第一次失败终态写入分别触发原有 3000 毫秒 busy_timeout，失败写被丢弃，留下 running job。修复只保留待写失败终态，先结清再准入，1000 毫秒有界唤醒重试 SQLite 写入；不重跑付费工作流、不增加或重置预算。终态写在同一事务中核对 attempts 和 v2 cycle，只作用于原 pending/running 任务，避免覆盖已经成功、删除或明确重试的新周期；remove/close 清理待写项。真实锁释放后终态落库和额外的 timer、旧写隔离测试分别验收。

另独立修正 KEJ-64 模型的响应/提交 actor 守卫：三类动作必须指向 extract_inflight/repair_inflight 分片，拒绝把后片请求归给已 done 的前片。真实工作流始终捕获同一分片；这是模型合法动作域修正，不是生产请求路由故障。保留三个禁用动作回归，原一/二分片、全部响应选择、39条见证和完整 TLC/BMC/真实重放独立重跑。

没有通知 outbox。COMMIT 后首通知前崩溃可以留下已持久结果和缺失通知；验证只要求不回滚结果、不重发付费请求，不承诺补发或 exactly-once 通知。

## 检查成本与通过标准

工具链固定为 Quint 0.33.0、Apalache 0.62.1、其内置 TLC 1.8.0，具体摘要见 toolchain.json。公共 setup 缓存可以复用，但两域的通过状态和报告不能互相借用。

- TLC 五域都必须完整枚举、无违例且 queue=0；模型检查深度不是 Apalache 深度。
- fast Apalache 深度为 relation_single=8、relation_multi_cap1/2=6、knowledge_single/two_parts=8。它们是新崩溃域的明确有界检查，不改变旧63/64深度或有限域。
- deep 独立报告为 relation_single=15、relation_multi_cap1/2=8、knowledge_single/two_parts=12；未运行或未完成不得声称通过。
- 固定种子模拟为 seed=20261014、100 samples、最大40步、每域选5条重放。随机模拟与固定见证、TLC、BMC是不同证据。
- 保持既有 runner 的单检查与外层期限。超时、取消、未完成、缺失或源摘要变化均不是通过。先测成本再给定profile，不通过增加时限或删核心边界造绿。

开发期初始成本探测在同步 COMMIT 屏障和当前 inflight-part 守卫下，TLC 已完整遍历：relation_single 296 个不同状态、multi_cap1 2898、multi_cap2 17685、knowledge_single 1754、knowledge_two_parts 87774；各命令约 9.7–20.4 秒。此数据只是开发期测量，不能替代最终已提交、干净源码上的完整报告。BMC 的具体运行完成状态与时间以最终报告为准。

发布门禁必须独立核对源码 SHA/dirty、模型与配置摘要、工具链摘要、完整运行结果、每个 ITF 原始文件和对应实现重放。局部打印“passed”、固定见证全过或某个模型已完成，均不能代表整套验证通过。

## 运行和证据

```sh
npm run setup:process-crash
npm run verify:process-crash -- --release
npm run verify:process-crash:report -- verification-evidence/process-crash/run-<id> --release
```

独立 CI job 执行 fast profile 并上传完整日志、ITF、进程/SQLite/供应商账本观测、负例及报告。Node、浏览器、Lean、原关系与知识模型 jobs 仍独立保留。deep 需显式 `--deep`；本次若只完成 fast，不能宣称 deep 通过。
