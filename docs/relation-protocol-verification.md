# 关系请求协议验证（KEJ-63）

本任务验证进程持续存活时的关系请求协议。生产实现仍由 `relation-workflow.mjs`、`relation-storage.mjs` 和 `relations.mjs` 提供。验证使用独立合成数据、供应商桩、测试门闩和临时真实 SQLite，不修改生产流程来配合模型。

新增性质卡位于 `verification/relation-protocol/properties.mjs`。原有 HW-04-01 单窗口成功试点保持不变。

| 性质 | 需求 | 验收映射 |
| --- | --- | --- |
| HW-04-02 | 调用前持久预留、账本与窗口预算；预留失败零调用 | AC-P01、AC-P02 |
| HW-04-03 | 协议错误累计二次边界、暂态总三次、混合分类与冷却 | AC-P09 |
| HW-04-04 | 响应后提交失败不重发；通知失败保留已提交结果 | AC-P05、AC-P06 |
| HW-04-05 | 正常空、全部过滤、候选不足的不同终态 | AC-P10 |

性质卡是需求与证据范围，不是通过记录。必须读取某一次运行的完整证据才能判断结果。

## 运行入口

使用仓库要求的 Node 24 和 Java 21 或更新版本：

```bash
npm run setup:relation-protocol
npm run verify:relation-protocol -- --release
npm run verify:relation-protocol -- --release --deep
npm run verify:relation-protocol:report -- RUN_DIR --release
```

每次运行使用新证据目录。`--release` 使用发布证据门禁，不将脏工作区或未完成检查包装成发布通过。首次测量、局部测试和已提交源码的最终 CI 证据必须分开记录。每个 PR 的形式化 CI 默认使用 fast profile；deep 使用独立运行与报告。

### 固定工具链

`toolchain.json` 固定 Quint 0.33.0、Apalache 0.62.1、Apalache 归档及 JAR 的 SHA256。该 JAR 捆绑上游声明的 TLC 1.8.0 和 Z3 4.14.1。TLC 在该打包方式下显示的运行时 Version 字符串不适合作为发布版本；以锁定 JAR 哈希和上游依赖声明为准。

安装器应先在临时目录下载并校验归档，解包后再校验 JAR。`QUINT_HOME` 是配置根目录本身，不会自动再加 `.quint`；后端路径为：

```text
$QUINT_HOME/apalache-dist-0.62.1/apalache/bin/apalache-mc
$QUINT_HOME/apalache-dist-0.62.1/apalache/lib/apalache.jar
```

本仓库脚本未设置 `QUINT_HOME` 时使用系统临时目录下的 `hearwise-quint`，并显式传给 Quint；直接调用上游 Quint 时，其默认值才是用户主目录下的 `.quint`。模拟和确定性见证显式选择 TypeScript 后端，避免另行下载 Rust evaluator。每项验证选择空闲本地端口，避免连接到不明版本的既有 Apalache 服务。`--apalache-version` 本身不会核验已运行服务的版本。运行器对超时和子进程组做清理。

## 模型状态与真实实现的对应关系

`protocol.qnt` 定义转换和不变量；`configurations.qnt` 实例化有限域；`witnesses.qnt` 定义确定性可达路径。状态保留 `lastAction`、`actor`、`response`、`mode`，以及每个 actor 的 `phase/counts/calls/relations/outcome/replies/ready`。

actor 0 是会话 0 的窗口 0，actor 1 是会话 1 的窗口 0，actor 2 是会话 0 的窗口 1。窗口数据使用独立合成节点与关系，不靠跨窗口重边凑结果。CAP 是模型和重放环境的准入约束，不是对生产调度器的完整验证。

| 模型动作 | 实现中的验证接点 | 读回证据 |
| --- | --- | --- |
| `init` | 建立合成收听、片段、知识节点和关系窗口 | 尚未准入的窗口、零账本和零调用 |
| `admit` | `nextRelationJob` 后进入真实 `workflow.execute`；在 `provider.run` 放行前停住 | `beginRelationRequest` 已提交；窗口累计计数与账本增加 |
| `send` | 放开 provider 门闩，进入真实 extract 接点 | 独立调用计数增加，预算已在 SQLite |
| `response` | 控制 extract 的成功或异常响应 | 成功停在提交前；异常按真实代码完成重试或失败写入 |
| `commit` | 放开 `context.step('relation.commit')`，执行真实存储事务后停住 | job/window 已完成，图谱和 outcome 已持久确定 |
| `commit_fail` | 在提交接点注入存储异常，保留真实错误处理 | 终态失败、零新增关系、没有第二次请求 |
| `notify` / `notify_fail` | 放开提交后的代码；可使通知回调抛错 | 已提交图谱、账本和 outcome 不变 |
| `advance_time` | 注入时钟跳到待重试/冷却时间的最大值 | 所有 `retry_wait` 一起变为 `idle` |
| `stutter` | 所有 actor 终止后的模型自环 | 只读现有投影，不再次执行业务 |

`counts` 读同 epoch 窗口的持久累计请求数，`calls` 独立记录供应商调用，不能用同一个自报变量相互证明。每一步还检查真实 job/window 状态、请求账本和图谱关系归属。`ready` 仅在 `retry_wait` 为 false。

