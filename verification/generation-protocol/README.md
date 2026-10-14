# KEJ-66：取消、请求代次与迟到结果隔离

本目录检查知识与关系工作流的请求生命周期边界。它不是新的产品调度器，也不修改产品请求额度。真实 SQLite/workflow 检查、模型穷举、指定深度 BMC 和固定见证必须分别报告；模型通过不等于真实实现重放通过。

## 实际字段映射

| 模型字段 | 知识工作流 | 关系工作流 |
| --- | --- | --- |
| `activeOwner(actor)` | scheduler `running` entry 与 runtime `TaskHandle` 的身份；同 listening 最多一个 | scheduler entry/controller 的身份；job ID 维度并发 |
| `generation(actor)` | 已取消 dispatch 对应的后续新 job 的观测编号 0/1；不是 `progress_json.cycle`，也不是新增持久字段 | listening 当前 round/epoch，归一化为 0/1；同 listening 的 actor 一起推进 |
| `requestGeneration(requestId)` | 捕获的原 dispatch/context 的代次 | 原 job 的 epoch；attempt 在创建请求时捕获，不读后来 job 的计数 |
| `aborted(requestId)` | 业务 continuation 前已失效的请求/context | 取消前捕获的 request/controller fence |
| `physical`、`calls` | 实际供应商调用的独立观测；取消后仍可悬挂 | 同左；不能拿本地 slot 数当外部连接/付费请求数 |
| `reserved` | 该 dispatch 的 `initial_requests` 或 `repair_reserved` 持久预留所对应的一次尝试 | `beginRelationRequest` 后的 request count 和 `relation_requests(job_id,attempt)` |
| `business`、`outcome` | 通过真实 workflow 检查后提交的知识结果、checkpoint/job 状态 | 通过 signal、round、epoch 与存储检查后提交的图结果/job 状态 |
| `usage` | 固定为 `none`；没有虚构知识持久 usage journal | 原 `(job_id,attempt)` 行的费用存在及非迟到/迟到分类 |
| `present` | listening 行及其外键关联行是否仍存在 | 同左 |

`requestId = actor * 2 + generation` 是模型编码，不是数据库主键。实际适配器须维护它到真实 job/attempt 的映射。`outcome=failed` 是不重试的终结分类：知识实际为 `invalid`，关系实际为 `failed`；不得把这个归一化值当作数据库原始字符串。

`authorizedBusiness` 和 `authorizedOutcome` 是验证用 ghost，记录合法提交的独立历史；它们不是实现输入，也不能驱动数据库补写。

知识 runtime 的子 step scope 正常结束时也会 abort 子 signal。因此模型 `aborted` 不可直接用任意已关闭子 scope 的最终 `signal.aborted` 填充，必须结合取消发生时间、业务 continuation 和实际 owner 终态。

关系实际 usage outcome 可从 `response_received` 被 commit 改成 `complete`/`partial`，随后真实 `onUsage` 又可以覆盖它。模型的 `response_received` 是非迟到归类，不宣称数据库字符串始终不变。真实重放仍须检查原始 journal 行、token 数与对应动作的实际 outcome。

## 动作与观察点

- `reserve(a)`：获得本地逻辑 owner，并在外呼前持久预留。与 `send(r)` 分开，所以允许取消发生在预留后、外呼前。
- `send(r)`：启动一个真实物理请求；供应商可以完全忽略 abort。
- `cancel(s)`：在本地 abort race 和 scheduler cleanup 已完成后观察。它释放逻辑 slot，不等供应商结束。关系取消当前 listening round 的所有 pending/running jobs；知识只取消活跃 handle，其他 pending jobs 仍可准入，旧 inflight checkpoint 及预算保留。
- `newGeneration(target)`：知识 `target` 是已取消 actor 对应的后续新 job；不修改其他 pending actor 或持久 cycle。关系 `target` 是 listening，表示显式 `enableRelations` 创建下一 round/epoch。已经成功的关系 window 不因这个动作凭空重跑。
- `response(r, result)`：供应商完成后，执行允许的 workflow continuation、同步持久提交和本地清理，再观察。成功或非重试失败均可自由选择。非重试失败可用 HTTP 418 实现；不把会阻塞同 key 的认证失败混为相同效果。
- `usage(r)`：真实关系 `onUsage` 回调或 settlement 的原 attempt upsert，可在响应前、响应后或取消后重复发生；不能给新 attempt 记账。
- `duplicate(r)`：同一个 JavaScript Promise 的重复 resolve/reject。它不能产生第二次业务 callback，是业务 stutter。这里没有虚构可直接重复调用 workflow 成功 continuation 的生产入口。
- `delete(s)`：删除 listening 及外键级联业务/预算/usage 行，并取消其本地 owner。外部请求观测仍保留，随后晚到不能重建任何行。
- `restart`：关闭并重新打开已静止的 scheduler/store。被删除 listening 的外部请求可仍然悬挂。未删除 listening 不能留有被取消的请求，因为真实知识 store 重开会将这种旧 checkpoint 恢复为 pending，需要另一套恢复/重试模型。此处没有用 stutter 假装那段恢复已经正确。