成功提交时，`outcome` 已是 `ok` 或 `empty`；通知之后不变。全部过滤的 `replies` 是 `filtered`，业务 `outcome` 是 `empty`。候选不足进入 `waiting_nodes`，没有 job 和付费请求。预留事务失败时，execute 抛错、持久 job 仍为 pending，模型用 `reserve_failed` 表示该测试终止；这不是虚构的业务 failed 状态。

存储会优先返回已到期的较早 pending job。但较早窗口仍在 `retry_wait` 时，它不会阻止后续 dirty 窗口准入。`laterWindowDuringRetryTest` 固定覆盖这个边界。

## 各种证据分别说明什么

### TLC：声明有限域内完成全部可达状态探索

单任务配置允许 `valid/no_candidates/reserve_fail` 三种初态；有效请求的每次响应可自由选择 ok、empty、filtered、protocol、transient、auth、rate_limit、rate_limit_long、unexpected。有效响应之后允许提交成功或失败，提交之后允许通知成功或失败。请求预算为三；协议错误判断使用累计窗口请求数，不是单独的协议错误计数。

三任务配置使用固定响应脚本：actor 0 为 protocol→ok，actor 1 为 transient→empty，actor 2 为 filtered。cap1 和 cap2 分别穷尽这些脚本在模型内的全部异步交错，包括通知异常。它们不代表三个任务任意响应组合的全探索。

本轮开发测量中，TLC 的实际结果为：

| 配置 | 生成状态 | 唯一状态 | 队列剩余 | 完整图搜索深度 |
| --- | ---: | ---: | ---: | ---: |
| single | 160 | 112 | 0 | 15 |
| multi_cap1 | 375 | 235 | 0 | 24 |
| multi_cap2 | 2457 | 990 | 0 | 24 |

这些数字是本轮模型版本的实测，不是静态保证或将来运行的通过条件。检查源码与配置变更后，数字可能变化。必须同时保存退出状态、TLC 原始日志、完成消息及零剩余队列；超时或仅出现中途进度不能算完整。TLC 使用状态指纹，日志中的碰撞概率估计也应保留。

### Apalache：所选深度以内的有界检查

| Profile | single | multi_cap1 | multi_cap2 |
| --- | ---: | ---: | ---: |
| fast（默认） | 15 | 8 | 8 |
| deep | 15 | 12 | 12 |

表中数字是最大转换步数，初态为第 0 个状态。首次成本测量中 cap2 depth8 约两分钟完成；可选 depth12 探测约十四分钟后按观察上限主动中止，最后观察到 depth11，明确为 incomplete/interrupted，不能算通过。因此把快、深配置分开；没有因反例而缩小范围。两个 profile 的 TLC 有限域完全相同，均要求完整枚举。

fast 通过不能代表 deep 通过。有界检查通过只能说明指定深度内未发现违反所检查性质的执行，不能表述为一般性证明。deep 的进行中、超时、缺失或失败都必须保留原状态，不能借用 fast 的结果。

### 模拟、确定性见证与真实实现重放

有种子的 Quint 模拟探索有限样本。报告应给 seed、backend、max-samples、max-steps 和实际产出轨迹数；它不能替代 TLC。`--witnesses` 只报告命中，不能保证覆盖验收路径。

确定性见证直接调用与模型相同的转换动作，再用 `expect` 检查目标。当前配置包含 20 个成功测试，其中有正常成功、空、过滤、候选不足、预留失败、协议/暂态预算、混合错误、认证错误、429、过长 Retry-After、提交失败、通知失败及多任务交错。这些成功测试同样由 Quint 导出 ITF，避免依靠随机命中。

ITF 整数编码是 `{"#bigint":"1"}`，映射是 `{"#map":[[key,value]]}`。字段带模块命名空间，驱动按最后一个 `::` 后的名称归一化，并拒绝重名。固定 seed 的业务轨迹可复现，但原始文件的顶层时间戳、描述和源路径会变化。应保留原始 ITF，并分别记录规范化状态的语义哈希。

Node 驱动读取 ITF 后逐步推动真实 workflow 与真实临时 SQLite，并在每一步比较模型和实现投影。模型检查与实现重放是不同证据：前者检查声明模型，后者检查所重放执行的实现对应关系。这里不声称已经形式化证明整个 JavaScript 实现。

出现差异时，驱动保留首个分歧状态之前的轨迹前缀（first-divergence-prefix）。这是当前轨迹内定位到的第一个差异，不是全局最短反例，也不是对所有替代调度做过最小化的结果。

## 负向控制与补充测试

模型包含三个独立负向变体：漏记预留后发送、有效响应后因提交失败而重试、第三次暂态失败后仍安排下一次请求。必须确认检查器报告的是预期性质的真实反例，并保存合法 ITF；单凭非零退出码不能把解析失败、工具不可用或超时当作检出成功。最后一种变体在第三次失败后安排重试时就违反 `terminalBudget`，不必等到第四次调用已经发出。

共享密钥冷却另由真实实现的补充回归测试检查。该证据应单列，不能加入多任务 TLC 的固定脚本范围。真实 Retry-After、错误对象分类与持久时间戳的边界也需要由实现侧断言约束，模型中的响应类别和逻辑时钟是抽象。

## 明确不覆盖

本任务不覆盖崩溃/重启、取消、删除、epoch 或来源变化、生产调度公平性、真实供应商语义质量、候选变化后的唤醒，以及其他 M1 故障。通知和提交错误仅覆盖进程存活、失败终态仍可写入的声明场景。不得用本任务通过结果替代这些独立验收。