取消后晚到不会再次执行 scheduler/runtime 的同一次 `finally`。模型检查旧响应期间新 owner 仍然存在，不凭空制造第二个旧 cleanup 入口。

## 声明的有限域

`config.json` 是可机读入口，`domains` 显式区分 `traceMain`/`specification` 与 `finiteMain`/`finiteSpecification`。

1. 知识和关系各一个 single 域：一个 actor、一个 listening、CAP=1。
2. 知识和关系各两个 multi 域：三个 actor、两个 listening、CAP=1 与 CAP=2。actor 0/2 属于 listening 0；actor 1 属于 listening 1。
3. 每 actor 最多两个代次，每 dispatch 一次物理请求。这是请求身份的有限抽象，不是把产品重试额度改成 1。
4. 所有满足动作 guard 的准入、成功/失败、取消、换代、乱序响应、重复 usage、重复 Promise settlement、删除和静止重启交错均参与穷举。没有固定供应商响应脚本或只抽取随机种子。
5. `relation-budget.qnt` 直接导入原关系协议的单 actor 完整自由响应域，保留每窗口最多 3 次请求及协议重试条件。
6. `knowledge-budget.qnt` 直接导入原知识协议的两个顺序 part 完整域，保留共享 extra<=2、protocol<=1、每 part repair<=1、已接受 sourceIndex、存储/通知故障及全部原响应。

预算域与并发代次域是独立检查，不能宣称已穷举「所有重试 × 所有代次 × 所有并发 actor」的笛卡尔积。跨代实际预算不回退仍需真实适配器的定向回归。准入选择抽象不证明真实 scheduler 的 round-robin/先后顺序或墙钟公平性；真实重放必须区分 matched 与 unreplayable，不能将不支持的动作序列算作通过。

### 真实准入顺序的已知 refinement 边界

当前 `admissible` 是请求生命周期的安全性过近似，不是 `nextRelationJob` 的完整选择规则。存在具体不可直接重放的序列：`reserve(0) → send(0) → cancel(0) → newGeneration(0) → reserve(2)`。在两窗口均 ready、旧 window 0 已存在的真实 fixture 中，新 round 的 `nextRelationJob` 会按 `from_sequence` 先选 window 0；CAP1、CAP2 均如此。不能在适配器暗中先预留 actor 0，再把它的预算和 slot 隐藏以匹配 actor 2。

固定 ready、无 correction barrier/重试等待的关系调度 refinement 可要求：actor 2 准入前，当代 actor 0 已被预留/启动/终结，或 actor 0 已有可复用成功结果。CAP2 仍允许 actor 0 在途时 actor 2 并发。任意任务到达、quiet/retry 截止时间或缺少候选的情形需要显式 availability/order 状态，不能把该固定-fixture约束说成所有产品行为。知识后续新 job 的优先级由真实入队顺序决定，也不能直接套用 actor 编号顺序。

因此当前完整模型证据只证明声明域的安全性。真实重放须另声明并核验调度 refinement，或明确报告无法重放的轨迹；不能把「模型 all passed」升级为「所有模型轨迹 matched」。

## 观察标签商的依据

`TRACE=false` 仅把 `lastAction`、`actor`、`response` 固定为常量。任何 guard、业务字段更新和安全不变量均不读取这三个标签，也不读取 `TRACE`。

因此删除三个标签的投影与每个动作交换：trace-enabled 的每一步投影后，恰好是相同动作的 finite 步；反向亦可为 finite 步选择其动作标签。没有删除请求、故障、代次或业务状态。固定见证、模拟和负例保留标签；TLC/BMC 使用这个安全性质等价的观察商，减少同一业务状态因「上一步叫什么」产生的重复展开。

`model.test.mjs` 静态检查 TRACE 仅出现在三种赋值，检查不变量完全不依赖标签，并比较每对 finite/trace 配置只有 TRACE 参数不同。按协议拆分 finite wrapper 还避免一次编译大量无关实例；这不改变任何实例的状态空间。

## 验证与证据

工具固定 Quint 0.33.0、Apalache 0.62.1（含 TLC 1.8.0），archive/JAR SHA-256 见 `toolchain.json`。只读共享 `QUINT_HOME`，不要在其他任务重建它时安装或覆盖。模型工具工作目录应在源码树之外，避免 `_apalache-out` 混入源码。

从仓库根运行模型级回归：

```sh
node --test --test-timeout=30000 verification/generation-protocol/model.test.mjs
```

固定见证共 39 条，另外有 13 条 disabled-action guard 回归和 6 条定向 mutant 回归。后者分别关闭持久预留和代次/取消 gate，并验证新请求仍活跃时旧成功或旧失败会被安全性质抓住。模型检查器还须独立为四个 mutant 产生真正的反例，而非只运行 `.expect(not(safety))`。

对 `domains` 的每一项分别运行 TLC 和 Apalache；使用 `finiteSpecification` 与 `finiteMain`。TLC 只有 `Model checking completed` 且 queue=0 才算完成。Apalache 必须记录 `profiles` 中对应 main 的具体深度和最终 `NoError`；BMC、seeded simulation、固定见证均不能代替完整有限穷举。任何 timeout、RPC 错误、进程中断或缺少终态都保留为 incomplete/failed。

模型源码、配置或上游原预算协议改变后，必须重跑。开发成本探测和脏工作树结果不是发布证据。完整 relation CAP2 观察商的首次实际成本为 818,608 个 distinct states、queue=0、图深度 26，检查器用时 157.5 秒；knowledge CAP2 为 141,440 个 distinct states、queue=0、图深度 29，用时 22.4 秒。据此将正式 TLC 上限冻结为 300 秒；早期 90 秒探测未完成，不能补记为通过。

### 验收项到见证的对应

- AC-P07：`cancelLateSuccessTest`、`cancelLateFailureTest`、`cancelReleasesSlotTest`；知识另有 `cancelDoesNotCancelPendingJobTest`。
- AC-P08：`oldResponseWhileNewActiveTest`、`outOfOrderGenerationTest`、`twoListeningOutOfOrderTest`、`oldPhysicalExceedsLocalCapacityTest`；关系另有 `repeatedLateUsageIsAttemptScopedTest`。
- AC-P11：`deleteLateRestartTest`、`deleteRestartLateTest`、`otherListeningSurvivesDeleteTest`、`successfulRestartTest`。
- AC-P12：四个 checker mutant（两协议的 reservation/generation guard）及 `negative-controls.qnt` 中六个定向负例。普通成功/失败和重复 settlement 的正向见证同时保留，避免负例靠不可达状态成立。

这些对应仅声明模型覆盖。真实实现的对应观察、持久字段及首差异由适配器报告另行提供。

## 明确不证明的事项

- 三个以上 actor、第三代次或无限域安全性。
- 供应商 exactly-once、通知 outbox、公平性、终将返回或物理请求数受本地 CAP 限制。
- 任意 source/window revision、语义质量或全部产品验收。
- 仍存在的被取消知识任务在进程恢复后的自动重试；该路径由独立恢复/预算检查处理。
- 在途 restore：生产 `restoreSafety` 会拒绝。显式用户恢复已删除备份是另一个授权动作，不能混作「删除后自动复活」。
- 模型轨迹自动等同真实 SQLite/workflow/scheduler 轨迹。
